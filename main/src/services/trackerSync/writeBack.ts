/**
 * trackerSync/writeBack — the OUTBOUND detection half of the sync engine
 * (cyboflow -> tracker). Design: docs/proposals/tracker-sync-integration.md
 * ("Write-back & sub-issue mirroring" + "Durability & failure semantics" #1).
 *
 * This module makes ZERO network calls. It subscribes to the entity-change
 * broadcast (`taskChangeEvents` on TASK_ALL_CHANNEL, emitted by
 * TaskChangeRouter after every committed entity write) and translates the
 * changes that matter into durable `tracker_outbox` rows. outboxWorker.ts is
 * the only thing that talks to a provider — so every remote write has a
 * durable local record BEFORE it is attempted, which is what makes echo
 * suppression and crash recovery possible.
 *
 * Three write-back triggers, all gated on "the entity is linked AND its
 * connection is active with two_way = 1":
 *
 *   1. STAGE MOVES. The entity's stage maps to a write-back group
 *      ('started' / 'completed' / 'cancelled' — `Ready for development`
 *      deliberately maps to nothing: readiness is not started). A group that
 *      differs from the last group we wrote (stamped on the link's baseline by
 *      the worker) enqueues an `update_state`.
 *   2. DECOMPOSITION. A linked idea that just picked up its `decomposed_at`
 *      retire stamp writes 'started' to the origin issue, and — when the
 *      connection has `mirror_subissues = 1` — enqueues one `create_sub_issue`
 *      per minted task that has no link yet.
 *   3. PARENT ROLLUP. A mirrored task reaching a terminal stage checks its
 *      siblings; once every mirrored child of the same parent issue is
 *      terminal, a `close_parent` is enqueued for the parent issue (an
 *      idempotent no-op where Linear's native auto-close already fired; the
 *      sole mechanism for Plane).
 *
 * Every enqueue is DEDUPED against the connection's unresolved outbox rows, so
 * a burst of events (or a replayed one) can never queue the same remote write
 * twice. Combined with the baseline's last-written-group stamp, a stage that
 * flaps back and forth still produces exactly the writes the tracker needs.
 *
 * All tracker-table access goes through store.ts; the only direct SQL here is
 * against the native entity tables (`tasks`), which store.ts does not own.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';
import type { EntityExternalLinkRow, TrackerConnectionRow } from '../../database/models';
import type { TrackerProvider, TrackerStateGroup } from '../../../../shared/types/trackerSync';
import {
  enqueueOutbox,
  getConnection,
  getLinkByEntity,
  getLinkByExternal,
  listLinksByParentExternal,
  listUnresolvedOutbox,
} from './store';
import { resolveStageIds, stageIdToWriteBackGroup, type TrackerStageIds } from './stateMapping';

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/**
 * The three canonical groups a cyboflow stage can demand of a tracker issue —
 * the non-null arm of stateMapping's `stageIdToWriteBackGroup`. The other three
 * TrackerStateGroup members (triage/backlog/unstarted) are inbound-only: no
 * local stage ever asks an issue to move to them.
 */
export type WriteBackGroup = Extract<TrackerStateGroup, 'started' | 'completed' | 'cancelled'>;

/** `payload_json` for the `update_state` and `close_parent` outbox kinds. */
export interface UpdateStatePayload {
  desiredGroup: WriteBackGroup;
}

/** `payload_json` for the `create_sub_issue` outbox kind. */
export interface CreateSubIssuePayload {
  parentExternalId: string;
  title: string;
  description: string | null;
}

/**
 * The write-back marker the outbox worker stamps onto a link's
 * `baseline_json` after a successful state write. `stateId` overwrites the
 * baseline's own state field so the inbound poller diffs our own write to
 * "no change" (echo suppression); `lastWrittenGroup` is what this module
 * compares against to avoid re-queueing a group we already wrote.
 */
export interface WriteBackBaselineStamp {
  stateId: string;
  lastWrittenGroup: WriteBackGroup;
  lastWrittenAt: string;
}

/** Both providers a link can point at — the lookup order for an unknown-provider entity. */
const PROVIDERS: readonly TrackerProvider[] = ['linear', 'plane'];

