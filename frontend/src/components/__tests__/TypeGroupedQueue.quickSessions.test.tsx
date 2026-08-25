/**
 * TypeGroupedQueue — quick-session triage integration.
 *
 * The old idle-session review_item group, and later the flat compact
 * QuickSessionsTable + "blocked quick session" cards, were replaced by the
 * live SessionTriageGroups (Needs your input / Ready for review / Working).
 * These tests pin the two behaviors that matter at the TypeGroupedQueue seam:
 *   1. A LEGACY `idle-session:<id>` human_task row (pending until the startup
 *      drain resolves it) is filtered OUT — it never renders as a stray "Human
 *      task", and there is no "Idle sessions" group any more.
 *   2. The quick-session triage groups render their rows and keep the queue
 *      mounted when a quick session needs attention.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDLE_REVIEW_SOURCE_PREFIX, type ReviewItem } from '../../../../shared/types/reviews';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';

let mockReviewItems: ReviewItem[] = [];
let mockQuickRows: QuickSessionRow[] = [];

vi.mock('../../stores/reviewQueueStore', () => ({
  useReviewQueueView: () => ({ blocking: [], normal: [] }),
}));
vi.mock('../../stores/reviewQueueSlice', () => ({
  useReviewQueueSlice: (selector: (s: { runStatusMap: Record<string, unknown> }) => unknown) =>
    selector({ runStatusMap: {} }),
}));
vi.mock('../../stores/landingStore', () => ({
  useAggregatedBlockingFindings: () => [],
  useAggregatedBlockingRunIds: () => new Set<string>(),
  useAggregatedReviewItems: () => mockReviewItems,
  useAggregatedRuns: () => [],
  useRunProjectMap: () => ({}),
}));
vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveRun: vi.fn(), setActiveQuickSession: vi.fn() }) },
}));
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ setActiveProjectId: vi.fn(), goToSession: vi.fn() }) },
}));
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ markSessionAsViewed: vi.fn().mockResolvedValue(undefined) }) },
}));
vi.mock('../../hooks/useReviewItemActions', () => ({
  useReviewItemActions: () => ({
    pendingItemId: null,
    error: null,
    resolve: vi.fn(),
    acceptFinding: vi.fn(),
    dismiss: vi.fn(),
    promoteToTask: vi.fn(),
  }),
}));

// The quick-session board store — actual selector logic (needsAttention) is kept
// real; only the data source + polling side effects are stubbed.
vi.mock('../../stores/quickSessionsStore', () => ({
  useQuickSessionRows: () => mockQuickRows,
  needsAttention: (row: QuickSessionRow) =>
    row.state === 'blocked' || (row.state === 'idle' && row.unviewed),
  useQuickSessionsStore: { getState: () => ({ init: () => () => undefined, refresh: vi.fn() }) },
}));

// The dynamic-workflow feed drives the idle→running override; no live workflows
// here, so the triage reflects the mocked quick rows verbatim.
vi.mock('../../stores/dynamicWorkflowStore', () => ({
  useActiveDynamicWorkflows: () => [],
}));

// SessionTriageGroups fires a best-effort git-cache warm on mount; stub it so
// the (unmocked-elsewhere) real API module never has to reach window.electronAPI.
vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getSummary: vi.fn().mockResolvedValue({ success: true, data: { enabled: true, summary: null, updatedAt: null, entries: [] } }),
    },
  },
}));

import { TypeGroupedQueue } from '../landing/TypeGroupedQueue';

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: overrides.id ?? 'rvw_1',
    project_id: 1,
    run_id: overrides.run_id ?? 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'human_task',
    status: 'pending',
    blocking: overrides.blocking ?? true,
    audience: 'human',
    title: overrides.title ?? 'A task',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: overrides.source ?? null,
    payload: null,
    created_at: overrides.created_at ?? '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
  };
}

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'smooth-falcon',
    projectId: 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? '2026-07-06T00:00:00.000Z',
    unviewed: overrides.unviewed ?? true,
    restedAtIso: overrides.restedAtIso ?? '2026-07-06T00:00:00.000Z',
    rawStatus: overrides.rawStatus ?? 'completed',
    exitCode: overrides.exitCode ?? null,
    summary: overrides.summary ?? null,
    summaryState: overrides.summaryState ?? null,
    waitingOn: overrides.waitingOn ?? null,
    summarySupported: overrides.summarySupported ?? true,
    worktreeName: overrides.worktreeName ?? null,
    git: overrides.git ?? null,
  };
}

beforeEach(() => {
  mockReviewItems = [];
  mockQuickRows = [];
});

describe('TypeGroupedQueue — quick-session triage', () => {
  it('filters a legacy idle-session item out (no Idle group, not a Human task)', () => {
    mockReviewItems = [
      makeItem({ id: 'rvw_idle', title: 'Idle session needs your attention', source: `${IDLE_REVIEW_SOURCE_PREFIX}sess-a` }),
    ];
    render(<TypeGroupedQueue />);
    expect(screen.queryByTestId('queue-group-idle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-group-human-task')).not.toBeInTheDocument();
    // With only a filtered legacy item and no quick rows, the queue is empty.
    expect(screen.getByText('No pending reviews')).toBeInTheDocument();
  });

  it('keeps a generic human_task while filtering the idle-session sibling', () => {
    mockReviewItems = [
      makeItem({ id: 'rvw_ht', title: 'Ping the owner', source: 'monitor', blocking: false }),
      makeItem({ id: 'rvw_idle', title: 'Idle session needs your attention', source: `${IDLE_REVIEW_SOURCE_PREFIX}sess-a` }),
    ];
    render(<TypeGroupedQueue />);
    const humanGroup = screen.getByTestId('queue-group-human-task');
    expect(within(humanGroup).getByText('Ping the owner')).toBeInTheDocument();
    expect(within(humanGroup).queryByText(/Idle session needs your attention/)).not.toBeInTheDocument();
  });

  it('surfaces a blocked quick session under Needs your input with the question chip', () => {
    mockQuickRows = [quickRow({ name: 'tidy-valley', state: 'blocked', idleSince: null, unviewed: false })];
    render(<TypeGroupedQueue />);
    const group = screen.getByTestId('queue-group-session-needs-input');
    expect(within(group).getByText('tidy-valley')).toBeInTheDocument();
    expect(within(group).getByText('question')).toBeInTheDocument();
    // The old dedicated "blocked quick session" card group no longer exists.
    expect(screen.queryByTestId('queue-group-quick-session-blocked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-group-quick-sessions')).not.toBeInTheDocument();
    // A blocked quick session alone keeps the queue up (not the empty state).
    expect(screen.queryByText('No pending reviews')).not.toBeInTheDocument();
  });

  it('surfaces an idle needs_input row under Needs your input with the asked-you chip and waitingOn text', () => {
    // needsAttention (which gates whether TypeGroupedQueue mounts anything at
    // all) is deliberately NOT widened for needs_input — see LandingHome's
    // wiring comment. An unviewed row is the realistic case (you haven't
    // looked at a session that just asked you something) and keeps this test
    // inside that gate, matching production.
    mockQuickRows = [
      quickRow({
        name: 'quiet-mesa',
        state: 'idle',
        unviewed: true,
        summaryState: 'needs_input',
        waitingOn: 'Which branch should I target?',
      }),
    ];
    render(<TypeGroupedQueue />);
    const group = screen.getByTestId('queue-group-session-needs-input');
    expect(within(group).getByText('quiet-mesa')).toBeInTheDocument();
    expect(within(group).getByText('asked you')).toBeInTheDocument();
    expect(within(group).getByText('Which branch should I target?')).toBeInTheDocument();
  });

  it('surfaces a clean idle session under Ready for review with its summary', () => {
    mockQuickRows = [
      quickRow({
        sessionId: 's2',
        name: 'busy-otter',
        state: 'idle',
        unviewed: true,
        summary: 'Fixed the login redirect bug.',
      }),
    ];
    render(<TypeGroupedQueue />);
    const group = screen.getByTestId('queue-group-session-ready');
    expect(within(group).getByText('busy-otter')).toBeInTheDocument();
    expect(within(group).getByText('Fixed the login redirect bug.')).toBeInTheDocument();
  });

  it('shows running quick sessions under Working', () => {
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'busy-otter', state: 'running', idleSince: null, unviewed: false }),
      quickRow({ sessionId: 's2', name: 'quiet-mesa', state: 'idle', unviewed: true }),
    ];
    render(<TypeGroupedQueue />);
    const working = screen.getByTestId('queue-group-session-working');
    expect(within(working).getByText('busy-otter')).toBeInTheDocument();
    expect(within(working).getByText('running')).toBeInTheDocument();
    const ready = screen.getByTestId('queue-group-session-ready');
    expect(within(ready).getByText('quiet-mesa')).toBeInTheDocument();
  });

  it('splits a blocked session into Needs your input while other sessions stay in their own groups', () => {
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'tidy-valley', state: 'blocked', idleSince: null, unviewed: false }),
      quickRow({ sessionId: 's2', name: 'busy-otter', state: 'running', idleSince: null, unviewed: false }),
    ];
    render(<TypeGroupedQueue />);
    const needsInput = screen.getByTestId('queue-group-session-needs-input');
    expect(within(needsInput).getByText('tidy-valley')).toBeInTheDocument();
    const working = screen.getByTestId('queue-group-session-working');
    expect(within(working).getByText('busy-otter')).toBeInTheDocument();
    expect(within(working).queryByText('tidy-valley')).not.toBeInTheDocument();
  });
});
