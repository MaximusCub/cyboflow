/**
 * SessionTriageGroups — the review-home quick-session triage board.
 *
 * Covers what the pure `quickSessionTriage.ts` unit tests don't: the expandable
 * "details" history panel (fetch-once caching via `sessions:get-summary`), the
 * summary-slot rules for an unsupported/never-summarized/present summary, the
 * best-effort git-cache warm on mount, and the live clock moving a row from
 * Working to Ready once the quiet grace window elapses.
 */
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { SessionSummaryPayload } from '../../../../shared/types/sessionSummary';
import { QUIET_GRACE_MS } from '../../utils/quickSessionTriage';

let mockQuickRows: QuickSessionRow[] = [];

const { warmQuickGitSpy, getSummarySpy } = vi.hoisted(() => ({
  warmQuickGitSpy: vi.fn(),
  getSummarySpy: vi.fn(),
}));

vi.mock('../../stores/quickSessionsStore', () => ({
  useQuickSessionRows: () => mockQuickRows,
  useQuickSessionsStore: { getState: () => ({ init: () => () => undefined, refresh: vi.fn() }) },
}));
vi.mock('../../stores/dynamicWorkflowStore', () => ({
  useActiveDynamicWorkflows: () => [],
}));
vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveQuickSession: vi.fn() }) },
}));
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ setActiveProjectId: vi.fn(), goToSession: vi.fn() }) },
}));
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ markSessionAsViewed: vi.fn().mockResolvedValue(undefined) }) },
}));
vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      warmQuickGit: warmQuickGitSpy,
      getSummary: getSummarySpy,
    },
  },
}));

import { SessionTriageGroups } from '../landing/SessionTriageGroups';

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'smooth-falcon',
    projectId: 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? '2026-07-06T00:00:00.000Z',
    unviewed: overrides.unviewed ?? false,
    updatedAtIso: overrides.updatedAtIso ?? '2026-07-06T00:00:00.000Z',
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
  mockQuickRows = [];
  warmQuickGitSpy.mockReset().mockResolvedValue({ success: true });
  getSummarySpy.mockReset().mockResolvedValue({
    success: true,
    data: { enabled: true, summary: null, updatedAt: null, entries: [] } satisfies SessionSummaryPayload,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionTriageGroups', () => {
  it('renders nothing when there are no quick sessions', () => {
    mockQuickRows = [];
    const { container } = render(<SessionTriageGroups />);
    expect(container).toBeEmptyDOMElement();
  });

  it('expands details on first click (one getSummary call), collapses, and does not refetch on re-expand', async () => {
    const payload: SessionSummaryPayload = {
      enabled: true,
      summary: 'did stuff',
      updatedAt: '2026-07-06T11:00:00.000Z',
      entries: [
        { id: 1, entry: 'started the task', createdAt: '2026-07-06T10:00:00.000Z' },
        { id: 2, entry: 'wrapped it up', createdAt: '2026-07-06T11:00:00.000Z' },
      ],
    };
    getSummarySpy.mockResolvedValue({ success: true, data: payload });
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'busy-otter', state: 'idle', unviewed: false, summary: 'did stuff' }),
    ];

    const user = userEvent.setup();
    render(<SessionTriageGroups />);

    await user.click(screen.getByText('details ▸'));

    expect(await screen.findByText('started the task')).toBeInTheDocument();
    expect(screen.getByText('wrapped it up')).toBeInTheDocument();
    expect(getSummarySpy).toHaveBeenCalledTimes(1);
    expect(getSummarySpy).toHaveBeenCalledWith('s1', { catchUp: false });

    // Collapse.
    await user.click(screen.getByText('details ▾'));
    expect(screen.queryByText('started the task')).not.toBeInTheDocument();

    // Re-expand — cached, no refetch.
    await user.click(screen.getByText('details ▸'));
    expect(await screen.findByText('started the task')).toBeInTheDocument();
    expect(getSummarySpy).toHaveBeenCalledTimes(1);
  });

  it('renders the disabled note when the summary feature is off', async () => {
    getSummarySpy.mockResolvedValue({
      success: true,
      data: { enabled: false, summary: null, updatedAt: null, entries: [] } satisfies SessionSummaryPayload,
    });
    mockQuickRows = [quickRow({ sessionId: 's1', name: 'busy-otter', state: 'idle', unviewed: false })];

    const user = userEvent.setup();
    render(<SessionTriageGroups />);
    await user.click(screen.getByText('details ▸'));

    expect(await screen.findByText('summaries are disabled in settings')).toBeInTheDocument();
  });

  it('shows "no summaries for this provider" for a row the summarizer cannot cover', () => {
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'codex-runner', state: 'idle', unviewed: false, summarySupported: false, summary: null }),
    ];
    render(<SessionTriageGroups />);
    expect(screen.getByText('no summaries for this provider')).toBeInTheDocument();
  });

  it('shows "no summary yet" for a supported row that has never been summarized', () => {
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'fresh-session', state: 'idle', unviewed: false, summarySupported: true, summary: null }),
    ];
    render(<SessionTriageGroups />);
    expect(screen.getByText('no summary yet')).toBeInTheDocument();
  });

  it('fires warmQuickGit on mount with the non-running rows\' ids', () => {
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'a', state: 'idle', unviewed: false }),
      quickRow({ sessionId: 's2', name: 'b', state: 'blocked' }),
      quickRow({ sessionId: 's3', name: 'c', state: 'running' }),
    ];
    render(<SessionTriageGroups />);
    expect(warmQuickGitSpy).toHaveBeenCalledWith(['s1', 's2']);
  });

  it('moves a recently-idle row from Working to Ready once the quiet grace window elapses', () => {
    vi.useFakeTimers();
    const idleSince = new Date('2026-07-06T12:00:00.000Z');
    // Mount 30s after the session rested — inside the 60s grace window.
    vi.setSystemTime(new Date(idleSince.getTime() + 30_000));
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'zebra', state: 'idle', idleSince: idleSince.toISOString(), unviewed: false }),
    ];

    render(<SessionTriageGroups />);
    expect(screen.getByTestId('queue-group-session-working')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-group-session-ready')).not.toBeInTheDocument();

    // Advance the fake clock (and the component's own 30s tick) well past the
    // grace window.
    act(() => {
      vi.advanceTimersByTime(QUIET_GRACE_MS + 30_000);
    });

    expect(screen.queryByTestId('queue-group-session-working')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-group-session-ready')).toBeInTheDocument();
  });
});