// ---------------------------------------------------------------------------
// Baseline / payload helpers (shared with outboxWorker)
// ---------------------------------------------------------------------------

/** Parse a JSON blob into a plain object, or `{}` for null/invalid/non-object input. */
export function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A corrupt baseline/payload must never break an entity write — treat it
    // as "no baseline" and let the next successful sync rewrite it.
  }
  return {};
}

/** True when `value` is one of the three write-back groups. */
export function isWriteBackGroup(value: unknown): value is WriteBackGroup {
  return value === 'started' || value === 'completed' || value === 'cancelled';
}

/** The group most recently written to this link's issue, or null if we never wrote one. */
export function readLastWrittenGroup(link: EntityExternalLinkRow): WriteBackGroup | null {
  const baseline = parseJsonObject(link.baseline_json);
  const group = baseline.lastWrittenGroup;
  return isWriteBackGroup(group) ? group : null;
}

/** Read `desiredGroup` off an outbox row's payload, or null when absent/invalid. */
export function readDesiredGroup(payloadJson: string): WriteBackGroup | null {
  const group = parseJsonObject(payloadJson).desiredGroup;
  return isWriteBackGroup(group) ? group : null;
}

/**
 * stageIdToWriteBackGroup narrowed to the three groups a write-back can carry.
 * The mapping module returns the full `TrackerStateGroup` union (it is shared
 * with the inbound direction); the extra members are unreachable here, and
 * narrowing keeps that guarantee typed instead of asserted.
 */
