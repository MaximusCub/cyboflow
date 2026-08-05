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
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VerificationRequest } from '../../../hooks/useVerificationRequests';

// ---------------------------------------------------------------------------
// Mocks (hoisted so the static component import binds to them).
// ---------------------------------------------------------------------------

const {
  useVerificationRequestsSpy,
  getAllSpy,
  budgetQuerySpy,
  healthQuerySpy,
  hostProbesQuerySpy,
  provisionChromiumSpy,
  requestAccessibilitySpy,
  openScreenRecordingSettingsSpy,
  goToWizardSpy,
} = vi.hoisted(() => ({
  useVerificationRequestsSpy: vi.fn(),
  getAllSpy: vi.fn(),
  budgetQuerySpy: vi.fn(),
  healthQuerySpy: vi.fn(),
  hostProbesQuerySpy: vi.fn(),
  provisionChromiumSpy: vi.fn(),
  requestAccessibilitySpy: vi.fn(),
  openScreenRecordingSettingsSpy: vi.fn(),
  goToWizardSpy: vi.fn(),
}));

vi.mock('../../../hooks/useVerificationRequests', () => ({
  useVerificationRequests: useVerificationRequestsSpy,
}));

vi.mock('../../../utils/api', () => ({
  API: { projects: { getAll: getAllSpy } },
}));

// The verify-budget header line (§3.6) is fetched by a direct trpc call, not
// through useVerificationRequests (judge_calls_used is deliberately excluded
// from the list row shape — see the router's own doc).
vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      verificationRequests: {
        budget: { query: budgetQuerySpy },
        // The §6 health panel's procedures (VerifyHealthPanel).
        health: { query: healthQuerySpy },
        hostProbes: { query: hostProbesQuerySpy },
        provisionChromium: { mutate: provisionChromiumSpy },
        requestAccessibility: { mutate: requestAccessibilitySpy },
        openScreenRecordingSettings: { mutate: openScreenRecordingSettingsSpy },
      },
    },
  },
}));

vi.mock('../../../stores/navigationStore', () => {
  // The view reads activeProjectId via a selector; the health panel's setup CTA
  // reaches for the store imperatively (getState().goToWizard).
  const useNavigationStore = (selector: (s: { activeProjectId: number | null }) => unknown): unknown =>
    selector({ activeProjectId: 1 });
  useNavigationStore.getState = (): { goToWizard: typeof goToWizardSpy } => ({
    goToWizard: goToWizardSpy,
  });
  return { useNavigationStore };
});

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
  budgetQuerySpy.mockReset();
  // Unlimited by default — the header line stays hidden unless a test opts a
  // project into a non-null budget.
  budgetQuerySpy.mockResolvedValue({ projectId: 1, projectName: 'ProjA', budgetCalls: null, usedCalls: 0 });
  healthQuerySpy.mockReset();
  healthQuerySpy.mockResolvedValue(emptyHealth());
  hostProbesQuerySpy.mockReset();
  hostProbesQuerySpy.mockResolvedValue({ probes: [], nativeScreenDeclared: false });
  provisionChromiumSpy.mockReset();
  requestAccessibilitySpy.mockReset();
  openScreenRecordingSettingsSpy.mockReset();
  goToWizardSpy.mockReset();
});

/** A health summary with nothing recorded — the default for the pre-existing suite. */
function emptyHealth(): {
  projectId: number;
  modalities: never[];
  unattributed: ReturnType<typeof emptyStats>;
  setupProof: ReturnType<typeof emptyStats>;
  setupProofCallsUsed: number;
  hostGeneration: number;
} {
  return {
    projectId: 1,
    modalities: [],
    unattributed: emptyStats(),
    setupProof: emptyStats(),
    setupProofCallsUsed: 0,
    hostGeneration: 0,
  };
}

