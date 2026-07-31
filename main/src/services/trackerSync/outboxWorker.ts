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
 *   - Only the ADAPTER CALL is wrapped in try/catch. Anything that throws
 *     AFTER a successful send (a sqlite failure while recording the outcome)
 *     propagates out of the drain with the row still `in_flight`, which is
 *     exactly right: the remote write happened, so the row must NOT be
 *     retried, and boot recovery will reconcile it.
 *   - Every successful state write stamps the written state onto the link's
 *     `baseline_json` (see {@link WriteBackBaselineStamp}), so the inbound
 *     poller diffs our own write to "no change" and never echoes it back.
 *
 * Failure taxonomy:
 *   - TrackerAuthError            -> terminal failure, connection paused, drain STOPS.
 *   - Other 4xx (not 408/429)     -> terminal failure; a malformed/forbidden write
 *                                    will never succeed on retry.
 *   - 5xx / 408 / 429 / network   -> retry, next_attempt_at = now + min(2^attempts, 32) min.
 */
import type Database from 'better-sqlite3';
import type { TrackerConnectionRow, TrackerOutboxRow } from '../../database/models';
import type { TrackerIssue, TrackerSourceSelection, TrackerState } from '../../../../shared/types/trackerSync';
import type { TrackerAdapter } from './adapterTypes';
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
import { pickWriteBackState } from './stateMapping';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface OutboxDeps {
  db: Database.Database;
  /** Build (or reuse) the provider client for a connection — decrypts the stored key. */
  adapterFor(connection: TrackerConnectionRow): TrackerAdapter;
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
  /** Sub-issues created (including ones ADOPTED by ambiguous recovery). */
  created: number;
  /** Rows that will never be retried (auth, 4xx, unresolvable state, malformed payload). */
  failedTerminal: number;
  /** Rows re-queued with a backoff `next_attempt_at`. */
  retriesScheduled: number;
  /** Rows moved OUT of `ambiguous` (adopted as done, or returned to pending). */
  ambiguousResolved: number;
  /** The connection was paused by an auth failure and the drain stopped early. */
  authPaused: boolean;
}

