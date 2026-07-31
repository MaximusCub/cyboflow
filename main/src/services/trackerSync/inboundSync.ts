/**
 * trackerSync/inboundSync — the INBOUND half of the sync engine (tracker →
 * cyboflow). Design: docs/proposals/tracker-sync-integration.md ("Import &
 * state mapping", "Conflict resolution", "Durability & failure semantics").
 *
 * One pass over one connection:
 *   1. Fetch the provider's states once and compute the effective mapping
 *      (seeded group defaults overlaid by the connection's stored choices).
 *   2. Fetch issues updated at/after `cursor_updated_at - OVERLAP_WINDOW`
 *      (full fetch when there is no cursor yet), sort ascending by the
 *      compound `(updatedAt, externalId)` key, and drop everything at or
 *      before the stored cursor — that is the overlap window's dedup.
 *   3. Apply each issue in order: import an unlinked issue as an IDEA, or
 *      three-way merge a linked one against `baseline_json`.
 *   4. Advance the cursor AFTER EACH applied item.
 *
 * CURSOR SEMANTICS (deliberate deviation from the design doc's wording). The
 * doc describes applying a whole page and the cursor bump in ONE sqlite
 * transaction. That is not reachable here: TaskChangeRouter.applyChange is
 * async and per-project queue-serialized, so it cannot share a raw
 * better-sqlite3 transaction with the cursor write. Instead we process in
 * ascending compound-key order and advance the cursor after each successfully
 * applied item. Combined with the overlap window and the idempotent re-apply
 * (a re-seen issue diffs to nothing against its refreshed baseline), a crash
 * mid-batch replays at most the overlap — the same guarantee the doc's
 * transaction wording intends.
 *
 * ECHO SUPPRESSION, INBOUND SIDE. An issue referenced by an UNRESOLVED outbox
 * row is one of our own in-flight writes. The batch STOPS at it (it is not
 * applied and the cursor is not advanced past it), so a half-created sub-issue
 * can never be re-imported as a fresh idea — the proposal's hard correctness
 * requirement. "Referenced by" is three-way (see {@link collectOutboxBlockers}):
 * the row's `external_id`, its `client_key`, and — where the provider cannot
 * make a create idempotent — the recovery marker the created child carries in
 * its description, which is the ONLY link back to us once the provider mints
 * its own id.
 *
 * That marker arm only fires for an issue THIS pass actually fetched with a
 * description on it, so it is one of two layers: trackerSyncService.runPass
 * additionally DEFERS this whole phase while a non-idempotent create is still
 * unresolved, which covers the fetch shapes where no marker ever surfaces (a
 * slim list payload, a selection the child falls outside of). See that method
 * for why both exist.
 *
 * ECHO SUPPRESSION, OUTBOUND SIDE. The other direction needs its own seam:
 * TaskChangedEvent's `actor` is OPTIONAL and merely advisory (a hand-built
 * broadcast carries none), so writeBack.ts's listener — which runs INLINE on
 * TaskChangeRouter's post-commit emit — cannot lean on it to tell a
 * provider-authored stage move from a local one, and would queue a state write
 * straight back at the issue we just read it from. Its dedupe key is the link
 * baseline's `lastWrittenGroup`, which this module reads as "the canonical
 * group the REMOTE issue is already known to be at": every stage move made in
 * response to a remote state stamps that group FIRST (see
 * {@link stampRemoteGroup}), so the listener recognizes the move as already
 * satisfied. Remote-wins then holds on the state VALUE too — an inbound move to
 * a second completed/cancelled state keeps the provider's own state instead of
 * being overwritten with the group's first one.
 *
 * IMPORT RECOVERY. An import is two writes (create the idea, then write the
 * link) that cannot share a transaction, so a crash between them would leave a
 * durable idea nothing points at — and the next pass, still seeing an unlinked
 * issue behind the cursor, would import it AGAIN. The provenance footer is the
 * recovery key: it carries the issue's `(provider, externalId)` and lands in
 * the SAME write as the idea, so the next pass finds the half-imported idea by
 * its marker and ADOPTS it instead of creating a duplicate. The link is also
 * written immediately after the create (before the stage move) so the window
 * is as narrow as two un-transacted writes allow; a crash inside it costs at
 * most the follow-up placement, which the adopt path repairs.
 *
 * AUTO-MODE AUDIT. Auto mode resolves a both-sides-changed field silently, so
 * the value it discards has to be recoverable somewhere the user actually
 * looks. The resolved `tracker_conflicts` row is not that place — every surface
 * reading conflicts lists OPEN ones — so each override also files a
 * NON-BLOCKING review-queue finding carrying both values, through the optional
 * `reviewRouter` seam. See {@link fileAutoResolutionFinding}.
 *
 * ERRORS. A per-issue failure (a rejected applyChange — active runs, a
 * forbidden stage, a vanished entity) propagates out of runInboundSync. That
 * is intentional: the cursor has not advanced past the failing item, so the
 * next pass replays it. The service layer owns logging/backoff.
 */
import type Database from 'better-sqlite3';
import type { EntityExternalLinkRow, TrackerConnectionRow } from '../../database/models';
import type { TaskChange, TaskFieldChanges } from '../../orchestrator/taskChangeRouter';
import type { ReviewItemCreate } from '../../orchestrator/reviewItemRouter';
import type { TrackerAdapter } from './adapterTypes';
import type {
  TrackerIssue,
  TrackerMappingTarget,
  TrackerProvider,
  TrackerSourceSelection,
  TrackerStateGroup,
  TrackerStateMapping,
} from '../../../../shared/types/trackerSync';
import {
  advanceCursor,
  getLinkByEntity,
  getLinkByExternal,
  hasOpenConflictForLink,
  insertConflict,
  listLinks,
  listUnresolvedOutbox,
  markOrphaned,
  resolveConflict,
  updateBaseline,
  upsertLink,
} from './store';
import {
  mappingTargetToStageId,
  resolveEffectiveMapping,
  resolveStageIds,
  type TrackerStageIds,
} from './stateMapping';
import { isWriteBackGroup, parseJsonObject, type WriteBackGroup } from './writeBack';
import { PROVENANCE_MARKER_PREFIX, provenanceMarker } from './provenance';

// ---------------------------------------------------------------------------
// Dependencies + public shapes
// ---------------------------------------------------------------------------

/**
 * The narrow slice of TaskChangeRouter the inbound pass needs — the entity
 * write chokepoint. Declared structurally (rather than importing the class) so
 * tests can pass a real router without this module depending on its
 * construction, and so nothing here is tempted to reach past applyChange.
 */
export interface EntityWriteRouter {
  applyChange(projectId: number, change: TaskChange): Promise<{ taskId: string }>;
}

/**
 * The narrow slice of ReviewItemRouter this pass needs — the review-inbox write
 * chokepoint, used for the audit record every AUTO override files (see
 * {@link fileAutoResolutionFinding}). Declared structurally for the same reason
 * {@link EntityWriteRouter} is: nothing here should be tempted to reach past
 * applyReviewItem, and a test can hand over a recorder without this module
 * depending on the router's construction.
 */
