/**
 * recommendedActions — pure "what should I do next" engine for the redesigned
 * Human Review Queue landing page.
 *
 * No React, no I/O. Every timestamp comparison takes an explicit `nowMs` so
 * the engine is deterministic and trivially testable. Reuses the existing
 * derivations rather than forking them:
 *   - session triage buckets come from {@link deriveQuickSessionTriage}
 *     (quickSessionTriage.ts) — this module does NOT re-derive blocked/idle/
 *     running state.
 *   - run activity comes from {@link classifyRun} (homeClassify.ts).
 *   - backlog stage/readiness math reuses the exported helpers in
 *     backlogSelectors.ts (`effectiveBoardPosition`, `READY_FOR_DEV_POSITION`,
 *     `isDecomposed`, `comparePriority`).
 *
 * ## Two ranked groups
 *
 * Group 1 (session triage, always ranked first) — review-blocked, merge-clean,
 * rebase-behind, wrap-up-stale, blocking-finding. Group 2 (flow launches,
 * ranked after triage) — launch-sprint, launch-planner, capture-first-idea,
 * run-launch-flow. Within a group, cards are emitted in exactly the catalog
 * order documented on {@link RecommendedActionKind}. At most {@link MAX_VISIBLE}
 * cards are returned as `visible`; anything beyond that is reported as a
 * plain `overflow` count.
 *
 * ## Deliberately NOT implemented (data not available in the frontend)
 *   - Compound-since stats (last compound run summary / staleness).
 *   - Verify-setup runbook state (proven/unproven, per-modality gaps).
 *   - Tracker (Linear/Plane/Dart/Beads) sync conflicts.
 * A future detector can be added to either group without touching the
 * ranking/dismissal machinery below.
 */
import type { QuickSessionRow } from '../../../shared/types/quickSessions';
import type { ActiveRunRow } from '../stores/activeRunsStore';
import type { BacklogTaskItem } from '../../../shared/types/tasks';
import type { IdeaComponentKey, IdeaComponentState } from '../../../shared/types/ideaComponents';
import type { ReviewItem } from '../../../shared/types/reviews';
import { classifyRun } from './homeClassify';
import type { QuickSessionTriage } from './quickSessionTriage';
import {
  READY_FOR_DEV_POSITION,
  comparePriority,
  effectiveBoardPosition,
  isDecomposed,
} from '../components/Backlog/backlogSelectors';
import type { DismissalMap } from './recommendedActionDismissals';

/** The internal sprint-flow workflow name (see shared/types/workflows.ts CYBOFLOW_WORKFLOW_NAMES). */
const SPRINT_WORKFLOW_NAME = 'sprint';

/** Staleness threshold for the `wrap-up-stale` detector — 72 hours. */
const STALE_QUIET_MS = 72 * 60 * 60 * 1000;

/** At most this many cards are ever shown at once; the rest is reported as `overflow`. */
export const MAX_VISIBLE = 6;

// ---------------------------------------------------------------------------
// Narrow input projections
// ---------------------------------------------------------------------------

/** The subset of an active run this engine needs — a projection of {@link ActiveRunRow}. */
export type RecommendedActionsRunRef = Pick<ActiveRunRow, 'project_id' | 'status' | 'workflowName'>;

/** A project's id + display name — everything a card needs to name its project. */
export interface RecommendedActionsProjectRef {
  id: number;
  name: string;
}

/**
 * Full engine input. `tasks` MUST be shaped like {@link BacklogTaskItem}'s
 * store convention: TOP-LEVEL items only, with an epic's child tasks nested
 * under its own `children` array (never a flat list of every entity) — the
 * same shape `backlogStore.tasks` holds.
 */
export interface RecommendedActionsInput {
  nowMs: number;
  quickSessionTriage: QuickSessionTriage;
  activeRuns: readonly RecommendedActionsRunRef[];
  reviewItems: readonly ReviewItem[];
  tasks: readonly BacklogTaskItem[];
  projects: readonly RecommendedActionsProjectRef[];
  dismissedSignatures: DismissalMap;
}

