/**
 * OverviewBacklogSection — section 3 of the Project Overview page: the planning
 * pipeline, and the two places you start work from.
 *
 * Layout (per state):
 *   - summary card: the counts line + in-flow / awaiting-review pills, and the
 *     four stage tiles (left color bar painted from the stage's own
 *     `color_oklch`, inline like KanbanView — a stage color is data, not a token);
 *   - "Top ideas": a checklist collapsed to the first three, with a
 *     "Show N more" expander, a per-row "Open" that opens the idea's home
 *     session, and a selection bar whose "Launch planner →" fires the light
 *     planner launch (capped at {@link PLANNER_MULTI_CAP}, matching both
 *     IdeaPickerModal and the `ideaIds` server-side max);
 *   - "Next up · Ready for development": the sprint-eligible tasks grouped by
 *     epic, the same checkbox idiom, and a "Launch sprint →" bar capped by
 *     `resolveSprintMaxTasks` over the RESOLVED substrate (the same value
 *     TaskBatchPickerModal computes, so this page's cap agrees with the
 *     server-side 400 in `runs.start`).
 *
 * In-flow rows are rendered but NOT selectable — an idea or task that already
 * has a live run association cannot be re-seeded, and showing it disabled with
 * an "in flow" pill explains why instead of silently hiding it.
 *
 * Empty variants live here rather than in the page: each sub-list renders its
 * own dashed well, and `empty-done` replaces the whole list area with the
 * "Backlog clear" banner.
 */
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Inbox, List as ListIcon } from 'lucide-react';
import { CategoryTag, PriorityTag, ScopeTag, TypeTag } from '../Backlog/markers';
import {
  SectionHeader,
  EmptyWell,
  SelectCheckbox,
  FlowPill,
  ReviewPill,
  ListLabel,
} from './overviewChrome';
import { useOverviewLaunch } from './useOverviewLaunch';
import { useIdeaSessionOpener } from '../../hooks/useIdeaSessionOpener';
import { useConfigStore } from '../../stores/configStore';
import { trpc } from '../../trpc/client';
import { resolveSprintMaxTasks } from '../../../../shared/types/sprintBatch';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import type { OverviewBacklog, OverviewIdea, OverviewPageState, OverviewTask } from './overviewModel';

/** Planner multi-idea batch cap — mirrors IdeaPickerModal's MULTI_CAP and `runs.start`'s `ideaIds` max. */
const PLANNER_MULTI_CAP = 4;

/** How many ideas the "Top ideas" list shows before the expander. */
const TOP_IDEA_COLLAPSED = 3;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function IdeaRow({
  idea,
  checked,
  disabled,
  onToggle,
  onOpen,
  opening,
}: {
  idea: OverviewIdea;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onOpen: () => void;
  opening: boolean;
}): React.JSX.Element {
  return (
    <div
      data-testid={`overview-idea-${idea.id}`}
      className={`flex items-center gap-2 border bg-surface-primary px-3.5 py-2 ${
        checked ? 'border-interactive' : 'border-border-primary'
      } ${idea.inFlow ? 'opacity-70' : ''}`}
    >
      <SelectCheckbox
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        label={idea.title}
        testId={`overview-idea-check-${idea.id}`}
      />
      <TypeTag type="idea" />
      {idea.scope !== null && <ScopeTag scope={idea.scope} />}
      <PriorityTag priority={idea.priority} />
      <span className="flex-1 truncate font-semibold text-text-primary" style={{ fontSize: '12px' }}>
        {idea.title}
      </span>
      {idea.inFlow && <FlowPill>{idea.inFlowLabel ?? 'in flow'}</FlowPill>}
      <span className="shrink-0 text-text-muted" style={{ fontSize: '10px' }}>
        {idea.ref}
      </span>
      <button
        type="button"
        onClick={onOpen}
        disabled={opening}
        className="shrink-0 border border-border-primary bg-surface-primary px-2.5 py-0.5 font-semibold text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        style={{ fontSize: '11px' }}
      >
        {opening ? 'Opening…' : 'Open'}
      </button>
    </div>
  );
}

