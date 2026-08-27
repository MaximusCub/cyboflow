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
 * ERRORS. An UNEXPECTED per-issue failure propagates out of runInboundSync.
 * That is intentional: the cursor has not advanced past the failing item, so
 * the next pass replays it. The service layer owns logging/backoff.
 *
 * The two EXPECTED rejections are handled per-item instead, because letting
 * them propagate wedges the connection rather than delaying one row. A linked
 * entity refuses a stage move while it has a live run ('active_runs') or when
 * the target stage is orchestrator-derived ('forbidden_stage') — and in
 * cyboflow the first is ordinary, not exotic: an item pulled into a session has
 * a non-terminal run for as long as the session lasts. Propagating aborted the
 * whole pass, left the cursor pinned on that item, and skipped every issue
 * behind it AND the deletion sweep — so one live run stopped the connection's
 * entire inbound flow until it ended. Both now defer the item exactly as a held
 * direction does (see {@link isDeferrableRejection}).
 */
import type Database from 'better-sqlite3';
import type { EntityExternalLinkRow, TrackerConnectionRow } from '../../database/models';
import type { TaskChange, TaskFieldChanges } from '../../orchestrator/taskChangeRouter';
import type { EntityCategory, Priority } from '../../../../shared/types/tasks';
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
  clearOrphaned,
  deleteLedgerEntries,
  findSiblingLinkForExternal,
  getLinkByEntity,
  getLinkByExternal,
  hasOpenConflictForLink,
  insertConflict,
  listLedgerEntries,
  listLinks,
  listUnresolvedOutbox,
  markOrphaned,
  resolveConflict,
  updateBaseline,
  upsertLedgerEntry,
  upsertLink,
} from './store';
import {
  mappingTargetToStageId,
  resolveEffectiveMapping,
  resolveStageIds,
  type TrackerStageIds,
} from './stateMapping';
import {
  localPriorityForToken,
  providerPriorityToken,
  providerTokensEqual,
  resolveEffectivePriorityMapping,
  type PriorityMapping,
} from './priorityMapping';
import {
  localCategoryForToken,
  providerCategoryToken,
  providerSupportsCategorySync,
  resolveEffectiveCategoryMapping,
  type CategoryMapping,
} from './categoryMapping';
import { isWriteBackGroup, parseJsonObject, type WriteBackGroup } from './writeBack';
import { provenanceMarker, splitBody, joinBody, normalizeDescription } from './provenance';

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
  /**
   * The remote's PROVIDER-RAW priority / type tokens (see
   * {@link TrackerIssue.priority} for why raw). OPTIONAL, and the difference
   * between `undefined` and `null` is load-bearing:
   *
   *   undefined — this baseline was written before the field was synced at all,
   *               so we do not know where the remote stood. The merge must do
   *               NOTHING with it (invariant 3): no diff, no conflict, no apply.
   *               `composeBaselineJson`'s unconditional overlay heals it at the
   *               end of the same pass, and merging starts from the next change.
   *   null      — we looked, and the remote genuinely has no value there.
   *
   * Collapsing the two would open a conflict (or silently overwrite the local
   * value) on every linked entity the first time a pass ran this code.
   */
  priority?: string | null;
  category?: string | null;
  /**
   * The link's LAST-SEEN reconciliation fingerprint — `TrackerIssue.revision`
   * as of the last pass that saw this issue. Written only by providers that
   * populate it (those declaring `requiresIdReconciliation`; beads today) and
   * read only by {@link runDeletionSweep}, which compares it against the swept
   * value to decide whether a LINKED id needs a point fetch.
   *
   * IT LIVES ON THE BASELINE BLOB RATHER THAN A COLUMN because it is exactly
   * the same kind of fact as the rest of it — "what the remote looked like when
   * we last agreed with it" — and because a column would have to be widened
   * into every provider's schema for one provider's benefit. It is deliberately
   * NOT part of the three-way merge: a fingerprint has no local counterpart, so
   * nothing can conflict on it.
   */
  revision?: string;
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
  /**
   * PRIORITY / CATEGORY conflicts only: the LOCAL value (`P0`… / `bug`…) the
   * remote token resolved to when the conflict was detected.
   *
   * The mirror image of `remoteStateId`, and it exists for the same reason: a
   * mapped field's `remote_value` cannot be acted on with only the row in hand.
   * A stage row stores the raw state because its `remote_value` is already
   * mapped; these store the mapped value because their `remote_value` is
   * deliberately RAW (invariant 2). Resolving the token later would mean
   * rebuilding the effective mapping — which needs the provider's LIVE option
   * list, i.e. a network call from a UI click, and one that could answer
   * differently than the pass did. Recording the pass's own answer keeps the
   * ruling faithful to the conflict the user was actually shown.
   */
  remoteLocal?: string;
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
 * The LOCAL value a mapped-field conflict recorded for its remote side, or null
 * when the row carries none — a title/description/stage conflict, or a
 * priority/category row written before this key existed. Still a bare string
 * here: the caller narrows it to a `Priority` or an `EntityCategory` depending
 * on which field it is resolving. See {@link TrackerConflictPayload.remoteLocal}.
 */