function emptyStats(): {
  attempts: number;
  inFlight: number;
  passed: number;
  passRate: number | null;
  outcomes: Record<string, number>;
  failures: Record<string, number>;
  medianDurationMs: number | null;
} {
  return {
    attempts: 0,
    inFlight: 0,
    passed: 0,
    passRate: null,
    outcomes: {},
    failures: { env: 0, deliverable: 0, ambiguous: 0, unclassified: 0 },
    medianDurationMs: null,
  };
}

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

  // --- verify-budget header line (§3.6) ------------------------------------

  it('renders the budget line for a project with a non-null budget', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    budgetQuerySpy.mockResolvedValue({ projectId: 1, projectName: 'ProjA', budgetCalls: 50, usedCalls: 12 });

    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-budget-line')).toHaveTextContent('verify budget: 12/50');
  });

  it('hides the budget line for an unlimited (null) budget', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    budgetQuerySpy.mockResolvedValue({ projectId: 1, projectName: 'ProjA', budgetCalls: null, usedCalls: 3 });

    render(<VerifyQueueView />);

    await screen.findByTestId('verify-queue-empty');
    expect(screen.queryByTestId('verify-budget-line')).not.toBeInTheDocument();
  });

  it('hides the budget line when the budget query fails (non-fatal — the queue itself keeps rendering)', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    budgetQuerySpy.mockRejectedValue(new Error('boom'));

    render(<VerifyQueueView />);

    await screen.findByTestId('verify-queue-empty');
    expect(screen.queryByTestId('verify-budget-line')).not.toBeInTheDocument();
  });

  // --- failure-class chip + evidence (§3.1, detail dialog) -----------------

  it('shows the failure-class chip and evidence list on a classified terminal row', async () => {
    const user = userEvent.setup();
    useVerificationRequestsSpy.mockReturnValue({
      requests: [
        baseRow({
          id: 'vr-1',
          status: 'skipped',
          failureClass: 'env',
          failureEvidence: [
            { source: 'preflight', check: 'chromium', detail: 'chromium binary not resolvable' },
          ],
        }),
      ],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);
    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));

    expect(await screen.findByTestId('verify-failure-class-chip')).toHaveTextContent('env');
    expect(screen.getByTestId('verify-detail-failure-evidence')).toHaveTextContent(
      'preflight (chromium): chromium binary not resolvable',
    );
  });

  it('omits the failure-class chip and evidence list when the row has neither', async () => {
    const user = userEvent.setup();
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });

    render(<VerifyQueueView />);
    await user.click(await screen.findByTestId('verify-queue-row-vr-1'));

    expect(await screen.findByTestId('verify-detail-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('verify-failure-class-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('verify-detail-failure-evidence')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Phase-3 health panel (verification-setup-flow.md §6)
// ---------------------------------------------------------------------------

function stats(over: Partial<ReturnType<typeof emptyStats>> = {}): ReturnType<typeof emptyStats> {
  return { ...emptyStats(), ...over };
}

describe('VerifyQueueView — health panel', () => {
  it('offers the setup CTA in the empty state and launches the wizard preselected', async () => {
    // Finding 2: the empty state is where a user who needs setup is standing,
    // and (since verify-setup is hidden from the flow list) its only entry.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    render(<VerifyQueueView />);

    const cta = await screen.findByTestId('verify-queue-empty-setup-cta');
    await userEvent.click(cta);

    expect(goToWizardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ preselectWorkflowName: 'verify-setup', lockProjectId: 1 }),
    );
  });

  it('renders the probe table with its live states', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      nativeScreenDeclared: true,
      probes: [
        {
          id: 'browser-driving',
          state: 'missing',
          detail: 'chromium: not installed',
          fix: 'provision-chromium',
        },
        { id: 'screen-recording', state: 'ok', detail: 'granted', fix: null },
        { id: 'accessibility', state: 'ok', detail: 'granted', fix: null },
      ],
    });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-probe-browser-driving')).toBeInTheDocument();
    expect(screen.getByTestId('verify-probe-state-browser-driving')).toHaveTextContent('missing');
    expect(screen.getByTestId('verify-probe-fix-browser-driving')).toBeInTheDocument();
    expect(screen.getByTestId('verify-probe-state-screen-recording')).toHaveTextContent('ok');
    expect(screen.getByTestId('verify-probe-state-accessibility')).toHaveTextContent('ok');
  });

  it('renders an inconclusive probe as unknown, with no fix offered', async () => {
    // The fail-open rule: a probe that declined to answer is not a failure, and
    // must not be dressed as one or given a remediation to chase.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      nativeScreenDeclared: false,
      probes: [{ id: 'browser-driving', state: 'inconclusive', detail: 'chromium: EPERM', fix: null }],
    });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-probe-state-browser-driving')).toHaveTextContent('unknown');
    expect(screen.queryByTestId('verify-probe-fix-browser-driving')).not.toBeInTheDocument();
  });

  it('provisioning chromium swaps the row to ok from the re-probed report', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      nativeScreenDeclared: false,
      probes: [{ id: 'browser-driving', state: 'missing', detail: 'chromium: not installed', fix: 'provision-chromium' }],
    });
    provisionChromiumSpy.mockResolvedValue({
      nativeScreenDeclared: false,
      probes: [{ id: 'browser-driving', state: 'ok', detail: '/chromium', fix: null }],
    });
    render(<VerifyQueueView />);

    await userEvent.click(await screen.findByTestId('verify-probe-fix-browser-driving'));

    await waitFor(() => {
      expect(screen.getByTestId('verify-probe-state-browser-driving')).toHaveTextContent('ok');
    });
  });

  it('routes each grant row to its OWN action, not to the chromium installer', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    const denied = {
      nativeScreenDeclared: true,
      probes: [
        {
          id: 'screen-recording',
          state: 'missing',
          detail: 'not granted',
          fix: 'open-screen-recording-settings',
        },
        { id: 'accessibility', state: 'missing', detail: 'not granted', fix: 'request-accessibility' },
      ],
    };
    hostProbesQuerySpy.mockResolvedValue(denied);
    openScreenRecordingSettingsSpy.mockResolvedValue(denied);
    requestAccessibilitySpy.mockResolvedValue({
      nativeScreenDeclared: true,
      probes: [
        { id: 'screen-recording', state: 'missing', detail: 'not granted', fix: 'open-screen-recording-settings' },
        { id: 'accessibility', state: 'ok', detail: 'granted', fix: null },
      ],
    });
    render(<VerifyQueueView />);

    // The two grants live in DIFFERENT Settings panes; one button opening the
    // other's pane is worse than no button.
    await userEvent.click(await screen.findByTestId('verify-probe-fix-screen-recording'));
    await waitFor(() => expect(openScreenRecordingSettingsSpy).toHaveBeenCalledTimes(1));
    expect(requestAccessibilitySpy).not.toHaveBeenCalled();
    expect(provisionChromiumSpy).not.toHaveBeenCalled();

    await userEvent.click(await screen.findByTestId('verify-probe-fix-accessibility'));
    await waitFor(() => {
      expect(screen.getByTestId('verify-probe-state-accessibility')).toHaveTextContent('ok');
    });
  });

  it('shows a grant the host does not need WITHOUT dressing it as a fault', async () => {
    // The rows are always listed — you cannot decide whether to use screen
    // capture without being told whether it works here — but an unmet grant
    // nobody's runbook needs is information, not an alarm.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    hostProbesQuerySpy.mockResolvedValue({
      nativeScreenDeclared: false,
      probes: [
        {
          id: 'screen-recording',
          state: 'missing',
          detail: 'not granted',
          fix: 'open-screen-recording-settings',
        },
      ],
    });
    render(<VerifyQueueView />);

    const pill = await screen.findByTestId('verify-probe-state-screen-recording');
    expect(pill).toHaveTextContent('missing');
    expect(pill.className).not.toMatch(/status-error/);
    expect(screen.getByTestId('verify-probe-optional-screen-recording')).toHaveTextContent(
      /not needed by any runbook/,
    );
  });

  it('leads a modality row with its runbook state and warns when nothing is proven', async () => {
    // The silent failure this panel exists to expose: no proven runbook means
    // every build/serve check skips, so an empty queue is the SYMPTOM.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    healthQuerySpy.mockResolvedValue({
      ...emptyHealth(),
      modalities: [
        {
          modality: 'web',
          ...stats({ attempts: 4, passed: 2, passRate: 0.5, medianDurationMs: 42_000, failures: { env: 2, deliverable: 0, ambiguous: 0, unclassified: 0 } }),
          capability: null,
          runbook: { status: 'unproven-draft', version: 3, portableHash: 'abc' },
        },
      ],
    });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-health-runbook-web')).toHaveTextContent(
      /not proven .* will skip/i,
    );
    expect(screen.getByTestId('verify-health-modality-web')).toHaveTextContent('4 attempts');
    expect(screen.getByTestId('verify-health-modality-web')).toHaveTextContent('50% pass');
    expect(screen.getByTestId('verify-health-modality-web')).toHaveTextContent('median 42s');
    expect(screen.getByTestId('verify-health-failures-web')).toHaveTextContent('env 2');
  });

  it('offers EXACTLY ONE setup CTA in the empty state', async () => {
    // The empty state carries its own prominent CTA, so the panel suppresses
    // its header one there — two buttons doing the same thing a few pixels
    // apart read as two different actions.
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-queue-empty-setup-cta')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('verify-health-panel')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('verify-health-setup-cta')).not.toBeInTheDocument();
  });

  it('keeps the setup CTA on a POPULATED queue, and relabels it once something is proven', async () => {
    // The reachability rule: verify-setup is hidden from the wizard's flow
    // list, so this CTA is its entry point. A populated queue is precisely
    // where the empty state's CTA is absent — if this one were conditional the
    // flow would be unlaunchable.
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });
    healthQuerySpy.mockResolvedValue({
      ...emptyHealth(),
      modalities: [
        {
          modality: 'web',
          ...stats({ attempts: 1, passed: 1, passRate: 1 }),
          capability: null,
          runbook: { status: 'proven', version: 2, portableHash: 'abc' },
        },
      ],
    });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-health-runbook-web')).toHaveTextContent('proven');
    // Present, but relabelled — presence tracks reachability, the label tracks
    // state. "Proven" here means ONE modality is, which is not "done".
    expect(screen.getByTestId('verify-health-setup-cta')).toHaveTextContent('Re-run setup');
  });

  it('still offers the setup CTA when only SOME modality is proven', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });
    healthQuerySpy.mockResolvedValue({
      ...emptyHealth(),
      modalities: [
        { modality: 'web', ...stats(), capability: null, runbook: { status: 'proven', version: 1, portableHash: 'h' } },
        { modality: 'cdp-app', ...stats(), capability: null, runbook: null },
      ],
    });
    render(<VerifyQueueView />);

    // cdp-app has no runbook at all — its checks all skip, and repairing that
    // is exactly what the CTA is for.
    expect(await screen.findByTestId('verify-health-runbook-cdp-app')).toHaveTextContent(/will skip/i);
    expect(screen.getByTestId('verify-health-setup-cta')).toBeInTheDocument();
  });

  it('shows an in-force suppression with its retry window', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    healthQuerySpy.mockResolvedValue({
      ...emptyHealth(),
      modalities: [
        {
          modality: 'cdp-app',
          ...stats(),
          capability: {
            status: 'suppressed',
            reason: 'port 4521 occupied',
            consecutiveEnvFailures: 5,
            suppressedUntil: new Date(Date.now() + 3_600_000).toISOString(),
            hostGeneration: 1,
            suppressionActive: true,
          },
          runbook: { status: 'proven', version: 1, portableHash: 'h' },
        },
      ],
    });
    render(<VerifyQueueView />);

    const line = await screen.findByTestId('verify-health-capability-cdp-app');
    expect(line).toHaveTextContent('suppressed: port 4521 occupied');
    expect(line).toHaveTextContent(/retries in/i);
  });

  it('reports the setup-proof spend that lands against the project budget', async () => {
    useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
    healthQuerySpy.mockResolvedValue({
      ...emptyHealth(),
      setupProof: stats({ attempts: 3, passed: 1, passRate: 1 / 3 }),
      setupProofCallsUsed: 6,
    });
    render(<VerifyQueueView />);

    expect(await screen.findByTestId('verify-health-setup-proof')).toHaveTextContent(
      /6 calls counted against the project budget/i,
    );
  });

  it('drops the health TABLES but keeps the CTA when both queries fail', async () => {
    // A failed health query is not a reason to remove the launch path for the
    // flow that repairs verification — it is a reason to want it. The tables
    // go (there is nothing to show), the affordance stays. No second error
    // surface either: the queue's own banner covers the primary failure mode.
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });
    healthQuerySpy.mockRejectedValue(new Error('nope'));
    hostProbesQuerySpy.mockRejectedValue(new Error('nope'));
    render(<VerifyQueueView />);

    const cta = await screen.findByTestId('verify-health-setup-cta');
    expect(cta).toHaveTextContent('Set up verification');
    expect(screen.queryByTestId('verify-health-modality-web')).not.toBeInTheDocument();
    expect(screen.queryByTestId('verify-probe-browser-driving')).not.toBeInTheDocument();
  });

  it('probes the host ONCE per open — the probes do not ride the health poll', async () => {
    // Every probe pass shells out (resolving a Playwright browser path, asking
    // the OS about the screen-recording grant). None of it is fast-moving: a
    // grant or an installed binary changes when a human does something, not on
    // a fifteen-second tick.
    vi.useFakeTimers();
    try {
      useVerificationRequestsSpy.mockReturnValue({ requests: [], isLoading: false, error: null });
      render(<VerifyQueueView />);

      // Flush the mount effects' promises without waitFor, which would itself
      // be waiting on the timers we control here.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(hostProbesQuerySpy).toHaveBeenCalledTimes(1);
      const healthCallsBefore = healthQuerySpy.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      // Health kept polling; the probes did not.
      expect(healthQuerySpy.mock.calls.length).toBeGreaterThan(healthCallsBefore);
      expect(hostProbesQuerySpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('launches the wizard preselected from the health CTA', async () => {
    useVerificationRequestsSpy.mockReturnValue({
      requests: [baseRow({ id: 'vr-1', status: 'passed' })],
      isLoading: false,
      error: null,
    });
    render(<VerifyQueueView />);

    await userEvent.click(await screen.findByTestId('verify-health-setup-cta'));

    expect(goToWizardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ preselectWorkflowName: 'verify-setup', lockProjectId: 1 }),
    );
  });
});