export interface ReviewFindingRouter {
  applyReviewItem(projectId: number, change: ReviewItemCreate): Promise<{ reviewItemId: string }>;
}

export interface InboundSyncDeps {
  /** Real better-sqlite3 handle; all tracker-table access goes through store.ts. */
  db: Database.Database;
  adapter: TrackerAdapter;
  router: EntityWriteRouter;
  /** Injected clock (ISO-8601) — stamped into conflict payloads. */
  nowIso(): string;
  /**
   * The review-inbox chokepoint an Auto-mode override is audited on. OPTIONAL:
   * a caller that does not wire it simply files nothing, and the already-
   * resolved `tracker_conflicts` row stays the only record — see
   * {@link fileAutoResolutionFinding}.
   */
  reviewRouter?: ReviewFindingRouter;
  /**
   * May this pass move a LINKED entity's stage in response to the remote state?
   * Defaults to true. False is the inbound half of `status_sync_mode = 'manual'`
   * (migration 094): the stage dimension stands down for the pass — no stage
   * apply, no stage conflict — and the change is kept RE-OFFERABLE two ways, so
   * that "manual delays work" never becomes "manual drops it":
   *   - the baseline's `stateId` is PINNED to its old value, so the diff
   *     reproduces on a later pass instead of reading as already-seen;
   *   - the CURSOR stops advancing at that issue, so a later pass still fetches
   *     it at all (see {@link runInboundSync}).
   * Content (title/description) is a different direction and merges normally
   * either way.
   */
  applyLinkedStage?: boolean;
  /**
   * May this pass import a NEW (unlinked) remote issue as an idea? Defaults to
   * true. False is `pull_mode = 'manual'` (migration 094).
   *
   * INDEPENDENT of {@link InboundSyncDeps.applyLinkedStage}, which is why the
   * inbound phase runs whenever EITHER direction is live: a connection that
   * pulls manually but syncs status automatically still needs its linked items
   * merged every pass. A skipped import holds the cursor exactly like a
   * deferred stage does, so the issue is re-offered until a pass may import it.
   *
   * ADOPTION IS NOT AN IMPORT. A half-imported idea from a crashed pass (found
   * by its provenance marker) is REPAIR of an import that already happened, so
   * it proceeds either way — leaving it unrepaired would strand an idea nothing
   * points at.
   */
  importNewIssues?: boolean;
}

/** The last-synced remote snapshot a link three-way-merges against. */
export interface TrackerBaseline {
  title: string;
  description: string | null;
  stateId: string;
  updatedAt: string;
}

/**
 * `tracker_conflicts.payload_json` for a field conflict.
 *
 * A STAGE conflict additionally records the REMOTE side's RAW state, because
 * its `remote_value` is the MAPPED board stage id — enough to apply the remote
 * side, not enough to advance a link's baseline. When the user later accepts
 * the LOCAL side, trackerSyncService reads these two keys back and stamps
 * `stateId` / `lastWrittenGroup`, so the next pass reads the remote as
 * UNCHANGED instead of re-opening the conflict that was just settled. Content
 * fields need nothing extra: their `remote_value` IS the remote value.
 */
export interface TrackerConflictPayload {
  externalId: string;
  mode: 'manual' | 'auto';
  detectedAt: string;
  /** STAGE conflicts only: the provider state id the remote issue was at. */
  remoteStateId?: string;
  /** STAGE conflicts only: that state's write-back group, null when it has none. */
  remoteGroup?: WriteBackGroup | null;
}

/**
 * The remote state a STAGE conflict recorded, or null when the row carries none
 * — a content-field conflict, or a stage row written before this key existed.
 * `group` is null when the remote's state belongs to no write-back group.
 */
export function readConflictRemoteState(
  payloadJson: string | null,
): { stateId: string; group: WriteBackGroup | null } | null {
  const payload = parseJsonObject(payloadJson);
  if (typeof payload.remoteStateId !== 'string' || payload.remoteStateId.length === 0) return null;
  return {
    stateId: payload.remoteStateId,
    group: isWriteBackGroup(payload.remoteGroup) ? payload.remoteGroup : null,
  };
}

/**
 * `tracker_connections.selection_json` — the wizard's Step 2 choice, read here
 * for inbound filtering. Kept main-side for now: no renderer surface consumes
 * it yet, so it does not need to cross IPC (promote it to
 * shared/types/trackerSync.ts when the wizard lands).
 */
export interface TrackerSelectionPayload {
  /** selection_mode 'assignee': only issues assigned to one of these import. */
  assigneeIds?: string[];
  /** selection_mode 'manual': only these external ids import. */
  issueIds?: string[];
}

/** Per-pass counters for the connected view's sync log. */
export interface InboundSyncReport {
  /** Unlinked issues imported as new ideas. */
  imported: number;
  /** Linked entities that received a remote change. */
  updated: number;
  /**
   * Fetched issues deliberately NOT applied: don't-import states, selection
   * filtered out, an open conflict pausing the item, an orphaned link, a
   * locally-deleted entity, or a first-pass baseline seed. Overlap-window
   * replays are dropped BEFORE this loop and are not counted.
   */
  skipped: number;
  /** Manual-mode conflict rows opened for the user this pass. */
  conflictsOpened: number;
  /** Auto-mode overrides recorded as already-resolved conflict rows. */
  autoResolved: number;
  /** Linked entities archived because the remote issue was archived. */
  archivedRemotely: number;
  /**
   * Remote stage changes recognized but NOT applied because the status
   * direction is held ({@link InboundSyncDeps.applyLinkedStage}). Each one also
   * pins the cursor, so they are re-offered until a pass may apply them.
   */
  stageDeferred: number;
  /**
   * NEW remote issues recognized but NOT imported because the import direction
   * is held ({@link InboundSyncDeps.importNewIssues}). Pins the cursor for the
   * same reason: a held import must be delayed, never dropped.
   */
  importDeferred: number;
  /** Filled in by {@link runDeletionSweep} when the service folds its result in. */
  sweepArchived?: number;
  /** External id the batch stopped at because our own write is still in flight. */
  haltedOnOutbox?: string;
}

/** {@link runDeletionSweep}'s counters — folded into an InboundSyncReport by the caller. */
export interface InboundSweepReport {
  /** Links whose remote issue vanished or was archived and were archived locally (Auto mode). */
  sweepArchived: number;
  /** Vanished/archived-issue conflict rows opened for the user (Manual mode). */
  conflictsOpened: number;
  /**
   * Links absent from the scoped id listing whose issue is still ALIVE remotely
   * — moved out of the connection's project/cycle/module. Nothing was done to
   * them; the count exists so the sync log can say so.
   */
  outOfScope: number;
}

/** The connection is not configured well enough to sync (bad/absent source_json). */
export class TrackerSyncConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerSyncConfigError';
  }
}

/**
 * How far BEFORE the stored cursor timestamp the incremental fetch reaches.
 * Covers same-second neighbours and modest provider clock skew; the compound
 * cursor then dedups everything the window re-delivers.
 */