// ---------------------------------------------------------------------------
// Output shape — discriminated union, one variant per card kind
// ---------------------------------------------------------------------------

export type RecommendedActionKind =
  | 'review-blocked'
  | 'merge-clean'
  | 'rebase-behind'
  | 'wrap-up-stale'
  | 'blocking-finding'
  | 'launch-sprint'
  | 'launch-planner'
  | 'capture-first-idea'
  | 'run-launch-flow';

interface RecommendedActionBase {
  id: string;
  title: string;
  description: string;
  ctaLabel: string;
  dismissible: boolean;
  /** Stable digest of the trigger evidence — see the file header's dismissal-semantics note. */
  signature: string;
}

export interface ReviewBlockedAction extends RecommendedActionBase {
  kind: 'review-blocked';
  sessionIds: string[];
}

export interface MergeCleanAction extends RecommendedActionBase {
  kind: 'merge-clean';
  sessionIds: string[];
}

export interface RebaseBehindAction extends RecommendedActionBase {
  kind: 'rebase-behind';
  sessionIds: string[];
}

export interface WrapUpStaleAction extends RecommendedActionBase {
  kind: 'wrap-up-stale';
  sessionIds: string[];
}

export interface BlockingFindingAction extends RecommendedActionBase {
  kind: 'blocking-finding';
  runId: string;
  projectId: number;
  findingIds: string[];
}

export interface LaunchSprintAction extends RecommendedActionBase {
  kind: 'launch-sprint';
  projectId: number;
  taskIds: string[];
}

export interface LaunchPlannerAction extends RecommendedActionBase {
  kind: 'launch-planner';
  projectId: number;
  ideaId: string;
}

export interface CaptureFirstIdeaAction extends RecommendedActionBase {
  kind: 'capture-first-idea';
}

export interface RunLaunchFlowAction extends RecommendedActionBase {
  kind: 'run-launch-flow';
  projectId: number;
}

export type RecommendedAction =
  | ReviewBlockedAction
  | MergeCleanAction
  | RebaseBehindAction
  | WrapUpStaleAction
  | BlockingFindingAction
  | LaunchSprintAction
  | LaunchPlannerAction
  | CaptureFirstIdeaAction
  | RunLaunchFlowAction;

export interface RecommendedActionsResult {
  visible: RecommendedAction[];
  overflow: number;
}

const CTA_LABELS: Record<RecommendedActionKind, string> = {
  'review-blocked': 'Review now',
  'merge-clean': 'Review & merge',
  'rebase-behind': 'Review & rebase',
  'wrap-up-stale': 'Wrap up',
  'blocking-finding': 'Resolve finding',
  'launch-sprint': 'Launch sprint',
  'launch-planner': 'Continue planning',
  'capture-first-idea': 'Capture an idea',
  'run-launch-flow': 'Run Launch',
};

// ---------------------------------------------------------------------------
// Small copy helpers
// ---------------------------------------------------------------------------

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** Join up to 2 names, appending an ", and N more" tail for anything beyond that. */
function joinNames(names: string[]): string {
  const shown = names.slice(0, 2);
  const overflow = names.length - shown.length;
  const base = shown.length === 2 ? `${shown[0]} and ${shown[1]}` : shown[0];
  return overflow > 0 ? `${base}, and ${overflow} more` : base;
}

function sortedIdSignature(ids: string[]): string {
  return [...ids].sort().join(',');
}

function projectName(projects: readonly RecommendedActionsProjectRef[], projectId: number): string {
  return projects.find((p) => p.id === projectId)?.name ?? 'this project';
}

// ---------------------------------------------------------------------------
// Group 1 — session triage
// ---------------------------------------------------------------------------

