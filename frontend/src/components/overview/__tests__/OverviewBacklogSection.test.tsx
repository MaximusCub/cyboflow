/**
 * Component tests for OverviewBacklogSection — the selection + launch wiring:
 *   1. The ideas selection bar appears only once at least one idea is checked,
 *      and "Launch planner →" fires the launcher with exactly the checked ids.
 *   2. An in-flow idea's checkbox is DISABLED (and the row carries its "in flow"
 *      pill) — a seeded idea cannot be re-seeded.
 *   3. Planner cap: selecting more than 4 ideas disables the CTA and explains why.
 *   4. Sprint cap: selecting more than `resolveSprintMaxTasks` tasks does the
 *      same, using the RESOLVED substrate the launch path would pick.
 *   5. The tasks selection bar fires launchSprint with the checked task ids.
 *   6. The "Show N more ideas" expander reveals the ideas past the first three.
 *
 * `useOverviewLaunch` is mocked so the launch assertions are about the ARGS the
 * section passes, not about the run-start ladder (which useTaskRunLauncher's own
 * suite already covers).
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef } from 'react';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

const { launchPlanner, launchSprint, openIdeaSession, resolveEffective } = vi.hoisted(() => ({
  launchPlanner: vi.fn().mockResolvedValue('run-1'),
  launchSprint: vi.fn().mockResolvedValue('run-2'),
  openIdeaSession: vi.fn().mockResolvedValue(undefined),
  resolveEffective: vi.fn().mockResolvedValue({ substrate: 'sdk' }),
}));

vi.mock('../useOverviewLaunch', () => ({
  useOverviewLaunch: () => ({
    launching: null,
    error: null,
    errorKind: null,
    clearError: vi.fn(),
    launchPlanner,
    launchSprint,
  }),
}));

vi.mock('../../../hooks/useIdeaSessionOpener', () => ({
  useIdeaSessionOpener: () => ({ openingTaskId: null, error: null, openIdeaSession }),
}));

vi.mock('../../../stores/configStore', () => ({
  useConfigStore: (selector?: (s: { config: { sprintMaxTasks: undefined } }) => unknown) => {
    const state = { config: { sprintMaxTasks: undefined } };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { substrates: { resolveEffective: { query: resolveEffective } } } },
}));

import { OverviewBacklogSection } from '../OverviewBacklogSection';
import { resolveSprintMaxTasks } from '../../../../../shared/types/sprintBatch';
import type { OverviewBacklog, OverviewIdea, OverviewTask } from '../overviewModel';

/** The cap the section computes for the default (sdk) substrate. */
const SPRINT_CAP = resolveSprintMaxTasks(undefined, 'sdk');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkIdea(n: number, over: Partial<OverviewIdea> = {}): OverviewIdea {
  return {
    id: `idea-${n}`,
    ref: `IDEA-${n}`,
    title: `Idea ${n}`,
    scope: null,
    priority: 'P2',
    inFlow: false,
    inFlowLabel: null,
    ...over,
  };
}

function mkTask(n: number, over: Partial<OverviewTask> = {}): OverviewTask {
  return {
    id: `task-${n}`,
    title: `Task ${n}`,
    priority: 'P2',
    category: 'feature',
    eligible: true,
    inFlow: false,
    ...over,
  };
}

function mkBacklog(over: Partial<OverviewBacklog> = {}): OverviewBacklog {
  return {
    counts: { items: 0, epics: 0, solo: 0, ideas: 0, done: 0, inFlow: 0, awaitingReview: 0 },
    stageTiles: [],
    topIdeas: [],
    nextUp: [],
    ...over,
  };
}