export const OVERLAP_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Provenance footer
// ---------------------------------------------------------------------------

const PROVIDER_LABEL: Record<TrackerProvider, string> = { linear: 'Linear', plane: 'Plane' };

/** The markdown rule the footer block opens with. */
const FOOTER_FENCE = '---\n';
/** The substring that identifies a footer block inside a stored body. */
const FOOTER_START = FOOTER_FENCE + PROVENANCE_MARKER_PREFIX;

/** The provenance block appended to an imported idea's body (issue ref + URL). */
function buildProvenanceFooter(provider: TrackerProvider, issue: TrackerIssue): string {
  const marker = provenanceMarker(provider, issue.externalId);
  return `${marker}\nImported from ${PROVIDER_LABEL[provider]} · [${issue.identifier}](${issue.url})`;
}

/**
 * Split a stored body into the remote-owned description half and the
 * cyboflow-owned provenance footer half. A body with no footer (a
 * pre-existing entity linked through the wizard's Reconcile step) reads back
 * as description-only, and rejoins without one — we never retro-fit a footer
 * onto an entity the user wrote themselves.
 *
 * Exported (with {@link joinBody}) for the service layer's manual
 * conflict-resolution path, which applies a stored `remote_value` description
 * onto an entity and must preserve that entity's footer exactly as this pass
 * would have.
 */
export function splitBody(body: string | null): { description: string | null; footer: string | null } {
  if (body === null) return { description: null, footer: null };
  const at = body.indexOf(FOOTER_START);
  if (at < 0) return { description: body.length > 0 ? body : null, footer: null };
  const description = body.slice(0, at).replace(/\s+$/, '');
  return {
    description: description.length > 0 ? description : null,
    footer: body.slice(at + FOOTER_FENCE.length),
  };
}

/** Inverse of {@link splitBody}. */
export function joinBody(description: string | null, footer: string | null): string | null {
  const desc = description !== null && description.trim().length > 0 ? description : null;
  if (footer === null) return desc;
  const block = `${FOOTER_FENCE}${footer}`;
  return desc === null ? block : `${desc}\n\n${block}`;
}

/** Empty and absent descriptions are the same thing on both sides of a diff. */
function normalizeDescription(value: string | null): string {
  return value === null ? '' : value.trim();
}

// ---------------------------------------------------------------------------
// Compound cursor
// ---------------------------------------------------------------------------

interface CursorKey {
  updatedAt: string;
  externalId: string;
}