function buildReviewBlocked(input: RecommendedActionsInput): RecommendedAction[] {
  const rows = input.quickSessionTriage.needsInput;
  if (rows.length === 0) return [];
  const sessionIds = rows.map((r) => r.sessionId);
  const names = rows.map((r) => r.name);
  const count = rows.length;
  return [
    {
      kind: 'review-blocked',
      id: 'review-blocked',
      title: pluralize(count, 'Review the session needing your attention', 'Review sessions needing your attention'),
      description: `${count} ${pluralize(count, 'session is', 'sessions are')} blocked on your answer — ${joinNames(names)}.`,
      ctaLabel: CTA_LABELS['review-blocked'],
      // The headline card — never individually dismissible.
      dismissible: false,
      signature: sortedIdSignature(sessionIds),
      sessionIds,
    },
  ];
}

function formatSessionWithAhead(row: QuickSessionRow): string {
  const ahead = row.git?.ahead ?? 0;
  return `${row.name} (↑${ahead})`;
}

function buildMergeClean(input: RecommendedActionsInput): { action: RecommendedAction | null; usedIds: Set<string> } {
  const rows = input.quickSessionTriage.readyForReview.filter((r) => r.git?.isReadyToMerge === true);
  const usedIds = new Set(rows.map((r) => r.sessionId));
  if (rows.length === 0) return { action: null, usedIds };
  const count = rows.length;
  const sessionIds = rows.map((r) => r.sessionId);
  const namesWithAhead = rows.map(formatSessionWithAhead);
  return {
    action: {
      kind: 'merge-clean',
      id: 'merge-clean',
      title: `Merge ${count} clean ${pluralize(count, 'session', 'sessions')}`,
      description: `${joinNames(namesWithAhead)} ${pluralize(count, 'is', 'are')} ready to merge with ${pluralize(count, 'a clean tree', 'clean trees')}.`,
      ctaLabel: CTA_LABELS['merge-clean'],
      dismissible: true,
      signature: sortedIdSignature(sessionIds),
      sessionIds,
    },
    usedIds,
  };
}

function buildRebaseBehind(
  input: RecommendedActionsInput,
  excludeIds: ReadonlySet<string>,
): { action: RecommendedAction | null; usedIds: Set<string> } {
  const rows = input.quickSessionTriage.readyForReview.filter(
    (r) => !excludeIds.has(r.sessionId) && r.git !== null && r.git.behind > 0,
  );
  const usedIds = new Set(rows.map((r) => r.sessionId));
  if (rows.length === 0) return { action: null, usedIds };
  const count = rows.length;
  const sessionIds = rows.map((r) => r.sessionId);
  const names = rows.map((r) => r.name);
  return {
    action: {
      kind: 'rebase-behind',
      id: 'rebase-behind',
      title: `Rebase ${count} ${pluralize(count, 'session', 'sessions')} behind base`,
      description: `${joinNames(names)} ${pluralize(count, 'needs', 'need')} a rebase before merging.`,
      ctaLabel: CTA_LABELS['rebase-behind'],
      dismissible: true,
      signature: sortedIdSignature(sessionIds),
      sessionIds,
    },
    usedIds,
  };
}

function buildWrapUpStale(
  input: RecommendedActionsInput,
  excludeIds: ReadonlySet<string>,
): RecommendedAction | null {
  const rows = input.quickSessionTriage.readyForReview.filter((r) => {
    if (excludeIds.has(r.sessionId) || r.restedAtIso === null) return false;
    const restedMs = Date.parse(r.restedAtIso);
    if (Number.isNaN(restedMs)) return false;
    return input.nowMs - restedMs > STALE_QUIET_MS;
  });
  if (rows.length === 0) return null;
  const count = rows.length;
  const sessionIds = rows.map((r) => r.sessionId);
  const names = rows.map((r) => r.name);
  return {
    kind: 'wrap-up-stale',
    id: 'wrap-up-stale',
    title: `Wrap up ${count} stale ${pluralize(count, 'session', 'sessions')}`,
    description: `${joinNames(names)} ${pluralize(count, 'has', 'have')} been quiet for over 3 days.`,
    ctaLabel: CTA_LABELS['wrap-up-stale'],
    dismissible: true,
    signature: sortedIdSignature(sessionIds),
    sessionIds,
  };
}

