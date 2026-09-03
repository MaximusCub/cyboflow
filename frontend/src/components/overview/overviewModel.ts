/**
 * overviewModel — pure read-side derivations for the Project Overview page.
 *
 * Framework-free (no React) so it unit-tests trivially and can be reused by
 * whatever renders the page. Mirrors the conventions in
 * frontend/src/components/Backlog/backlogSelectors.ts: every function is a
 * pure projection over already-loaded data, timestamps are taken as ISO
 * string parameters (never `Date.now()` internally), and existing backlog
 * selectors are reused rather than re-derived.
 *
 * Three concerns live here:
 *  1. {@link selectOverviewPageState} — which of the page's empty/normal
 *     states to render, from the project's non-archived backlog alone.
 *  2. {@link deriveOverviewBacklog} — the board-tile counts, top open ideas,
 *     and sprint-eligible "next up" task groups the normal page renders.
 *  3. {@link deriveRecommendedActions} — the "you should probably do this
 *     next" cards, folding in workflow run stats, verification setup, and
 *     tracker conflicts alongside the derived backlog.
 */
import type {
  BacklogTaskItem,
  BoardStage,
  EntityCategory,
  IdeaScope,
  Priority,
} from '../../../../shared/types/tasks';
import type { WorkflowRunStats } from '../../../../shared/types/insights';
import type { VerifyProjectSetupRow } from '../../../../shared/types/visualVerification';
import type { TrackerProvider } from '../../../../shared/types/trackerSync';
import {
  deriveCounts,
  bucketByStage,
  READY_FOR_DEV_POSITION,
  WONT_DO_POSITION,
  type BacklogCounts,
} from '../Backlog/backlogSelectors';
import { groupTasksByEpic } from '../cyboflow/taskGrouping';

// ---------------------------------------------------------------------------
// Shared internal helpers
// ---------------------------------------------------------------------------

/**
 * Every `type === 'task'` entity reachable from the (already non-archived,
 * per this module's contract) top-level list — solo tasks AND tasks nested
 * under an epic's `children`. `tasks.list` nests one level deep only (tasks
 * under epics; epics/ideas never nest further), so this is not recursive.
 * Defensively re-checks `archived_at === null` on children, since a caller
 * that filtered only the top-level array could still hand us an archived
 * child under a live epic.
 */
function allTaskEntities(items: readonly BacklogTaskItem[]): BacklogTaskItem[] {
  const out: BacklogTaskItem[] = [];
  for (const item of items) {
    if (item.type === 'task' && item.archived_at === null) out.push(item);
    for (const child of item.children ?? []) {
      if (child.type === 'task' && child.archived_at === null) out.push(child);
    }
  }
  return out;
}

/**
 * The FlowMarker-style "agent · session" label for a live run association,
 * taking the FIRST `inFlow` entry (mirrors TaskBatchPickerModal's
 * `inFlightLabel`, falling back to the short run id when the hosting session
 * is unresolved). `null` when the item has no live association.
 */
