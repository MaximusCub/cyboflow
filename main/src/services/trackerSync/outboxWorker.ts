/**
 * trackerSync/outboxWorker — the only place in the sync engine that performs a
 * remote WRITE. Design: docs/proposals/tracker-sync-integration.md
 * ("Durability & failure semantics" #1).
 *
 * writeBack.ts turns entity changes into durable `tracker_outbox` rows; this
 * module drains them against a provider adapter. The contract that makes the
 * whole thing crash-safe:
 *
 *   - A row is CLAIMED (pending -> in_flight, attempts++) before its API call,
 *     so a crash mid-flight is distinguishable from "never attempted". At boot
 *     the service calls store.requeueInFlightAsAmbiguous, and
 *     {@link processAmbiguous} reconciles those rows (point lookup by client
 *     key where the provider has idempotent creates, list-and-match where it
 *     does not) BEFORE any retry — a sub-issue can never be double-created.
 *     A LIVE drain parks lost creates in that same `ambiguous` state (see the
 *     failure taxonomy below), so the guarantee does not depend on a crash.
 *   - Only the ADAPTER CALL is wrapped in try/catch. Anything that throws
 *     AFTER a successful send (a sqlite failure while recording the outcome)
 *     propagates out of the drain with the row still `in_flight`, which is
 *     exactly right: the remote write happened, so the row must NOT be
 *     retried, and boot recovery will reconcile it.
 *   - Every successful state write stamps the written state onto the link's
 *     `baseline_json` (see {@link WriteBackBaselineStamp}), so the inbound
 *     poller diffs our own write to "no change" and never echoes it back.
 *
 *   - A claimed state write is dropped unsent when a NEWER unsettled write for
 *     the same issue exists (see {@link isSuperseded}), so a delayed retry can
 *     never regress the remote past a decision the user has already replaced.
 *
 * Failure taxonomy:
 *   - TrackerAuthError            -> connection paused, drain STOPS, and the row is
 *                                    HELD unsettled (see {@link pauseConnection}) so a
 *                                    key rotation replays it rather than losing it.
 *   - Other 4xx (not 408/429)     -> terminal failure; a malformed/forbidden write
 *                                    will never succeed on retry.
 *   - 5xx / 408 / 429 / network   -> retry, next_attempt_at = now + min(2^attempts, 32) min.
 *   - …the same, on a create the provider cannot make idempotent (Plane)
 *                                 -> `ambiguous`, NEVER a blind retry. Those errors say
 *                                    "outcome unknown", and a create that landed before
 *                                    its response was lost would be duplicated by the
 *                                    next POST — so the row waits for
 *                                    {@link processAmbiguous}'s client-key lookup.
 */
import type Database from 'better-sqlite3';
import type { TrackerConnectionRow, TrackerOutboxRow } from '../../database/models';
import type {
  TrackerIssue,
  TrackerNarrowKind,
  TrackerSourceSelection,
  TrackerState,
} from '../../../../shared/types/trackerSync';
import type { IssueDraft, TrackerAdapter } from './adapterTypes';
import { TrackerApiError, TrackerAuthError } from './errors';
import {
  claimNextPending,
  listUnresolvedOutbox,
  resolveOutbox,
  updateBaseline,
  updateConnectionSettings,
  upsertLink,
  getLinkByExternal,
} from './store';
import {
  parseJsonObject,
  readDesiredGroup,
  type CreateSubIssuePayload,
  type WriteBackBaselineStamp,
  type WriteBackGroup,
} from './writeBack';
import {
  pickWriteBackState,
  resolveEffectiveMapping,
  resolveStageIds,
  stageIdToWriteBackGroup,
} from './stateMapping';
import {
  joinBody,
  normalizeDescription,
  splitBody,
  type EntityWriteRouter,
} from './inboundSync';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface OutboxDeps {
  db: Database.Database;
  /** Build (or reuse) the provider client for a connection — decrypts the stored key. */
  adapterFor(connection: TrackerConnectionRow): TrackerAdapter;
  /**
   * The entity-write chokepoint — the SAME structural slice of TaskChangeRouter
   * the inbound pass takes. This module writes exactly one local field, on
   * exactly one occasion: aligning a body with the description the provider
   * actually stored for a create (see {@link alignLocalDescription}). Everything
   * else it touches is tracker bookkeeping, which belongs to store.ts.
   */
  router: EntityWriteRouter;
  /**
   * Current timestamp. Normalized to sqlite's `datetime('now')` shape
   * ('YYYY-MM-DD HH:MM:SS', UTC) before it is compared against or written to
   * any timestamp column, so a caller passing a JS ISO string still orders
   * correctly against the schema's own defaults.
   */
  nowIso(): string;
}

export interface OutboxReport {
  /** `update_state` / `close_parent` rows successfully written to the tracker. */
  sent: number;
  /** Issues created — mirrored children AND pushed ideas, including ones ADOPTED by ambiguous recovery. */
  created: number;
  /**
   * The `create_issue` subset of {@link created} — top-level issues created for
   * pushed local ideas. Split out so the sync log can word a pushed idea as
   * "pushed", not mislabel it a mirrored sub-issue.
   */
  pushedIdeas: number;
  /** Rows that will never be retried (4xx, unresolvable state, malformed payload). */
  failedTerminal: number;
  /** Rows re-queued with a backoff `next_attempt_at`. */
  retriesScheduled: number;
  /** Rows moved OUT of `ambiguous` (adopted as done, or returned to pending). */
  ambiguousResolved: number;
  /** Stale state writes settled unsent because a newer one supersedes them (see {@link isSuperseded}). */
  superseded: number;
  /**
   * Recovered creates whose ORIGINATING IDEA is gone or archived: the remote
   * issue exists and nothing local may point at it, so it is left orphaned in
   * the tracker and reported here for the connected view's log.
   */
  orphanedCreates: number;
  /** The connection was paused by an auth failure and the drain stopped early. */
  authPaused: boolean;
}