function TaskRow({
  task,
  refLabel,
  checked,
  disabled,
  onToggle,
}: {
  task: OverviewTask;
  refLabel: string | null;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <div
      data-testid={`overview-task-${task.id}`}
      className={`flex items-center gap-2 border bg-surface-primary px-3.5 py-2 ${
        checked ? 'border-interactive' : 'border-border-primary'
      } ${task.inFlow ? 'opacity-70' : ''}`}
    >
      <SelectCheckbox
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
        label={task.title}
        testId={`overview-task-check-${task.id}`}
      />
      <PriorityTag priority={task.priority} />
      <CategoryTag category={task.category} />
      <span className="flex-1 truncate font-semibold text-text-primary" style={{ fontSize: '12px' }}>
        {task.title}
      </span>
      {task.inFlow && <FlowPill>in flow</FlowPill>}
      {refLabel !== null && (
        <span className="shrink-0 text-text-muted" style={{ fontSize: '10px' }}>
          {refLabel}
        </span>
      )}
    </div>
  );
}

/** The rust selection bar shared by the idea and task lists. */
function SelectionBar({
  count,
  noun,
  ctaLabel,
  ctaDisabled,
  busy,
  hint,
  error,
  onClear,
  onLaunch,
  testId,
}: {
  count: number;
  noun: string;
  ctaLabel: string;
  ctaDisabled: boolean;
  busy: boolean;
  hint: string | null;
  error: string | null;
  onClear: () => void;
  onLaunch: () => void;
  testId: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      {hint !== null && (
        <p className="text-text-muted" style={{ fontSize: '11px' }}>
          {hint}
        </p>
      )}
      {error !== null && (
        <p className="text-status-error" role="alert" style={{ fontSize: '11px' }}>
          {error}
        </p>
      )}
      <div className="flex items-center gap-3 border border-interactive bg-interactive-surface px-3.5 py-2.5">
        <span className="font-semibold text-text-primary" style={{ fontSize: '12px' }}>
          {count} {noun}
          {count === 1 ? '' : 's'} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-text-muted hover:text-text-secondary"
          style={{ fontSize: '10px' }}
        >
          Clear selection
        </button>
        <button
          type="button"
          onClick={onLaunch}
          disabled={ctaDisabled || busy}
          data-testid={`${testId}-cta`}
          className="ml-auto border border-interactive-hover bg-interactive px-3.5 py-1 font-semibold text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
          style={{ fontSize: '12px' }}
        >
          {busy ? 'Launching…' : `${ctaLabel} →`}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface OverviewBacklogSectionProps {
  projectId: number;
  pageState: OverviewPageState;
  backlog: OverviewBacklog;
  /**
   * The project's raw backlog rows, keyed lookup for the two things the derived
   * model deliberately does not carry: the `BacklogTaskItem` an idea "Open"
   * needs, and a task's display `ref`.
   */
  itemsById: Map<string, BacklogTaskItem>;
  /** Opens the backlog pane filtered to this project. */
  onOpenBacklog: () => void;
  /** Opens the wizard preselected to the planner (the "no ideas yet" escape hatch). */
  onRunPlannerFlow: () => void;
}

export function OverviewBacklogSection({
  projectId,
  pageState,
  backlog,
  itemsById,
  onOpenBacklog,
  onRunPlannerFlow,
}: OverviewBacklogSectionProps): React.JSX.Element {
  const [ideasExpanded, setIdeasExpanded] = useState(false);
  const [selectedIdeaIds, setSelectedIdeaIds] = useState<string[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);

  const { launching, error, errorKind, clearError, launchPlanner, launchSprint } =
    useOverviewLaunch();
  const { openingTaskId, error: openError, openIdeaSession } = useIdeaSessionOpener();

  // Sprint cap: the user's per-substrate override resolved against the
  // substrate the launch path would actually pick (identical to
  // TaskBatchPickerModal). Falls back to 'sdk' until the resolver answers.
  const sprintMaxTasks = useConfigStore((s) => s.config?.sprintMaxTasks);
  const [effectiveSubstrate, setEffectiveSubstrate] = useState<CliSubstrate>('sdk');
  useEffect(() => {
    let cancelled = false;
    trpc.cyboflow.substrates.resolveEffective
      .query({})
      .then((res) => {
        if (!cancelled) setEffectiveSubstrate(res.substrate);
      })
      .catch((err: unknown) => {
        // The server-side cap in runs.start is the real guard — a failed
        // preview must not block the page.
        console.warn('[OverviewBacklogSection] substrate resolve failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const sprintCap = resolveSprintMaxTasks(sprintMaxTasks, effectiveSubstrate);

  // Selections are pruned to what is still selectable whenever the data moves
  // (a row going in-flow, or leaving the list entirely).
  const selectableIdeaIds = useMemo(
    () => new Set(backlog.topIdeas.filter((i) => !i.inFlow).map((i) => i.id)),
    [backlog.topIdeas],
  );
  const selectableTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of backlog.nextUp) for (const t of g.tasks) if (!t.inFlow) ids.add(t.id);
    return ids;
  }, [backlog.nextUp]);

  useEffect(() => {
    setSelectedIdeaIds((prev) => {
      const next = prev.filter((id) => selectableIdeaIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [selectableIdeaIds]);
  useEffect(() => {
    setSelectedTaskIds((prev) => {
      const next = prev.filter((id) => selectableTaskIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [selectableTaskIds]);

  const toggleIdea = (id: string): void => {
    clearError();
    setSelectedIdeaIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };
  const toggleTask = (id: string): void => {
    clearError();
    setSelectedTaskIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const visibleIdeas = ideasExpanded
    ? backlog.topIdeas
    : backlog.topIdeas.slice(0, TOP_IDEA_COLLAPSED);
  const hiddenIdeaCount = backlog.topIdeas.length - visibleIdeas.length;

  const overIdeaCap = selectedIdeaIds.length > PLANNER_MULTI_CAP;
  const overTaskCap = selectedTaskIds.length > sprintCap;

  const counts = backlog.counts;
  const countsLine = [
    `${counts.items} item${counts.items === 1 ? '' : 's'}`,
    `${counts.epics} epic${counts.epics === 1 ? '' : 's'}`,
    `${counts.solo} solo`,
    `${counts.ideas} idea${counts.ideas === 1 ? '' : 's'}`,
    `${counts.done} done`,
  ].join(' · ');

  const isDone = pageState === 'empty-done';
  const backlogEmpty = pageState === 'empty-new' || pageState === 'empty-new-existing';

  return (
    <section className="flex flex-col gap-2.5" data-testid="overview-backlog">
      <SectionHeader
        dotColor="var(--color-phase-plan)"
        title="Backlog"
        count={counts.items}
      />

      {backlogEmpty ? (
        <EmptyWell
          icon={Inbox}
          title="Backlog is empty"
          hint={
            pageState === 'empty-new'
              ? 'Run the Launch flow to seed ideas from a project interview, or add your first idea by hand.'
              : 'Add your first idea by hand, or launch a planner — it interviews you and drafts the spec.'
          }
          action={{ label: 'Add an idea', onClick: onOpenBacklog }}
          tall
          testId="overview-backlog-empty"
        />
      ) : (
        <>
          {isDone && (
            <div
              data-testid="overview-backlog-clear"
              className="flex items-center gap-3 border border-border-primary bg-surface-primary px-4 py-3.5"
              style={{ boxShadow: 'inset 3px 0 0 var(--color-status-success)' }}
            >
              <CheckCircle2
                className="h-5 w-5 shrink-0 text-status-success"
                strokeWidth={1.8}
                aria-hidden="true"
              />
              <div className="flex flex-col gap-0.5">
                <div className="font-bold text-text-primary" style={{ fontSize: '13px' }}>
                  Backlog clear
                </div>
                <div className="text-text-secondary" style={{ fontSize: '11.5px' }}>
                  All {counts.items} item{counts.items === 1 ? '' : 's'} shipped — {counts.done} done
                  across {counts.epics} epic{counts.epics === 1 ? '' : 's'}.
                </div>
              </div>
              <button
                type="button"
                onClick={onOpenBacklog}
                className="ml-auto shrink-0 text-interactive hover:text-interactive-hover"
                style={{ fontSize: '11px' }}
              >
                View done items →
              </button>
            </div>
          )}

          {/* Summary card — counts line + stage tiles */}
          <div className="flex flex-col gap-3 border border-border-primary bg-surface-primary px-4 py-3.5">
            {!isDone && (
              <div
                className="flex flex-wrap items-center gap-2.5 text-text-secondary"
                style={{ fontSize: '12px' }}
              >
                <span data-testid="overview-counts-line">{countsLine}</span>
                {counts.inFlow > 0 && <FlowPill>{counts.inFlow} in flow</FlowPill>}
                {counts.awaitingReview > 0 && (
                  <ReviewPill>{counts.awaitingReview} awaiting review</ReviewPill>
                )}
              </div>
            )}
            {/* auto-fit: column count follows the PANE's width, not viewport
                breakpoints (which lie when side panels compress the center),
                and empty tracks collapse so the tiles always fill the card. */}
            <div
              className="grid gap-2.5"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}
            >
              {backlog.stageTiles.map((tile) => (
                <div
                  key={tile.stageId}
                  data-testid={`overview-stage-${tile.stageId}`}
                  className="flex flex-col gap-1 py-1 pl-3"
                  style={{ borderLeft: `3px solid ${tile.color}` }}
                >
                  <div className="truncate text-text-secondary" style={{ fontSize: '11px' }}>
                    {tile.label}
                  </div>
                  <div
                    className={`font-bold leading-none ${
                      tile.count === 0 ? 'text-text-muted' : 'text-text-primary'
                    }`}
                    style={{ fontSize: '26px' }}
                  >
                    {tile.count}
                  </div>
                  {tile.hint !== null && (
                    <div className="truncate text-text-muted" style={{ fontSize: '10px' }}>
                      {tile.hint}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {!isDone && (
            <>
              {/* ── Top ideas ─────────────────────────────────────────── */}
              <ListLabel>Top ideas</ListLabel>
              {backlog.topIdeas.length === 0 ? (
                <EmptyWell
                  icon={Inbox}
                  title="No open ideas"
                  hint="Every idea has been planned or closed. Capture a new one to start the next piece of work."
                  action={{ label: 'Add an idea', onClick: onOpenBacklog }}
                  testId="overview-ideas-empty"
                />
              ) : (
                <>
                  {visibleIdeas.map((idea) => (
                    <IdeaRow
                      key={idea.id}
                      idea={idea}
                      checked={selectedIdeaIds.includes(idea.id)}
                      disabled={idea.inFlow}
                      onToggle={() => toggleIdea(idea.id)}
                      opening={openingTaskId === idea.id}
                      onOpen={() => {
                        const item = itemsById.get(idea.id);
                        if (item !== undefined) void openIdeaSession(item);
                      }}
                    />
                  ))}
                  {hiddenIdeaCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setIdeasExpanded(true)}
                      data-testid="overview-ideas-expander"
                      className="border border-dashed border-border-primary py-1.5 text-text-secondary hover:text-text-primary"
                      style={{ fontSize: '11px' }}
                    >
                      Show {hiddenIdeaCount} more idea{hiddenIdeaCount === 1 ? '' : 's'} ▾
                    </button>
                  )}
                  {openError !== null && (
                    <p className="text-status-error" role="alert" style={{ fontSize: '11px' }}>
                      {openError}
                    </p>
                  )}
                  {selectedIdeaIds.length > 0 && (
                    <SelectionBar
                      testId="overview-idea-selection"
                      count={selectedIdeaIds.length}
                      noun="idea"
                      ctaLabel="Launch planner"
                      ctaDisabled={overIdeaCap}
                      busy={launching === 'planner'}
                      hint={
                        overIdeaCap
                          ? `A planner run scopes at most ${PLANNER_MULTI_CAP} ideas — deselect ${
                              selectedIdeaIds.length - PLANNER_MULTI_CAP
                            } to launch.`
                          : null
                      }
                      error={errorKind === 'planner' ? error : null}
                      onClear={() => setSelectedIdeaIds([])}
                      onLaunch={() => void launchPlanner(selectedIdeaIds, projectId)}
                    />
                  )}
                </>
              )}

              {/* ── Next up ───────────────────────────────────────────── */}
              <div className="flex flex-col gap-2.5">
                <ListLabel>Next up · Ready for development</ListLabel>
                {backlog.nextUp.length === 0 ? (
                  <EmptyWell
                    icon={ListIcon}
                    title={
                      pageState === 'empty-drained'
                        ? 'Task queue is empty — everything captured has shipped'
                        : 'No tasks yet'
                    }
                    hint="Decompose an idea with a planner — approved tasks land here, ready to batch into a sprint."
                    action={{ label: 'Launch a planner', onClick: onRunPlannerFlow }}
                    testId="overview-nextup-empty"
                  />
                ) : (
                  <>
                    {backlog.nextUp.map((group) => (
                      <div
                        key={group.epicId ?? '__solo__'}
                        className="flex flex-col gap-2"
                        data-testid={`overview-group-${group.epicId ?? 'solo'}`}
                      >
                        <div className="flex items-center gap-2">
                          {group.epicId !== null && (
                            <span className="text-text-muted" style={{ fontSize: '10px' }}>
                              {itemsById.get(group.epicId)?.ref ?? ''}
                            </span>
                          )}
                          <span
                            className="truncate font-bold text-text-primary"
                            style={{ fontSize: '11px' }}
                          >
                            {group.epicTitle}
                          </span>
                          <span
                            className="ml-auto shrink-0 text-text-muted"
                            style={{ fontSize: '10px' }}
                          >
                            {group.readyCount} of {group.totalCount} task
                            {group.totalCount === 1 ? '' : 's'} ready
                          </span>
                        </div>
                        <div className="flex flex-col gap-2 pl-3.5">
                          {group.tasks.map((task) => {
                            const checked = selectedTaskIds.includes(task.id);
                            return (
                              <TaskRow
                                key={task.id}
                                task={task}
                                refLabel={itemsById.get(task.id)?.ref ?? null}
                                checked={checked}
                                disabled={task.inFlow}
                                onToggle={() => toggleTask(task.id)}
                              />
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    {selectedTaskIds.length > 0 && (
                      <SelectionBar
                        testId="overview-task-selection"
                        count={selectedTaskIds.length}
                        noun="task"
                        ctaLabel="Launch sprint"
                        ctaDisabled={overTaskCap}
                        busy={launching === 'sprint'}
                        hint={
                          overTaskCap
                            ? `A sprint batch caps at ${sprintCap} tasks on this substrate — deselect ${
                                selectedTaskIds.length - sprintCap
                              } to launch.`
                            : null
                        }
                        error={errorKind === 'sprint' ? error : null}
                        onClear={() => setSelectedTaskIds([])}
                        onLaunch={() => void launchSprint(selectedTaskIds, projectId)}
                      />
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