export function readConflictRemoteLocal(payloadJson: string | null): string | null {
  const payload = parseJsonObject(payloadJson);
  return typeof payload.remoteLocal === 'string' && payload.remoteLocal.length > 0
    ? payload.remoteLocal
    : null;
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
   * filtered out, an issue a sibling mapping already owns, an open conflict
   * pausing the item, an orphaned link, a locally-deleted entity, or a
   * first-pass baseline seed. Overlap-window replays are dropped BEFORE this
   * loop and are not counted.
   */
  skipped: number;
  /** Manual-mode conflict rows opened for the user this pass. */
  conflictsOpened: number;
  /** Auto-mode overrides recorded as already-resolved conflict rows. */
  autoResolved: number;
  /** Linked entities archived because the remote issue was archived. */
  archivedRemotely: number;
  /**
   * Unlinked issues another mapping on the same tracker identity already owns
   * (see {@link isOwnedBySiblingMapping}). Also counted in {@link skipped} —
   * this is the REASON breakdown of a permanent skip, not a separate outcome.
   */
  crossScopeSkips: number;
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
  /**
   * Remote CONTENT changes an item PARKED behind an open conflict is sitting
   * on, which no conflict row records (see {@link outcomeForParkedLink}). Pins
   * the cursor: nothing else holds these, so letting the window move past one
   * would lose a remote edit outright.
   */
  contentDeferred: number;
  /**
   * Remote changes recognized but NOT applied because the LOCAL entity refused
   * the write — a live run owns its stage, or the mapped stage is
   * orchestrator-derived. Pins the cursor like the other deferrals: the entity
   * is unlocked by time, not by a user decision, so the change is re-offered
   * every pass until one lands it. See {@link isDeferrableRejection}.
   */
  entityLocked: number;
  /**
   * Remote priority/category values this pass could not express locally: the
   * provider token has no entry in the effective mapping, because the workspace
   * renamed it or defines a value the mapping never named (both are ordinary on
   * Dart, which addresses these fields BY TITLE).
   *
   * Nothing is applied and no conflict is opened — we will not guess a level or
   * a classification the user never chose. The count exists so the sync log can
   * say "confirm the mapping", and the merge deliberately keeps the field's half
   * of the baseline PINNED so the warning re-derives every pass instead of going
   * quiet after the first one.
   */
  unmappedFieldValues: number;
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
  /**
   * Links whose remote issue is gone but whose local entity refused the archive
   * (a live run owns it). Nothing was written, so the link stays active and the
   * next sweep retries it. See {@link isDeferrableRejection}.
   */
  entityLocked: number;
  /**
   * RECONCILIATION ONLY (`capabilities.requiresIdReconciliation`). Point
   * lookups the reconciliation phase actually performed — the cost metric the
   * whole ledger exists to hold down, and the one the zero-lookup repeat-sweep
   * guarantee is stated in terms of.
   */
  reconcileFetched: number;
  /** Reconciled ids that reached the ordinary import path and now hold a link. */
  reconcileImported: number;
  /** Reconciled ids resolved WITHOUT a link and recorded in the ledger. */
  reconcileLedgered: number;
  /**
   * Ids the ledger (or a matching link fingerprint) answered for free — no
   * point lookup, no work. The number this sweep did NOT spend.
   */
  reconcileSkipped: number;
  /**
   * Orphaned links whose remote issue REAPPEARED in the full listing and were
   * put back in sync (docs/proposals/tracker-beads-provider.md, round 18's
   * reversible archival). Never zero for long: a sweep that archives something
   * a concurrent restore brought back reports it here on the very next pass.
   */
  resurrected: number;
  /**
   * Archival decisions this sweep DID NOT apply because the workspace changed
   * under it (`TrackerAdapter.workspaceHead` moved between the sweep's start and
   * the first archive). Nothing was written for them; the next sweep decides
   * again from a fresh listing. See the HEAD-guard note in
   * {@link runDeletionSweep}.
   */
  archivalDeferred: number;
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

const PROVIDER_LABEL: Record<TrackerProvider, string> = {
  linear: 'Linear',
  plane: 'Plane',
  dart: 'Dart',
  beads: 'Beads',
};

/** The provenance block appended to an imported idea's body (issue ref + URL). */
function buildProvenanceFooter(provider: TrackerProvider, issue: TrackerIssue): string {
  const marker = provenanceMarker(provider, issue.externalId);
  return `${marker}\nImported from ${PROVIDER_LABEL[provider]} \u00b7 [${issue.identifier}](${issue.url})`;
}

/**
 * The body-split helpers now live in provenance.ts, beside the marker that
 * DEFINES where a footer begins — writeBack.ts's content trigger needs the same
 * description half, and this module already imports from writeBack, so keeping
 * them here would close an import cycle.
 *
 * Re-exported under their historical names so every existing call site (the
 * outbox worker's body alignment, the service's conflict resolution, the tests)
 * keeps importing them from the module that used to own them.
 */
export { splitBody, joinBody, normalizeDescription } from './provenance';

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

/**
 * Parse `source_json` into the adapter's source selection.
 *
 * Exported for the ADOPTION path, whose pre-import reconciliation lists the
 * newly adopted workspace itself, ahead of any pass: it needs the same selection
 * a pass would use, and re-deriving one at that call site would be a second
 * parser of the same blob with its own defaults.
 */
export function parseSourceSelection(connection: TrackerConnectionRow): TrackerSourceSelection {
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
  const selection: TrackerSourceSelection = {
    containerId: candidate.containerId,
    narrowId: candidate.narrowId,
    narrowKind: candidate.narrowKind ?? 'all',
  };
  // Dart space groups only: the concrete board a CREATE is filed against. Read
  // here so ONE parse serves the whole pass; nothing inbound uses it, and it is
  // never invented — a selection without one simply has none.
  if (typeof candidate.pushContainerId === 'string') {
    selection.pushContainerId = candidate.pushContainerId;
  }
  return selection;
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
  const baseline: TrackerBaseline = {
    title: candidate.title,
    description: typeof candidate.description === 'string' ? candidate.description : null,
    stateId: candidate.stateId,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
  };
  // KEY PRESENCE, not value truthiness: an absent key must stay `undefined` so
  // the backfill arm can recognize a pre-feature baseline, while a stored null
  // is a real "the remote has no priority" answer. Defaulting either one would
  // erase that distinction — see TrackerBaseline.priority.
  if ('priority' in candidate) baseline.priority = asNullableString(candidate.priority);
  if ('category' in candidate) baseline.category = asNullableString(candidate.category);
  if (typeof candidate.revision === 'string') baseline.revision = candidate.revision;
  return baseline;
}

/**
 * The reconciliation fingerprint stored on a link's baseline blob, or null when
 * it carries none (every HTTP-provider link, and a beads link written before
 * the first fingerprinted pass).
 *
 * Read STANDALONE rather than through {@link parseBaseline} because the sweep
 * asks its question of links whose baseline may not be a usable MERGE baseline
 * at all — a half-written blob, or the outbound half's write-back stamp on its
 * own. Those still hold a perfectly good fingerprint, and rejecting them would
 * point-fetch the whole workspace on every sweep.
 */
export function readBaselineRevision(baselineJson: string | null): string | null {
  const revision = parseJsonObject(baselineJson).revision;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

/** A stored token, or null for anything that is not a usable string. */
function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Snapshot an issue's merge-relevant fields for `baseline_json`.
 *
 * `priority` / `category` are ALWAYS emitted, including as null. That is what
 * makes the backfill arm self-healing: the first pass over a pre-feature link
 * declines to merge the field and then writes this snapshot over the blob, so
 * the NEXT pass has a real baseline to diff against.
 */
function snapshotOf(issue: TrackerIssue): TrackerBaseline {
  const snapshot: TrackerBaseline = {
    title: issue.title,
    description: issue.description,
    stateId: issue.stateId,
    updatedAt: issue.updatedAt,
    priority: issue.priority,
    category: issue.category,
  };
  // OMITTED WHEN THE PROVIDER HAS NONE, rather than emitted as undefined:
  // composeBaselineJson overlays this object key-by-key, so an explicit
  // `revision: undefined` would ERASE a fingerprint an earlier pass stored.
  // (JSON.stringify drops the undefined, which is precisely how the erasure
  // would be silent.)
  if (issue.revision !== undefined) snapshot.revision = issue.revision;
  return snapshot;
}

/**
 * A FRESH `baseline_json` for a link being bound to `issue` for the first time,
 * with NOTHING carried over from whatever the link held before.
 *
 * The adoption path's re-link is the caller (docs/proposals/
 * tracker-beads-provider.md, round 18's pre-import reconciliation): it repoints
 * an orphaned link at an issue in a DIFFERENT DATABASE, so every key the old
 * blob carried — the previous remote snapshot, the write-back dedupe stamps, the
 * sweep's archival marker — describes a workspace that no longer exists.
 * Overlaying onto it, the way {@link composeBaselineJson} deliberately does for
 * an ongoing link, would leave the first pass diffing the new issue against the
 * old one's fields.
 */
export function freshBaselineJson(issue: TrackerIssue): string {
  return JSON.stringify(snapshotOf(issue));
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
  /**
   * Both columns are NOT NULL with defaults on all THREE entity tables — 015
   * created `priority` on each, 059 added `category` to each — so the merge's
   * priority and category arms apply uniformly to ideas, epics and tasks, with
   * no per-table branch.
   */
  priority: Priority;
  category: EntityCategory;
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
      `SELECT ref, title, body, stage_id AS stageId, priority, category
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
  /**
   * The connection's effective field mappings, resolved ONCE per pass beside
   * the state mapping (same seed → overlay shape). Both are consulted only at
   * the merge edge: the diff itself runs in provider space (invariant 2).
   */
  priorityMapping: PriorityMapping;
  categoryMapping: CategoryMapping;
  /**
   * Does this provider model a type the category can live on? False stands the
   * whole category arm down — see {@link providerSupportsCategorySync}.
   */
  categorySync: boolean;
  /** See {@link InboundSyncDeps.applyLinkedStage}. */
  applyLinkedStage: boolean;
  /** See {@link InboundSyncDeps.importNewIssues}. */
  importNewIssues: boolean;
  /**
   * Called by {@link applyIssue} with the REASON an UNLINKED issue was skipped
   * permanently — the reconciliation ledger's `reason` column. Wired only by
   * {@link runDeletionSweep}; the ordinary pass leaves it undefined and the
   * gates just count as they always did.
   *
   * A CALLBACK RATHER THAN A RE-DERIVATION AT THE CALL SITE. The sweep needs to
   * know which of four gates a skipped issue actually took, and re-evaluating
   * the same predicates afterwards would encode their ORDER a second time —
   * a duplicate that goes wrong silently (a mis-ordered copy just files the
   * wrong reason string). Reporting from the branch itself cannot drift.
   */
  onPermanentSkip?: (reason: ReconciliationSkipReason) => void;
  /**
   * Remote ids an ADOPTION put ON HOLD — the `'awaiting-adoption'` ledger rows
   * its pre-import reconciliation wrote for issues that plausibly, but not
   * provably, belong to an entity the replaced workspace orphaned
   * (docs/proposals/tracker-beads-provider.md, round 18).
   *
   * READ BY BOTH DETECTION PATHS, which is the whole reason it lives on the
   * context rather than in the sweep. The ledger alone holds only the SWEEP
   * back; the ordinary incremental pass has its own route to the import, and a
   * fresh connection's first pass fetches from a null cursor — so without this
   * the held issue would be imported as a new idea within seconds of the
   * finding being filed, which is exactly what the hold exists to prevent.
   *
   * Empty for every connection that has never been adopted, which is all of them
   * on the three HTTP providers.
   */
  heldExternalIds: ReadonlySet<string>;
  report: InboundSyncReport;
}

/**
 * Why a reconciliation point-fetch resolved a remote id WITHOUT minting a link
 * — persisted verbatim as `tracker_reconciliation_ledger.reason` so a user (or
 * a support read of the table) can tell "your mapping declines this state" from
 * "another mapping owns it" without re-running anything.
 *
 * Deliberately narrower than the ordinary pass's skip counters: only the
 * UNLINKED gates can produce a ledger row, because every other skip either has
 * a link already (which is its own record) or is a DEFERRAL, which must be
 * re-offered rather than remembered.
 *
 * `'awaiting-adoption'` is the one reason NO gate in {@link applyIssue}
 * produces: the ADOPTION path writes it directly (see
 * TrackerSyncService.adoptNewWorkspace) for an issue in a newly adopted
 * workspace that plausibly — but not conclusively — belongs to an entity whose
 * link was orphaned by the replacement. It is a HOLD, not a verdict: the issue
 * must not be imported as new behind the user's back while the confirmation
 * finding is still open, and the ledger is what makes that hold survive the
 * sweep that would otherwise import it minutes later.
 */
export type ReconciliationSkipReason =
  | 'archived'
  | 'unmapped-state'
  | 'out-of-selection'
  | 'sibling-owned'
  | 'awaiting-adoption';

/**
 * The mapping target for an issue's state; an unmapped state never imports.
 *
 * `'indev'` is normalized to `'dont'` HERE rather than being handled at each of
 * the branches below: it is an outbound-only pin (see TrackerMappingTarget), so
 * inbound must behave as though the state were simply not imported. Collapsing
 * it once, at the single point every inbound decision reads, is what keeps the
 * rest of this file from needing to know the target exists.
 */
function targetFor(ctx: SyncContext, issue: TrackerIssue): TrackerMappingTarget {
  const target = ctx.mapping[issue.stateId] ?? 'dont';
  return target === 'indev' ? 'dont' : target;
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

/**
 * The two {@link TaskChangeError} codes that mean "not now" rather than
 * "never": the local entity refused this write for a reason that is about the
 * entity's CURRENT state, not about the change being wrong.
 *
 *   - 'active_runs'     — a non-terminal run owns the entity's stage, so a
 *     non-orchestrator actor may not move it (TaskChangeRouter's stage-move and
 *     archive guards). Ordinary in cyboflow: any item pulled into a session
 *     holds one for the life of that session.
 *   - 'forbidden_stage' — the target stage is orchestrator-derived.
 *
 * Matched STRUCTURALLY, on `code`, rather than with `instanceof`. This module
 * depends on the router only through the {@link EntityWriteRouter} seam (module
 * header), and a test double throwing its own shaped error must be recognized
 * the same way the real router's is.
 *
 * Everything else still propagates — a rejection nobody predicted is a bug, and
 * swallowing it here would hide it behind a counter.
 */
const DEFERRABLE_REJECTION_CODES: ReadonlySet<string> = new Set(['active_runs', 'forbidden_stage']);

function isDeferrableRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && DEFERRABLE_REJECTION_CODES.has(code);
}

// ---------------------------------------------------------------------------
// runInboundSync
// ---------------------------------------------------------------------------

/** The per-pass counters every {@link SyncContext} starts from. */
function emptyInboundReport(): InboundSyncReport {
  return {
    imported: 0,
    updated: 0,
    skipped: 0,
    crossScopeSkips: 0,
    conflictsOpened: 0,
    autoResolved: 0,
    archivedRemotely: 0,
    stageDeferred: 0,
    importDeferred: 0,
    contentDeferred: 0,
    entityLocked: 0,
    unmappedFieldValues: 0,
  };
}

/**
 * Resolve everything {@link applyIssue} needs before it can judge a single
 * issue: the board's stage ids, the provider's live state and field
 * vocabularies, and the connection's effective mappings over them.
 *
 * EXTRACTED SO THE RECONCILIATION SWEEP CAN REUSE IT. The sweep's point
 * fetches run through the ordinary import/merge path, and that path is only
 * correct against the same resolved mappings a pass would have used — a second
 * copy of this resolution would be a second chance to disagree with it. Two
 * adapter calls, which is why the sweep builds this LAZILY (see
 * {@link runDeletionSweep}): a sweep with nothing to point-fetch pays nothing.
 */
async function buildSyncContext(
  deps: InboundSyncDeps,
  connection: TrackerConnectionRow,
  selection: TrackerSourceSelection,
  report: InboundSyncReport,
): Promise<SyncContext> {
  const { db, adapter, router } = deps;
  const stageIds = resolveStageIds(db, connection.project_id);
  const states = await adapter.listStates(selection);
  const mapping = resolveEffectiveMapping(states, connection.state_mapping_json);
  // Fetched beside the states, for the same reason: both are per-pass provider
  // vocabulary the merge needs before it can compare anything. Free on every
  // provider — Linear and Plane state their fixed scales, and Dart serves this
  // off the same cached `/config` listStates just used.
  const fieldOptions = await adapter.listFieldOptions();
  // Migration 118 columns: an empty '{}' overlay (every pre-Phase-6 connection)
  // resolves to the seed, exactly like Phase 2's `null` placeholder did.
  // A persisted mapping entry the workspace no longer offers is dropped rather
  // than sent, and counted like the inbound values it cannot express: both are
  // "the tracker renamed this out from under your mapping", both are fixed by
  // confirming the mapping, and the pass's ⚠ line already says exactly that.
  // Counted ONCE per pass, and re-counted every pass while the overlay stays
  // stale — the same never-goes-quiet property the inbound half has.
  const onStaleOverlayToken = (): void => {
    report.unmappedFieldValues++;
  };
  const priorityMapping = resolveEffectivePriorityMapping(
    connection.provider,
    fieldOptions.priorities,
    connection.priority_mapping_json,
    onStaleOverlayToken,
  );
  const categoryMapping = resolveEffectiveCategoryMapping(
    connection.provider,
    fieldOptions.categories,
    connection.category_mapping_json,
    onStaleOverlayToken,
  );

  const stateGroups: Record<string, TrackerStateGroup> = {};
  for (const state of states) stateGroups[state.id] = state.group;

  return {
    db,
    router,
    reviewRouter: deps.reviewRouter,
    nowIso: deps.nowIso,
    connection,
    stageIds,
    mapping,
    stateGroups,
    priorityMapping,
    categoryMapping,
    categorySync: providerSupportsCategorySync(connection.provider),
    applyLinkedStage: deps.applyLinkedStage !== false,
    importNewIssues: deps.importNewIssues !== false,
    heldExternalIds: readAdoptionHolds(db, connection),
    report,
  };
}

/**
 * The `'awaiting-adoption'` ledger rows still in force for a connection — see
 * {@link SyncContext.heldExternalIds}.
 *
 * ONE QUERY PER PASS, over a table already scoped to the connection, and empty
 * for anything that was never adopted. A row from an older `config_generation`
 * is treated as absent exactly like every other ledger read: a mapping change is
 * the user re-deciding what this connection syncs, and a hold must not outlive
 * that decision silently.
 */
function readAdoptionHolds(
  db: Database.Database,
  connection: TrackerConnectionRow,
): ReadonlySet<string> {
  const held = new Set<string>();
  for (const [externalId, row] of listLedgerEntries(db, connection.id)) {
    if (row.reason === 'awaiting-adoption' && row.config_generation === connection.config_generation) {
      held.add(externalId);
    }
  }
  return held;
}

/**
 * Run ONE inbound pass for a connection. See the module header for the cursor,
 * echo-suppression and error semantics.
 */
export async function runInboundSync(
  deps: InboundSyncDeps,
  connection: TrackerConnectionRow,
): Promise<InboundSyncReport> {
  const { db, adapter } = deps;
  const report = emptyInboundReport();

  const selection = parseSourceSelection(connection);
  const ctx = await buildSyncContext(deps, connection, selection, report);

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
      else if (outcome === 'entity-locked') report.entityLocked++;
      else if (outcome === 'content-deferred') report.contentDeferred++;
      else report.importDeferred++;
    }
    if (cursorAdvances) advanceCursor(db, connection.id, issue.updatedAt, issue.externalId);
  }

  return report;
}

/**
 * What {@link applyIssue} did with one issue, as far as the CURSOR is concerned.
 * Every deferral means the issue is NOT finished with — something recognized
 * work and declined to do it — so the cursor must not move past it:
 *   - 'stage-deferred'   — a remote stage change the status direction is holding.
 *   - 'import-deferred'  — a new issue the import direction is holding.
 *   - 'content-deferred' — a parked item is sitting on a remote content change
 *     that no open conflict row records; see {@link outcomeForParkedLink}.
 *   - 'entity-locked'    — a write the LOCAL entity refused; see
 *     {@link isDeferrableRejection}. Held by a live run rather than by a
 *     setting, but identical as far as the cursor is concerned.
 */
type ApplyOutcome =
  | 'applied'
  | 'stage-deferred'
  | 'import-deferred'
  | 'content-deferred'
  | 'entity-locked';

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
    // REPAIR COMES FIRST, ahead of every permanent-skip gate below.
    //
    // A half-imported idea from a crashed pass is REPAIR of an import that
    // already happened, not a new one (see the module header's IMPORT RECOVERY
    // note) — and the ONLY thing that repairs it is the link write. Deciding
    // eligibility first would make the repair hostage to conditions that have
    // nothing to do with it: an issue archived, remapped to 'dont', or filtered
    // out of the selection between the crash and this pass would take the
    // permanent-skip branch, return 'applied', and let the cursor advance —
    // stranding the local idea unlinked forever, because those branches never
    // look at the marker and the issue may never enter the incremental window
    // again.
    //
    // So the repair runs unconditionally, and the CURRENT eligibility only
    // decides what happens to the now-linked entity afterwards.
    const adoptable = findAdoptableIdea(
      db,
      connection.project_id,
      connection.provider,
      provenanceMarker(connection.provider, issue.externalId),
    );
    if (adoptable !== null) {
      await repairHalfImport(ctx, issue, adoptable);
      return 'applied';
    }

    // AHEAD OF EVERY OTHER PERMANENT GATE, because it is the only one that
    // represents a decision a HUMAN still owes: an adoption found this issue
    // plausibly-but-not-provably the same as an item whose link the replacement
    // orphaned, and filed it for confirmation. Relabelling it as 'archived' or
    // 'unmapped-state' would record the wrong reason in the ledger and, worse,
    // let a later mapping change turn the open question into an import.
    if (ctx.heldExternalIds.has(issue.externalId)) {
      report.skipped++;
      ctx.onPermanentSkip?.('awaiting-adoption');
      return 'applied';
    }

    // An archived remote issue never seeds a NEW local idea — importing
    // something the tracker already retired is pure noise.
    if (issue.archivedAt !== null) {
      report.skipped++;
      ctx.onPermanentSkip?.('archived');
      return 'applied';
    }
    const target = targetFor(ctx, issue);
    if (target === 'dont') {
      report.skipped++;
      ctx.onPermanentSkip?.('unmapped-state');
      return 'applied';
    }
    if (!passesSelectionFilter(connection, issue)) {
      report.skipped++;
      ctx.onPermanentSkip?.('out-of-selection');
      return 'applied';
    }
    // A sibling mapping already imported this issue. PERMANENT, so it is a skip
    // rather than a deferral — and it deliberately sits AHEAD of the import
    // hold below, which exists to delay work we will eventually do.
    if (isOwnedBySiblingMapping(ctx, issue)) {
      report.skipped++;
      report.crossScopeSkips++;
      ctx.onPermanentSkip?.('sibling-owned');
      return 'applied';
    }
    if (!ctx.importNewIssues) {
      // Deferred, NOT skipped: the cursor holds so this issue is re-offered
      // until a pass may import it.
      return 'import-deferred';
    }
    await importIssueAsIdea(ctx, issue, target, null);
    return 'applied';
  }

  // Manual mode parks a conflicting item until the user decides; everything
  // else keeps flowing past it. The item is NOT necessarily finished with,
  // though — see {@link outcomeForParkedLink}.
  if (hasOpenConflictForLink(db, link.id)) {
    report.skipped++;
    return outcomeForParkedLink(ctx, issue, link);
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

/**
 * Is this UNLINKED issue already owned by another mapping of the same tracker?
 *
 * Multi-project mapping (design doc "Multi-project mapping (rev 4)") gives one
 * workspace N sibling connections, and their scopes legitimately OVERLAP: a
 * Linear team group and a project group beneath it both fetch every issue in
 * that project, and an issue MOVED remotely between two mapped groups is
 * suddenly in-scope for a connection that never imported it. Both cases arrive
 * here as "unlinked issue" — the link belongs to the sibling, so
 * getLinkByExternal (scoped to one connection) cannot see it — and importing
 * would mint a SECOND idea for one remote issue, with two connections then
 * write-backing at it from different local entities.
 *
 * Scoped to the tracker IDENTITY rather than to the project, because the
 * duplicate that matters is the remote one: the sibling's idea may live in an
 * entirely different cyboflow project and still be the same issue.
 *
 * A connection whose `workspace_id` was never recorded owns no identity to
 * compare, so it claims nothing and is claimed by nothing — the same reading
 * store.connectionMatchesIdentity takes.
 */
function isOwnedBySiblingMapping(ctx: SyncContext, issue: TrackerIssue): boolean {
  const { connection } = ctx;
  if (connection.workspace_id === null) return false;
  return (
    findSiblingLinkForExternal(ctx.db, {
      provider: connection.provider,
      workspaceId: connection.workspace_id,
      baseUrl: connection.base_url,
      externalId: issue.externalId,
      excludeConnectionId: connection.id,
    }) !== null
  );
}

/**
 * What a link PARKED behind an open conflict means for the cursor.
 *
 * The park applies nothing and leaves the baseline where it was, so the whole
 * item is re-derived on every later pass — for as long as the pass still SEES
 * it. That is the catch: the cursor is what decides whether it does, and an
 * issue the cursor moved past is only ever fetched again if the tracker touches
 * it again. So anything the park suppressed that no durable row records is lost
 * the moment the cursor advances.
 *
 * The one such thing is a remote STAGE change:
 *   - status direction HELD ('manual'): the merge computed the delta and
 *     declined to apply it, recording nothing. Nothing else will.
 *   - status AUTO, item parked by a CONTENT conflict: the stage move was
 *     applicable and the park dropped it on the floor with the rest of the
 *     item. Resolving the title conflict advances only the title baseline
 *     ({@link acceptLocalFieldValue} et al), so the stage would never re-derive.
 * Both hold the cursor, so the change is re-offered until a pass applies it.
 *
 * An open STAGE conflict is the exception: that row already carries the remote
 * state id and its group, and resolving it applies (or deliberately declines)
 * the change. The work is durable, so the cursor may move on — and must, or an
 * unresolved stage conflict would pin the fetch window open indefinitely.
 */
function outcomeForParkedLink(
  ctx: SyncContext,
  issue: TrackerIssue,
  link: EntityExternalLinkRow,
): ApplyOutcome {
  const { db } = ctx;
  if (hasOpenConflictForLink(db, link.id, 'stage')) return 'applied';
  // An archived issue never reaches the merge at all ({@link applyRemoteArchive}
  // owns it), so there is no stage move being held back — and pinning the
  // cursor on one would stall the window behind a remote-deletion conflict the
  // user has not answered yet.
  if (issue.archivedAt !== null) return 'applied';

  const baseline = parseBaseline(link.baseline_json);
  if (baseline === null) return 'applied';
  const local = readLocalEntity(db, link.entity_type, link.entity_id);
  if (local === null) return 'applied';

  // The same delta mergeLinkedIssue computes, asked only for its existence.
  const baselineStageId = mappingTargetToStageId(ctx.mapping[baseline.stateId] ?? 'dont', ctx.stageIds);
  const remoteStageId = mappingTargetToStageId(targetFor(ctx, issue), ctx.stageIds);
  const stageWaiting =
    remoteStageId !== null && remoteStageId !== baselineStageId && remoteStageId !== local.stageId;
  if (stageWaiting) return 'stage-deferred';
  return hasUnrecordedContentDelta(ctx, issue, link, baseline) ? 'content-deferred' : 'applied';
}

/**
 * Is this parked item holding a remote CONTENT change that no open conflict
 * records?
 *
 * THE SAME QUESTION THE STAGE ARM ASKS, about the other four fields. A park
 * applies nothing, so every delta it computed is dropped on the floor; a delta
 * that an open conflict row CARRIES is durable (resolving it applies or
 * deliberately declines the change), and one that no row carries exists nowhere
 * but in the fetched issue. Let the cursor past THAT one and it is gone for
 * good — the issue is only ever refetched if the tracker touches it again.
 *
 * The ordinary shape of the hazard: an item parked by a TITLE conflict whose
 * remote DESCRIPTION also changed. Resolving the title advances only the title
 * half of the baseline, so nothing ever re-derives the description delta.
 *
 * THE COST IS A PINNED CURSOR, and it is the trade the stage arm already makes
 * for a held direction: the fetch window stays open at this issue until the
 * user answers the conflict the UI is showing them. Losing an edit silently is
 * the worse of the two, and unlike the stage arm's `remote_deleted` escape
 * there is no row here that would make the change durable on its own.
 *
 * PROVIDER SPACE for the two mapped fields (invariant 2), and an `undefined`
 * baseline half is NOT a delta (invariant 3) — the same two rules the merge
 * itself runs by, because this must agree with it exactly or the cursor would
 * pin on a delta the merge would never compute.
 */
function hasUnrecordedContentDelta(
  ctx: SyncContext,
  issue: TrackerIssue,
  link: EntityExternalLinkRow,
  baseline: TrackerBaseline,
): boolean {
  const { db } = ctx;
  const unrecorded = (field: FieldConflict['field'], changed: boolean): boolean =>
    changed && !hasOpenConflictForLink(db, link.id, field);

  if (unrecorded('title', issue.title !== baseline.title)) return true;
  if (
    unrecorded(
      'description',
      normalizeDescription(issue.description) !== normalizeDescription(baseline.description),
    )
  ) {
    return true;
  }
  if (
    baseline.priority !== undefined &&
    unrecorded('priority', !providerTokensEqual(issue.priority, baseline.priority))
  ) {
    return true;
  }
  return (
    ctx.categorySync &&
    baseline.category !== undefined &&
    unrecorded('category', !providerTokensEqual(issue.category, baseline.category))
  );
}

/**
 * Finish an import a crash interrupted between the idea's create and its link
 * write, whatever the issue's CURRENT import eligibility says (see the call
 * site in {@link applyIssue} for why eligibility cannot gate this).
 *
 * The link is written first and unconditionally, because it is the repair: it
 * is what stops the marked idea from being an orphan and the issue from being
 * imported a second time.
 *
 * WHAT FOLLOWS depends on the issue, and lands the entity exactly where a
 * LINKED issue in the same state would have:
 *   - ARCHIVED remotely -> {@link applyRemoteArchive}, i.e. Auto archives the
 *     idea in place and orphans the link, Manual opens a `remote_deleted`
 *     conflict. Its mapped stage is deliberately NOT applied on the way — a
 *     placement onto a board column for an entity we are about to archive is
 *     noise in the event log and changes nothing.
 *   - otherwise -> the mapped placement the crashed pass never made. A state
 *     mapped to 'dont' places nothing (there is no stage it names), which is
 *     the same non-answer a linked issue on that state gets from the merge.
 */
async function repairHalfImport(
  ctx: SyncContext,
  issue: TrackerIssue,
  adopted: { id: string; stageId: string },
): Promise<void> {
  const archived = issue.archivedAt !== null;
  await importIssueAsIdea(ctx, issue, archived ? 'dont' : targetFor(ctx, issue), adopted);
  if (!archived) return;
  const link = getLinkByExternal(ctx.db, ctx.connection.id, issue.externalId);
  if (link !== null) await applyRemoteArchive(ctx, issue, link);
}

/**
 * The mapped fields a fresh IMPORT carries over from the remote issue, as a
 * patch to fold into the create.
 *
 * WHY THE IMPORT HAS TO SET THESE. Everything else about a new idea comes from
 * the issue, but priority and category would otherwise take the table's
 * defaults (P2 / feature) while the link's baseline recorded the remote's REAL
 * token. That gap never closes on its own: the next pass reads remote-unchanged
 * and local-changed, which is "the user re-prioritized it locally" — so an
 * Urgent issue would import as Medium and, once outbound content write-back
 * exists, be DEMOTED in the tracker to match.
 *
 * An unmapped or unsupported value is simply omitted (the local default
 * stands), and deliberately NOT counted in `unmappedFieldValues`: that counter
 * reports a remote value that CHANGED and could not be mirrored, which is a
 * mapping the user should confirm. An import has no prior expectation to
 * violate, and counting it would make every single import on a workspace that
 * models no categories warn, forever.
 *
 * Only the CREATE branch calls this. An adopted half-import was created by an
 * earlier run of this same code and already carries them.
 */
function mappedFieldsFor(ctx: SyncContext, issue: TrackerIssue): TaskFieldChanges {
  const fields: TaskFieldChanges = {};
  const priority = localPriorityForToken(ctx.connection.provider, ctx.priorityMapping, issue.priority);
  if (priority !== null) fields.priority = priority;
  if (ctx.categorySync) {
    const category = localCategoryForToken(ctx.categoryMapping, issue.category);
    if (category !== null) fields.category = category;
  }
  return fields;
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
 * plus a provenance footer, the mapped priority/category ride along on the
 * create ({@link mappedFieldsFor}), and the mapped stage is applied as a
 * follow-up move so the import reads as "created, then placed" in the entity
 * event log.
 *
 * CRASH-IDEMPOTENT (module header, IMPORT RECOVERY). The three writes cannot
 * share a transaction, so the order is chosen to make every interruption
 * recoverable: create (which durably stamps the recovery marker into the body),
 * then the link, then the placement. A crash after the create is repaired on
 * the next pass by adopting the marked idea instead of creating a second one;
 * a crash after the link leaves an ordinary linked entity the merge path owns.
 *
 * `adopted` is that half-imported idea. It is resolved by the CALLER, because
 * the caller needs the same answer BEFORE it decides anything: a repair runs
 * ahead of every skip gate and regardless of the import direction, a fresh
 * import runs behind both (see {@link applyIssue} and {@link repairHalfImport}).
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
      fields: { title: issue.title, body, ...mappedFieldsFor(ctx, issue) },
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
    // beads reports '' — it has no web UI and therefore no per-issue URL — and
    // an empty link is worse than none, so it is stored as NULL. Never reached
    // by the HTTP providers, whose `url` is always populated.
    external_url: issue.url || null,
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

/**
 * One field's three-way verdict, carried from the diff into the per-mode apply.
 *
 * The two VALUE members are in whatever space that field's diff ran in: content
 * fields carry their literal text, a stage row's `remoteValue` is the mapped
 * board stage id, and a priority/category row carries BOTH sides as
 * provider-raw tokens (invariant 2 — see the priority arm). `tracker_conflicts.field`
 * has no CHECK constraint, so widening this union needs no migration.
 */
interface FieldConflict {
  field: 'title' | 'description' | 'stage' | 'priority' | 'category';
  localValue: string | null;
  remoteValue: string | null;
  /**
   * MAPPED fields only: the local value `remoteValue` resolved to under the
   * effective mapping — recorded so a later ruling need not re-resolve it. See
   * {@link TrackerConflictPayload.remoteLocal}.
   */
  remoteLocalValue?: string;
}

/**
 * What one MAPPED-field arm decided, so the caller can act on all three
 * outcomes without the arm reaching into `fields` / `conflicts` / the snapshot
 * itself.
 *
 *   'none'      — nothing to do (converged, or only the local side moved).
 *   'unmapped'  — the remote token has no local meaning; counted, not applied,
 *                 and the baseline half stays PINNED so it re-derives.
 *   'conflict'  — both sides moved; the conflict has been pushed.
 *   'apply'     — a remote-only change to mirror; the field has been set.
 */
type FieldArmOutcome = 'none' | 'unmapped' | 'conflict' | 'apply';

/** One mapped field's inputs — see {@link mergeMappedField}. */
interface MappedFieldArm<T extends string> {
  field: 'priority' | 'category';
  /** The link baseline's token; `undefined` = never synced (the backfill arm). */
  baselineToken: string | null | undefined;
  /** The remote's current token, provider-raw. */
  remoteToken: string | null;
  /** The local entity's current value. */
  localValue: T;
  /** Local value -> provider token, through the connection's effective mapping. */
  toProvider(value: T): string | null;
  /** Provider token -> local value; null when the token has no local meaning. */
  toLocal(token: string | null): T | null;
  /** Where a both-sides-changed verdict is filed. */
  conflicts: FieldConflict[];
  /** Mirror a remote-only change onto the local entity. */
  apply(value: T): void;
}

/**
 * THREE-WAY MERGE of one MAPPED field — priority or category — entirely in
 * PROVIDER SPACE (invariant 2).
 *
 * Both fields are lossy in the outbound direction (seven local priorities onto
 * four or five provider rungs; three categories onto whatever types a workspace
 * happens to define), so the comparison converts the LOCAL side out through
 * `toProvider` rather than converting the remote side in. A local-space diff
 * would read "P3 here, P2 there" on an issue nobody touched and demote the
 * user's P3 on every pass. The conversion back through `toLocal` happens once,
 * at the single point a remote change is actually applied.
 *
 * The gates, in order, and why that order:
 *
 *  1. BACKFILL (invariant 3). An `undefined` baseline token is a link written
 *     before this field was synced: we do not know where the remote stood, so
 *     any verdict would be invented. Doing nothing lets `composeBaselineJson`'s
 *     unconditional overlay heal the baseline at the end of the same pass.
 *  2. REMOTE UNCHANGED — nothing happened on their side.
 *  3. CONVERGED — the two sides already mean the same provider value. This is
 *     what keeps a P3 (`medium`) quiet when the remote moves to `medium`.
 *  4. UNMAPPED, ahead of the conflict gate on purpose: if the remote token has
 *     no local meaning we cannot apply it, so opening a conflict would offer
 *     the user a "take theirs" button that could not do anything. It is
 *     reported instead.
 *  5. Both sides moved -> conflict; only theirs -> apply.
 */
function mergeMappedField<T extends string>(arm: MappedFieldArm<T>): FieldArmOutcome {
  const { baselineToken, remoteToken } = arm;
  if (baselineToken === undefined) return 'none';
  if (providerTokensEqual(remoteToken, baselineToken)) return 'none';

  const localToken = arm.toProvider(arm.localValue);
  if (providerTokensEqual(remoteToken, localToken)) return 'none';

  const nextLocal = arm.toLocal(remoteToken);
  if (nextLocal === null) return 'unmapped';

  if (!providerTokensEqual(localToken, baselineToken)) {
    arm.conflicts.push({
      field: arm.field,
      localValue: localToken,
      remoteValue: remoteToken,
      remoteLocalValue: nextLocal,
    });
    return 'conflict';
  }
  // Unreachable while `toLocal` and `toProvider` agree (gate 3 would have
  // caught it), but a persisted overlay can carry the two halves independently
  // and a no-op field write would still emit an entity event.
  if (nextLocal === arm.localValue) return 'none';
  arm.apply(nextLocal);
  return 'apply';
}

/**
 * Compose a field conflict's `payload_json`. See {@link TrackerConflictPayload}
 * for why a STAGE row carries the remote's raw state on top of the common keys.
 * Priority and category need nothing extra: unlike a stage, their `remote_value`
 * IS the value the baseline stamp wants (invariant 2 keeps both raw).
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
  if (conflict.remoteLocalValue !== undefined) payload.remoteLocal = conflict.remoteLocalValue;
  return JSON.stringify(payload);
}

/**
 * THREE-WAY MERGE of a linked issue against its baseline, per field
 * (title, description, priority, category, and remote state → local stage).
 *
 *  - remote changed only  → apply the remote value locally
 *  - local changed only   → leave it (outbound owns pushing it back)
 *  - both changed to the same value → converged, nothing to do
 *  - both changed, differently → a conflict, resolved per the connection's mode
 *
 * The title/description arms diff literal text. Priority and category are
 * MAPPED fields and diff in PROVIDER space instead, with two extra outcomes
 * (never-synced and unmappable) — {@link mergeMappedField} owns all of it.
 *
 * Auto mode: every field except stage takes the REMOTE value, stage keeps the
 * LOCAL one, and every override is recorded as an already-resolved conflict row
 * so the log can show what was overridden.
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

  // ----- priority (compared in PROVIDER space — see mergeMappedField) -----
  const priorityOutcome = mergeMappedField<Priority>({
    field: 'priority',
    baselineToken: baseline.priority,
    remoteToken: issue.priority,
    localValue: local.priority,
    toProvider: (value) => providerPriorityToken(ctx.priorityMapping, value),
    toLocal: (token) => localPriorityForToken(ctx.connection.provider, ctx.priorityMapping, token),
    conflicts,
    apply: (value) => {
      fields.priority = value;
    },
  });
  if (priorityOutcome === 'unmapped') report.unmappedFieldValues++;

  // ----- category (Dart only) -----
  // Gated on the PROVIDER's capability, not on the value: Linear and Plane send
  // a structural null here because they model no issue type at all, and running
  // the arm on that would read the absence of the concept as "the tracker
  // cleared this entity's category".
  const categoryOutcome: FieldArmOutcome = !ctx.categorySync
    ? 'none'
    : mergeMappedField<EntityCategory>({
        field: 'category',
        baselineToken: baseline.category,
        remoteToken: issue.category,
        localValue: local.category,
        toProvider: (value) => providerCategoryToken(ctx.categoryMapping, value),
        toLocal: (token) => localCategoryForToken(ctx.categoryMapping, token),
        conflicts,
        apply: (value) => {
          fields.category = value;
        },
      });
  if (categoryOutcome === 'unmapped') report.unmappedFieldValues++;

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
    //
    // A `stageMove` computed here was APPLICABLE (remote-only change, status
    // direction running) and the park has just dropped it along with the rest
    // of the item. Nothing records it: the conflict rows above are about the
    // CONTENT fields, and resolving one advances only its own field's baseline.
    // So the cursor holds, exactly as a held stage does, and the move is
    // re-offered once the item stops being parked. See
    // {@link outcomeForParkedLink} for the later passes.
    return stageDeferred || stageMove !== undefined ? 'stage-deferred' : 'applied';
  }

  // Auto mode: tracker wins content, cyboflow wins stage. Record each override
  // as an already-resolved conflict row before applying it.
  for (const conflict of conflicts) {
    const remoteWins = conflict.field !== 'stage';
    if (remoteWins) applyRemoteConflictValue(ctx, issue, localBody.footer, conflict, fields);
    await recordAutoResolution(
      ctx,
      link,
      local,
      issue,
      conflict,
      remoteWins ? 'auto-remote' : 'auto-local',
    );
  }

  /** The entity refused the stage move; content still landed. */
  let entityLocked = false;
  const hasFields = Object.keys(fields).length > 0;
  if (hasFields || stageMove !== undefined) {
    // The stage move is ours to mirror, not to announce back — stamp where the
    // remote stands before the write-back listener sees the event.
    if (stageMove !== undefined) {
      baselineJson = stampRemoteGroup(ctx, link, baselineJson, remoteWriteBackGroup(ctx, issue));
    }
    try {
      await ctx.router.applyChange(connection.project_id, {
        actor: connection.provider,
        entityType: link.entity_type,
        taskId: link.entity_id,
        ...(hasFields ? { fields } : {}),
        ...(stageMove !== undefined ? { stageId: stageMove } : {}),
      });
      report.updated++;
    } catch (err) {
      // Only the STAGE half can draw these codes, so a rejection with no stage
      // move in the request is somebody else's problem — rethrow it.
      if (stageMove === undefined || !isDeferrableRejection(err)) throw err;
      entityLocked = true;
      // The content merge is independent of the stage and already has its
      // conflicts recorded above; re-running the whole item next pass would
      // file those findings a second time. So retry the half that CAN land.
      if (hasFields) {
        await ctx.router.applyChange(connection.project_id, {
          actor: connection.provider,
          entityType: link.entity_type,
          taskId: link.entity_id,
          fields,
        });
        report.updated++;
      }
      // The stamp written above is deliberately NOT rolled back: it says where
      // the REMOTE stands, which is true whether or not we mirrored it (see
      // {@link stampRemoteGroup}).
    }
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
  // A refused move pins the state half for the SAME reason a held direction
  // does: the remote change has not been mirrored, so it must stay "unseen" or
  // the next pass would compute no delta and silently drop it.
  if (!ctx.applyLinkedStage || entityLocked) snapshot.stateId = baseline.stateId;
  // An UNMAPPED remote value pins its own half, for a third reason: the pass
  // could not express the change, and letting the snapshot advance would make
  // the next pass see no delta and stop reporting it — so a one-line warning
  // about a renamed tracker value would scroll away after a single pass and
  // never appear again. Pinned, it re-derives until the mapping is fixed. The
  // CURSOR still advances (unlike a deferral): the condition is not one that
  // time resolves, and stalling the fetch window on it would block every issue
  // behind this one indefinitely.
  if (priorityOutcome === 'unmapped') snapshot.priority = baseline.priority;
  if (categoryOutcome === 'unmapped') snapshot.category = baseline.category;
  updateBaseline(db, link.id, composeBaselineJson(baselineJson, snapshot));
  if (entityLocked) return 'entity-locked';
  return stageDeferred ? 'stage-deferred' : 'applied';
}

/**
 * Stage the REMOTE side of a conflict Auto mode is resolving in the tracker's
 * favour, onto the `fields` patch the caller is about to apply.
 *
 * An exhaustive switch rather than the two-way branch this replaced: with five
 * conflict fields, a fall-through `else` would silently treat a new field as a
 * description write. `stage` is listed and does nothing — Auto gives status to
 * cyboflow, so its override keeps the LOCAL value and there is nothing to
 * stage.
 */
function applyRemoteConflictValue(
  ctx: SyncContext,
  issue: TrackerIssue,
  footer: string | null,
  conflict: FieldConflict,
  fields: TaskFieldChanges,
): void {
  switch (conflict.field) {
    case 'title':
      fields.title = issue.title;
      return;
    case 'description':
      fields.body = joinBody(issue.description, footer);
      return;
    case 'priority': {
      // The arm never files a conflict for a token it could not map, so this is
      // always present — guarded rather than asserted because the two halves of
      // a persisted mapping can be edited independently.
      const next = localPriorityForToken(ctx.connection.provider, ctx.priorityMapping, issue.priority);
      if (next !== null) fields.priority = next;
      return;
    }
    case 'category': {
      const next = localCategoryForToken(ctx.categoryMapping, issue.category);
      if (next !== null) fields.category = next;
      return;
    }
    case 'stage':
      return;
  }
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
 * `baseline_json` key stamped when the SWEEP archives a link, and cleared when
 * reconciliation resurrects it.
 *
 * IT EXISTS TO MAKE RESURRECTION SELECTIVE. A link can be orphaned for three
 * very different reasons — this sweep decided its issue was gone, the user
 * ruled it out of sync, or our own outbound archive trashed the twin — and only
 * the FIRST is a guess that a later sweep may overturn. Un-archiving on a bare
 * `orphaned_at` would undo the user's own removal on the next pass, which is
 * why the reversible-archival rule needs a marker rather than a null check.
 */
const SWEPT_ARCHIVED_AT = 'sweptArchivedAt';

/** True when THIS module's sweep is what orphaned the link (see {@link SWEPT_ARCHIVED_AT}). */
function wasSweptArchived(link: EntityExternalLinkRow): boolean {
  const stamp = parseJsonObject(link.baseline_json)[SWEPT_ARCHIVED_AT];
  return typeof stamp === 'string' && stamp.length > 0;
}

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
 *
 * ═══ THE RECONCILIATION HALF ═══ (`capabilities.requiresIdReconciliation`,
 * beads only — docs/proposals/tracker-beads-provider.md "4. Pull
 * reconciliation"). For a provider whose `updated_at` cannot be trusted as a
 * change cursor — beads preserves an issue's original stamp across a
 * `bd dolt pull`, and label/comment/dependency edits never bump it at all — the
 * incremental window is not a complete detection path, and the sweep becomes
 * the backstop that closes the gap. Such an adapter reports (id, revision)
 * pairs instead of bare ids, and this pass partitions EVERY id in the listing
 * into exactly one of three classes, each with its own detection path:
 *
 *   UNSEEN   — no link, and no ledger row at the current `config_generation`.
 *              Point-fetched and run through the ordinary import path, which is
 *              what makes a backdated pull-merged issue importable at all. An
 *              imported id needs no ledger row (its link IS the record); one
 *              resolved WITHOUT a link is ledgered at the swept revision.
 *   LEDGERED — a current-generation ledger row exists. Its stored revision is
 *              compared against the swept one: EQUAL COSTS NOTHING (the
 *              zero-lookup guarantee the ledger exists for), and a difference
 *              point-fetches and re-evaluates, so a skipped issue that a
 *              backdated remote edit makes eligible is not suppressed forever.
 *   LINKED   — the link's last-seen fingerprint (`baseline_json.revision`) is
 *              compared against the swept one; a difference point-fetches into
 *              the ordinary merge/conflict path. This is the only thing that
 *              catches a backdated edit to an ALREADY-LINKED issue, which both
 *              the cursor and a bare id diff are blind to.
 *
 * Plus the inverse of archival: an orphaned link whose id REAPPEARS in the
 * listing is put back in sync (see {@link SWEPT_ARCHIVED_AT}). No probe
 * sequence can be atomic with the local archive over a CLI, so archival is
 * defined REVERSIBLE instead — every residual race in that family degrades from
 * "wrongly archived" to "archived for at most one sweep interval, then
 * self-healed".
 *
 * ═══ THE HEAD GUARD ═══ (round 16, BEST-EFFORT). Identity catches a REPLACED
 * database; it says nothing about a concurrent `bd dolt pull` RESTORING an issue
 * inside the same one, between its absent-id lookup and the local archive. So
 * when the adapter can hand back a whole-workspace token
 * ({@link TrackerAdapter.workspaceHead}), it is captured at the top of the sweep
 * and re-read before the FIRST archival decision is applied. A moved token
 * defers the ARCHIVAL SUBSET ONLY — imports, merges and resurrections apply
 * regardless, each individually safe under ordinary merge semantics, and
 * scoping the guard this way keeps a busy workspace from starving the whole
 * sweep.
 *
 * Two deliberate limits. It is skipped entirely with no linked id to address the
 * read with, or when the token cannot be read: a guard that cannot run must
 * degrade to no guard, never to a failed sweep — the reversible-archival rule
 * above is the primary defense and was designed to suffice alone. And the
 * re-read happens LAZILY, at the first link that would actually be archived, so
 * a sweep with nothing to archive (the steady state) spends no extra call, and
 * the token is compared as late as it can be — after the absent-id point
 * lookups, which is strictly narrower than re-reading before them.
 *
 * Providers without the flag take the byte-for-byte path they always did: one
 * `listIssueIds`, no ledger, no fingerprints, no extra adapter calls.
 */
export async function runDeletionSweep(
  deps: InboundSyncDeps,
  connection: TrackerConnectionRow,
): Promise<InboundSweepReport> {
  const { db, adapter, router } = deps;
  const sweep: InboundSweepReport = {
    sweepArchived: 0,
    conflictsOpened: 0,
    outOfScope: 0,
    entityLocked: 0,
    reconcileFetched: 0,
    reconcileImported: 0,
    reconcileLedgered: 0,
    reconcileSkipped: 0,
    resurrected: 0,
    archivalDeferred: 0,
  };

  const selection = parseSourceSelection(connection);
  // BEFORE the listing, so the window the guard covers spans everything the
  // archival decisions were derived from.
  const guard = await openHeadGuard(deps, connection);
  const revisions = await sweepListing(adapter, selection);
  const remoteIds = new Set(revisions.map((entry) => entry.id));

  if (adapter.capabilities.requiresIdReconciliation) {
    await reconcileRemoteIds(deps, connection, selection, revisions, sweep);
  }

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

    // The last thing before the first WRITE of the archival subset: the
    // workspace may have moved under everything above (see the HEAD-guard note).
    if (!(await guard.stillCurrent())) {
      sweep.archivalDeferred++;
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

    try {
      await router.applyChange(connection.project_id, {
        actor: connection.provider,
        entityType: link.entity_type,
        taskId: link.entity_id,
        archived: true,
      });
    } catch (err) {
      if (!isDeferrableRejection(err)) throw err;
      // A live run owns the entity. Nothing below has run, so the link stays
      // active, no conflict row is filed, and the next sweep retries it —
      // whereas letting this propagate abandoned every link behind it.
      sweep.entityLocked++;
      continue;
    }
    markOrphaned(db, link.id);
    // Stamped BEFORE the conflict row so a crash between the two still leaves a
    // link a later sweep can recognize as its own and reverse.
    updateBaseline(
      db,
      link.id,
      JSON.stringify({
        ...parseJsonObject(link.baseline_json),
        [SWEPT_ARCHIVED_AT]: deps.nowIso(),
      }),
    );
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

/**
 * One sweep's archival HEAD guard: the token captured at the start, plus the
 * lazy, memoized re-read that decides whether the archival subset may still be
 * applied. See {@link runDeletionSweep}'s HEAD-guard note for why the guard is
 * scoped to archival, best-effort, and evaluated late.
 */
interface HeadGuard {
  /**
   * True while archival may proceed. The FIRST call re-reads the token and
   * caches the verdict for the rest of the sweep — the question is "did the
   * workspace change under THIS sweep", which has one answer per sweep, and
   * re-reading per link would spend a spawn per archived issue to keep asking it.
   */
  stillCurrent(): Promise<boolean>;
}

/** A guard that always allows — the shape every skip condition degrades to. */
const OPEN_HEAD_GUARD: HeadGuard = { stillCurrent: async () => true };

async function openHeadGuard(
  deps: InboundSyncDeps,
  connection: TrackerConnectionRow,
): Promise<HeadGuard> {
  const { db, adapter } = deps;
  if (!adapter.capabilities.requiresIdReconciliation) return OPEN_HEAD_GUARD;
  const readHead = adapter.workspaceHead;
  if (typeof readHead !== 'function') return OPEN_HEAD_GUARD;

  // Any ACTIVE link answers: the token describes the workspace, and the id is
  // only what the read is addressed with. A connection with none has nothing to
  // archive either, so the guard is moot as well as unavailable.
  const anchor = listLinks(db, connection.id, { activeOnly: true })[0];
  if (anchor === undefined) return OPEN_HEAD_GUARD;

  const captured = await readHead.call(adapter, anchor.external_id);
  if (captured === null) return OPEN_HEAD_GUARD;

  let verdict: boolean | null = null;
  return {
    stillCurrent: async (): Promise<boolean> => {
      if (verdict === null) {
        const current = await readHead.call(adapter, anchor.external_id);
        // An unreadable token now is NOT a moved one: the guard is best-effort,
        // and refusing every archive because a read failed would let one flaky
        // spawn suppress deletion handling indefinitely.
        verdict = current === null || current === captured;
      }
      return verdict;
    },
  };
}

/**
 * The sweep's ground truth, in whichever shape the adapter can provide it.
 *
 * A `requiresIdReconciliation` adapter MUST implement `listIssueRevisions` —
 * the flag is what declares the whole reconciliation contract, and an adapter
 * that sets it without the method would silently degrade to a bare id diff,
 * which is exactly the blind spot the flag exists to close. So that pairing is
 * asserted rather than fallen back from: it is a programming error in the
 * adapter, not a provider condition, and it must fail where it is introduced.
 *
 * Everyone else gets `listIssueIds` and a null revision, which every consumer
 * below reads as "this provider has no fingerprints".
 */
async function sweepListing(
  adapter: TrackerAdapter,
  selection: TrackerSourceSelection,
): Promise<Array<{ id: string; revision: string | null }>> {
  if (!adapter.capabilities.requiresIdReconciliation) {
    return (await adapter.listIssueIds(selection)).map((id) => ({ id, revision: null }));
  }
  if (typeof adapter.listIssueRevisions !== 'function') {
    throw new Error(
      `[trackerSync] the ${adapter.provider} adapter declares requiresIdReconciliation but ` +
        'implements no listIssueRevisions — the reconciliation sweep cannot run without it',
    );
  }
  return await adapter.listIssueRevisions(selection);
}

/**
 * The reconciliation half of the sweep: partition every swept id into
 * unseen / ledgered / linked and spend a point lookup only where one of those
 * classes says a change is possible. See {@link runDeletionSweep}'s header for
 * the class definitions and why each exists.
 *
 * THE SYNC CONTEXT IS BUILT LAZILY, on the first id that actually needs a
 * lookup. It costs two adapter round-trips (states + field options), and the
 * steady state of this pass — every id linked-and-unchanged or
 * ledgered-and-unchanged — needs none of it. A workspace nobody has touched
 * since the last sweep therefore costs exactly one listing, which is the
 * property the ledger was designed to buy.
 */
async function reconcileRemoteIds(
  deps: InboundSyncDeps,
  connection: TrackerConnectionRow,
  selection: TrackerSourceSelection,
  revisions: ReadonlyArray<{ id: string; revision: string | null }>,
  sweep: InboundSweepReport,
): Promise<void> {
  const { db } = deps;
  const ledger = listLedgerEntries(db, connection.id);
  // The ordinary pass's counters, filled in by the merges these point fetches
  // drive. Most have no reader on a sweep — but `conflictsOpened` does: the
  // service adds the sweep's to `conflictsTouched`, which is what broadcasts a
  // 'conflicts' change to the connected view. A conflict a reconciliation merge
  // opened must reach the user as promptly as one the incremental pass opened,
  // so it is folded into the sweep's own count below.
  const report = emptyInboundReport();
  let ctx: SyncContext | null = null;
  const context = async (): Promise<SyncContext> => {
    ctx ??= await buildSyncContext(deps, connection, selection, report);
    return ctx;
  };

  for (const { id, revision } of revisions) {
    const link = getLinkByExternal(db, connection.id, id);

    if (link !== null) {
      // REVERSIBLE ARCHIVAL, first: the id is present remotely, so an orphaning
      // this sweep performed was wrong (or has been overtaken by a restore).
      // Ahead of the fingerprint compare so the resurrected link then merges in
      // the same pass rather than waiting for the next one.
      if (link.orphaned_at !== null && wasSweptArchived(link)) {
        await resurrectSweptLink(deps, connection, link, sweep);
      }
      if (revision !== null && readBaselineRevision(link.baseline_json) === revision) {
        sweep.reconcileSkipped++;
        continue;
      }
      // A link whose remote issue changed (or whose fingerprint we have never
      // stored) takes the ordinary merge/conflict path.
      await reconcileOneIssue(deps, await context(), id, revision, sweep);
      continue;
    }

    const ledgered = ledger.get(id);
    if (
      ledgered !== undefined &&
      ledgered.config_generation === connection.config_generation &&
      revision !== null &&
      ledgered.last_seen_revision === revision
    ) {
      // THE ZERO-LOOKUP CASE. A ledger row from an OLDER generation deliberately
      // fails this test: a mapping/selection change must re-consider every
      // previously-skipped id exactly once, which is what the generation
      // counter buys over deleting the rows outright.
      sweep.reconcileSkipped++;
      continue;
    }

    const resolved = await reconcileOneIssue(deps, await context(), id, revision, sweep);
    if (resolved.outcome === 'linked') {
      // Its link is now the record; a ledger row would be a second, staler one.
      deleteLedgerEntries(db, connection.id, [id]);
      sweep.reconcileImported++;
      continue;
    }
    if (resolved.outcome === 'deferred' || resolved.skipReason === null) {
      // DEFERRED (a held import direction), or gone between the listing and the
      // lookup. Neither is a settled verdict, so nothing is ledgered and the
      // next sweep asks again — a ledger row here would turn a delay into a
      // permanent drop.
      continue;
    }
    upsertLedgerEntry(db, {
      connection_id: connection.id,
      external_id: id,
      reason: resolved.skipReason,
      last_seen_revision: revision,
      config_generation: connection.config_generation,
    });
    sweep.reconcileLedgered++;
  }

  sweep.conflictsOpened += report.conflictsOpened;

  // OPPORTUNISTIC CLEANUP, in the same pass that already holds both sets: a
  // ledger row for an id that is no longer in the remote listing describes
  // nothing, and without this the table would only ever grow.
  const swept = new Set(revisions.map((entry) => entry.id));
  const stale = [...ledger.keys()].filter((id) => !swept.has(id));
  if (stale.length > 0) deleteLedgerEntries(db, connection.id, stale);
}

/** {@link reconcileOneIssue}'s verdict on one point-fetched id. */
interface ReconcileOutcome {
  /**
   * `'linked'` — the id now holds a link (imported, repaired, or already
   * merged). `'deferred'` — a direction hold declined it, so ask again next
   * sweep. `'unlinked'` — resolved without a link.
   */
  outcome: 'linked' | 'deferred' | 'unlinked';
  /**
   * Which permanent-skip gate an UNLINKED id took, or null when no gate ran
   * (the issue vanished between the listing and the lookup). Only a non-null
   * reason may be ledgered — see the caller.
   */
  skipReason: ReconciliationSkipReason | null;
}

/**
 * Point-fetch one swept id and run it through the ordinary inbound path.
 *
 * The fingerprint is stamped onto the link SEPARATELY from whatever the merge
 * did, and that separation is load-bearing: the fingerprint covers labels,
 * comment counts and dependencies, NONE of which have a local counterpart, so a
 * merge can legitimately apply nothing at all and still owe the link a fresh
 * fingerprint. Leaving it unstamped would point-fetch that same issue on every
 * sweep forever.
 */
async function reconcileOneIssue(
  deps: InboundSyncDeps,
  ctx: SyncContext,
  externalId: string,
  sweptRevision: string | null,
  sweep: InboundSweepReport,
): Promise<ReconcileOutcome> {
  sweep.reconcileFetched++;
  const issue = await deps.adapter.getIssue(externalId);
  // Deleted between the listing and this lookup. The deletion pass owns that
  // case for a LINKED id, and an unlinked one simply never existed for us.
  if (issue === null) return { outcome: 'unlinked', skipReason: null };

  // A holder rather than a bare `let`: applyIssue reports the reason through a
  // callback, and a local narrowed to `null` by its own initializer would read
  // back as `null` no matter what the callback wrote.
  const skip: { reason: ReconciliationSkipReason | null } = { reason: null };
  const outcome = await applyIssue(
    {
      ...ctx,
      onPermanentSkip: (reason) => {
        skip.reason = reason;
      },
    },
    issue,
  );

  const link = getLinkByExternal(deps.db, ctx.connection.id, externalId);
  if (link !== null) {
    // Prefer the POINT FETCH's own fingerprint over the swept one: if the issue
    // changed again between the two, this is the value the next sweep's listing
    // will report, so stamping it converges immediately instead of costing one
    // more lookup.
    //
    // A PARKED LINK IS NOT STAMPED. An item behind an open conflict has had
    // NOTHING applied — the merge stood down and waited for the user — so
    // stamping the fingerprint would tell every later sweep "we are up to date
    // with this issue" and the remote change would be lost the moment the
    // conflict is resolved. The cursor path pins these the same way
    // (`contentDeferred`), and here the cursor may never deliver the issue
    // again at all, which is the whole reason this sweep exists. The cost is
    // one point lookup per sweep per OPEN conflict — bounded by a set that is
    // already waiting on a human.
    const revision = issue.revision ?? sweptRevision;
    if (revision !== null && !hasOpenConflictForLink(deps.db, link.id)) {
      updateBaseline(
        deps.db,
        link.id,
        JSON.stringify({ ...parseJsonObject(link.baseline_json), revision }),
      );
    }
    return { outcome: 'linked', skipReason: null };
  }
  return { outcome: outcome === 'applied' ? 'unlinked' : 'deferred', skipReason: skip.reason };
}

/**
 * Put a link this sweep previously archived back in sync, because its remote
 * issue is in the listing again (docs/proposals/tracker-beads-provider.md,
 * round 18). Un-archives the local twin, un-orphans the link, clears the
 * {@link SWEPT_ARCHIVED_AT} marker, and files a review finding so the round
 * trip is visible rather than silent.
 *
 * A REFUSED UN-ARCHIVE IS NOT AN ERROR: a live run owning the entity is the
 * same deferrable condition the archive half already tolerates, and the next
 * sweep sees the same reappeared id and tries again. The marker is left in
 * place in that case so the link stays eligible for exactly this.
 */
async function resurrectSweptLink(
  deps: InboundSyncDeps,
  connection: TrackerConnectionRow,
  link: EntityExternalLinkRow,
  sweep: InboundSweepReport,
): Promise<void> {
  try {
    await deps.router.applyChange(connection.project_id, {
      actor: connection.provider,
      entityType: link.entity_type,
      taskId: link.entity_id,
      archived: false,
    });
  } catch (err) {
    if (!isDeferrableRejection(err)) throw err;
    sweep.entityLocked++;
    return;
  }
  clearOrphaned(deps.db, link.id);
  const blob = parseJsonObject(link.baseline_json);
  delete blob[SWEPT_ARCHIVED_AT];
  updateBaseline(deps.db, link.id, JSON.stringify(blob));
  sweep.resurrected++;

  const reviewRouter = deps.reviewRouter;
  if (reviewRouter === undefined) return;
  const label = PROVIDER_LABEL[connection.provider];
  const identifier = link.external_identifier ?? link.external_id;
  try {
    await reviewRouter.applyReviewItem(connection.project_id, {
      op: 'create',
      actor: connection.provider,
      kind: 'finding',
      title: `Tracker sync un-archived ${identifier} — the issue came back`,
      body: [
        `A reconciliation sweep archived this item because \`${link.external_id}\` was missing`,
        `from ${label}'s issue listing, and a later sweep found it there again. The local entity`,
        'has been un-archived and its link put back in sync — nothing was lost.',
        '',
        'The usual cause is a concurrent restore landing between the sweep\'s lookup and its',
        'archive. Worth knowing about if it repeats.',
      ].join('\n'),
      blocking: false,
      severity: 'info',
      source: `tracker:${connection.provider}`,
      entityType: link.entity_type,
      entityId: link.entity_id,
      payload: { kind: 'finding', category: 'tracker-sync' },
    });
  } catch {
    // Fail-soft, exactly like the auto-resolution findings: an audit record
    // must never sink a sweep that has already done the right thing.
  }
}
