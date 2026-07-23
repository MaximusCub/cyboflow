/**
 * VerifyQueueView tests (L6 Verify-Queue panel, S7).
 *
 * Behaviors verified:
 *   1. Empty state — the empty-list placeholder renders when the hook returns [].
 *   2. Populated state — one row per request with id / verify-type / status badge
 *      / current-backend + attempt / a verdict summary parsed from verdict_json.
 *   3. error-state banner renders (non-fatal) while the last list still shows.
 *   4. The project filter renders the loaded projects.
 *
 * The data hook (useVerificationRequests) + API.projects + the navigation store
 * are mocked so the test exercises the view's rendering contract in isolation.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerificationRequest } from '../../../hooks/useVerificationRequests';

// ---------------------------------------------------------------------------
// Mocks (hoisted so the static component import binds to them).
// ---------------------------------------------------------------------------

const { useVerificationRequestsSpy, getAllSpy } = vi.hoisted(() => ({
  useVerificationRequestsSpy: vi.fn(),
  getAllSpy: vi.fn(),
}));

vi.mock('../../../hooks/useVerificationRequests', () => ({
  useVerificationRequests: useVerificationRequestsSpy,
}));

vi.mock('../../../utils/api', () => ({
  API: { projects: { getAll: getAllSpy } },
}));

vi.mock('../../../stores/navigationStore', () => ({
  // The view reads only activeProjectId via a selector.
  useNavigationStore: (selector: (s: { activeProjectId: number | null }) => unknown) =>
    selector({ activeProjectId: 1 }),
}));

import { VerifyQueueView } from '../VerifyQueueView';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseRow(over: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    id: 'vr-1',
    run_id: 'run-1',
    project_id: 1,
    status: 'queued',
    verify_type: 'static-render-snapshot',
    deliverable_json: JSON.stringify({ intent: 'Renders the dashboard' }),
    chain_json: '["capturePage"]',
    current_backend: null,
    attempt: 0,
    verdict_json: null,
    error_message: null,
    enqueued_at: '2026-06-28T00:00:01.000Z',
    leased_at: null,
    ended_at: null,
    // Migration-078 columns (verification-agent redesign §5.2/§5.6) — NULL by
    // default (a legacy row); individual tests override via `over` for an
    // agent-engine row.
    task_json: null,
    report_json: null,
    delivery_state: null,
    snapshot_sha: null,
    enqueue_key: null,
    // Origin-session columns (LEFT-JOINed by the list query) — a run with no
    // session row reads back NULL on both.
    session_id: 'sess-1',
    session_name: 'twilight-leaf',
    ...over,
  };
}

beforeEach(() => {
  useVerificationRequestsSpy.mockReset();
  getAllSpy.mockReset();
  getAllSpy.mockResolvedValue({ success: true, data: [{ id: 1, name: 'ProjA', path: '/tmp/a' }] });
});

describe('VerifyQueueView', () => {
  it('renders the empty state when there are no requests', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-empty')).toBeInTheDocument();
    expect(screen.getByTestId('verify-queue-view')).toBeInTheDocument();
  });

  it('renders one row per request with status badge + verdict summary', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({ id: 'vr-1', status: 'queued', deliverable_json: JSON.stringify({ intent: 'Queued check' }) }),
        baseRow({
          id: 'vr-2',
          status: 'passed',
          current_backend: 'capturePage',
          attempt: 1,
          verdict_json: JSON.stringify({
            status: 'pass',
            confidence: 0.92,
            issues: [],
            feedback: 'Looks correct',
            judgedFileNames: ['shot.png'],
            baselineUsed: false,
            model: 'fake',
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    // Both rows present.
    expect(await screen.findByTestId('verify-queue-row-vr-1')).toBeInTheDocument();
    expect(screen.getByTestId('verify-queue-row-vr-2')).toBeInTheDocument();

    // Status badges.
    expect(screen.getByTestId('verify-queue-status-vr-1')).toHaveTextContent('queued');
    expect(screen.getByTestId('verify-queue-status-vr-2')).toHaveTextContent('passed');

    // Intent + verdict summary (parsed from verdict_json) on the passed row.
    expect(screen.getByText('Renders the dashboard')).toBeInTheDocument();
    expect(screen.getByText(/pass · 92% — Looks correct/)).toBeInTheDocument();

    // Verify-type chip + backend/attempt line.
    expect(screen.getAllByText('static-render-snapshot').length).toBeGreaterThan(0);
    expect(screen.getByText('backend: capturePage')).toBeInTheDocument();
    expect(screen.getByText('attempt 1')).toBeInTheDocument();
  });

  it('renders a non-fatal error banner while keeping the list', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1' })],
      isLoading: false,
      error: new Error('refresh failed'),
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-error')).toHaveTextContent('refresh failed');
    expect(screen.getByTestId('verify-queue-row-vr-1')).toBeInTheDocument();
  });

  it('populates the project filter with the loaded projects', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });

    render(<VerifyQueueView />);

    const select = await screen.findByTestId('verify-queue-project-filter');
    await waitFor(() => expect(screen.getByRole('option', { name: 'ProjA' })).toBeInTheDocument());
    expect(select).toBeInTheDocument();
  });

  // --- engine identity + agent-row rendering (verification-agent redesign §5.11) ---

  it('tags a legacy row (no task_json) with the "legacy" engine chip', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1' })],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-engine-vr-1')).toHaveTextContent('legacy');
  });

  it('tags an agent-engine row (task_json populated) with the "agent" chip and shows the task summary', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'queued',
          task_json: JSON.stringify({
            version: 1,
            summary: 'Submitting the login form navigates to the dashboard',
            behaviors: [],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-engine-vr-1')).toHaveTextContent('agent');
    expect(screen.getByText('Submitting the login form navigates to the dashboard')).toBeInTheDocument();
    expect(screen.getByText('Awaiting the verification agent')).toBeInTheDocument();
  });

  it('shows agent-appropriate lifecycle copy while running', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'running',
          task_json: JSON.stringify({ version: 1, summary: 'Checks the dashboard', behaviors: [] }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByText('Agent building + driving the deliverable')).toBeInTheDocument();
  });

  it('shows the report outcome (outcome only) for a terminal agent row', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'failed',
          task_json: JSON.stringify({ version: 1, summary: 'Checks the dashboard', behaviors: [] }),
          report_json: JSON.stringify({
            version: 1,
            behaviors: [],
            screenshots: [],
            outcome: 'build_failed',
            confidence: 0.9,
            feedback: 'The build failed — should not render here.',
            issues: [],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    const row = await screen.findByTestId('verify-queue-row-vr-1');
    expect(row).toHaveTextContent('report outcome: build failed');
    // Only the outcome renders — not the report's feedback text.
    expect(row).not.toHaveTextContent('should not render here');
  });

  it('a legacy row with a VerdictV1 still wins over any report_json (verdict takes precedence)', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-2',
          status: 'passed',
          current_backend: 'capturePage',
          attempt: 1,
          verdict_json: JSON.stringify({
            status: 'pass',
            confidence: 0.92,
            issues: [],
            feedback: 'Looks correct',
            judgedFileNames: ['shot.png'],
            baselineUsed: false,
            model: 'fake',
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-engine-vr-2')).toHaveTextContent('legacy');
    expect(screen.getByText(/pass · 92% — Looks correct/)).toBeInTheDocument();
  });

  // --- pending-first sectioning ------------------------------------------

  it('lists in-flight requests above history, oldest-enqueued first', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      // The hook hands back newest-enqueued FIRST (the list query's order).
      requests: [
        baseRow({ id: 'vr-new-pending', status: 'running', enqueued_at: '2026-06-28T00:00:30.000Z' }),
        baseRow({ id: 'vr-old-pending', status: 'queued', enqueued_at: '2026-06-28T00:00:10.000Z' }),
        baseRow({ id: 'vr-done', status: 'passed', enqueued_at: '2026-06-28T00:00:05.000Z' }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    const pending = await screen.findByTestId('verify-queue-pending-list');
    const history = screen.getByTestId('verify-queue-history-list');

    // Section membership: terminal rows never appear in the pending section.
    expect(pending).toContainElement(screen.getByTestId('verify-queue-row-vr-old-pending'));
    expect(pending).toContainElement(screen.getByTestId('verify-queue-row-vr-new-pending'));
    expect(history).toContainElement(screen.getByTestId('verify-queue-row-vr-done'));

    // Pending is drain order (oldest first), not the newest-first list order.
    const ids = Array.from(pending.children).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['verify-queue-row-vr-old-pending', 'verify-queue-row-vr-new-pending']);

    // The pending section renders before history in the DOM.
    expect(pending.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(screen.getByTestId('verify-queue-pending-list-count')).toHaveTextContent('2');
    expect(screen.getByTestId('verify-queue-history-list-count')).toHaveTextContent('1');
  });

  it('shows a per-section empty line when one side of the split is empty', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-pending-list-empty')).toBeInTheDocument();
    expect(screen.getByTestId('verify-queue-history-list')).toBeInTheDocument();
  });

  // --- session pill --------------------------------------------------------

  it('shows the origin-session pill, falling back to the run id when unattributed', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({ id: 'vr-1', session_name: 'twilight-leaf' }),
        baseRow({ id: 'vr-2', run_id: 'run-orphan', session_id: null, session_name: null }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-session-vr-1')).toHaveTextContent('twilight-leaf');
    expect(screen.getByTestId('verify-queue-session-vr-2')).toHaveTextContent('run-orphan');
  });

  // --- detail dialog -------------------------------------------------------

  it('opens the detail dialog on card click and shows tested behaviors + criteria results', async () => {
    const user = userEvent.setup();
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'failed',
          task_json: JSON.stringify({
            version: 1,
            summary: 'Login redirects to the dashboard',
            behaviors: [
              { id: 'b1', description: 'Submit valid credentials', expected: 'Dashboard renders' },
              { id: 'b2', description: 'Submit bad credentials', expected: 'Inline error renders' },
            ],
          }),
          report_json: JSON.stringify({
            version: 1,
            behaviors: [
              { id: 'b1', result: 'pass', evidence: { screenshots: ['dash.png'], notes: 'dashboard visible' } },
              { id: 'b2', result: 'fail', evidence: { screenshots: [], notes: 'no error shown' } },
            ],
            screenshots: [{ fileName: 'dash.png', caption: 'Dashboard after login' }],
            outcome: 'fail',
            confidence: 0.8,
            feedback: 'The error path regressed.',
            issues: [],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));

    expect(await screen.findByTestId('verify-detail-modal')).toBeInTheDocument();
    // What was tested.
    expect(screen.getByTestId('verify-detail-summary')).toHaveTextContent(
      'Login redirects to the dashboard',
    );
    expect(screen.getByText('Submit valid credentials')).toBeInTheDocument();
    // Which criteria passed / failed.
    expect(screen.getByTestId('verify-detail-result-b1')).toHaveTextContent('pass');
    expect(screen.getByTestId('verify-detail-result-b2')).toHaveTextContent('fail');
    // What was captured (the byte load fails without electronAPI — the tile
    // still lists the file so the user knows what SHOULD be there).
    expect(screen.getByTestId('verify-detail-screenshots')).toHaveTextContent('dash.png');
    expect(screen.getByTestId('verify-detail-feedback')).toHaveTextContent('The error path regressed.');
  });

  it('renders a task behavior with no report entry as pending', async () => {
    const user = userEvent.setup();
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'running',
          task_json: JSON.stringify({
            version: 1,
            summary: 'Checks the dashboard',
            behaviors: [{ id: 'b1', description: 'Loads', expected: 'Renders' }],
          }),
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));

    expect(await screen.findByTestId('verify-detail-result-b1')).toHaveTextContent('pending');
    expect(screen.getByTestId('verify-detail-no-screenshots')).toBeInTheDocument();
  });

  it('closes the detail dialog when the project filter changes', async () => {
    const user = userEvent.setup();
    getAllSpy.mockResolvedValue({
      success: true,
      data: [
        { id: 1, name: 'ProjA', path: '/tmp/a' },
        { id: 2, name: 'ProjB', path: '/tmp/b' },
      ],
    });
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1' })],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);

    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));
    expect(await screen.findByTestId('verify-detail-modal')).toBeInTheDocument();

    await user.selectOptions(screen.getByTestId('verify-queue-project-filter'), '2');

    await waitFor(() =>
      expect(screen.queryByTestId('verify-detail-modal')).not.toBeInTheDocument(),
    );
  });
});