export function writeBackGroupForStage(
  stageId: string,
  stageIds: TrackerStageIds,
): WriteBackGroup | null {
  const group = stageIdToWriteBackGroup(stageId, stageIds);
  return isWriteBackGroup(group) ? group : null;
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

export interface WriteBackDeps {
  db: Database.Database;
  /**
   * Current timestamp, in sqlite's `datetime('now')` shape ('YYYY-MM-DD
   * HH:MM:SS', UTC). Nothing here needs it TODAY — every column this module
   * writes takes the schema's own `datetime('now')` default — but it is part
   * of the sync engine's shared deps shape (outboxWorker.ts does its backoff
   * arithmetic with it), so the service constructs one object for both halves
   * and tests get a single injection point for time.
   */
  nowIso(): string;
}

export interface WriteBackListener {
  /** Handle one TaskChangedEvent. Never throws — a sync bug must not break entity writes. */
  handleTaskChanged(event: TaskChangedEvent): void;
  /** Stop reacting to events (the service still owns removing the emitter subscription). */
  dispose(): void;
}

/**
 * Build the entity-event -> outbox translator. The service layer owns the
 * subscription itself (`taskChangeEvents.on(TASK_ALL_CHANNEL, l.handleTaskChanged)`)
 * so this module stays free of emitter lifecycle and is trivially testable
 * with synthesized events.
 */
export function createWriteBackListener(deps: WriteBackDeps): WriteBackListener {
  let disposed = false;

  function handleTaskChanged(event: TaskChangedEvent): void {
    if (disposed) return;
    try {
      route(deps, event);
    } catch (err) {
      // Swallowed BY DESIGN: this listener runs inline on TaskChangeRouter's
      // post-commit emit, so a throw here would surface as a failed entity
      // write. A missed write-back is recoverable (the next stage move, or a
      // manual "Sync now", re-derives it); a broken backlog write is not.
      console.error('[trackerSync/writeBack] failed to route entity change', err);
    }
  }

  return {
    handleTaskChanged,
    dispose(): void {
      disposed = true;
    },
  };
}

/** The linked-entity context every write-back trigger needs. */
interface LinkedContext {
  link: EntityExternalLinkRow;
  connection: TrackerConnectionRow;
}

/** Resolve the (link, connection) pair for an entity, or null when it is not syncing. */
function resolveLinked(
  db: Database.Database,
  entityType: 'idea' | 'epic' | 'task',
  entityId: string,
): LinkedContext | null {
  for (const provider of PROVIDERS) {
    const link = getLinkByEntity(db, entityType, entityId, provider);
    // An orphaned link points at an issue the remote no longer has — the
    // deletion sweep already archived it, so writing back is pointless.
    if (!link || link.orphaned_at !== null) continue;
    const connection = getConnection(db, link.connection_id);
    if (!connection) continue;
    if (connection.status !== 'active' || connection.two_way !== 1) continue;
    return { link, connection };
  }
  return null;
}

/** Main dispatch for one event — see the three triggers in the file header. */
function route(deps: WriteBackDeps, event: TaskChangedEvent): void {
  // A hard delete is handled by the local-delete prompt ("unlink" vs "cancel
  // the issue"), not by stage-derived write-back.
  if (event.action === 'deleted') return;

  const entityType = event.task.type;
  // Epics are never linked to an issue: imports land as ideas, and mirroring
  // creates sub-issues for TASKS only.
  if (entityType !== 'idea' && entityType !== 'task') return;

  const linked = resolveLinked(deps.db, entityType, event.taskId);
  if (!linked) return;

  const stageIds = resolveStageIds(deps.db, event.projectId);
  const group = writeBackGroupForStage(event.task.stage_id, stageIds);

  if (group !== null) {
    enqueueStateWrite(deps, linked, linked.link.external_id, group, {
      entityType,
      entityId: event.taskId,
    });
  }

  if (entityType === 'idea' && event.task.decomposed_at !== null) {
    handleDecomposition(deps, linked, event.taskId, group);
  }

  if (entityType === 'task' && group === 'completed') {
    handleParentRollup(deps, linked, event, stageIds);
  }
}

// ---------------------------------------------------------------------------
// Trigger 1 — stage moves
// ---------------------------------------------------------------------------

/**
 * Enqueue an `update_state` (or `close_parent`) for `externalId`, unless we
 * already wrote that group or an unresolved row is carrying it. Returns true
 * when a row was actually written.
 */
function enqueueStateWrite(
  deps: WriteBackDeps,
  linked: LinkedContext,
  externalId: string,
  group: WriteBackGroup,
  opts: {
    entityType?: 'idea' | 'epic' | 'task';
    entityId?: string;
    kind?: 'update_state' | 'close_parent';
  } = {},
): boolean {
  const { db } = deps;
  const { connection } = linked;

  // Already the group we last wrote for this issue -> nothing to say.
  const targetLink =
    externalId === linked.link.external_id
      ? linked.link
      : getLinkByExternal(db, connection.id, externalId);
  if (targetLink && readLastWrittenGroup(targetLink) === group) return false;

  // An unresolved row already carries this exact intent. Kind is deliberately
  // NOT part of the dedup key: update_state and close_parent both move the
  // same issue to the same group, so either one satisfies the other.
  const duplicate = listUnresolvedOutbox(db, connection.id).some(
    (row) =>
      row.external_id === externalId &&
      (row.kind === 'update_state' || row.kind === 'close_parent') &&
      readDesiredGroup(row.payload_json) === group,
  );
  if (duplicate) return false;

  const payload: UpdateStatePayload = { desiredGroup: group };
  enqueueOutbox(db, {
    connection_id: connection.id,
    kind: opts.kind ?? 'update_state',
    entity_type: opts.entityType ?? null,
    entity_id: opts.entityId ?? null,
    external_id: externalId,
    payload_json: JSON.stringify(payload),
  });
  return true;
}

// ---------------------------------------------------------------------------
// Trigger 2 — decomposition + sub-issue mirroring
// ---------------------------------------------------------------------------

/** The columns the sub-issue draft is built from. */
interface MintedTaskRow {
  id: string;
  title: string;
  summary: string | null;
  body: string | null;
}

/**
 * Tasks minted from an idea — BOTH the epic-nested ones and the direct
 * children a small-idea decomposition produces (mirroring taskListing's
 * selectIdeaDecomposition, which unions the same two shapes). Archived tasks
 * are skipped: a task retired before the mirror ran should not appear in the
 * tracker at all.
 */
function listMintedTasks(db: Database.Database, ideaId: string): MintedTaskRow[] {
  return db
    .prepare(
      `SELECT id, title, summary, body
         FROM tasks
        WHERE originating_idea_id = ? AND archived_at IS NULL
        ORDER BY created_at ASC, ref ASC`,
    )
    .all(ideaId) as MintedTaskRow[];
}

/**
 * A decomposed idea writes 'started' to its origin issue, then (mirroring on)
 * fans its minted tasks out as sub-issues. A task is mirrored exactly once:
 * once it has a link, or once an unresolved create is already queued for it,
 * a replayed decomposition event is a no-op.
 *
 * `stageGroup` is what the idea's own stage already demands. A terminal one
 * (Done / Won't do) WINS: an idea that was decomposed and then closed must not
 * have its issue dragged back to In Progress by a replayed decomposition event.
 */
function handleDecomposition(
  deps: WriteBackDeps,
  linked: LinkedContext,
  ideaId: string,
  stageGroup: WriteBackGroup | null,
): void {
  const { db } = deps;
  const { connection, link } = linked;

  // Decomposition means work started, whatever planning stage the idea sits in.
  if (stageGroup === null) {
    enqueueStateWrite(deps, linked, link.external_id, 'started', {
      entityType: 'idea',
      entityId: ideaId,
    });
  }

  if (connection.mirror_subissues !== 1) return;

  const pendingCreates = new Set(
    listUnresolvedOutbox(db, connection.id)
      .filter((row) => row.kind === 'create_sub_issue' && row.entity_id !== null)
      .map((row) => row.entity_id as string),
  );

  for (const task of listMintedTasks(db, ideaId)) {
    if (getLinkByEntity(db, 'task', task.id, connection.provider) !== null) continue;
    if (pendingCreates.has(task.id)) continue;
    const payload: CreateSubIssuePayload = {
      parentExternalId: link.external_id,
      title: task.title,
      description: task.body ?? task.summary ?? null,
    };
    enqueueOutbox(db, {
      connection_id: connection.id,
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: task.id,
      // The parent issue, so an ambiguous-create reconcile knows where to look
      // without re-parsing the payload.
      external_id: null,
      // The idempotency key: Linear uses it as the created issue's id; Plane
      // matches against the outbox record when a create's response is lost.
      client_key: randomUUID(),
      payload_json: JSON.stringify(payload),
    });
    pendingCreates.add(task.id);
  }
}

// ---------------------------------------------------------------------------
// Trigger 3 — close the parent when every mirrored child is terminal
// ---------------------------------------------------------------------------

/**
 * A mirrored task just went terminal. When every OTHER mirrored child of the
 * same parent issue is terminal too, close the parent.
 *
 * "Terminal" here is Done OR Won't do (write-back groups 'completed' /
 * 'cancelled'): a decomposition where some stories were abandoned is still
 * finished, and waiting for a cancelled child to become Done would strand the
 * parent open forever.
 */
function handleParentRollup(
  deps: WriteBackDeps,
  linked: LinkedContext,
  event: TaskChangedEvent,
  stageIds: TrackerStageIds,
): void {
  const { db } = deps;
  const { connection, link } = linked;
  const parentExternalId = link.external_parent_id;
  if (parentExternalId === null) return;

  const siblings = listLinksByParentExternal(db, connection.id, parentExternalId).filter(
    (row) => row.entity_type === 'task' && row.orphaned_at === null,
  );
  if (siblings.length === 0) return;

  const allTerminal = siblings.every((sibling) => {
    // The event's own entity is read from the event: the emit happens after
    // commit, so the DB agrees — but the event is the authoritative statement
    // of what just changed.
    const stageId =
      sibling.entity_id === event.taskId ? event.task.stage_id : readTaskStage(db, sibling.entity_id);
    if (stageId === null) return false;
    const group = writeBackGroupForStage(stageId, stageIds);
    return group === 'completed' || group === 'cancelled';
  });
  if (!allTerminal) return;

  enqueueStateWrite(deps, linked, parentExternalId, 'completed', { kind: 'close_parent' });
}

/** A task's current stage id, or null when the row is gone. */
function readTaskStage(db: Database.Database, taskId: string): string | null {
  const row = db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskId) as
    | { stage_id: string }
    | undefined;
  return row?.stage_id ?? null;
}