/** Epoch ms for an ISO timestamp; 0 when unparseable (falls through to string order). */
function cursorTime(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Order two compound cursor keys. Instant first (so differing ISO offsets /
 * precisions still order correctly), then the raw timestamp string, then the
 * external id — total and deterministic.
 */
function compareCursor(a: CursorKey, b: CursorKey): number {
  const ta = cursorTime(a.updatedAt);
  const tb = cursorTime(b.updatedAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  if (a.externalId === b.externalId) return 0;
  return a.externalId < b.externalId ? -1 : 1;
}

function issueKey(issue: TrackerIssue): CursorKey {
  return { updatedAt: issue.updatedAt, externalId: issue.externalId };
}

/** The `since` bound for listIssues: cursor minus the overlap window, or undefined for a full fetch. */
function computeSince(connection: TrackerConnectionRow): string | undefined {
  const cursor = connection.cursor_updated_at;
  if (cursor === null || cursor.length === 0) return undefined;
  const parsed = Date.parse(cursor);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed - OVERLAP_WINDOW_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Connection JSON blobs
// ---------------------------------------------------------------------------

/** Parse `source_json` into the adapter's source selection. */
function parseSourceSelection(connection: TrackerConnectionRow): TrackerSourceSelection {
  if (connection.source_json === null || connection.source_json.length === 0) {
    throw new TrackerSyncConfigError(`connection ${connection.id} has no source selected`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(connection.source_json);
  } catch {
    throw new TrackerSyncConfigError(`connection ${connection.id} has an unparseable source_json`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new TrackerSyncConfigError(`connection ${connection.id} has a malformed source_json`);
  }
  const candidate = parsed as Partial<TrackerSourceSelection>;
  if (typeof candidate.containerId !== 'string' || typeof candidate.narrowId !== 'string') {
    throw new TrackerSyncConfigError(`connection ${connection.id} source_json is missing container/narrow ids`);
  }
  return {
    containerId: candidate.containerId,
    narrowId: candidate.narrowId,
    narrowKind: candidate.narrowKind ?? 'all',
  };
}

/** Parse `selection_json`; a missing/corrupt blob reads back as an empty selection. */
function parseSelectionPayload(selectionJson: string | null): TrackerSelectionPayload {
  if (selectionJson === null || selectionJson.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(selectionJson);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const candidate = parsed as Record<string, unknown>;
  return {
    assigneeIds: stringArray(candidate.assigneeIds),
    issueIds: stringArray(candidate.issueIds),
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Parse `baseline_json`; null when absent or structurally unusable. */
function parseBaseline(baselineJson: string | null): TrackerBaseline | null {
  if (baselineJson === null || baselineJson.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(baselineJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.title !== 'string' || typeof candidate.stateId !== 'string') return null;
  return {
    title: candidate.title,
    description: typeof candidate.description === 'string' ? candidate.description : null,
    stateId: candidate.stateId,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
  };
}

/** Snapshot an issue's merge-relevant fields for `baseline_json`. */
function snapshotOf(issue: TrackerIssue): TrackerBaseline {
  return {
    title: issue.title,
    description: issue.description,
    stateId: issue.stateId,
    updatedAt: issue.updatedAt,
  };
}

/**
 * Compose what gets written to `baseline_json`: the fresh remote snapshot laid
 * OVER whatever the blob already holds. `baseline_json` is shared with the
 * OUTBOUND half, which stamps its own keys onto it (writeBack.ts's
 * `lastWrittenGroup` / `lastWrittenAt`, its write-back dedupe) — a wholesale
 * replace here would silently drop them and make every inbound pass re-queue a
 * state write we already made. A corrupt/absent blob simply becomes the
 * snapshot.
 */
function composeBaselineJson(existingJson: string | null, snapshot: TrackerBaseline): string {
  let existing: Record<string, unknown> = {};
  if (existingJson !== null && existingJson.length > 0) {
    try {
      const parsed: unknown = JSON.parse(existingJson);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable — the snapshot alone is a better baseline than nothing.
    }
  }
  return JSON.stringify({ ...existing, ...snapshot });
}

// ---------------------------------------------------------------------------
// Local entity reads
// ---------------------------------------------------------------------------

const ENTITY_TABLE: Record<EntityExternalLinkRow['entity_type'], 'ideas' | 'epics' | 'tasks'> = {
  idea: 'ideas',
  epic: 'epics',
  task: 'tasks',
};

interface LocalEntity {
  /** Display ref (IDEA-009 / TASK-014) — what an audit record names the entity by. */
  ref: string;
  title: string;
  body: string | null;
  stageId: string;
}

/**
 * Read the merge-relevant local state of a linked entity. A plain SELECT: the
 * chokepoint rule governs WRITES, and taskListing's projections carry run
 * overlays this pass has no use for.
 */
function readLocalEntity(
  db: Database.Database,
  entityType: EntityExternalLinkRow['entity_type'],
  entityId: string,
): LocalEntity | null {
  const row = db
    .prepare(
      `SELECT ref, title, body, stage_id AS stageId
         FROM ${ENTITY_TABLE[entityType]}
        WHERE id = ?`,
    )
    .get(entityId) as LocalEntity | undefined;
  return row ?? null;
}

/** Escape the LIKE metacharacters in a literal substring (paired with `ESCAPE '\'`). */
function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The half-imported idea an interrupted {@link importIssueAsIdea} left behind,
 * or null. Matches on the provenance marker the create wrote INTO the body (see
 * the module header's IMPORT RECOVERY note) — a plain read-only SELECT, like
 * {@link readLocalEntity}; the chokepoint rule governs WRITES.
 *
 * Two candidates are refused rather than adopted:
 *  - an ARCHIVED idea — a user who archived a half-imported idea should not
 *    have it silently resurrected as this issue's entity;
 *  - an idea that ALREADY carries a link for this provider — it belongs to
 *    another connection, and adopting it would repoint that connection's link.
 */
function findAdoptableIdea(
  db: Database.Database,
  projectId: number,
  provider: TrackerProvider,
  marker: string,
): { id: string; stageId: string } | null {
  const rows = db
    .prepare(
      `SELECT id, stage_id AS stageId
         FROM ideas
        WHERE project_id = ?
          AND archived_at IS NULL
          AND body LIKE ? ESCAPE '\\'
        ORDER BY created_at ASC, id ASC`,
    )
    .all(projectId, `%${escapeLikeLiteral(marker)}%`) as Array<{ id: string; stageId: string }>;
  return rows.find((row) => getLinkByEntity(db, 'idea', row.id, provider) === null) ?? null;
}

// ---------------------------------------------------------------------------
// Per-pass context
// ---------------------------------------------------------------------------

interface SyncContext {
  db: Database.Database;
  router: EntityWriteRouter;
  /** Absent when the caller wired no review-inbox seam — overrides then file nothing. */
  reviewRouter?: ReviewFindingRouter;
  nowIso(): string;
  connection: TrackerConnectionRow;
  stageIds: TrackerStageIds;
  mapping: TrackerStateMapping;
  /** stateId -> the provider state's CANONICAL group (the write-back stamp's input). */
  stateGroups: Record<string, TrackerStateGroup>;
  /** See {@link InboundSyncDeps.applyLinkedStage}. */
  applyLinkedStage: boolean;
  /** See {@link InboundSyncDeps.importNewIssues}. */
  importNewIssues: boolean;
  report: InboundSyncReport;
}

/** The mapping target for an issue's state; an unmapped state never imports. */
function targetFor(ctx: SyncContext, issue: TrackerIssue): TrackerMappingTarget {
  return ctx.mapping[issue.stateId] ?? 'dont';
}

/**
 * The canonical group the remote issue is in, narrowed to the three a local
 * stage can ever demand. Null for triage/backlog/unstarted (no stage writes
 * those back, so there is nothing to suppress) and for a state the provider no
 * longer lists.
 */
function remoteWriteBackGroup(ctx: SyncContext, issue: TrackerIssue): WriteBackGroup | null {
  const group = ctx.stateGroups[issue.stateId];
  return isWriteBackGroup(group) ? group : null;
}

/**
 * Record where the REMOTE issue stands in `baseline_json.lastWrittenGroup` —
 * the key writeBack.ts's inline listener dedupes against (see the module
 * header's OUTBOUND ECHO SUPPRESSION note). Called BEFORE the applyChange that
 * moves a linked entity in response to a remote state, because the listener
 * fires synchronously inside that call: a stamp written afterwards is too late
 * and the echo is already queued.
 *
 * The failure shape is deliberately safe. If the stamp lands and applyChange
 * then fails, the blob claims only that the remote is at that group — which is
 * TRUE, independently of whether we managed to mirror it locally; the next pass
 * replays the move against an unchanged baseline. `lastWrittenAt` is left
 * alone: it timestamps OUR writes, and this is an observation of theirs.
 *
 * A group of null CLEARS the key rather than leaving a stale one behind — once
 * the remote leaves the terminal groups, a later local move to Done/Won't do is
 * a genuine write-back and must not be suppressed.
 *
 * Returns the blob it wrote (or the input, unchanged, when there was nothing to
 * say) so the caller keeps composing on top of it: the in-memory link row goes
 * stale the moment this lands.
 */
function stampRemoteGroup(
  ctx: SyncContext,
  link: EntityExternalLinkRow,
  baselineJson: string | null,
  group: WriteBackGroup | null,
): string | null {
  const blob = parseJsonObject(baselineJson);
  const current = isWriteBackGroup(blob.lastWrittenGroup) ? blob.lastWrittenGroup : null;
  if (current === group) return baselineJson;

  if (group === null) delete blob.lastWrittenGroup;
  else blob.lastWrittenGroup = group;
  const next = JSON.stringify(blob);
  updateBaseline(ctx.db, link.id, next);
  return next;
}

// ---------------------------------------------------------------------------
// runInboundSync
// ---------------------------------------------------------------------------

/**
 * Run ONE inbound pass for a connection. See the module header for the cursor,
 * echo-suppression and error semantics.
 */
export async function runInboundSync(
  deps: InboundSyncDeps,
  connection: TrackerConnectionRow,
): Promise<InboundSyncReport> {
  const { db, adapter, router } = deps;
  const report: InboundSyncReport = {
    imported: 0,
    updated: 0,
    skipped: 0,
    conflictsOpened: 0,
    autoResolved: 0,
    archivedRemotely: 0,
    stageDeferred: 0,
    importDeferred: 0,
  };

  const selection = parseSourceSelection(connection);
  const stageIds = resolveStageIds(db, connection.project_id);
  const states = await adapter.listStates(selection);
  const mapping = resolveEffectiveMapping(states, connection.state_mapping_json);

  const issues = await adapter.listIssues(selection, computeSince(connection));

  // The stored compound high-water mark. Both halves must be present — a
  // half-written cursor is treated as no cursor (replay the whole window).
  const cursor: CursorKey | null =
    connection.cursor_updated_at !== null && connection.cursor_external_id !== null
      ? { updatedAt: connection.cursor_updated_at, externalId: connection.cursor_external_id }
      : null;

  // Ascending compound order, then drop everything the overlap window
  // re-delivered (<= the stored cursor). Those are pure replays, so they are
  // not counted as skips.
  const ordered = [...issues]
    .sort((a, b) => compareCursor(issueKey(a), issueKey(b)))
    .filter((issue) => cursor === null || compareCursor(issueKey(issue), cursor) > 0);

  const blockers = collectOutboxBlockers(db, connection.id);

  const stateGroups: Record<string, TrackerStateGroup> = {};
  for (const state of states) stateGroups[state.id] = state.group;

  const ctx: SyncContext = {
    db,
    router,
    reviewRouter: deps.reviewRouter,
    nowIso: deps.nowIso,
    connection,
    stageIds,
    mapping,
    stateGroups,
    applyLinkedStage: deps.applyLinkedStage !== false,
    importNewIssues: deps.importNewIssues !== false,
    report,
  };

  // The cursor is a high-water mark of "everything at or before this is FULLY
  // applied", so it stops moving the moment this pass DEFERS anything — a stage
  // change or a whole import. Deliberately not a `break`: the rest of the batch
  // still applies, it is just re-delivered next pass, where re-applying it is a
  // no-op against the baselines this pass advanced (see the module header's
  // cursor note). Without this, held work would be filtered out of every later
  // fetch by the very cursor that skipped it — "manual delays work" would
  // quietly become "manual drops it".
  let cursorAdvances = true;
  for (const issue of ordered) {
    // ECHO SUPPRESSION: one of our own writes is still in flight for this
    // issue. Stop the batch here — applying it would race our own create /
    // state write, and advancing past it would let a half-created sub-issue
    // re-import on the next pass.
    if (isBlockedByOutbox(blockers, issue)) {
      report.haltedOnOutbox = issue.externalId;
      break;
    }

    const outcome = await applyIssue(ctx, issue);
    if (outcome !== 'applied') {
      cursorAdvances = false;
      if (outcome === 'stage-deferred') report.stageDeferred++;
      else report.importDeferred++;
    }
    if (cursorAdvances) advanceCursor(db, connection.id, issue.updatedAt, issue.externalId);
  }

  return report;
}

/**
 * What {@link applyIssue} did with one issue, as far as the CURSOR is concerned.
 * Both deferrals mean the issue is NOT finished with — a held direction
 * recognized work and declined to do it — so the cursor must not move past it:
 *   - 'stage-deferred'  — a remote stage change the status direction is holding.
 *   - 'import-deferred' — a new issue the import direction is holding.
 */
type ApplyOutcome = 'applied' | 'stage-deferred' | 'import-deferred';

/** What the unresolved outbox makes untouchable this pass — see {@link collectOutboxBlockers}. */
interface OutboxBlockers {
  /** Matched against a fetched issue's `externalId`. */
  ids: Set<string>;
  /** Matched against a fetched issue's `recoveryClientKey`. */
  clientKeys: Set<string>;
}

/**
 * Everything an unresolved outbox row makes untouchable, in the two shapes a
 * fetched issue can present it in.
 *
 * `ids` — `external_id` (an update-state / close-parent write against a known
 * issue) and `client_key` (a create whose client-generated id BECOMES the
 * external id where the provider supports idempotent creates).
 *
 * `clientKeys` — the same create keys, matched instead against the issue's
 * `recoveryClientKey`. Where creates are NOT idempotent (Plane) the created
 * issue carries a PROVIDER-MINTED id that matches neither column, so the
 * description marker the adapter surfaces is the only proof it is ours; without
 * this arm a create that committed and then lost its response would be imported
 * here as a brand-new idea.
 *
 * KIND-AGNOSTIC by construction, which is what makes it cover the PUSH
 * direction for free: an unacked `create_issue` (an idea we filed as a
 * top-level issue) blocks on exactly the same two columns as an unacked
 * `create_sub_issue`, so the pushed issue is never re-imported as a SECOND idea
 * alongside the one that produced it. The outbox row carries the originating
 * idea's id, so the reconcile that follows links the remote issue back to it.
 *
 * Deliberately reads the whole unresolved set once rather than calling
 * findOutboxByClientKey per issue: that lookup is state-agnostic, so a
 * long-since-'done' create would block its own issue forever.
 */
function collectOutboxBlockers(db: Database.Database, connectionId: string): OutboxBlockers {
  const ids = new Set<string>();
  const clientKeys = new Set<string>();
  for (const row of listUnresolvedOutbox(db, connectionId)) {
    if (row.external_id !== null) ids.add(row.external_id);
    if (row.client_key !== null) {
      ids.add(row.client_key);
      clientKeys.add(row.client_key);
    }
  }
  return { ids, clientKeys };
}

/** True when one of OUR writes is still in flight for this issue (either shape). */
function isBlockedByOutbox(blockers: OutboxBlockers, issue: TrackerIssue): boolean {
  if (blockers.ids.has(issue.externalId)) return true;
  return issue.recoveryClientKey !== null && blockers.clientKeys.has(issue.recoveryClientKey);
}

/** Apply a single fetched issue. Never advances the cursor — the caller does. */
async function applyIssue(ctx: SyncContext, issue: TrackerIssue): Promise<ApplyOutcome> {
  const { db, connection, report } = ctx;
  const link = getLinkByExternal(db, connection.id, issue.externalId);

  if (link === null) {
    // An archived remote issue never seeds a NEW local idea — importing
    // something the tracker already retired is pure noise.
    if (issue.archivedAt !== null) {
      report.skipped++;
      return 'applied';
    }
    const target = targetFor(ctx, issue);
    if (target === 'dont') {
      report.skipped++;
      return 'applied';
    }
    if (!passesSelectionFilter(connection, issue)) {
      report.skipped++;
      return 'applied';
    }
    // A half-imported idea from a crashed pass is REPAIR of an import that
    // already happened, not a new one — so it proceeds even while the import
    // direction is held. Resolved HERE rather than inside importIssueAsIdea so
    // the gate below can tell the two apart.
    const adoptable = findAdoptableIdea(
      db,
      connection.project_id,
      connection.provider,
      provenanceMarker(connection.provider, issue.externalId),
    );
    if (!ctx.importNewIssues && adoptable === null) {
      // Deferred, NOT skipped: the cursor holds so this issue is re-offered
      // until a pass may import it.
      return 'import-deferred';
    }
    await importIssueAsIdea(ctx, issue, target, adoptable);
    return 'applied';
  }

  // Manual mode parks a conflicting item until the user decides; everything
  // else keeps flowing past it.
  if (hasOpenConflictForLink(db, link.id)) {
    report.skipped++;
    return 'applied';
  }

  // An orphaned link already had its remote deletion/archive applied. Leaving
  // it alone keeps repeated passes from re-archiving (and re-recording) it;
  // resurrecting a link whose issue came back is a user decision.
  if (link.orphaned_at !== null) {
    report.skipped++;
    return 'applied';
  }

  const local = readLocalEntity(db, link.entity_type, link.entity_id);
  if (local === null) {
    // The local entity was hard-deleted out from under the link. Outbound owns
    // the "what happens to the tracker issue" prompt; inbound just stands down.
    report.skipped++;
    return 'applied';
  }

  if (issue.archivedAt !== null) {
    await applyRemoteArchive(ctx, issue, link);
    return 'applied';
  }

  const baseline = parseBaseline(link.baseline_json);
  if (baseline === null) {
    // No usable baseline yet — a link written without one (the Reconcile path),
    // or one carrying only the outbound half's write-back stamp. Adopt the
    // current remote snapshot and apply nothing: the least destructive way to
    // become mergeable from the next change on.
    updateBaseline(db, link.id, composeBaselineJson(link.baseline_json, snapshotOf(issue)));
    report.skipped++;
    return 'applied';
  }

  return await mergeLinkedIssue(ctx, issue, link, local, baseline);
}

/** selection_mode gate — applied only to issues that would import as NEW ideas. */
function passesSelectionFilter(connection: TrackerConnectionRow, issue: TrackerIssue): boolean {
  if (connection.selection_mode === 'all') return true;
  const payload = parseSelectionPayload(connection.selection_json);
  if (connection.selection_mode === 'assignee') {
    const assigneeIds = payload.assigneeIds ?? [];
    return issue.assignee !== null && assigneeIds.includes(issue.assignee.id);
  }
  return (payload.issueIds ?? []).includes(issue.externalId);
}

/**
 * Import an orphaned tracker item as an IDEA (v1's ideas-by-default rule; the
 * agent-driven smart import is V2). The body carries the remote description
 * plus a provenance footer, and the mapped stage is applied as a follow-up
 * move so the import reads as "created, then placed" in the entity event log.
 *
 * CRASH-IDEMPOTENT (module header, IMPORT RECOVERY). The three writes cannot
 * share a transaction, so the order is chosen to make every interruption
 * recoverable: create (which durably stamps the recovery marker into the body),
 * then the link, then the placement. A crash after the create is repaired on
 * the next pass by adopting the marked idea instead of creating a second one;
 * a crash after the link leaves an ordinary linked entity the merge path owns.
 *
 * `adopted` is that half-imported idea, resolved by the CALLER (applyIssue) —
 * which needs the same answer to tell a genuine new import from a repair when
 * the import direction is held.
 */
async function importIssueAsIdea(
  ctx: SyncContext,
  issue: TrackerIssue,
  target: TrackerMappingTarget,
  adopted: { id: string; stageId: string } | null,
): Promise<void> {
  const { db, connection, report } = ctx;

  let entityId: string;
  if (adopted !== null) {
    entityId = adopted.id;
  } else {
    const body = joinBody(issue.description, buildProvenanceFooter(connection.provider, issue));
    const created = await ctx.router.applyChange(connection.project_id, {
      actor: connection.provider,
      entityType: 'idea',
      fields: { title: issue.title, body },
    });
    entityId = created.taskId;
  }

  // The link goes in IMMEDIATELY after the create: it is what stops the issue
  // from being re-imported at all, so the marker-based recovery above only ever
  // has to cover the gap between these two statements. Its baseline is seeded
  // WITH the remote-group stamp, because the placement below is the first event
  // the write-back listener can see for this entity — an issue imported
  // straight onto Done/Won't do would otherwise echo its own state back.
  const group = remoteWriteBackGroup(ctx, issue);
  const snapshot = snapshotOf(issue);
  upsertLink(db, {
    connection_id: connection.id,
    entity_type: 'idea',
    entity_id: entityId,
    provider: connection.provider,
    external_id: issue.externalId,
    external_identifier: issue.identifier,
    external_url: issue.url,
    external_parent_id: issue.parentExternalId,
    baseline_json: JSON.stringify(group === null ? snapshot : { ...snapshot, lastWrittenGroup: group }),
  });

  // A fresh idea lands in the board's Idea column, so a target that already
  // matches files no move. On the adopt path the comparison is against the
  // idea's CURRENT stage, which is how a placement the crash skipped gets made.
  const stageBefore = adopted?.stageId ?? ctx.stageIds.idea;
  const stageId = mappingTargetToStageId(target, ctx.stageIds);
  if (stageId !== null && stageId !== stageBefore) {
    await ctx.router.applyChange(connection.project_id, {
      actor: connection.provider,
      entityType: 'idea',
      taskId: entityId,
      stageId,
    });
  }

  report.imported++;
}

/** One field's three-way verdict, carried from the diff into the per-mode apply. */
interface FieldConflict {
  field: 'title' | 'description' | 'stage';
  localValue: string | null;
  remoteValue: string | null;
}

/**
 * Compose a field conflict's `payload_json`. See {@link TrackerConflictPayload}
 * for why a STAGE row carries the remote's raw state on top of the common keys.
 */
function conflictPayloadJson(
  ctx: SyncContext,
  issue: TrackerIssue,
  conflict: FieldConflict,
  mode: 'manual' | 'auto',
): string {
  const payload: TrackerConflictPayload = {
    externalId: issue.externalId,
    mode,
    detectedAt: ctx.nowIso(),
  };
  if (conflict.field === 'stage') {
    payload.remoteStateId = issue.stateId;
    payload.remoteGroup = remoteWriteBackGroup(ctx, issue);
  }
  return JSON.stringify(payload);
}

/**
 * THREE-WAY MERGE of a linked issue against its baseline, per field
 * (title, description, remote state → local stage).
 *
 *  - remote changed only  → apply the remote value locally
 *  - local changed only   → leave it (outbound owns pushing it back)
 *  - both changed to the same value → converged, nothing to do
 *  - both changed, differently → a conflict, resolved per the connection's mode
 *
 * Auto mode: content fields (title/description) take the REMOTE value, stage
 * keeps the LOCAL one, and every override is recorded as an already-resolved
 * conflict row so the log can show what was overridden.
 *
 * Manual mode: an OPEN conflict row per conflicting field, NOTHING applied for
 * this issue, and the baseline deliberately left where it was — so the next
 * pass sees the same conflict and (via hasOpenConflictForLink) skips the item
 * until the user resolves it.
 */
async function mergeLinkedIssue(
  ctx: SyncContext,
  issue: TrackerIssue,
  link: EntityExternalLinkRow,
  local: LocalEntity,
  baseline: TrackerBaseline,
): Promise<ApplyOutcome> {
  const { db, connection, report } = ctx;
  const localBody = splitBody(local.body);
  // Tracks the link's baseline blob across the echo-suppression stamp below,
  // which writes it BEFORE applyChange and so leaves `link` stale.
  let baselineJson = link.baseline_json;

  const fields: TaskFieldChanges = {};
  let stageMove: string | undefined;
  const conflicts: FieldConflict[] = [];

  // ----- title -----
  const remoteTitleChanged = issue.title !== baseline.title;
  const localTitleChanged = local.title !== baseline.title;
  if (remoteTitleChanged && issue.title !== local.title) {
    if (localTitleChanged) {
      conflicts.push({ field: 'title', localValue: local.title, remoteValue: issue.title });
    } else {
      fields.title = issue.title;
    }
  }

  // ----- description (the remote-owned half of the body) -----
  const remoteDescription = normalizeDescription(issue.description);
  const baselineDescription = normalizeDescription(baseline.description);
  const localDescription = normalizeDescription(localBody.description);
  const remoteDescChanged = remoteDescription !== baselineDescription;
  const localDescChanged = localDescription !== baselineDescription;
  if (remoteDescChanged && remoteDescription !== localDescription) {
    if (localDescChanged) {
      conflicts.push({
        field: 'description',
        localValue: localBody.description,
        remoteValue: issue.description,
      });
    } else {
      fields.body = joinBody(issue.description, localBody.footer);
    }
  }

  // ----- stage (remote state, mapped) -----
  // A state mapped to 'dont' yields a null stage: we cannot say where it should
  // sit, so it neither moves the entity nor counts as a local divergence.
  const baselineStageId = mappingTargetToStageId(ctx.mapping[baseline.stateId] ?? 'dont', ctx.stageIds);
  const remoteStageId = mappingTargetToStageId(targetFor(ctx, issue), ctx.stageIds);
  const remoteStageChanged = remoteStageId !== null && remoteStageId !== baselineStageId;
  const localStageChanged = baselineStageId !== null && local.stageId !== baselineStageId;
  /** The status direction is held and this issue HAS a stage change waiting. */
  let stageDeferred = false;
  if (remoteStageChanged && remoteStageId !== local.stageId) {
    if (!ctx.applyLinkedStage) {
      // HELD: no move, and no conflict either — a conflict row would demand a
      // ruling on a dimension the user has asked us not to sync yet, and (in
      // Manual conflict mode) would park the whole item, stopping the content
      // merge that is still supposed to flow. The diff is still COMPUTED, since
      // knowing a change is waiting is what pins the cursor.
      stageDeferred = true;
    } else if (localStageChanged) {
      conflicts.push({ field: 'stage', localValue: local.stageId, remoteValue: remoteStageId });
    } else {
      stageMove = remoteStageId;
    }
  }

  if (conflicts.length > 0 && connection.conflict_mode === 'manual') {
    for (const conflict of conflicts) {
      insertConflict(db, {
        connection_id: connection.id,
        link_id: link.id,
        kind: 'field_conflict',
        field: conflict.field,
        local_value: conflict.localValue,
        remote_value: conflict.remoteValue,
        payload_json: conflictPayloadJson(ctx, issue, conflict, 'manual'),
      });
      report.conflictsOpened++;
    }
    // Nothing applied, baseline untouched — the item is parked.
    return stageDeferred ? 'stage-deferred' : 'applied';
  }

  // Auto mode: tracker wins content, cyboflow wins stage. Record each override
  // as an already-resolved conflict row before applying it.
  for (const conflict of conflicts) {
    const remoteWins = conflict.field !== 'stage';
    if (remoteWins) {
      if (conflict.field === 'title') fields.title = issue.title;
      else fields.body = joinBody(issue.description, localBody.footer);
    }
    await recordAutoResolution(
      ctx,
      link,
      local,
      issue,
      conflict,
      remoteWins ? 'auto-remote' : 'auto-local',
    );
  }

  if (Object.keys(fields).length > 0 || stageMove !== undefined) {
    // The stage move is ours to mirror, not to announce back — stamp where the
    // remote stands before the write-back listener sees the event.
    if (stageMove !== undefined) {
      baselineJson = stampRemoteGroup(ctx, link, baselineJson, remoteWriteBackGroup(ctx, issue));
    }
    await ctx.router.applyChange(connection.project_id, {
      actor: connection.provider,
      entityType: link.entity_type,
      taskId: link.entity_id,
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      ...(stageMove !== undefined ? { stageId: stageMove } : {}),
    });
    report.updated++;
  }

  // The STATE half of the snapshot is pinned to the old baseline when the stage
  // dimension is held, so the remote move stays "unseen" and applies on the
  // first pass allowed to apply it. Everything else advances: the content merge
  // ran, and re-offering a title we already merged would re-open its conflict
  // forever. Field-by-field rather than skipping the write, because
  // `composeBaselineJson` is a whole-snapshot overlay and letting `stateId`
  // ride along on a content update is exactly the cross-field clobber that has
  // bitten this function before.
  const snapshot = snapshotOf(issue);
  if (!ctx.applyLinkedStage) snapshot.stateId = baseline.stateId;
  updateBaseline(db, link.id, composeBaselineJson(baselineJson, snapshot));
  return stageDeferred ? 'stage-deferred' : 'applied';
}

/**
 * Record an Auto-mode override, in BOTH places it has to exist: an immediately-
 * resolved `tracker_conflicts` row (the engine's own history) and a non-blocking
 * review-queue finding (the user-facing audit record).
 */
async function recordAutoResolution(
  ctx: SyncContext,
  link: EntityExternalLinkRow,
  local: LocalEntity,
  issue: TrackerIssue,
  conflict: FieldConflict,
  resolution: 'auto-remote' | 'auto-local',
): Promise<void> {
  const row = insertConflict(ctx.db, {
    connection_id: ctx.connection.id,
    link_id: link.id,
    kind: 'field_conflict',
    field: conflict.field,
    local_value: conflict.localValue,
    remote_value: conflict.remoteValue,
    payload_json: conflictPayloadJson(ctx, issue, conflict, 'auto'),
  });
  resolveConflict(ctx.db, row.id, resolution);
  ctx.report.autoResolved++;
  await fileAutoResolutionFinding(ctx, link, local, issue, conflict, resolution);
}

/**
 * The design doc's REQUIRED audit record for an Auto-mode override: "Every
 * auto-resolution that overrode a change files a non-blocking review-queue
 * finding for spot-checking" (Conflict resolution → Auto).
 *
 * WHY THE CONFLICT ROW IS NOT ENOUGH. It is written already-RESOLVED, and every
 * surface that reads conflicts — the facade's `conflicts()`, the connected view —
 * lists OPEN ones. So on the default (Auto) mode a title or description the
 * tracker overwrote was recorded in a table no product surface reads: the user
 * could neither notice the override nor recover what it replaced. The finding
 * carries BOTH values, which is what makes the overwritten one restorable by
 * reading it.
 *
 * ALWAYS NON-BLOCKING. This is a spot-check, not a gate; nothing about a merge
 * that already happened should park a run or demand an answer.
 *
 * FAIL-SOFT, BOTH WAYS. With no `reviewRouter` wired (a unit test driving the
 * merge in isolation) nothing is filed at all, and a router that throws is
 * swallowed: the override has already been applied and its conflict row is
 * already durable, so failing the pass here would only replay the whole merge
 * next interval — and re-file the same audit record — for no gain. The conflict
 * row remains the fallback record in both cases.
 */
async function fileAutoResolutionFinding(
  ctx: SyncContext,
  link: EntityExternalLinkRow,
  local: LocalEntity,
  issue: TrackerIssue,
  conflict: FieldConflict,
  resolution: 'auto-remote' | 'auto-local',
): Promise<void> {
  const router = ctx.reviewRouter;
  if (router === undefined) return;
  const { connection } = ctx;
  try {
    await router.applyReviewItem(connection.project_id, {
      op: 'create',
      // The provider is the actor, exactly as on the applyChange this override
      // rides in on: the value landing locally is the tracker's, whoever's poll
      // happened to carry it.
      actor: connection.provider,
      kind: 'finding',
      title: `Tracker sync auto-resolved a conflict on ${local.ref}`,
      body: autoResolutionBody(connection.provider, local, issue, conflict, resolution),
      blocking: false,
      severity: 'info',
      source: `tracker:${connection.provider}`,
      entityType: link.entity_type,
      entityId: link.entity_id,
      payload: { kind: 'finding', category: 'tracker-sync' },
    });
  } catch {
    // Deliberately swallowed — see the fail-soft note above.
  }
}

/**
 * The finding's body: which entity, which field, BOTH values, which side won
 * and why, and the issue it came from. Written for a human skimming the review
 * queue days later, so the losing value is spelled out rather than referenced.
 */
function autoResolutionBody(
  provider: TrackerProvider,
  local: LocalEntity,
  issue: TrackerIssue,
  conflict: FieldConflict,
  resolution: 'auto-remote' | 'auto-local',
): string {
  const label = PROVIDER_LABEL[provider];
  const remoteWon = resolution === 'auto-remote';
  return [
    `**${local.ref} — ${local.title}**`,
    '',
    `Both sides changed \`${conflict.field}\` since the last sync, and Auto mode resolved it:`,
    remoteWon
      ? `the **tracker** value won (Auto mode gives content fields to the tracker).`
      : `the **cyboflow** value won (Auto mode gives stage/status to cyboflow).`,
    '',
    `- cyboflow — ${remoteWon ? 'OVERWRITTEN' : 'kept'}: ${renderConflictValue(conflict.localValue)}`,
    `- ${label} — ${remoteWon ? 'applied' : 'NOT applied'}: ${renderConflictValue(conflict.remoteValue)}`,
    '',
    `Issue: [${issue.identifier}](${issue.url}) · ${label} \`${issue.externalId}\``,
  ].join('\n');
}

/**
 * One side's value in the finding body. A multi-line value (a description) goes
 * in a fenced block so it survives markdown intact; an absent or blank one reads
 * as "(empty)" rather than as a stray pair of backticks.
 */
function renderConflictValue(value: string | null): string {
  if (value === null || value.trim().length === 0) return '_(empty)_';
  return value.includes('\n') ? `\n\n\`\`\`\n${value}\n\`\`\`\n` : `\`${value}\``;
}

/**
 * The remote issue was ARCHIVED (Linear `archivedAt` / trash). Auto mode
 * archives the linked entity in place and orphans the link; Manual mode files
 * an open `remote_deleted` conflict so the user chooses keep-local vs archive.
 * We never hard-delete locally.
 */
async function applyRemoteArchive(
  ctx: SyncContext,
  issue: TrackerIssue,
  link: EntityExternalLinkRow,
): Promise<void> {
  const { db, connection, report } = ctx;
  const payload = JSON.stringify({
    externalId: issue.externalId,
    identifier: issue.identifier,
    reason: 'archived',
    archivedAt: issue.archivedAt,
    detectedAt: ctx.nowIso(),
  });

  if (connection.conflict_mode === 'manual') {
    insertConflict(db, {
      connection_id: connection.id,
      link_id: link.id,
      kind: 'remote_deleted',
      payload_json: payload,
    });
    report.conflictsOpened++;
    return;
  }

  await ctx.router.applyChange(connection.project_id, {
    actor: connection.provider,
    entityType: link.entity_type,
    taskId: link.entity_id,
    archived: true,
  });
  markOrphaned(db, link.id);
  const row = insertConflict(db, {
    connection_id: connection.id,
    link_id: link.id,
    kind: 'remote_deleted',
    payload_json: payload,
  });
  resolveConflict(db, row.id, 'auto-archived');
  report.archivedRemotely++;
}

// ---------------------------------------------------------------------------
// Deletion sweep
// ---------------------------------------------------------------------------

/**
 * Reconciliation sweep for remote HARD deletes (proposal, "Durability &
 * failure semantics" #3). The incremental path only ever sees issues that
 * still exist, so a deleted issue is invisible to it; this compares the
 * provider's full id set for the connection's source against the connection's
 * ACTIVE links.
 *
 * ABSENCE IS NOT DELETION. `listIssueIds` is SCOPED to the connection's
 * configured project/cycle/module, so an issue moved out of that scope — an
 * everyday tracker reorganization — is just as absent as a deleted one. Every
 * absent id therefore gets a selection-INDEPENDENT point lookup
 * ({@link TrackerAdapter.getIssue}) before anything is done to the entity:
 * null means genuinely gone, an `archivedAt` stamp means remotely archived,
 * and a live issue means out of scope — left linked, syncable and untouched,
 * counted only so the log can mention it. A lookup that THROWS (transport /
 * auth) aborts the sweep rather than guessing: nothing has been done to that
 * link yet, so the next sweep simply retries it.
 *
 * For the two real cases: Auto mode archives the local entity in place and
 * orphans the link; Manual mode opens a `remote_deleted` conflict. A link that
 * already has an open conflict is left alone so repeated sweeps do not pile up
 * duplicate rows.
 *
 * Exported separately from {@link runInboundSync}: it costs a full id listing,
 * so the service layer decides the cadence (every Nth poll, and every manual
 * "Sync now").
 */
export async function runDeletionSweep(
  deps: InboundSyncDeps,
  connection: TrackerConnectionRow,
): Promise<InboundSweepReport> {
  const { db, adapter, router } = deps;
  const sweep: InboundSweepReport = { sweepArchived: 0, conflictsOpened: 0, outOfScope: 0 };

  const selection = parseSourceSelection(connection);
  const remoteIds = new Set(await adapter.listIssueIds(selection));

  for (const link of listLinks(db, connection.id, { activeOnly: true })) {
    if (remoteIds.has(link.external_id)) continue;
    if (hasOpenConflictForLink(db, link.id)) continue;

    // Absent from the scoped listing — confirm what that actually means before
    // touching anything (see the "ABSENCE IS NOT DELETION" note above).
    const remote = await adapter.getIssue(link.external_id);
    if (remote !== null && remote.archivedAt === null) {
      sweep.outOfScope++;
      continue;
    }

    const payload = JSON.stringify({
      externalId: link.external_id,
      identifier: link.external_identifier,
      reason: remote === null ? 'deleted' : 'archived',
      archivedAt: remote?.archivedAt ?? null,
      detectedAt: deps.nowIso(),
    });

    if (connection.conflict_mode === 'manual') {
      insertConflict(db, {
        connection_id: connection.id,
        link_id: link.id,
        kind: 'remote_deleted',
        payload_json: payload,
      });
      sweep.conflictsOpened++;
      continue;
    }

    await router.applyChange(connection.project_id, {
      actor: connection.provider,
      entityType: link.entity_type,
      taskId: link.entity_id,
      archived: true,
    });
    markOrphaned(db, link.id);
    const row = insertConflict(db, {
      connection_id: connection.id,
      link_id: link.id,
      kind: 'remote_deleted',
      payload_json: payload,
    });
    resolveConflict(db, row.id, 'auto-archived');
    sweep.sweepArchived++;
  }

  return sweep;
}
