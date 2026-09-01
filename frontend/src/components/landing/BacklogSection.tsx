/**
 * BacklogSection — the violet band: what the backlog holds and what to start next.
 *
 * Three pieces, in increasing commitment:
 *   1. the funnel strip — four stage counts plus the in-flow / awaiting-review
 *      pills, so the shape of the backlog reads at a glance;
 *   2. two pick-lists — the top ideas and the ready-for-development tasks;
 *   3. per-column selection bars that launch a Planner or a Sprint over exactly
 *      what you ticked, without going through the wizard.
 *
 * ## Colors come from the board, not from here
 *
 * The stage bars and the section dot use each {@link BoardStage}'s own
 * `color_oklch`, which is the same value the Backlog board paints its columns
 * with. Hard-coding a parallel palette here would let the two surfaces drift.
 *
 * ## Selection is per-project on purpose
 *
 * A run belongs to one project and one worktree, so a batch spanning two
 * projects has no meaning. The first tick therefore pins the project and every
 * other project's checkbox goes disabled with a tooltip saying why. Planner
 * additionally caps at {@link MAX_PLANNER_IDEAS} because `runs.start` rejects
 * more than that server-side.
 */
import React from 'react';
import { Inbox } from 'lucide-react';
import type { BacklogTaskItem, Board } from '../../../../shared/types/tasks';
import {
  READY_FOR_DEV_POSITION,
  bucketByStage,
  comparePriority,
  deriveCounts,
  effectiveBoardPosition,
  filterTasks,
  unifiedStages,
} from '../Backlog/backlogSelectors';
import {
  Chip,
  DashedToggle,
  GhostButton,
  OutlinePill,
  PrimaryButton,
  ProminentButton,
  SecondaryButton,
  SectionHeader,
  EmptyWell,
} from './QueuePrimitives';

/** `runs.start` accepts at most four seed ideas for a planner batch. */
const MAX_PLANNER_IDEAS = 4;

/** Rows shown per column before the "Show N more" toggle. */
const COLLAPSED_ROW_COUNT = 3;

/** Board positions the funnel strip reports, in order. */
const FUNNEL_POSITIONS = [1, READY_FOR_DEV_POSITION, 7, 9] as const;

/** Fallback labels for the funnel when a project's board has no stage at that position. */
const FUNNEL_FALLBACK_LABELS: Record<number, string> = {
  1: 'Idea',
  6: 'Ready for development',
  7: 'In development',
  9: 'Done',
};

function priorityTone(priority: string): 'neutral' | 'warning' | 'error' {
  if (priority === 'P0') return 'error';
  if (priority === 'P1') return 'warning';
  return 'neutral';
}