function buildBlockingFindings(input: RecommendedActionsInput): RecommendedAction[] {
  const findings = input.reviewItems.filter(
    (item) => item.kind === 'finding' && item.status === 'pending' && item.blocking && item.run_id !== null,
  );
  const byRun = new Map<string, ReviewItem[]>();
  for (const item of findings) {
    const runId = item.run_id as string;
    const list = byRun.get(runId);
    if (list) list.push(item);
    else byRun.set(runId, [item]);
  }

  const entries: Array<{ action: BlockingFindingAction; newestCreatedAt: string }> = [];
  for (const [runId, items] of byRun) {
    // Newest first within the run's own findings so the representative headline
    // is always the most recent one.
    const sorted = [...items].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    const newest = sorted[0];
    const findingIds = items.map((i) => i.id);
    entries.push({
      action: {
        kind: 'blocking-finding',
        id: `blocking-finding:${runId}`,
        title: 'Blocking finding needs a decision',
        description:
          items.length === 1
            ? `"${newest.title}" is blocking this run.`
            : `${items.length} blocking findings need a decision, including "${newest.title}".`,
        ctaLabel: CTA_LABELS['blocking-finding'],
        dismissible: true,
        signature: `${runId}:${sortedIdSignature(findingIds)}`,
        runId,
        projectId: newest.project_id,
        findingIds,
      },
      newestCreatedAt: newest.created_at,
    });
  }

  // Newest run first, by each run's own newest finding's created_at.
  entries.sort((a, b) => (a.newestCreatedAt < b.newestCreatedAt ? 1 : a.newestCreatedAt > b.newestCreatedAt ? -1 : 0));
  return entries.map((e) => e.action);
}

// ---------------------------------------------------------------------------
// Group 2 — flow launches
// ---------------------------------------------------------------------------

function isReadyForDevTask(t: BacklogTaskItem): boolean {
  return (
    t.type === 'task' &&
    !t.isDone &&
    t.archived_at === null &&
    t.inFlow.length === 0 &&
    effectiveBoardPosition(t) === READY_FOR_DEV_POSITION
  );
}

/** Flatten the store's top-level-plus-nested-children shape one level deep (idea/epic -> task). */
function flattenTasks(tasks: readonly BacklogTaskItem[]): BacklogTaskItem[] {
  const out: BacklogTaskItem[] = [];
  for (const t of tasks) {
    out.push(t);
    if (t.children !== undefined) out.push(...t.children);
  }
  return out;
}

function hasActiveSprintRun(activeRuns: readonly RecommendedActionsRunRef[], projectId: number): boolean {
  return activeRuns.some(
    (r) => r.project_id === projectId && r.workflowName === SPRINT_WORKFLOW_NAME && classifyRun(r.status) !== 'terminal',
  );
}

function buildLaunchSprint(input: RecommendedActionsInput): RecommendedAction[] {
  const flat = flattenTasks(input.tasks);
  const readyByProject = new Map<number, string[]>();
  for (const t of flat) {
    if (!isReadyForDevTask(t)) continue;
    const list = readyByProject.get(t.project_id);
    if (list) list.push(t.id);
    else readyByProject.set(t.project_id, [t.id]);
  }

  const namedProjects = input.projects.length > 1;
  const actions: RecommendedAction[] = [];
  for (const [projectId, taskIds] of readyByProject) {
    if (taskIds.length < 3) continue;
    if (hasActiveSprintRun(input.activeRuns, projectId)) continue;
    const name = projectName(input.projects, projectId);
    actions.push({
      kind: 'launch-sprint',
      id: `launch-sprint:${projectId}`,
      title: namedProjects ? `Launch a sprint for ${name}` : 'Launch a sprint',
      description: `${taskIds.length} tasks are ready for development.`,
      ctaLabel: CTA_LABELS['launch-sprint'],
      dismissible: true,
      signature: `${projectId}:${sortedIdSignature(taskIds)}`,
      projectId,
      taskIds,
    });
  }
  return actions;
}

function componentComplete(components: IdeaComponentState[] | undefined, key: IdeaComponentKey): boolean {
  if (components === undefined || components.length === 0) return false;
  return components.find((c) => c.component === key)?.state === 'complete';
}

