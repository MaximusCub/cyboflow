/**
 * Component tests for ProjectOverviewPage — the page's OWN wiring:
 *   1. Page-state routing: each of the six {@link OverviewPageState} values
 *      renders the variant the design specifies (the recommended-actions
 *      descriptor line + the backlog body that goes with it).
 *   2. Recommended-action dismissal: clicking Dismiss removes the card AND
 *      persists the id under OVERVIEW_DISMISSED_KEY(projectId), so it stays
 *      gone on the next mount.
 *
 * Everything the page reads is mocked at the LEAF (the four stores, the tRPC
 * client, the idea-session opener) so these tests exercise the page's own
 * derivation + routing rather than any store's fetch lifecycle. The pure model
 * is NOT mocked — routing is the thing under test, and stubbing the selector
 * would test the stub.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem, Board, BoardStage } from '../../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Store mocks — a tiny zustand-shaped double: callable with a selector, plus
// a getState() for the imperative `useX.getState().init()` call sites.
// ---------------------------------------------------------------------------

interface MockStore<T> {
  (selector?: (s: T) => unknown): unknown;
  getState: () => T;
  __set: (next: Partial<T>) => void;
}

const {
  backlogStore,
  activeRunsStore,
  quickSessionsStore,
  reviewQueueStore,
  navigationStore,
  configStore,
  cyboflowStore,
} = vi.hoisted(() => {
  function makeStore<T extends object>(initial: T): MockStore<T> {
    let state = initial;
    const hook = ((selector?: (s: T) => unknown) =>
      selector ? selector(state) : state) as MockStore<T>;
    hook.getState = () => state;
    hook.__set = (next: Partial<T>) => {
      state = { ...state, ...next };
    };
    return hook;
  }
  const teardown = () => () => {};
  return {
    backlogStore: makeStore({
      tasks: [] as BacklogTaskItem[],
      boards: [] as Board[],
      projects: [{ id: 1, name: 'cyboflow' }],
      init: teardown,
      setFilterProject: vi.fn(),
    }),
    activeRunsStore: makeStore({
      runsByProject: {} as Record<number, unknown[]>,
      init: teardown,
      refresh: vi.fn().mockResolvedValue(undefined),
    }),
    quickSessionsStore: makeStore({ rows: [] as unknown[], init: teardown }),
    reviewQueueStore: makeStore({ queue: [] as unknown[], init: teardown }),
    navigationStore: makeStore({
      openHumanReview: vi.fn(),
      openBacklog: vi.fn(),
      openSettings: vi.fn(),
      goToWizard: vi.fn(),
      setActiveProjectId: vi.fn(),
      goToSession: vi.fn(),
    }),
    configStore: makeStore({ config: { sprintMaxTasks: undefined } }),
    cyboflowStore: makeStore({ activeRunId: null, initModel: null, setActiveRun: vi.fn() }),
  };
});

vi.mock('../../../stores/backlogStore', () => ({ useBacklogStore: backlogStore }));
vi.mock('../../../stores/activeRunsStore', () => ({
  useActiveRunsStore: activeRunsStore,
  isTerminalRunStatus: (s: string) => ['completed', 'failed', 'canceled'].includes(s),
}));
vi.mock('../../../stores/quickSessionsStore', () => ({ useQuickSessionsStore: quickSessionsStore }));
vi.mock('../../../stores/reviewQueueStore', () => ({ useReviewQueueStore: reviewQueueStore }));
vi.mock('../../../stores/navigationStore', () => ({ useNavigationStore: navigationStore }));
vi.mock('../../../stores/configStore', () => ({ useConfigStore: configStore }));
vi.mock('../../../stores/cyboflowStore', () => ({ useCyboflowStore: cyboflowStore }));

vi.mock('../../../hooks/useIdeaSessionOpener', () => ({
  useIdeaSessionOpener: () => ({ openingTaskId: null, error: null, openIdeaSession: vi.fn() }),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      insights: { workflowStats: { query: vi.fn().mockResolvedValue([]) } },
      verificationRequests: { setupByProject: { query: vi.fn().mockResolvedValue([]) } },
      tracker: { connections: { query: vi.fn().mockResolvedValue([]) } },
      substrates: { resolveEffective: { query: vi.fn().mockResolvedValue({ substrate: 'sdk' }) } },
      workflows: { list: { query: vi.fn().mockResolvedValue([]) } },
      runs: { start: { mutate: vi.fn() } },
      approvals: { approve: { mutate: vi.fn() }, reject: { mutate: vi.fn() } },
    },
  },
}));

import { ProjectOverviewPage } from '../ProjectOverviewPage';
import { OVERVIEW_DISMISSED_KEY } from '../overviewModel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function stage(position: number, label: string, over: Partial<BoardStage> = {}): BoardStage {
  return {
    id: over.id ?? `s-${position}`,
    label,
    color_oklch: 'oklch(0.5 0.1 0)',
    hint: over.hint ?? null,
    position,
    write_policy: over.write_policy ?? 'asserted',
    is_terminal: over.is_terminal ?? false,
    hidden_by_default: over.hidden_by_default ?? false,
  };
}

const STAGES: BoardStage[] = [
  stage(1, 'Idea'),
  stage(6, 'Ready for development'),
  stage(7, 'In development', { write_policy: 'derived' }),
  stage(9, 'Done', { is_terminal: true }),
];

const BOARD: Board = {
  id: 'board-1',
  project_id: 1,
  name: 'Default',
  kind: 'default',
  is_default: true,
  stages: STAGES,
};

let idCounter = 0;
function item(over: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  idCounter += 1;
  const n = idCounter;
  return {
    id: `id-${n}`,
    project_id: 1,
    type: 'task',
    ref: `TASK-${n}`,
    title: `Item ${n}`,
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 's-6',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

const idea = (over: Partial<BacklogTaskItem> = {}): BacklogTaskItem =>
  item({ type: 'idea', ref: 'IDEA-1', stage_id: 's-1', stage_position: 1, approved_at: null, ...over });

const doneTask = (over: Partial<BacklogTaskItem> = {}): BacklogTaskItem =>
  item({ stage_id: 's-9', stage_position: 9, isDone: true, ...over });

function mount(tasks: BacklogTaskItem[]): void {
  backlogStore.__set({ tasks, boards: [BOARD] });
  render(<ProjectOverviewPage projectId={1} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  backlogStore.__set({ tasks: [], boards: [BOARD] });
});

// ---------------------------------------------------------------------------
// 1. Page-state routing
// ---------------------------------------------------------------------------

describe('ProjectOverviewPage — page-state routing', () => {
  it('empty-new-existing: an empty backlog with unknown codebase freshness shows the existing-codebase card set', async () => {
    mount([]);
    expect(await screen.findByText('Where to start in an existing codebase')).toBeInTheDocument();
    expect(screen.getByTestId('overview-backlog-empty')).toBeInTheDocument();
    expect(screen.getByTestId('overview-action-launch-planner')).toBeInTheDocument();
    expect(screen.getByTestId('overview-action-capture-idea')).toBeInTheDocument();
  });

  it('empty-ideas: open ideas with no tasks keeps the ideas list and shows the no-tasks well', async () => {
    mount([idea({ title: 'Project overview page' })]);
    expect(await screen.findByText('Project overview page')).toBeInTheDocument();
    expect(screen.getByTestId('overview-nextup-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-backlog-empty')).not.toBeInTheDocument();
    // Derived (not hardcoded) card set for this state.
    expect(screen.getByText("Computed from this project's recent activity")).toBeInTheDocument();
  });

  it('empty-drained: shipped tasks + open ideas + a dry queue shows the drained next-up well', async () => {
    mount([idea({ title: 'Notification digest' }), doneTask({ title: 'Shipped thing' })]);
    expect(await screen.findByTestId('overview-nextup-empty')).toBeInTheDocument();
    expect(
      screen.getByText('Task queue is empty — everything captured has shipped'),
    ).toBeInTheDocument();
  });

  it('empty-done: everything shipped renders the Backlog-clear banner and the milestone card set', async () => {
    mount([doneTask({ title: 'Shipped thing' })]);
    expect(await screen.findByTestId('overview-backlog-clear')).toBeInTheDocument();
    expect(screen.getByText('Close out this milestone, then start the next one')).toBeInTheDocument();
    expect(screen.getByTestId('overview-action-plan-next-milestone')).toBeInTheDocument();
    // The two selectable lists are replaced by the banner in this state.
    expect(screen.queryByText('Top ideas')).not.toBeInTheDocument();
  });

  it('normal: ready tasks render the Next-up list, no empty wells', async () => {
    mount([idea({ title: 'An idea' }), item({ title: 'A ready task' })]);
    expect(await screen.findByText('A ready task')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-nextup-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('overview-backlog-empty')).not.toBeInTheDocument();
    expect(screen.getByText('Next up · Ready for development')).toBeInTheDocument();
  });

  it('renders the project name in the header and the active-agents empty well when nothing is live', async () => {
    mount([]);
    expect(await screen.findByRole('heading', { name: 'cyboflow' })).toBeInTheDocument();
    expect(screen.getByTestId('overview-active-agents-empty')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Dismissal
// ---------------------------------------------------------------------------

describe('ProjectOverviewPage — recommended-action dismissal', () => {
  it('hides the card and persists its id under the per-project key', async () => {
    const user = userEvent.setup();
    mount([]);

    const card = await screen.findByTestId('overview-action-capture-idea');
    expect(card).toBeInTheDocument();

    await user.click(screen.getByTestId('overview-action-dismiss-capture-idea'));

    await waitFor(() => {
      expect(screen.queryByTestId('overview-action-capture-idea')).not.toBeInTheDocument();
    });
    expect(JSON.parse(localStorage.getItem(OVERVIEW_DISMISSED_KEY(1)) ?? '[]')).toContain(
      'capture-idea',
    );
  });

  it('stays dismissed on a fresh mount (the persisted set is read back at init)', async () => {
    localStorage.setItem(OVERVIEW_DISMISSED_KEY(1), JSON.stringify(['capture-idea']));
    mount([]);
    expect(await screen.findByTestId('overview-action-launch-planner')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-action-capture-idea')).not.toBeInTheDocument();
  });
});