/** Flatten the store's top-level-plus-nested-children shape one level (idea/epic → task). */
function flattenOneLevel(tasks: readonly BacklogTaskItem[]): BacklogTaskItem[] {
  const out: BacklogTaskItem[] = [];
  for (const t of tasks) {
    out.push(t);
    if (t.children !== undefined) out.push(...t.children);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pick-list rows
// ---------------------------------------------------------------------------

interface PickRowProps {
  item: BacklogTaskItem;
  checked: boolean;
  /** Disabled with this reason as the tooltip; null when selectable. */
  disabledReason: string | null;
  showProject: boolean;
  projectName: string | null;
  onToggle: () => void;
  testId: string;
}

function PickRow({
  item,
  checked,
  disabledReason,
  showProject,
  projectName,
  onToggle,
  testId,
}: PickRowProps): React.JSX.Element {
  const inFlow = item.inFlow.length > 0;
  return (
    <label
      data-testid={testId}
      title={disabledReason ?? undefined}
      className={`flex items-center gap-[7px] border bg-surface-primary px-[11px] py-[7px] ${
        checked ? 'border-interactive' : 'border-border-primary'
      } ${disabledReason === null ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabledReason !== null}
        onChange={onToggle}
        className="h-3 w-3 shrink-0 accent-[var(--color-interactive-primary)]"
        aria-label={`Select ${item.title}`}
      />
      {item.scope !== null && (
        <Chip tone={item.scope === 'small' ? 'success' : 'warning'}>
          {item.scope === 'small' ? 'S' : 'L'}
        </Chip>
      )}
      <Chip tone={priorityTone(item.priority)}>{item.priority}</Chip>
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-text-primary" title={item.title}>
        {item.title}
      </span>
      {showProject && projectName !== null && <Chip title={projectName}>{projectName}</Chip>}
      {inFlow && <OutlinePill tone="accent">in flow</OutlinePill>}
      <span className="shrink-0 text-[10px] text-text-tertiary">{item.ref}</span>
    </label>
  );
}

/** One pick-list column: kicker, rows, expand toggle, and its selection bar. */
function PickColumn({
  kicker,
  items,
  selectedIds,
  lockedProjectId,
  maxSelectable,
  showProject,
  projectNameById,
  rowTestId,
  launchLabel,
  launchTestId,
  noun,
  launching,
  onToggle,
  onClear,
  onLaunch,
}: {
  kicker: string;
  items: BacklogTaskItem[];
  selectedIds: ReadonlySet<string>;
  /** Project pinned by the current selection across BOTH columns, or null. */
  lockedProjectId: number | null;
  /** Cap on how many rows may be ticked at once; Infinity for no cap. */
  maxSelectable: number;
  showProject: boolean;
  projectNameById: Record<number, string>;
  rowTestId: string;
  launchLabel: string;
  launchTestId: string;
  noun: 'idea' | 'task';
  launching: boolean;
  onToggle: (item: BacklogTaskItem) => void;
  onClear: () => void;
  onLaunch: () => void;
}): React.JSX.Element {
  const [showAll, setShowAll] = React.useState(false);
  const shown = showAll ? items : items.slice(0, COLLAPSED_ROW_COUNT);
  const remaining = items.length - COLLAPSED_ROW_COUNT;
  const atCap = selectedIds.size >= maxSelectable;

  const reasonFor = (item: BacklogTaskItem): string | null => {
    if (selectedIds.has(item.id)) return null;
    if (item.inFlow.length > 0) return 'Already running in a flow';
    if (lockedProjectId !== null && item.project_id !== lockedProjectId) return 'Launch is per-project';
    if (atCap) return `One run accepts at most ${maxSelectable} ${noun}s`;
    return null;
  };

  return (
    <div className="flex flex-col gap-[7px]">
      <div className="eyebrow text-text-tertiary">{kicker}</div>
      {items.length === 0 ? (
        <div className="border border-dashed border-border-primary px-[11px] py-3 text-center text-[10px] text-text-tertiary">
          Nothing here yet.
        </div>
      ) : (
        shown.map((item) => (
          <PickRow
            key={item.id}
            item={item}
            checked={selectedIds.has(item.id)}
            disabledReason={reasonFor(item)}
            showProject={showProject}
            projectName={projectNameById[item.project_id] ?? null}
            onToggle={() => onToggle(item)}
            testId={rowTestId}
          />
        ))
      )}
      {remaining > 0 && (
        <DashedToggle compact onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer ▴' : `Show ${remaining} more ${noun}s ▾`}
        </DashedToggle>
      )}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2.5 border border-interactive bg-interactive/10 px-[11px] py-[7px]">
          <span className="text-[11px] font-semibold text-text-primary">
            {selectedIds.size} {noun}
            {selectedIds.size === 1 ? '' : 's'} selected
          </span>
          <GhostButton onClick={onClear}>Clear</GhostButton>
          <PrimaryButton className="ml-auto" onClick={onLaunch} disabled={launching} data-testid={launchTestId}>
            {launching ? 'Launching…' : launchLabel}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface BacklogSectionProps {
  tasks: BacklogTaskItem[];
  boards: Board[];
  projectNameById: Record<number, string>;
  projectCount: number;
  /**
   * `full` renders everything; `funnel-only` drops the pick-lists (the caught-up
   * state, where the point is the shape and not the next click); `empty` renders
   * the bootstrap well.
   */
  variant: 'full' | 'funnel-only' | 'empty';
  /** Non-null while a launch from this section is in flight. */
  launchingColumn: 'ideas' | 'tasks' | null;
  onOpenBacklog: () => void;
  onLaunchPlanner: (ideaIds: string[], projectId: number) => void;
  onLaunchSprint: (taskIds: string[], projectId: number) => void;
}

/** BacklogSection — see {@link BacklogSectionProps}. */
export function BacklogSection({
  tasks,
  boards,
  projectNameById,
  projectCount,
  variant,
  launchingColumn,
  onOpenBacklog,
  onLaunchPlanner,
  onLaunchSprint,
}: BacklogSectionProps): React.JSX.Element {
  const [selectedIdeaIds, setSelectedIdeaIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [selectedTaskIds, setSelectedTaskIds] = React.useState<ReadonlySet<string>>(() => new Set());

  const stages = React.useMemo(() => unifiedStages(boards, null, false), [boards]);
  const filtered = React.useMemo(() => filterTasks(tasks, null, false), [tasks]);
  const counts = React.useMemo(() => deriveCounts(filtered), [filtered]);
  const buckets = React.useMemo(() => bucketByStage(filtered, stages), [filtered, stages]);

  const countByPosition = React.useMemo(() => {
    const map: Record<number, number> = {};
    for (const bucket of buckets) map[bucket.stage.position] = bucket.tasks.length;
    return map;
  }, [buckets]);

  const colorByPosition = React.useMemo(() => {
    const map: Record<number, string> = {};
    for (const stage of stages) map[stage.position] = stage.color_oklch;
    return map;
  }, [stages]);

  const labelByPosition = React.useMemo(() => {
    const map: Record<number, string> = {};
    for (const stage of stages) map[stage.position] = stage.label;
    return map;
  }, [stages]);

  const topIdeas = React.useMemo(
    () => filtered.filter((t) => t.type === 'idea' && !t.isDone).sort(comparePriority),
    [filtered],
  );

  const readyTasks = React.useMemo(
    () =>
      flattenOneLevel(filtered)
        .filter(
          (t) =>
            t.type === 'task' &&
            !t.isDone &&
            t.archived_at === null &&
            t.inFlow.length === 0 &&
            effectiveBoardPosition(t) === READY_FOR_DEV_POSITION,
        )
        .sort(comparePriority),
    [filtered],
  );

  // One project pins BOTH columns: a sprint and a planner each run in one
  // worktree, and a mixed tick set could not be launched either way.
  const lockedProjectId = React.useMemo(() => {
    const all = [...topIdeas, ...readyTasks];
    const first = all.find((t) => selectedIdeaIds.has(t.id) || selectedTaskIds.has(t.id));
    return first?.project_id ?? null;
  }, [topIdeas, readyTasks, selectedIdeaIds, selectedTaskIds]);

  const toggle = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
  ): ((item: BacklogTaskItem) => void) =>
    (item) => {
      setter((prev) => {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      });
    };

  const sectionDot = colorByPosition[1];

  // An empty backlog always renders the bootstrap well, whatever variant the
  // page asked for — a funnel of four zeros tells the reader nothing.
  if (variant === 'empty' || counts.items === 0) {
    return (
      <section data-testid="rq-backlog-section" className="flex flex-col gap-2.5">
        <SectionHeader dotColor={sectionDot} dotClass={sectionDot === undefined ? 'bg-status-info' : undefined} title="Backlog" count={0} countMuted />
        <EmptyWell
          testId="rq-state-well-backlog-empty"
          icon={<Inbox className="h-[18px] w-[18px] text-text-tertiary" strokeWidth={1.8} />}
          title="Backlog is empty"
          body="Run the Launch flow to seed ideas from a project interview, or add your first idea by hand."
          action={<ProminentButton onClick={onOpenBacklog}>Add an idea</ProminentButton>}
        />
      </section>
    );
  }

  return (
    <section data-testid="rq-backlog-section" className="flex flex-col gap-2.5">
      <SectionHeader
        dotColor={sectionDot}
        dotClass={sectionDot === undefined ? 'bg-status-info' : undefined}
        title="Backlog"
        count={counts.items}
      />

      <div className="flex flex-wrap items-center gap-x-[18px] gap-y-2.5 border border-border-primary bg-surface-primary px-3.5 py-2.5">
        {FUNNEL_POSITIONS.map((position) => (
          <div
            key={position}
            className="flex items-baseline gap-[7px] border-l-[3px] pl-2.5"
            style={{ borderColor: colorByPosition[position] ?? 'var(--color-border-primary)' }}
          >
            <span className="text-[17px] font-bold leading-none tabular-nums text-text-primary">
              {countByPosition[position] ?? 0}
            </span>
            <span className="text-[10px] text-text-secondary">
              {labelByPosition[position] ?? FUNNEL_FALLBACK_LABELS[position]}
            </span>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2.5">
          {counts.inFlow > 0 && <OutlinePill tone="accent">{counts.inFlow} in flow</OutlinePill>}
          {counts.awaitingReview > 0 && (
            <OutlinePill tone="warning">{counts.awaitingReview} awaiting review</OutlinePill>
          )}
          <SecondaryButton onClick={onOpenBacklog}>Open backlog →</SecondaryButton>
        </div>
      </div>

      {variant === 'full' && (
        <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
          <PickColumn
            kicker="Top ideas"
            items={topIdeas}
            selectedIds={selectedIdeaIds}
            lockedProjectId={lockedProjectId}
            maxSelectable={MAX_PLANNER_IDEAS}
            showProject={projectCount > 1}
            projectNameById={projectNameById}
            rowTestId="rq-idea-row"
            launchLabel="Launch planner →"
            launchTestId="rq-launch-planner"
            noun="idea"
            launching={launchingColumn === 'ideas'}
            onToggle={toggle(setSelectedIdeaIds)}
            onClear={() => setSelectedIdeaIds(new Set())}
            onLaunch={() => {
              if (lockedProjectId === null) return;
              onLaunchPlanner([...selectedIdeaIds], lockedProjectId);
              setSelectedIdeaIds(new Set());
            }}
          />
          <PickColumn
            kicker="Next up · Ready for development"
            items={readyTasks}
            selectedIds={selectedTaskIds}
            lockedProjectId={lockedProjectId}
            maxSelectable={Number.POSITIVE_INFINITY}
            showProject={projectCount > 1}
            projectNameById={projectNameById}
            rowTestId="rq-task-row"
            launchLabel="Launch sprint →"
            launchTestId="rq-launch-sprint"
            noun="task"
            launching={launchingColumn === 'tasks'}
            onToggle={toggle(setSelectedTaskIds)}
            onClear={() => setSelectedTaskIds(new Set())}
            onLaunch={() => {
              if (lockedProjectId === null) return;
              onLaunchSprint([...selectedTaskIds], lockedProjectId);
              setSelectedTaskIds(new Set());
            }}
          />
        </div>
      )}
    </section>
  );
}