function buildLaunchPlanner(input: RecommendedActionsInput): RecommendedAction[] {
  const candidates = input.tasks.filter(
    (t) => t.type === 'idea' && !t.isDone && t.archived_at === null && !isDecomposed(t),
  );
  if (candidates.length === 0) return [];

  const [highest] = [...candidates].sort(comparePriority);
  if (highest.inFlow.length > 0) return [];

  const incomplete = !componentComplete(highest.components, 'idea-spec') && !componentComplete(highest.components, 'stories');
  if (!incomplete) return [];

  return [
    {
      kind: 'launch-planner',
      id: `launch-planner:${highest.id}`,
      title: 'Continue planning',
      description: `"${highest.title}" still needs its idea spec or stories completed.`,
      ctaLabel: CTA_LABELS['launch-planner'],
      dismissible: true,
      signature: `${highest.project_id}:${highest.id}`,
      projectId: highest.project_id,
      ideaId: highest.id,
    },
  ];
}

function buildCaptureFirstIdea(input: RecommendedActionsInput): RecommendedAction[] {
  const anyIdea = input.tasks.some((t) => t.type === 'idea' && t.archived_at === null);
  if (anyIdea) return [];
  return [
    {
      kind: 'capture-first-idea',
      id: 'capture-first-idea',
      title: 'Capture your first idea',
      description: 'You have no ideas yet — write one down to get started.',
      ctaLabel: CTA_LABELS['capture-first-idea'],
      dismissible: true,
      signature: 'no-ideas',
    },
  ];
}

function buildRunLaunchFlow(input: RecommendedActionsInput): RecommendedAction[] {
  const flat = flattenTasks(input.tasks);
  const namedProjects = input.projects.length > 1;
  const actions: RecommendedAction[] = [];
  for (const project of input.projects) {
    const hasAnyEntity = flat.some((t) => t.project_id === project.id);
    if (hasAnyEntity) continue;
    actions.push({
      kind: 'run-launch-flow',
      id: `run-launch-flow:${project.id}`,
      title: namedProjects ? `Run the Launch flow for ${project.name}` : 'Run the Launch flow',
      description: `${project.name}'s backlog is empty — Launch will interview you and seed a starter backlog.`,
      ctaLabel: CTA_LABELS['run-launch-flow'],
      dismissible: true,
      signature: `${project.id}`,
      projectId: project.id,
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// Ranking + dismissal filtering
// ---------------------------------------------------------------------------

function isFilteredByDismissal(action: RecommendedAction, dismissed: DismissalMap): boolean {
  if (!action.dismissible) return false;
  return dismissed[action.id] === action.signature;
}

/**
 * Derive the ranked, dismissal-filtered, MAX_VISIBLE-capped recommended
 * actions for the landing page. See the file header for the group/ranking
 * contract and the per-detector trigger rules.
 */
export function deriveRecommendedActions(input: RecommendedActionsInput): RecommendedActionsResult {
  const merged = buildMergeClean(input);
  const rebase = buildRebaseBehind(input, merged.usedIds);
  const combinedExcluded = new Set<string>([...merged.usedIds, ...rebase.usedIds]);
  const stale = buildWrapUpStale(input, combinedExcluded);

  const ranked: RecommendedAction[] = [
    ...buildReviewBlocked(input),
    ...(merged.action ? [merged.action] : []),
    ...(rebase.action ? [rebase.action] : []),
    ...(stale ? [stale] : []),
    ...buildBlockingFindings(input),
    ...buildLaunchSprint(input),
    ...buildLaunchPlanner(input),
    ...buildCaptureFirstIdea(input),
    ...buildRunLaunchFlow(input),
  ];

  const filtered = ranked.filter((action) => !isFilteredByDismissal(action, input.dismissedSignatures));

  return {
    visible: filtered.slice(0, MAX_VISIBLE),
    overflow: Math.max(0, filtered.length - MAX_VISIBLE),
  };
}
