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
 * ECHO SUPPRESSION. An issue referenced by an UNRESOLVED outbox row is one of
 * our own in-flight writes. The batch STOPS at it (it is not applied and the
 * cursor is not advanced past it), so a half-created sub-issue can never be
 * re-imported as a fresh idea — the proposal's hard correctness requirement.
 *
 * ERRORS. A per-issue failure (a rejected applyChange — active runs, a
 * forbidden stage, a vanished entity) propagates out of runInboundSync. That
 * is intentional: the cursor has not advanced past the failing item, so the
 * next pass replays it. The service layer owns logging/backoff.
 */
import type Database from 'better-sqlite3';
import type { EntityExternalLinkRow, TrackerConnectionRow } from '../../database/models';
import type { TaskChange, TaskFieldChanges } from '../../orchestrator/taskChangeRouter';
import type { TrackerAdapter } from './adapterTypes';
import type {
  TrackerIssue,
  TrackerMappingTarget,
  TrackerProvider,
  TrackerSourceSelection,
  TrackerStateMapping,
} from '../../../../shared/types/trackerSync';
import {
  advanceCursor,
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

export interface InboundSyncDeps {
  /** Real better-sqlite3 handle; all tracker-table access goes through store.ts. */
  db: Database.Database;
  adapter: TrackerAdapter;
  router: EntityWriteRouter;
  /** Injected clock (ISO-8601) — stamped into conflict payloads. */
  nowIso(): string;
}

/** The last-synced remote snapshot a link three-way-merges against. */
export interface TrackerBaseline {
  title: string;
  description: string | null;
  stateId: string;
  updatedAt: string;
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
  /** Filled in by {@link runDeletionSweep} when the service folds its result in. */
  sweepArchived?: number;
  /** External id the batch stopped at because our own write is still in flight. */
  haltedOnOutbox?: string;
}

/** {@link runDeletionSweep}'s counters — folded into an InboundSyncReport by the caller. */
export interface InboundSweepReport {
  /** Links whose remote issue vanished and were archived locally (Auto mode). */
  sweepArchived: number;
  /** Vanished-issue conflict rows opened for the user (Manual mode). */
  conflictsOpened: number;
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

/** Machine-recognizable marker so the footer can be split back off a body. */
const PROVENANCE_MARKER = '<!-- cyboflow:tracker -->';
/** The markdown rule the footer block opens with. */
const FOOTER_FENCE = '---\n';
/** The exact substring that identifies a footer block inside a stored body. */
const FOOTER_START = FOOTER_FENCE + PROVENANCE_MARKER;

/** The provenance block appended to an imported idea's body (issue ref + URL). */
function buildProvenanceFooter(provider: TrackerProvider, issue: TrackerIssue): string {
  return `${PROVENANCE_MARKER}\nImported from ${PROVIDER_LABEL[provider]} · [${issue.identifier}](${issue.url})`;
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
      `SELECT title, body, stage_id AS stageId
         FROM ${ENTITY_TABLE[entityType]}
        WHERE id = ?`,
    )
    .get(entityId) as { title: string; body: string | null; stageId: string } | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Per-pass context
// ---------------------------------------------------------------------------

interface SyncContext {
  db: Database.Database;
  router: EntityWriteRouter;
  nowIso(): string;
  connection: TrackerConnectionRow;
  stageIds: TrackerStageIds;
  mapping: TrackerStateMapping;
  report: InboundSyncReport;
}

/** The mapping target for an issue's state; an unmapped state never imports. */
function targetFor(ctx: SyncContext, issue: TrackerIssue): TrackerMappingTarget {
  return ctx.mapping[issue.stateId] ?? 'dont';
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

  const blocked = collectBlockedExternalIds(db, connection.id);

  const ctx: SyncContext = {
    db,
    router,
    nowIso: deps.nowIso,
    connection,
    stageIds,
    mapping,
    report,
  };

  for (const issue of ordered) {
    // ECHO SUPPRESSION: one of our own writes is still in flight for this
    // issue. Stop the batch here — applying it would race our own create /
    // state write, and advancing past it would let a half-created sub-issue
    // re-import on the next pass.
    if (blocked.has(issue.externalId)) {
      report.haltedOnOutbox = issue.externalId;
      break;
    }

    await applyIssue(ctx, issue);
    advanceCursor(db, connection.id, issue.updatedAt, issue.externalId);
  }

  return report;
}

/**
 * External ids an unresolved outbox row refers to. Both `external_id` (an
 * update-state / close-parent write against a known issue) and `client_key`
 * (a create whose client-generated id BECOMES the external id where the
 * provider supports idempotent creates) count.
 *
 * Deliberately reads the whole unresolved set once rather than calling
 * findOutboxByClientKey per issue: that lookup is state-agnostic, so a
 * long-since-'done' create would block its own issue forever.
 */
function collectBlockedExternalIds(db: Database.Database, connectionId: string): Set<string> {
  const blocked = new Set<string>();
  for (const row of listUnresolvedOutbox(db, connectionId)) {
    if (row.external_id !== null) blocked.add(row.external_id);
    if (row.client_key !== null) blocked.add(row.client_key);
  }
  return blocked;
}

/** Apply a single fetched issue. Never advances the cursor — the caller does. */
async function applyIssue(ctx: SyncContext, issue: TrackerIssue): Promise<void> {
  const { db, connection, report } = ctx;
  const link = getLinkByExternal(db, connection.id, issue.externalId);

  if (link === null) {
    // An archived remote issue never seeds a NEW local idea — importing
    // something the tracker already retired is pure noise.
    if (issue.archivedAt !== null) {
      report.skipped++;
      return;
    }
    const target = targetFor(ctx, issue);
    if (target === 'dont') {
      report.skipped++;
      return;
    }
    if (!passesSelectionFilter(connection, issue)) {
      report.skipped++;
      return;
    }
    await importIssueAsIdea(ctx, issue, target);
    return;
  }

  // Manual mode parks a conflicting item until the user decides; everything
  // else keeps flowing past it.
  if (hasOpenConflictForLink(db, link.id)) {
    report.skipped++;
    return;
  }

  // An orphaned link already had its remote deletion/archive applied. Leaving
  // it alone keeps repeated passes from re-archiving (and re-recording) it;
  // resurrecting a link whose issue came back is a user decision.
  if (link.orphaned_at !== null) {
    report.skipped++;
    return;
  }

  const local = readLocalEntity(db, link.entity_type, link.entity_id);
  if (local === null) {
    // The local entity was hard-deleted out from under the link. Outbound owns
    // the "what happens to the tracker issue" prompt; inbound just stands down.
    report.skipped++;
    return;
  }

  if (issue.archivedAt !== null) {
    await applyRemoteArchive(ctx, issue, link);
    return;
  }

  const baseline = parseBaseline(link.baseline_json);
  if (baseline === null) {
    // No usable baseline yet — a link written without one (the Reconcile path),
    // or one carrying only the outbound half's write-back stamp. Adopt the
    // current remote snapshot and apply nothing: the least destructive way to
    // become mergeable from the next change on.
    updateBaseline(db, link.id, composeBaselineJson(link.baseline_json, snapshotOf(issue)));
    report.skipped++;
    return;
  }

  await mergeLinkedIssue(ctx, issue, link, local, baseline);
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
 */
async function importIssueAsIdea(
  ctx: SyncContext,
  issue: TrackerIssue,
  target: TrackerMappingTarget,
): Promise<void> {
  const { db, connection, report } = ctx;
  const body = joinBody(issue.description, buildProvenanceFooter(connection.provider, issue));

  const created = await ctx.router.applyChange(connection.project_id, {
    actor: connection.provider,
    entityType: 'idea',
    fields: { title: issue.title, body },
  });

  const stageId = mappingTargetToStageId(target, ctx.stageIds);
  if (stageId !== null && target !== 'idea') {
    await ctx.router.applyChange(connection.project_id, {
      actor: connection.provider,
      entityType: 'idea',
      taskId: created.taskId,
      stageId,
    });
  }

  upsertLink(db, {
    connection_id: connection.id,
    entity_type: 'idea',
    entity_id: created.taskId,
    provider: connection.provider,
    external_id: issue.externalId,
    external_identifier: issue.identifier,
    external_url: issue.url,
    external_parent_id: issue.parentExternalId,
    baseline_json: JSON.stringify(snapshotOf(issue)),
  });

  report.imported++;
}

/** One field's three-way verdict, carried from the diff into the per-mode apply. */
interface FieldConflict {
  field: 'title' | 'description' | 'stage';
  localValue: string | null;
  remoteValue: string | null;
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
): Promise<void> {
  const { db, connection, report } = ctx;
  const localBody = splitBody(local.body);

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
  if (remoteStageChanged && remoteStageId !== local.stageId) {
    if (localStageChanged) {
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
        payload_json: JSON.stringify({
          externalId: issue.externalId,
          mode: 'manual',
          detectedAt: ctx.nowIso(),
        }),
      });
      report.conflictsOpened++;
    }
    // Nothing applied, baseline untouched — the item is parked.
    return;
  }

  // Auto mode: tracker wins content, cyboflow wins stage. Record each override
  // as an already-resolved conflict row before applying it.
  for (const conflict of conflicts) {
    const remoteWins = conflict.field !== 'stage';
    if (remoteWins) {
      if (conflict.field === 'title') fields.title = issue.title;
      else fields.body = joinBody(issue.description, localBody.footer);
    }
    recordAutoResolution(ctx, link, issue, conflict, remoteWins ? 'auto-remote' : 'auto-local');
  }

  if (Object.keys(fields).length > 0 || stageMove !== undefined) {
    await ctx.router.applyChange(connection.project_id, {
      actor: connection.provider,
      entityType: link.entity_type,
      taskId: link.entity_id,
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      ...(stageMove !== undefined ? { stageId: stageMove } : {}),
    });
    report.updated++;
  }

  updateBaseline(db, link.id, composeBaselineJson(link.baseline_json, snapshotOf(issue)));
}

/** File an Auto-mode override as a conflict row that is immediately resolved. */
function recordAutoResolution(
  ctx: SyncContext,
  link: EntityExternalLinkRow,
  issue: TrackerIssue,
  conflict: FieldConflict,
  resolution: 'auto-remote' | 'auto-local',
): void {
  const row = insertConflict(ctx.db, {
    connection_id: ctx.connection.id,
    link_id: link.id,
    kind: 'field_conflict',
    field: conflict.field,
    local_value: conflict.localValue,
    remote_value: conflict.remoteValue,
    payload_json: JSON.stringify({
      externalId: issue.externalId,
      mode: 'auto',
      detectedAt: ctx.nowIso(),
    }),
  });
  resolveConflict(ctx.db, row.id, resolution);
  ctx.report.autoResolved++;
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
 * ACTIVE links and treats every vanished id as a deletion event.
 *
 * Auto mode archives the local entity in place and orphans the link; Manual
 * mode opens a `remote_deleted` conflict. A link that already has an open
 * conflict is left alone so repeated sweeps do not pile up duplicate rows.
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
  const sweep: InboundSweepReport = { sweepArchived: 0, conflictsOpened: 0 };

  const selection = parseSourceSelection(connection);
  const remoteIds = new Set(await adapter.listIssueIds(selection));

  for (const link of listLinks(db, connection.id, { activeOnly: true })) {
    if (remoteIds.has(link.external_id)) continue;
    if (hasOpenConflictForLink(db, link.id)) continue;

    const payload = JSON.stringify({
      externalId: link.external_id,
      identifier: link.external_identifier,
      reason: 'deleted',
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