function emptyReport(): OutboxReport {
  return {
    sent: 0,
    created: 0,
    pushedIdeas: 0,
    failedTerminal: 0,
    retriesScheduled: 0,
    ambiguousResolved: 0,
    superseded: 0,
    orphanedCreates: 0,
    authPaused: false,
  };
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** Longest backoff between attempts, in minutes (2^attempts, clamped). */
const MAX_BACKOFF_MINUTES = 32;

/**
 * Normalize a timestamp to sqlite's `datetime('now')` shape. store.ts compares
 * `next_attempt_at <= now` as STRINGS, so a JS ISO-8601 value ('…T…Z') and a
 * schema-default value ('… …') must never be compared against each other —
 * 'T' > ' ' would make a future retry look due. Everything this module writes
 * or compares passes through here first.
 */
export function toSqliteUtc(value: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

/** `base` + `minutes`, in the sqlite timestamp shape. */
function addMinutes(base: string, minutes: number): string {
  const normalized = base.includes('T') ? base : `${base.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return base;
  return new Date(parsed.getTime() + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

/**
 * Drain every eligible pending row for one connection, oldest first, until the
 * queue is empty (or an auth failure pauses the connection).
 *
 * `allowedKinds` is the DIRECTION-MODE gate (migration 094): the caller passes
 * the kinds whose direction is running this pass, and every other row is simply
 * not claimed — it stays `pending`, in order, until a pass whose filter includes
 * it comes along. Omitting the argument drains everything. An EMPTY array is a
 * legitimate "every direction is held" and drains nothing.
 *
 * The provider's state list is fetched at most ONCE per drain and shared by
 * every state write in it.
 */
export async function drainOutbox(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  allowedKinds?: readonly TrackerOutboxRow['kind'][],
): Promise<OutboxReport> {
  const report = emptyReport();
  const adapter = deps.adapterFor(connection);
  const states = new StateCache(adapter, connection);

  for (;;) {
    const row = claimNextPending(deps.db, connection.id, toSqliteUtc(deps.nowIso()), allowedKinds);
    if (!row) break;
    const halted = await processRow(deps, connection, adapter, states, row, report);
    if (halted) break;
  }
  return report;
}

/**
 * Handle one claimed row. Returns true when the drain must STOP (auth failure
 * -> the connection is paused and every remaining row would fail the same way).
 */
async function processRow(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  states: StateCache,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  if (row.kind === 'create_sub_issue') {
    return await processCreate(deps, connection, adapter, row, report);
  }
  if (row.kind === 'create_issue') {
    return await processPush(deps, connection, adapter, states, row, report);
  }
  return await processStateWrite(deps, connection, adapter, states, row, report);
}

/**
 * Is this claimed state write STALE — does a NEWER unsettled write for the same
 * issue already exist?
 *
 * THE BACKSTOP HALF of supersession, not the primary one. The ordering hazard
 * is fixed where both rows are knowable — at ENQUEUE, in
 * store.supersedeQueuedStateWrites, which is the only moment that can see a
 * newer write that has already LANDED and settled. This check enforces the same
 * invariant at the point of USE, for a row that never met that sweep: anything
 * queued before this behaviour existed, or by an enqueue path added later that
 * forgets to call it. Redundant on the ordinary path, and deliberately so — the
 * cost is one already-cheap query per claimed state write, and the failure it
 * prevents is silent.
 *
 * THE KEY is `external_id` + the two STATUS kinds, deliberately not `kind`
 * alone — the same key writeBack's enqueue dedupe uses, and for the same
 * reason: `update_state` and `close_parent` both move the SAME issue's state,
 * so a later one of either kind states the truth the earlier one is now wrong
 * about. Newer means a higher autoincrement `id`; unsettled means
 * pending/in_flight/ambiguous, so a row that already failed terminally cannot
 * supersede anything.
 *
 * CRASH-SAFE by the existing state machine: the decision is made on a row we
 * have just CLAIMED, under the same exclusion the send would have had. A crash
 * between this check and the settle leaves the row `in_flight`, boot recovery
 * demotes it to `ambiguous`, and {@link resolveAmbiguous} returns a state write
 * straight to `pending` — where the next claim asks the same question again,
 * against data that is by then even fresher. Nothing is lost, nothing is sent
 * twice.
 */
function isSuperseded(
  db: Database.Database,
  connectionId: string,
  row: TrackerOutboxRow,
): boolean {
  if (row.external_id === null) return false;
  return listUnresolvedOutbox(db, connectionId).some(
    (other) =>
      other.id > row.id &&
      other.external_id === row.external_id &&
      (other.kind === 'update_state' || other.kind === 'close_parent'),
  );
}

/** `update_state` / `close_parent`: resolve the provider state, write it, stamp the baseline. */
async function processStateWrite(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  states: StateCache,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  // Settled, not failed: a superseded write is not a problem, it is an
  // instruction the user has already replaced. Sending it would be the bug.
  if (isSuperseded(deps.db, connection.id, row)) {
    resolveOutbox(deps.db, row.id, 'done', {
      lastError: 'superseded by a newer state write for the same issue',
    });
    report.superseded += 1;
    return false;
  }

  const desiredGroup = readDesiredGroup(row.payload_json);
  if (desiredGroup === null || row.external_id === null) {
    failTerminal(deps, row, report, 'malformed payload: desiredGroup / external_id missing');
    return false;
  }

  let state: TrackerState | null;
  try {
    const loaded = await states.load();
    // The mapping is passed so an explicit 'indev' pin can name the started
    // state instead of falling back to the adapter's group inference.
    state = pickWriteBackState(
      loaded,
      desiredGroup,
      resolveEffectiveMapping(loaded, connection.state_mapping_json),
    );
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err);
  }
  if (state === null) {
    failTerminal(deps, row, report, `no provider state maps to the '${desiredGroup}' group`);
    return false;
  }

  const externalId = row.external_id;
  try {
    await adapter.updateIssueState(externalId, state.id);
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err);
  }

  // Past the send: everything below is local bookkeeping, deliberately OUTSIDE
  // the catch (see the file header — a throw here must leave the row in_flight
  // for boot recovery, never schedule a retry of a write that already landed).
  resolveOutbox(deps.db, row.id, 'done');
  report.sent += 1;
  stampWriteBackBaseline(deps, connection, externalId, state.id, desiredGroup);
  return false;
}

/** `create_sub_issue`: create the issue, then link it. */
async function processCreate(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  const payload = readCreatePayload(row);
  if (payload === null || row.entity_id === null || row.client_key === null) {
    failTerminal(deps, row, report, 'malformed payload: parentExternalId / entity_id / client_key missing');
    return false;
  }

  let issue: TrackerIssue;
  try {
    issue = await adapter.createSubIssue(
      payload.parentExternalId,
      { title: payload.title, description: payload.description ?? undefined },
      row.client_key,
    );
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err, {
      // A create is the one write that cannot be repeated safely. Where the
      // provider has no idempotency key (Plane), an uncertain failure may well
      // have committed the child before the response was lost, so the row parks
      // as `ambiguous` and the marker lookup — not a second POST — decides.
      // Linear's client key IS the created issue's id, so a repeat is a no-op
      // there and the plain backoff retry stands.
      uncertainIsAmbiguous: !adapter.capabilities.idempotentCreate,
    });
  }

  await adoptCreatedIssue(deps, connection, row, issue, payload.parentExternalId, payload.description);
  report.created += 1;
  return false;
}

/**
 * Record a created (or recovered) sub-issue: link it, snapshot its baseline,
 * settle the outbox row, then align the local body with what the provider
 * stored. Post-send bookkeeping — never inside a catch.
 *
 * `sentDescription` is what the create actually PUT ON THE WIRE, or undefined
 * when that is unknowable (no path has that gap today: a sub-issue's draft
 * description is the payload's, on the live and the recovery path alike). See
 * {@link alignLocalDescription} for why the comparison is against the sent text
 * rather than the local body.
 */
async function adoptCreatedIssue(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  issue: TrackerIssue,
  parentExternalId: string,
  sentDescription: string | null | undefined,
): Promise<void> {
  upsertLink(deps.db, {
    connection_id: connection.id,
    entity_type: 'task',
    entity_id: row.entity_id as string,
    provider: connection.provider,
    external_id: issue.externalId,
    external_identifier: issue.identifier,
    external_url: issue.url,
    external_parent_id: parentExternalId,
    baseline_json: JSON.stringify(baselineSnapshot(issue)),
  });
  resolveOutbox(deps.db, row.id, 'done');
  await alignLocalDescription(deps, connection, 'task', row.entity_id as string, issue, sentDescription);
}

// ---------------------------------------------------------------------------
// create_issue — the PUSH direction
// ---------------------------------------------------------------------------

/** The idea columns a pushed draft is composed from. */
interface PushableIdea {
  title: string;
  body: string | null;
  stage_id: string;
  archived_at: string | null;
}

/**
 * `create_issue`: file the idea as a TOP-LEVEL issue in the connection's source
 * container, then link it.
 *
 * THE DRAFT IS COMPOSED HERE, not at enqueue time (see
 * writeBack.CREATE_ISSUE_PAYLOAD_JSON): a push can wait a long time when
 * `push_mode` is 'manual', and the tracker should receive the idea as it stands
 * when the user asks for the sync, not as it was first typed.
 *
 * AN IDEA THAT NO LONGER EXISTS — hard-deleted, or archived while the push
 * waited — settles the row DONE with no remote write. The user's last statement
 * about that idea was "take it away", and honouring a stale intent by filing it
 * into a shared workspace is the one outcome nobody can undo from here.
 */
async function processPush(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  states: StateCache,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  if (row.entity_id === null || row.client_key === null) {
    failTerminal(deps, row, report, 'malformed row: entity_id / client_key missing');
    return false;
  }
  const selection = parseSelection(connection);
  if (selection === null) {
    failTerminal(deps, row, report, 'connection has no source selected to create an issue in');
    return false;
  }

  const idea = readPushableIdea(deps.db, row.entity_id);
  if (idea === null || idea.archived_at !== null) {
    // Settled, not failed: there is nothing left to push and nothing went wrong.
    resolveOutbox(deps.db, row.id, 'done');
    return false;
  }

  let draft: IssueDraft;
  let providerStates: TrackerState[];
  try {
    providerStates = await states.load();
    draft = composePushDraft(deps, connection, idea, providerStates);
  } catch (err) {
    // Covers the state fetch AND the local board-stage resolution; neither has
    // sent anything, so an ordinary backoff retry is safe.
    return recordAdapterFailure(deps, connection, row, report, err);
  }

  let issue: TrackerIssue;
  try {
    issue = await adapter.createIssue(selection, draft, row.client_key);
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err, {
      // Identical reasoning to a sub-issue create: where the provider has no
      // idempotency key (Plane) an uncertain failure may already have filed the
      // issue, so the marker lookup — not a second POST — decides.
      uncertainIsAmbiguous: !adapter.capabilities.idempotentCreate,
    });
  }

  await adoptPushedIssue(
    deps,
    connection,
    row,
    issue,
    groupOfState(providerStates, issue.stateId),
    draft.description ?? null,
  );
  report.created += 1;
  report.pushedIdeas += 1;
  return false;
}

/**
 * The draft for a pushed idea: its CURRENT title and description, with the
 * provenance footer split off (an idea that carries one is not pushed at all —
 * this is belt-and-braces so a marker can never reach a remote body), plus the
 * provider state its board stage implies.
 *
 * INITIAL STATE. The idea's stage maps to a write-back group exactly as a stage
 * MOVE would (In development → started, Done → completed, Won't do →
 * cancelled); every other stage means "filed, not started", which is the
 * `backlog` group. A workspace with no state in the resolved group leaves
 * `stateId` unset and takes the provider's own default — for a create that is a
 * reasonable answer, unlike a state WRITE where the state is the entire point.
 */
function composePushDraft(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  idea: PushableIdea,
  states: TrackerState[],
): IssueDraft {
  const stageIds = resolveStageIds(deps.db, connection.project_id);
  const group = stageIdToWriteBackGroup(idea.stage_id, stageIds) ?? 'backlog';
  const state = pickWriteBackState(
    states,
    group,
    resolveEffectiveMapping(states, connection.state_mapping_json),
  );
  const { description } = splitBody(idea.body);
  return {
    title: idea.title,
    description: description ?? undefined,
    stateId: state?.id,
  };
}

/**
 * Record a pushed issue: link the idea to it, seed the baseline from the issue
 * as created, and settle the row. Post-send bookkeeping — never inside a catch.
 *
 * `group` is the group the issue ACTUALLY landed in (read back off its own
 * `stateId`, not off what we asked for), stamped as `lastWrittenGroup` so a
 * later local move to that same stage recognizes the tracker as already there
 * and queues nothing. A group outside the three write-back ones — the ordinary
 * case, a freshly-filed idea in `backlog` — stamps NOTHING, because a stale key
 * there would suppress the first genuine Done/Won't-do write-back.
 *
 * `sentDescription` is the draft description this push put on the wire, or
 * undefined on the RECOVERY path, which cannot know it: the row carries no
 * payload (the draft is composed at drain time from an idea that may have moved
 * on since), so there is nothing to compare the returned body against and the
 * alignment stands down. See {@link alignLocalDescription}.
 */
async function adoptPushedIssue(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  issue: TrackerIssue,
  group: WriteBackGroup | null,
  sentDescription: string | null | undefined,
): Promise<void> {
  const snapshot = baselineSnapshot(issue);
  upsertLink(deps.db, {
    connection_id: connection.id,
    entity_type: 'idea',
    entity_id: row.entity_id as string,
    provider: connection.provider,
    external_id: issue.externalId,
    external_identifier: issue.identifier,
    external_url: issue.url,
    external_parent_id: issue.parentExternalId,
    baseline_json: JSON.stringify(
      group === null ? snapshot : { ...snapshot, lastWrittenGroup: group },
    ),
  });
  resolveOutbox(deps.db, row.id, 'done');
  await alignLocalDescription(deps, connection, 'idea', row.entity_id as string, issue, sentDescription);
}

/**
 * AFTER A CREATE, MAKE THE LOCAL BODY SAY WHAT THE BASELINE SAYS.
 *
 * A provider is free to normalize the markdown it stores, and Dart MEASURABLY
 * does (dartAdapter.ts's SYNC_MARKER_RE note: it re-emits emphasis runs,
 * reflows lists and linkifies dotted tokens). The adoption paths above snapshot
 * the baseline from the issue the provider RETURNED — the normalized text —
 * while the local entity keeps the text the user authored. Left alone the two
 * disagree from the moment of creation, and the disagreement is silent until
 * the remote description genuinely changes: inboundSync's three-way merge then
 * diffs the new remote against a baseline the local body never matched, reads
 * "both sides moved", and whole-field-replaces the local body with the
 * provider's mangled copy. Description has no outbound path in v1, so nothing
 * ever pushes the authored text back.
 *
 * Aligning here converts that latent corruption into an immediate, attributable
 * correction: one `body` write through the entity chokepoint, attributed to the
 * PROVIDER actor, visible in the entity's event log the moment it happens.
 *
 * THE COMPARISON IS AGAINST WHAT WE SENT, not against the local body. They
 * differ exactly when the user edited the entity between enqueue and drain —
 * and there the local text is NEWER than the create, so overwriting it with the
 * create's echo would discard a real edit. Equal-after-normalization counts as
 * agreement, because that is precisely what the merge counts as agreement (see
 * inboundSync.normalizeDescription): a difference it would never diff on is a
 * local event with nothing behind it.
 *
 * ORDER: strictly last, after the link and after the row is settled `done`. A
 * throw here (a deleted entity, a sqlite failure) propagates like any other
 * post-send bookkeeping failure — see the file header — and because the row is
 * already settled it can never cause the create to be re-sent. The cost of that
 * failure is the baseline divergence we have today, not a duplicate issue.
 *
 * NO OUTBOUND ECHO: writeBack.route has no content trigger at all, so a body
 * write enqueues nothing on its own. (An entity sitting in a write-back stage
 * can enqueue one redundant, idempotent state write off this event — bounded at
 * one by the `lastWrittenGroup` stamp the very same write records.)
 */
async function alignLocalDescription(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  entityType: 'idea' | 'task',
  entityId: string,
  issue: TrackerIssue,
  sentDescription: string | null | undefined,
): Promise<void> {
  // Unknowable (the recovery push path) or absent: nothing to compare against,
  // and a provider that returned no description at all has said nothing about
  // what it stored.
  if (sentDescription === undefined || issue.description === null) return;
  if (normalizeDescription(issue.description) === normalizeDescription(sentDescription)) return;

  const body = readEntityBody(deps.db, entityType, entityId);
  if (body === undefined) return;
  // The footer is cyboflow's half of the body and belongs to no provider —
  // preserved exactly as an inbound merge would preserve it.
  const { footer } = splitBody(body);
  await deps.router.applyChange(connection.project_id, {
    actor: connection.provider,
    entityType,
    taskId: entityId,
    fields: { body: joinBody(issue.description, footer) },
  });
}

/** One entity's stored body, or undefined when the row is gone. */
function readEntityBody(
  db: Database.Database,
  entityType: 'idea' | 'task',
  entityId: string,
): string | null | undefined {
  const table = entityType === 'idea' ? 'ideas' : 'tasks';
  const row = db.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(entityId) as
    | { body: string | null }
    | undefined;
  return row === undefined ? undefined : row.body;
}

/** An idea's pushable columns, or null when the row is gone. */
function readPushableIdea(db: Database.Database, ideaId: string): PushableIdea | null {
  const row = db
    .prepare('SELECT title, body, stage_id, archived_at FROM ideas WHERE id = ?')
    .get(ideaId) as PushableIdea | undefined;
  return row ?? null;
}

/** The write-back group a provider state belongs to, or null when it has none. */
function groupOfState(states: TrackerState[], stateId: string): WriteBackGroup | null {
  const group = states.find((state) => state.id === stateId)?.group;
  return group === 'started' || group === 'completed' || group === 'cancelled' ? group : null;
}

// ---------------------------------------------------------------------------
// Ambiguous recovery
// ---------------------------------------------------------------------------

/**
 * What {@link resolveAmbiguous} did with a row:
 *   - `adopted`    — the write HAD landed; the row is done and its issue linked.
 *   - `orphaned`   — the write HAD landed, but the entity that asked for it is
 *                    gone or archived; the row is settled with NO link and the
 *                    stranded remote issue is reported (see {@link adoptOrOrphanPush}).
 *   - `requeued`   — the write did NOT land; the row is pending again (safe to retry).
 *   - `unresolved` — still unknown (the reconciling lookup itself failed); stays ambiguous.
 *   - `failed`     — unusable row, settled terminally.
 *   - `halted`     — auth failure: the connection is paused, the row is left
 *                    UNSETTLED, and the pass stops.
 */
export type AmbiguousOutcome =
  | 'adopted'
  | 'orphaned'
  | 'requeued'
  | 'unresolved'
  | 'failed'
  | 'halted';

/**
 * Reconcile every `ambiguous` row for a connection — writes whose outcome is
 * genuinely unknown, from either source: store.requeueInFlightAsAmbiguous
 * produces them at boot from a crash mid-flight, and a live drain parks a
 * non-idempotent create there when its call fails uncertainly. The service
 * calls this BEFORE {@link drainOutbox} so a lost create is adopted rather
 * than repeated.
 */
export async function processAmbiguous(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
): Promise<OutboxReport> {
  const report = emptyReport();
  const rows = listUnresolvedOutbox(deps.db, connection.id).filter((row) => row.state === 'ambiguous');

  for (const row of rows) {
    const outcome = await resolveAmbiguous(deps, connection, row);
    if (outcome === 'adopted') {
      report.created += 1;
      if (row.kind === 'create_issue') report.pushedIdeas += 1;
      report.ambiguousResolved += 1;
    } else if (outcome === 'orphaned') {
      report.orphanedCreates += 1;
      report.ambiguousResolved += 1;
    } else if (outcome === 'requeued') {
      report.ambiguousResolved += 1;
    } else if (outcome === 'failed') {
      report.failedTerminal += 1;
      report.ambiguousResolved += 1;
    } else if (outcome === 'halted') {
      // NOT a terminal failure: the row is deliberately left unsettled so it
      // replays once the credentials are fixed (see {@link pauseConnection}).
      report.authPaused = true;
      break;
    }
  }
  return report;
}

/**
 * Reconcile ONE ambiguous row:
 *   - `create_sub_issue` + `capabilities.idempotentCreate` (Linear): the client
 *     key IS the issue id, so a point lookup settles it — found means the create
 *     landed, missing means it never did and a retry is safe.
 *   - `create_sub_issue` without idempotent creates (Plane): ask the adapter for
 *     the child of this parent carrying the row's client key (see
 *     {@link ClientKeyRecoverableAdapter}) — same two answers, same guarantee.
 *   - `update_state` / `close_parent`: idempotent by nature — straight back to
 *     pending, the drain will simply write the state again.
 *
 * A failed lookup leaves the row `ambiguous` (returning it to pending is only
 * safe once we KNOW the write did not land — otherwise a retry duplicates the
 * sub-issue), except an auth failure, which pauses the connection and halts.
 */
export async function resolveAmbiguous(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
): Promise<AmbiguousOutcome> {
  if (row.kind !== 'create_sub_issue' && row.kind !== 'create_issue') {
    requeue(deps, row);
    return 'requeued';
  }

  // A sub-issue create carries its parent in the payload; a push carries no
  // payload at all and is scoped by the connection's own source selection.
  const payload = row.kind === 'create_sub_issue' ? readCreatePayload(row) : null;
  const selection = row.kind === 'create_issue' ? parseSelection(connection) : null;
  if (row.entity_id === null || row.client_key === null) {
    resolveOutbox(deps.db, row.id, 'failed', { lastError: 'malformed row: entity_id / client_key missing' });
    return 'failed';
  }
  if (row.kind === 'create_sub_issue' && payload === null) {
    resolveOutbox(deps.db, row.id, 'failed', {
      lastError: 'malformed payload: parentExternalId missing',
    });
    return 'failed';
  }
  if (row.kind === 'create_issue' && selection === null) {
    resolveOutbox(deps.db, row.id, 'failed', {
      lastError: 'connection has no source selected to search for the created issue in',
    });
    return 'failed';
  }

  const adapter = deps.adapterFor(connection);
  const clientKey = row.client_key;
  let found: TrackerIssue | null;
  try {
    found = adapter.capabilities.idempotentCreate
      ? await adapter.getIssue(clientKey)
      : await findByClientKey(adapter, connection, clientKey, {
          // A sub-issue lives in its parent's container, so the parent both
          // scopes and constrains the search; a top-level push is scoped by the
          // selection's container with NO parent constraint. The narrow KIND
          // rides along so the adapter never has to guess what the container
          // id names — a Dart SPACE and a Dart board can share a title, and a
          // wrong guess searches the wrong boards and re-creates a committed
          // create.
          containerId: selection?.containerId ?? null,
          narrowKind: selection?.narrowKind ?? null,
          parentExternalId: payload?.parentExternalId ?? null,
        });
  } catch (err) {
    if (err instanceof TrackerAuthError) {
      // The row stays `ambiguous` — its outcome is still genuinely unknown, and
      // the auth failure told us nothing about it. Returning it to `pending`
      // would let a retry duplicate a create the first attempt may already have
      // committed. See {@link pauseConnection} for the same "hold, do not
      // terminalize" reasoning on the drain side.
      resolveOutbox(deps.db, row.id, 'ambiguous', { lastError: describeError(err) });
      updateConnectionSettings(deps.db, connection.id, { status: 'paused' });
      return 'halted';
    }
    // Outcome still unknown -> stay ambiguous, record why, try again next pass.
    resolveOutbox(deps.db, row.id, 'ambiguous', { lastError: describeError(err) });
    return 'unresolved';
  }

  if (found === null) {
    requeue(deps, row);
    return 'requeued';
  }

  if (payload !== null) {
    await adoptCreatedIssue(deps, connection, row, found, payload.parentExternalId, payload.description);
    return 'adopted';
  }
  return await adoptOrOrphanPush(deps, connection, row, found);
}

/**
 * Finish a RECOVERED top-level push: link the created issue back to the idea
 * that asked for it — or, when that idea is gone, settle the row and leave the
 * issue orphaned.
 *
 * WHY THE RE-READ. The remote create already committed; only its response was
 * lost. Between then and this recovery pass — which can be a whole app restart
 * later — the user may well have deleted or archived the idea, and the ordinary
 * push path treats exactly that as "there is nothing left to push"
 * ({@link processPush}). Adopting regardless would write an ACTIVE link to an
 * entity that is archived (inbound sync would then keep mutating something the
 * user retired) or to no entity at all (a permanent zombie link the poller
 * finds, fails to resolve, and skips on every pass forever).
 *
 * WHAT ORPHANING MEANS. The row settles `done` — nothing failed, and there is
 * nothing left to attempt — with the reason recorded on the row, and the count
 * surfaces in the connected view's log. We do NOT delete or cancel the remote
 * issue: this module never hard-deletes on someone else's tracker, and the
 * user's local removal never said anything about an issue they did not know had
 * been created. Discoverable and reversible by hand beats tidy and destructive.
 *
 * NO `lastWrittenGroup` STAMP on the adopt path, deliberately: reading the
 * issue's group back would cost a state-list round trip on a rare recovery, and
 * its only effect is suppressing ONE redundant (idempotent) state write the next
 * time this idea moves. The sub-issue adopt path makes the same trade.
 */
async function adoptOrOrphanPush(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  issue: TrackerIssue,
): Promise<AmbiguousOutcome> {
  const idea = row.entity_id === null ? null : readPushableIdea(deps.db, row.entity_id);
  if (idea === null || idea.archived_at !== null) {
    resolveOutbox(deps.db, row.id, 'done', {
      lastError:
        `the idea this issue was created for is ${idea === null ? 'gone' : 'archived'}; ` +
        `${issue.identifier} (${issue.url}) was left in the tracker, unlinked`,
    });
    return 'orphaned';
  }
  // `undefined`, not null: what this push sent is genuinely unknown here — see
  // {@link adoptPushedIssue}.
  await adoptPushedIssue(deps, connection, row, issue, null, undefined);
  return 'adopted';
}

/**
 * Recovery seam for a provider whose creates are NOT natively idempotent
 * (Plane): the adapter stamps the outbox row's client key into every issue it
 * creates and can therefore point at the one child of a parent that is ours.
 *
 * Deliberately not on `TrackerAdapter`: the marker carrying the key is provider
 * plumbing that the adapter strips from every description it returns (so it
 * never lands in a local body or a merge baseline), which is exactly why this
 * match cannot be done here over a mapped `TrackerIssue`.
 */
interface ClientKeyRecoverableAdapter {
  findIssueByClientKey(
    scope: {
      containerId: string | null;
      /** What `containerId` names (the selection's narrow kind), or null when only a parent scopes the search. */
      narrowKind: TrackerNarrowKind | null;
      parentExternalId: string | null;
    },
    clientKey: string,
  ): Promise<TrackerIssue | null>;
}

function supportsClientKeyRecovery(
  adapter: TrackerAdapter,
): adapter is TrackerAdapter & ClientKeyRecoverableAdapter {
  const candidate = adapter as Partial<ClientKeyRecoverableAdapter>;
  return typeof candidate.findIssueByClientKey === 'function';
}

/**
 * Match the candidate issues on the row's CLIENT KEY, never on the title: a
 * container routinely holds two issues with the same title, and adopting the
 * wrong one would link the entity to an unrelated issue and point every later
 * write-back at it. Because the adapter stamps the key into every create, "none
 * carries it" means our create never landed and the retry is safe.
 *
 * `scope.parentExternalId` narrows a mirrored sub-issue to one parent's
 * children; a top-level push passes null and searches the container instead.
 * Exactly one of the two is always present, and the ADAPTER decides which it
 * needs: a sub-issue's container is implicit in its parent's external id, which
 * only the adapter may parse (`TrackerIssue.externalId` is adapter-opaque by
 * contract).
 *
 * Throws when the adapter cannot match by client key at all — "cannot look it
 * up" must NOT read as "it isn't there", or the retry would duplicate the
 * issue.
 */
async function findByClientKey(
  adapter: TrackerAdapter,
  connection: TrackerConnectionRow,
  clientKey: string,
  scope: {
    containerId: string | null;
    narrowKind: TrackerNarrowKind | null;
    parentExternalId: string | null;
  },
): Promise<TrackerIssue | null> {
  if (!supportsClientKeyRecovery(adapter)) {
    throw new TrackerApiError(
      connection.provider,
      'adapter has neither idempotent creates nor client-key recovery',
    );
  }
  return await adapter.findIssueByClientKey(scope, clientKey);
}

/**
 * Put a row back in the pending queue, eligible immediately. `lastError`
 * defaults to whatever the row already carried — a requeue is not itself a new
 * failure — and is passed explicitly when the requeue IS the response to one
 * (see {@link pauseConnection}).
 */
function requeue(deps: OutboxDeps, row: TrackerOutboxRow, lastError?: string): void {
  resolveOutbox(deps.db, row.id, 'failed', {
    lastError: lastError ?? row.last_error,
    nextAttemptAtIso: toSqliteUtc(deps.nowIso()),
  });
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * Settle a failed adapter call. Returns true when the DRAIN must stop (auth).
 * Auth failures pause the connection and HOLD the row (see
 * {@link pauseConnection}); other client errors are terminal; everything
 * else — 5xx, 408/429, a network error with no status at all — leaves the
 * outcome UNKNOWN and is re-queued with exponential backoff.
 *
 * `opts.uncertainIsAmbiguous` redirects that last arm for the one write that
 * cannot be repeated blind (a create on a provider without idempotent creates):
 * the row settles as `ambiguous` instead, so the client-key lookup runs before
 * any re-POST. That ordering holds by construction — every pass runs
 * {@link processAmbiguous} ahead of {@link drainOutbox}, and `ambiguous` is not
 * a state {@link claimNextPending} will ever claim, so the row simply cannot be
 * re-sent until the reconcile has spoken. The reconcile pass supplies its own
 * cadence, which is why no backoff is stamped here. It still counts as a
 * scheduled retry in the report: from the queue's side the write is unsettled
 * and headed back to pending if the lookup says the create never landed.
 */
function recordAdapterFailure(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  report: OutboxReport,
  err: unknown,
  opts: { uncertainIsAmbiguous?: boolean } = {},
): boolean {
  if (err instanceof TrackerAuthError) {
    pauseConnection(deps, connection, row, report, err);
    return true;
  }
  if (isTerminalApiError(err)) {
    failTerminal(deps, row, report, describeError(err));
    return false;
  }
  if (opts.uncertainIsAmbiguous) {
    resolveOutbox(deps.db, row.id, 'ambiguous', { lastError: describeError(err) });
    report.retriesScheduled += 1;
    return false;
  }
  // `attempts` was already incremented by claimNextPending, so the first
  // failure waits 2 minutes and the ceiling is MAX_BACKOFF_MINUTES.
  const delay = Math.min(2 ** row.attempts, MAX_BACKOFF_MINUTES);
  resolveOutbox(deps.db, row.id, 'failed', {
    lastError: describeError(err),
    nextAttemptAtIso: addMinutes(deps.nowIso(), delay),
  });
  report.retriesScheduled += 1;
  return false;
}

/**
 * A 4xx that is not a rate limit / timeout will fail identically forever
 * (malformed write, deleted issue, revoked scope) — retrying it just burns the
 * queue, so it settles terminally and surfaces in the connected view's log.
 */
function isTerminalApiError(err: unknown): boolean {
  if (!(err instanceof TrackerApiError)) return false;
  const status = err.status;
  if (status === null) return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

function failTerminal(deps: OutboxDeps, row: TrackerOutboxRow, report: OutboxReport, message: string): void {
  resolveOutbox(deps.db, row.id, 'failed', { lastError: message });
  report.failedTerminal += 1;
}

/**
 * A 401/403: the CREDENTIALS are wrong, the write is not. Pause the connection
 * and HOLD the row — pending, no backoff — so it replays verbatim once the user
 * rotates the key.
 *
 * TERMINALIZING IT INSTEAD LOSES REAL WORK, which is why this is not the
 * ordinary 4xx path it superficially resembles. A revoked or rotated API key is
 * routine, and it rejects EVERY queued write at once: mirrored sub-issue
 * creates, the stage moves recording that a story shipped, a user's explicit
 * "cancel this in Linear". None of those are re-derivable — writeBack only
 * enqueues on the entity EVENT, which is long past — so a terminal failure
 * silently drops the lot, and the tracker stays permanently behind with no
 * indication of what went missing.
 *
 * NO BACKOFF CHURN comes for free from the pause: `next_attempt_at` is cleared
 * (the row is eligible the instant the connection is usable again), and every
 * entry point into a drain — the tick, "Sync now", the debounced write-back
 * nudge — refuses a non-`active` connection, so nothing claims the row in the
 * meantime. The drain also stops here (this returns true), because every
 * remaining row would fail identically.
 */
function pauseConnection(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  report: OutboxReport,
  err: TrackerAuthError,
): void {
  requeue(deps, row, describeError(err));
  updateConnectionSettings(deps.db, connection.id, { status: 'paused' });
  report.retriesScheduled += 1;
  report.authPaused = true;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Baseline + payload helpers
// ---------------------------------------------------------------------------

/**
 * Fetch-once-per-drain provider state list. Every state write in a drain wants
 * the same list, and both providers charge a round trip for it.
 */
class StateCache {
  private states: TrackerState[] | null = null;

  constructor(
    private readonly adapter: TrackerAdapter,
    private readonly connection: TrackerConnectionRow,
  ) {}

  async load(): Promise<TrackerState[]> {
    if (this.states !== null) return this.states;
    const selection = parseSelection(this.connection);
    if (selection === null) {
      // No source selected: nothing can map, so every state write in this
      // drain settles terminally with a clear reason.
      this.states = [];
      return this.states;
    }
    this.states = await this.adapter.listStates(selection);
    return this.states;
  }
}

/**
 * The connection's persisted source selection, or null when it is unset/corrupt.
 *
 * Reads `source_json` — the wizard's Step-1 source choice (container +
 * narrow), the same column inboundSync.parseSourceSelection reads. NOT
 * `selection_json`, which holds the Step-2 TASKS selection payload
 * (assignee/manual id lists) and never carries container/narrow ids.
 *
 * `pushContainerId` matters MOST here: it is what a Dart space group's create
 * is filed against, since the selection's own `containerId` is a space name no
 * issue can be created in. Dropping it would leave the adapter to guess a
 * board.
 */
function parseSelection(connection: TrackerConnectionRow): TrackerSourceSelection | null {
  const parsed = parseJsonObject(connection.source_json);
  const { containerId, narrowId, narrowKind, pushContainerId } = parsed;
  if (typeof containerId !== 'string' || typeof narrowId !== 'string' || typeof narrowKind !== 'string') {
    return null;
  }
  const selection = { containerId, narrowId, narrowKind } as TrackerSourceSelection;
  if (typeof pushContainerId === 'string') selection.pushContainerId = pushContainerId;
  return selection;
}

/** Typed read of a `create_sub_issue` payload, or null when it is unusable. */
function readCreatePayload(row: TrackerOutboxRow): CreateSubIssuePayload | null {
  const parsed = parseJsonObject(row.payload_json);
  const { parentExternalId, title, description } = parsed;
  if (typeof parentExternalId !== 'string' || typeof title !== 'string') return null;
  return {
    parentExternalId,
    title,
    description: typeof description === 'string' ? description : null,
  };
}

/** The last-synced field snapshot the conflict engine three-way-merges against. */
function baselineSnapshot(issue: TrackerIssue): Record<string, unknown> {
  return {
    stateId: issue.stateId,
    title: issue.title,
    description: issue.description,
    updatedAt: issue.updatedAt,
  };
}

/**
 * Stamp our own write onto the link's baseline (ECHO SUPPRESSION): the next
 * inbound pass sees the tracker's state equal to the baseline's and treats it
 * as unchanged instead of a remote edit. The rest of the baseline is preserved
 * — it belongs to the inbound half.
 *
 * A missing link is not an error: `close_parent` targets an issue whose link
 * may live under a different entity, and a first write can race the link's
 * creation. The next inbound pass rebuilds the baseline either way.
 */
function stampWriteBackBaseline(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  externalId: string,
  stateId: string,
  group: WriteBackGroup,
): void {
  const link = getLinkByExternal(deps.db, connection.id, externalId);
  if (!link) return;
  const stamp: WriteBackBaselineStamp = {
    stateId,
    lastWrittenGroup: group,
    lastWrittenAt: toSqliteUtc(deps.nowIso()),
  };
  updateBaseline(deps.db, link.id, JSON.stringify({ ...parseJsonObject(link.baseline_json), ...stamp }));
}