function flowLabel(t: BacklogTaskItem): string | null {
  if (t.inFlow.length === 0) return null;
  const f = t.inFlow[0];
  return `${f.agent} · ${f.sessionName ?? f.runId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// 1. Page state selection
// ---------------------------------------------------------------------------

export type OverviewPageState =
  | 'normal'
  | 'empty-new'
  | 'empty-new-existing'
  | 'empty-ideas'
  | 'empty-drained'
  | 'empty-done';

export interface OverviewPageStateInput {
  /** The project's non-archived backlog items (nested: epic children under `children`). */
  items: BacklogTaskItem[];
  /** Whether the codebase this project points at is freshly initialized. `null` = unknown. */
  codebaseFresh: boolean | null;
}

/**
 * A "sprint-eligible ready pending" task, approximated WITHOUT a board-stage
 * lookup (unlike {@link deriveOverviewBacklog}'s precise
 * `isSprintEligible`, this function's caller has no `BoardStage[]` to check
 * `is_terminal` against). `isDone` stands in for "at the terminal Done stage"
 * and `WONT_DO_POSITION` for the other terminal stage — the same
 * position-constant approach `readyForDevChildTaskIds`/`isExecutionStage`
 * already take elsewhere in backlogSelectors, so this stays consistent with
 * the rest of the codebase's default-board assumptions.
 */
function isReadyPendingApprox(t: BacklogTaskItem): boolean {
  return (
    t.type === 'task' &&
    t.approved_at !== null &&
    t.archived_at === null &&
    !t.isDone &&
    t.stage_position >= READY_FOR_DEV_POSITION &&
    t.stage_position !== WONT_DO_POSITION
  );
}

/** An idea still open on the board: not done, not archived, not decomposed off it. */
function isOpenIdea(t: BacklogTaskItem): boolean {
  return t.type === 'idea' && !t.isDone && t.archived_at === null && t.decomposed_at === null;
}

/**
 * Which empty/normal state the Overview page renders, from the project's
 * non-archived backlog alone (see the module doc for the six states).
 *
 * Order matters: each branch below is checked in the order the design lists
 * them, and the branches are mutually exclusive by construction (empty-drained
 * requires open ideas; empty-done requires none) — see the boundary tests in
 * overviewModel.test.ts for the exact seams.
 */
export function selectOverviewPageState(input: OverviewPageStateInput): OverviewPageState {
  // Defense in depth: the contract says `items` is already non-archived, but
  // an archived top-level row costs nothing extra to drop here too.
  const items = input.items.filter((t) => t.archived_at === null);
  const ideas = items.filter((t) => t.type === 'idea');
  const tasks = allTaskEntities(items);

  const hasAnyIdea = ideas.length > 0;
  const hasAnyTask = tasks.length > 0;
  const hasOpenIdea = ideas.some(isOpenIdea);
  const hasDoneTask = tasks.some((t) => t.isDone);
  const hasPendingTask = tasks.some((t) => !t.isDone);
  const readyPendingCount = tasks.filter(isReadyPendingApprox).length;

  // Nothing ever captured (done items count as "captured" too) — the hero
  // Launch-flow CTA is offered only when the codebase is PROVABLY fresh;
  // unknown freshness falls back to the "existing codebase" empty state.
  if (!hasAnyIdea && !hasAnyTask) {
    return input.codebaseFresh === true ? 'empty-new' : 'empty-new-existing';
  }

  // Ideas waiting to be planned, nothing has ever been decomposed into a task.
  if (hasOpenIdea && !hasAnyTask) {
    return 'empty-ideas';
  }

  // Tasks exist and have been worked, but the pipeline is dry (zero
  // sprint-ready tasks — a remaining pending task, if any, is just not yet
  // approved/ready) AND there is still idea backlog to plan into more tasks.
  if (hasAnyTask && readyPendingCount === 0 && hasDoneTask && hasOpenIdea) {
    return 'empty-drained';
  }

  // Everything captured has shipped and there is nothing left to plan or work.
  if (hasDoneTask && !hasOpenIdea && !hasPendingTask) {
    return 'empty-done';
  }

  return 'normal';
}

// ---------------------------------------------------------------------------
// 2. Backlog derivations (board tiles, top ideas, next-up task groups)
// ---------------------------------------------------------------------------

export interface OverviewStageTile {
  stageId: string;
  label: string;
  /** The stage's `color_oklch` value, verbatim. */
  color: string;
  hint: string | null;
  count: number;
}

export interface OverviewIdea {
  id: string;
  ref: string;
  title: string;
  scope: IdeaScope | null;
  priority: Priority;
  /** True when this idea has a live run association (e.g. an in-flight Planner). */
  inFlow: boolean;
  inFlowLabel: string | null;
}

export interface OverviewTask {
  id: string;
  title: string;
  priority: Priority;
  category: EntityCategory;
  /** Always true for a task surfaced in {@link OverviewTaskGroup.tasks} — every member already passed the sprint-eligibility predicate. */
  eligible: boolean;
  /** True when the task has a live run association and cannot be re-batched. */
  inFlow: boolean;
}

export interface OverviewTaskGroup {
  epicId: string | null;
  /** `'No epic'` for the trailing catch-all group of solo tasks (mirrors EpicGroupedTaskList's convention). */
  epicTitle: string;
  /** Count of `tasks` that are NOT in-flight — actually poolable into a sprint batch right now. */
  readyCount: number;
  totalCount: number;
  tasks: OverviewTask[];
}

export interface OverviewBacklog {
  counts: BacklogCounts;
  stageTiles: OverviewStageTile[];
  topIdeas: OverviewIdea[];
  nextUp: OverviewTaskGroup[];
}

/**
 * The sprint-eligibility predicate mirrored EXACTLY from
 * TaskBatchPickerModal's `isEligible` (the strict `runs.start` pre-check
 * SprintLaneStore.filterEligibleTaskIds enforces server-side): a real task,
 * approved, not archived, at "Ready for development" or later, and not at a
 * terminal stage. Unlike {@link isReadyPendingApprox} above, this has an
 * actual `BoardStage[]` to resolve terminal stage ids from, so it does not
 * need the isDone/WONT_DO_POSITION approximation.
 */
function isSprintEligible(t: BacklogTaskItem, terminalStageIds: ReadonlySet<string>): boolean {
  return (
    t.type === 'task' &&
    t.approved_at !== null &&
    t.archived_at === null &&
    t.stage_position >= READY_FOR_DEV_POSITION &&
    !terminalStageIds.has(t.stage_id)
  );
}

/** P0 (highest) .. P6 (lowest), for the idea sort below. */
const PRIORITY_ORDER: readonly Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

/**
 * Idea sort: priority ascending (P0 first), then `updated_at` DESCENDING.
 * A local comparator rather than backlogSelectors' `comparePriority` because
 * that one's tiebreak is the manual `sort_order` chain, not recency — the
 * Overview's "top ideas" list wants freshest-first among same-priority ideas.
 */
function compareTopIdea(a: BacklogTaskItem, b: BacklogTaskItem): number {
  const diff = PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority);
  if (diff !== 0) return diff;
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? -1 : 1;
  return 0;
}

/**
 * The board-tile counts, top open ideas, and sprint-eligible "next up" task
 * groups the normal Overview page renders. `tasks` is the project's nested
 * backlog list (as returned by `cyboflow.tasks.list`); `stages` is the
 * project's board stages (unfiltered — `is_terminal` is read off the FULL
 * set so both Done and Won't-do count as terminal for sprint eligibility,
 * while `stageTiles` separately excludes `hidden_by_default` stages).
 */
export function deriveOverviewBacklog(tasks: BacklogTaskItem[], stages: BoardStage[]): OverviewBacklog {
  const counts = deriveCounts(tasks);

  const visibleStages = stages.filter((s) => !s.hidden_by_default).slice().sort((a, b) => a.position - b.position);
  const stageTiles: OverviewStageTile[] = bucketByStage(tasks, visibleStages).map((bucket) => ({
    stageId: bucket.stage.id,
    label: bucket.stage.label,
    color: bucket.stage.color_oklch,
    hint: bucket.stage.hint,
    count: bucket.tasks.length,
  }));

  const topIdeas: OverviewIdea[] = tasks
    .filter(isOpenIdea)
    .slice()
    .sort(compareTopIdea)
    .map((t) => ({
      id: t.id,
      ref: t.ref,
      title: t.title,
      scope: t.scope,
      priority: t.priority,
      inFlow: t.inFlow.length > 0,
      inFlowLabel: flowLabel(t),
    }));

  const terminalStageIds = new Set(stages.filter((s) => s.is_terminal).map((s) => s.id));
  const groups = groupTasksByEpic(tasks, (t) => isSprintEligible(t, terminalStageIds));
  const nextUp: OverviewTaskGroup[] = groups.map((g) => {
    const groupTasks: OverviewTask[] = g.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      category: t.category,
      eligible: true,
      inFlow: t.inFlow.length > 0,
    }));
    return {
      epicId: g.epic?.id ?? null,
      epicTitle: g.epic?.title ?? 'No epic',
      readyCount: groupTasks.filter((t) => !t.inFlow).length,
      totalCount: groupTasks.length,
      tasks: groupTasks,
    };
  });

  return { counts, stageTiles, topIdeas, nextUp };
}

// ---------------------------------------------------------------------------
// 3. Recommended actions
// ---------------------------------------------------------------------------

export type RecommendedActionId =
  | 'launch-sprint'
  | 'launch-planner'
  | 'run-compound'
  | 'verify-setup'
  | 'tracker-conflicts';

export type RecommendedActionCtaKind = 'primary' | 'secondary';
export type RecommendedActionAccent = 'terracotta' | 'blue' | 'purple' | 'green' | 'amber';

export interface RecommendedAction {
  id: RecommendedActionId;
  title: string;
  body: string;
  ctaLabel: string;
  ctaKind: RecommendedActionCtaKind;
  accent: RecommendedActionAccent;
  /**
   * Compact encoding of the trigger state this card was computed from.
   * Dismissals are stored as `id → fingerprint`, so a dismissal only holds
   * while the situation that produced the card is unchanged — when the
   * fingerprint moves (new ready tasks, a different top idea, another merged
   * sprint, a conflict-count change) the card reappears.
   */
  fingerprint: string;
}

export interface RecommendedActionsInput {
  backlog: OverviewBacklog;
  /** The project's run stats across all workflows; the 'Sprint' and 'Compound' rows are picked out by `workflowName`. */
  workflowStats: WorkflowRunStats[];
  verifySetup: VerifyProjectSetupRow | undefined;
  trackerConflictCount: number;
  /** `null` when no tracker connection exists for this project. */
  trackerProvider: TrackerProvider | null;
  /** `null` when the connection has never synced. */
  trackerLastSyncAt: string | null;
  /** `id → fingerprint` of dismissed cards (see {@link RecommendedAction.fingerprint}). */
  dismissed: Readonly<Record<string, string>>;
  nowIso: string;
}

/** Display label for a tracker provider (mirrors the wizard's own labels). */
const TRACKER_PROVIDER_LABEL: Record<TrackerProvider, string> = {
  linear: 'Linear',
  plane: 'Plane',
  dart: 'Dart',
  beads: 'Beads',
};

/** Merged-sprint-run threshold that recommends a Compound consolidation pass. */
const COMPOUND_MERGED_RUN_THRESHOLD = 3;

/**
 * "Nm ago" / "today" / "never" for the recommended-action bodies that cite a
 * days-since figure (Compound's last run, a tracker's last sync). `thenIso ===
 * null` means "never happened" and always reads "never". A malformed
 * timestamp on either side also reads "never" rather than throwing or
 * printing `NaN days ago`.
 */
export function formatDaysSince(nowIso: string, thenIso: string | null): string {
  if (thenIso === null) return 'never';
  const now = new Date(nowIso).getTime();
  const then = new Date(thenIso).getTime();
  if (Number.isNaN(now) || Number.isNaN(then)) return 'never';
  const diffMs = Math.max(0, now - then);
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/** Priority pill tone for the Overview UI: P0 hot, P1 warm, P2-P6 neutral (mirrors markers.tsx's `PRIORITY_CLASS` top tier). */
export type PriorityTone = 'red' | 'amber' | 'neutral';

const PRIORITY_TONE: Record<Priority, PriorityTone> = {
  P0: 'red',
  P1: 'amber',
  P2: 'neutral',
  P3: 'neutral',
  P4: 'neutral',
  P5: 'neutral',
  P6: 'neutral',
};

export function priorityTone(priority: Priority): PriorityTone {
  return PRIORITY_TONE[priority];
}

/** The localStorage key an Overview page's per-project dismissals are kept under, as an `actionId → fingerprint` record. A brand-new key — no legacy name exists, so no migrateLocalStorageKey call is needed. */
export function OVERVIEW_DISMISSED_KEY(projectId: number): string {
  return `cyboflow.projectOverview.dismissed.${projectId}`;
}

function pluralRuns(n: number): string {
  return n === 1 ? 'run' : 'runs';
}

/** The partitioned card sets {@link deriveRecommendedActions} returns. */
export interface DerivedRecommendedActions {
  /** Cards to show, in the fixed order (never reordered). */
  active: RecommendedAction[];
  /**
   * Cards that still QUALIFY but are suppressed by a matching dismissal —
   * what the section's "View dismissed" affordance reveals (with a Restore).
   */
  dismissed: RecommendedAction[];
}

/**
 * The "you should probably do this next" cards, in the fixed order
 * launch-sprint → launch-planner → run-compound → verify-setup →
 * tracker-conflicts, partitioned into active vs dismissed-but-qualifying.
 */
export function deriveRecommendedActions(
  input: RecommendedActionsInput,
): DerivedRecommendedActions {
  const actions: RecommendedAction[] = [];

  // launch-sprint: at least one task is actually poolable right now (not
  // merely eligible — in-flight tasks don't count, see OverviewTaskGroup.readyCount).
  const totalReady = input.backlog.nextUp.reduce((sum, g) => sum + g.readyCount, 0);
  if (totalReady > 0) {
    const isOne = totalReady === 1;
    // Fingerprint: the ready-task id set — a task landing in (or leaving)
    // Ready for development resurfaces a dismissed card.
    const readyIds = input.backlog.nextUp
      .flatMap((g) => g.tasks.filter((t) => !t.inFlow).map((t) => t.id))
      .sort()
      .join(',');
    actions.push({
      id: 'launch-sprint',
      title: 'Launch a sprint',
      body: isOne
        ? '1 task is Ready for development — select it below and batch it into a sprint.'
        : `${totalReady} tasks are Ready for development — select them below and batch them into a sprint.`,
      ctaLabel: 'Select tasks',
      ctaKind: 'primary',
      accent: 'terracotta',
      fingerprint: readyIds,
    });
  }

  // launch-planner: the top open idea, by definition never decomposed yet.
  const topIdea = input.backlog.topIdeas[0];
  if (topIdea !== undefined) {
    actions.push({
      id: 'launch-planner',
      title: 'Plan the next idea',
      body: `"${topIdea.title}" is the top idea with no spec or stories yet — plan it before the next sprint.`,
      ctaLabel: 'Open planner',
      ctaKind: 'secondary',
      accent: 'blue',
      // A different idea reaching the top resurfaces a dismissed card.
      fingerprint: topIdea.id,
    });
  }

  // run-compound: enough merged Sprint work has piled up to warrant a
  // consolidation pass, whether or not Compound has ever run before.
  const sprintRow = input.workflowStats.find((s) => s.workflowName === 'Sprint');
  const compoundRow = input.workflowStats.find((s) => s.workflowName === 'Compound');
  const sprintMergedRuns = sprintRow?.mergedRuns ?? 0;
  if (sprintMergedRuns >= COMPOUND_MERGED_RUN_THRESHOLD) {
    const compoundLastRunAt = compoundRow?.lastRunAt ?? null;
    const body =
      compoundLastRunAt === null
        ? `${sprintMergedRuns} sprint ${pluralRuns(sprintMergedRuns)} merged and Compound has never run — run it to consolidate learnings.`
        : `${sprintMergedRuns} sprint ${pluralRuns(sprintMergedRuns)} merged since Compound last ran (${formatDaysSince(input.nowIso, compoundLastRunAt)}) — run it to consolidate learnings.`;
    actions.push({
      id: 'run-compound',
      title: 'Run Compound',
      body,
      ctaLabel: 'Run Compound',
      ctaKind: 'secondary',
      accent: 'purple',
      // Another merged sprint (or a Compound run moving lastRunAt) resurfaces
      // a dismissed card.
      fingerprint: `${sprintMergedRuns}:${compoundLastRunAt ?? 'never'}`,
    });
  }

  // verify-setup: no proven runbook (missing row OR not status 'proven').
  if (input.verifySetup === undefined || input.verifySetup.status !== 'proven') {
    actions.push({
      id: 'verify-setup',
      title: 'No proven verification runbook',
      body: 'No proven runbook for this project — sprint visual checks are being skipped silently.',
      ctaLabel: 'Set up verification',
      ctaKind: 'primary',
      accent: 'amber',
      // Setup-status moves (missing → draft → …) resurface a dismissed card;
      // while nothing changes the dismissal holds.
      fingerprint: input.verifySetup?.status ?? 'missing',
    });
  }

  // tracker-conflicts: any open conflict needs a human ruling.
  if (input.trackerConflictCount > 0) {
    const isOne = input.trackerConflictCount === 1;
    const providerLabel = input.trackerProvider !== null ? TRACKER_PROVIDER_LABEL[input.trackerProvider] : 'your tracker';
    const syncHint =
      input.trackerLastSyncAt === null ? 'never synced' : `last synced ${formatDaysSince(input.nowIso, input.trackerLastSyncAt)}`;
    actions.push({
      id: 'tracker-conflicts',
      title: 'Tracker conflicts need review',
      body: `${input.trackerConflictCount} conflict${isOne ? '' : 's'} need${isOne ? 's' : ''} review in ${providerLabel} (${syncHint}).`,
      ctaLabel: 'Review conflicts',
      ctaKind: 'secondary',
      accent: 'green',
      // The conflict count moving (new conflicts, or some resolved but not
      // all) resurfaces a dismissed card.
      fingerprint: String(input.trackerConflictCount),
    });
  }

  // A dismissal only suppresses the card while its fingerprint still matches
  // the state it was dismissed under; the suppressed cards are still returned
  // (they qualify) so "View dismissed" can show them.
  return {
    active: actions.filter((a) => input.dismissed[a.id] !== a.fingerprint),
    dismissed: actions.filter((a) => input.dismissed[a.id] === a.fingerprint),
  };
}