function emptyReport(): OutboxReport {
  return {
    sent: 0,
    created: 0,
    failedTerminal: 0,
    retriesScheduled: 0,
    ambiguousResolved: 0,
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
 * The provider's state list is fetched at most ONCE per drain and shared by
 * every state write in it.
 */
export async function drainOutbox(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
): Promise<OutboxReport> {
  const report = emptyReport();
  const adapter = deps.adapterFor(connection);
  const states = new StateCache(adapter, connection);

  for (;;) {
    const row = claimNextPending(deps.db, connection.id, toSqliteUtc(deps.nowIso()));
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
  return await processStateWrite(deps, connection, adapter, states, row, report);
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
  const desiredGroup = readDesiredGroup(row.payload_json);
  if (desiredGroup === null || row.external_id === null) {
    failTerminal(deps, row, report, 'malformed payload: desiredGroup / external_id missing');
    return false;
  }

  let state: TrackerState | null;
  try {
    state = pickWriteBackState(await states.load(), desiredGroup);
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
    return recordAdapterFailure(deps, connection, row, report, err);
  }

  adoptCreatedIssue(deps, connection, row, issue, payload.parentExternalId);
  report.created += 1;
  return false;
}

/**
 * Record a created (or recovered) sub-issue: link it, snapshot its baseline,
 * settle the outbox row. Post-send bookkeeping — never inside a catch.
 */
function adoptCreatedIssue(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  issue: TrackerIssue,
  parentExternalId: string,
): void {
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
}

// ---------------------------------------------------------------------------
// Ambiguous recovery
// ---------------------------------------------------------------------------

/**
 * What {@link resolveAmbiguous} did with a row:
 *   - `adopted`    — the write HAD landed; the row is done and its issue linked.
 *   - `requeued`   — the write did NOT land; the row is pending again (safe to retry).
 *   - `unresolved` — still unknown (the reconciling lookup itself failed); stays ambiguous.
 *   - `failed`     — unusable row, settled terminally.
 *   - `halted`     — auth failure: the connection is paused and the pass stops.
 */
export type AmbiguousOutcome = 'adopted' | 'requeued' | 'unresolved' | 'failed' | 'halted';

/**
 * Reconcile every `ambiguous` row for a connection — the rows
 * store.requeueInFlightAsAmbiguous produced at boot from writes whose outcome
 * is genuinely unknown. The service calls this BEFORE {@link drainOutbox} so a
 * lost create is adopted rather than repeated.
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
      report.ambiguousResolved += 1;
    } else if (outcome === 'requeued') {
      report.ambiguousResolved += 1;
    } else if (outcome === 'failed') {
      report.failedTerminal += 1;
      report.ambiguousResolved += 1;
    } else if (outcome === 'halted') {
      report.failedTerminal += 1;
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
  if (row.kind !== 'create_sub_issue') {
    requeue(deps, row);
    return 'requeued';
  }

  const payload = readCreatePayload(row);
  if (payload === null || row.entity_id === null || row.client_key === null) {
    resolveOutbox(deps.db, row.id, 'failed', {
      lastError: 'malformed payload: parentExternalId / entity_id / client_key missing',
    });
    return 'failed';
  }

  const adapter = deps.adapterFor(connection);
  const clientKey = row.client_key;
  let found: TrackerIssue | null;
  try {
    found = adapter.capabilities.idempotentCreate
      ? await adapter.getIssue(clientKey)
      : await findByClientKey(adapter, connection, payload, clientKey);
  } catch (err) {
    if (err instanceof TrackerAuthError) {
      resolveOutbox(deps.db, row.id, 'failed', { lastError: describeError(err) });
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

  adoptCreatedIssue(deps, connection, row, found, payload.parentExternalId);
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
  findSubIssueByClientKey(parentExternalId: string, clientKey: string): Promise<TrackerIssue | null>;
}

function supportsClientKeyRecovery(
  adapter: TrackerAdapter,
): adapter is TrackerAdapter & ClientKeyRecoverableAdapter {
  const candidate = adapter as Partial<ClientKeyRecoverableAdapter>;
  return typeof candidate.findSubIssueByClientKey === 'function';
}

/**
 * Match the parent's children on the row's CLIENT KEY, never on the title: a
 * parent routinely holds two children with the same title, and adopting the
 * wrong one would link the task to an unrelated issue and point every later
 * write-back at it. Because the adapter stamps the key into every create, "no
 * child carries it" means our create never landed and the retry is safe.
 *
 * Throws when the adapter cannot match by client key at all — "cannot look it
 * up" must NOT read as "it isn't there", or the retry would duplicate the
 * sub-issue.
 */
async function findByClientKey(
  adapter: TrackerAdapter,
  connection: TrackerConnectionRow,
  payload: CreateSubIssuePayload,
  clientKey: string,
): Promise<TrackerIssue | null> {
  if (!supportsClientKeyRecovery(adapter)) {
    throw new TrackerApiError(
      connection.provider,
      'adapter has neither idempotent creates nor client-key recovery',
    );
  }
  return await adapter.findSubIssueByClientKey(payload.parentExternalId, clientKey);
}

/** Put a row back in the pending queue, eligible immediately. */
function requeue(deps: OutboxDeps, row: TrackerOutboxRow): void {
  resolveOutbox(deps.db, row.id, 'failed', {
    lastError: row.last_error,
    nextAttemptAtIso: toSqliteUtc(deps.nowIso()),
  });
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * Settle a failed adapter call. Returns true when the DRAIN must stop (auth).
 * Auth failures are terminal AND pause the connection; other client errors are
 * terminal; everything else is re-queued with exponential backoff.
 */
function recordAdapterFailure(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  report: OutboxReport,
  err: unknown,
): boolean {
  if (err instanceof TrackerAuthError) {
    pauseConnection(deps, connection, row, report, err);
    return true;
  }
  if (isTerminalApiError(err)) {
    failTerminal(deps, row, report, describeError(err));
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

function pauseConnection(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  report: OutboxReport,
  err: TrackerAuthError,
): void {
  resolveOutbox(deps.db, row.id, 'failed', { lastError: describeError(err) });
  updateConnectionSettings(deps.db, connection.id, { status: 'paused' });
  report.failedTerminal += 1;
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
 */
function parseSelection(connection: TrackerConnectionRow): TrackerSourceSelection | null {
  const parsed = parseJsonObject(connection.source_json);
  const { containerId, narrowId, narrowKind } = parsed;
  if (typeof containerId !== 'string' || typeof narrowId !== 'string' || typeof narrowKind !== 'string') {
    return null;
  }
  return { containerId, narrowId, narrowKind } as TrackerSourceSelection;
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