function renderSection(backlog: OverviewBacklog): void {
  render(
    <OverviewBacklogSection
      projectId={7}
      pageState="normal"
      backlog={backlog}
      itemsById={new Map<string, BacklogTaskItem>()}
      nextUpRef={createRef<HTMLDivElement>()}
      onOpenBacklog={vi.fn()}
      onRunPlannerFlow={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('OverviewBacklogSection — idea selection', () => {
  it('shows the selection bar only once an idea is checked and launches the planner with the checked ids', async () => {
    const user = userEvent.setup();
    renderSection(mkBacklog({ topIdeas: [mkIdea(1), mkIdea(2)] }));

    expect(screen.queryByTestId('overview-idea-selection')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('overview-idea-check-idea-2'));
    expect(screen.getByTestId('overview-idea-selection')).toBeInTheDocument();
    expect(screen.getByText('1 idea selected')).toBeInTheDocument();

    await user.click(screen.getByTestId('overview-idea-selection-cta'));
    expect(launchPlanner).toHaveBeenCalledWith(['idea-2'], 7);
  });

  it('disables the checkbox of an idea that already has a live run association', () => {
    renderSection(
      mkBacklog({ topIdeas: [mkIdea(1, { inFlow: true, inFlowLabel: 'planner · misty-owl' })] }),
    );
    expect(screen.getByTestId('overview-idea-check-idea-1')).toBeDisabled();
    expect(screen.getByText('planner · misty-owl')).toBeInTheDocument();
  });

  it('disables the CTA past the 4-idea planner cap and says how many to deselect', async () => {
    const user = userEvent.setup();
    renderSection(mkBacklog({ topIdeas: [1, 2, 3, 4, 5].map((n) => mkIdea(n)) }));

    // Past the first three, the expander gates the rest.
    await user.click(screen.getByTestId('overview-ideas-expander'));
    for (const n of [1, 2, 3, 4, 5]) {
      await user.click(screen.getByTestId(`overview-idea-check-idea-${n}`));
    }

    expect(screen.getByTestId('overview-idea-selection-cta')).toBeDisabled();
    expect(
      screen.getByText('A planner run scopes at most 4 ideas — deselect 1 to launch.'),
    ).toBeInTheDocument();
    expect(launchPlanner).not.toHaveBeenCalled();
  });

  it('the expander reveals the ideas past the first three', async () => {
    const user = userEvent.setup();
    renderSection(mkBacklog({ topIdeas: [1, 2, 3, 4, 5].map((n) => mkIdea(n)) }));

    expect(screen.queryByTestId('overview-idea-idea-4')).not.toBeInTheDocument();
    expect(screen.getByText('Show 2 more ideas ▾')).toBeInTheDocument();

    await user.click(screen.getByTestId('overview-ideas-expander'));
    expect(screen.getByTestId('overview-idea-idea-4')).toBeInTheDocument();
    expect(screen.getByTestId('overview-idea-idea-5')).toBeInTheDocument();
  });
});

describe('OverviewBacklogSection — task selection', () => {
  const group = (tasks: OverviewTask[]) => ({
    epicId: 'epic-1',
    epicTitle: 'Tracker conflict resolution UI',
    readyCount: tasks.filter((t) => !t.inFlow).length,
    totalCount: tasks.length,
    tasks,
  });

  it('launches the sprint with exactly the checked task ids', async () => {
    const user = userEvent.setup();
    renderSection(mkBacklog({ nextUp: [group([mkTask(1), mkTask(2), mkTask(3)])] }));

    await user.click(screen.getByTestId('overview-task-check-task-1'));
    await user.click(screen.getByTestId('overview-task-check-task-3'));

    expect(screen.getByText('2 tasks selected')).toBeInTheDocument();
    await user.click(screen.getByTestId('overview-task-selection-cta'));
    expect(launchSprint).toHaveBeenCalledWith(['task-1', 'task-3'], 7);
  });

  it('disables an in-flow task and blocks the CTA past the resolved sprint cap', async () => {
    const user = userEvent.setup();
    const tasks = Array.from({ length: SPRINT_CAP + 1 }, (_, i) => mkTask(i + 1));
    tasks.push(mkTask(99, { inFlow: true }));
    renderSection(mkBacklog({ nextUp: [group(tasks)] }));

    expect(screen.getByTestId('overview-task-check-task-99')).toBeDisabled();

    for (let i = 1; i <= SPRINT_CAP + 1; i += 1) {
      await user.click(screen.getByTestId(`overview-task-check-task-${i}`));
    }

    expect(screen.getByTestId('overview-task-selection-cta')).toBeDisabled();
    expect(
      screen.getByText(
        `A sprint batch caps at ${SPRINT_CAP} tasks on this substrate — deselect 1 to launch.`,
      ),
    ).toBeInTheDocument();
    expect(launchSprint).not.toHaveBeenCalled();
  });
});
