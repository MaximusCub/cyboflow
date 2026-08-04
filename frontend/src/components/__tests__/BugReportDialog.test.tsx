/**
 * BugReportDialog behavior tests.
 *
 * The load-bearing assertion here is the consent model: structured diagnostics
 * ride along automatically, but raw log output is OFF by default and the actual
 * text is shown before it can be sent. That split came out of adversarial
 * review — the project's scrubber only strips the username segment of a home
 * path, so log text cannot be made safe automatically and the user reading it is
 * the real control.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  BugReportPreview,
  BugReportSubmitResponse,
} from '../../../../shared/types/bugReport';

type SubmitResult = { success: boolean; data?: BugReportSubmitResponse; error?: string };
type PreviewResult = { success: boolean; data?: BugReportPreview; error?: string };

const sessionState = {
  sessions: [
    { id: 'session-1', name: 'azure-island' },
    { id: 'session-2', name: 'quiet-harbor' },
  ],
  activeSessionId: 'session-1',
};

const runsState = {
  runsByProject: { 1: [{ id: 'run-9', session_id: 'session-1', workflowName: 'sprint' }] },
};

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (s: typeof sessionState) => unknown) => selector(sessionState),
}));

vi.mock('../../stores/activeRunsStore', () => ({
  useActiveRunsStore: (selector: (s: typeof runsState) => unknown) => selector(runsState),
}));

import { BugReportDialog } from '../BugReportDialog';

const PREVIEW: BugReportPreview = {
  diagnostics: {
    appVersion: '0.1.35',
    platform: 'darwin',
    arch: 'arm64',
    electronVersion: '38.0.0',
    environment: 'stable',
    installId: 'install-uuid',
    recentErrors: [],
  },
  logTail: {
    kind: 'app-log',
    filePath: '/Users/k/.cyboflow/logs/cyboflow-2026-08-03.log',
    text: 'SECRET_LOG_MARKER: something happened',
    unavailable: false,
  },
};

const submit = vi.fn(
  async (..._args: unknown[]): Promise<SubmitResult> => ({
    success: true,
    data: { delivery: 'accepted', eventId: 'evt-1' },
  }),
);

let uuidCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.activeSessionId = 'session-1';
  submit.mockResolvedValue({ success: true, data: { delivery: 'accepted', eventId: 'evt-1' } });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      bugReport: {
        getPreview: vi.fn(async (): Promise<PreviewResult> => ({ success: true, data: PREVIEW })),
        submit,
      },
    },
  });
  uuidCounter = 0;
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { randomUUID: () => `idem-key-${++uuidCounter}` },
  });
});

async function openDialog() {
  const result = render(<BugReportDialog isOpen onClose={vi.fn()} />);
  await waitFor(() => expect(window.electronAPI.bugReport.getPreview).toHaveBeenCalled());
  return result;
}

function submittedPayload(index = 0): Record<string, unknown> {
  return submit.mock.calls[index][0] as Record<string, unknown>;
}

describe('log consent', () => {
  it('leaves log inclusion off by default and does not display the log text', async () => {
    await openDialog();

    const checkbox = screen.getByRole('checkbox', { name: /include recent log output/i });
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText(/SECRET_LOG_MARKER/)).not.toBeInTheDocument();
  });

  it('shows the actual log text and a warning once the user opts in', async () => {
    await openDialog();

    fireEvent.click(screen.getByRole('checkbox', { name: /include recent log output/i }));

    expect(screen.getByText(/SECRET_LOG_MARKER/)).toBeInTheDocument();
    expect(screen.getByText(/automated redaction cannot reliably remove/i)).toBeInTheDocument();
  });

  it('omits logText from the submission when not opted in', async () => {
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submittedPayload()).toMatchObject({ logText: undefined });
  });

  it('sends exactly the previewed text when opted in', async () => {
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /include recent log output/i }));
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submittedPayload()).toMatchObject({
      logText: 'SECRET_LOG_MARKER: something happened',
    });
  });
});

describe('contact consent', () => {
  it('hides the email field until the user opts into being contacted', async () => {
    await openDialog();

    expect(screen.queryByLabelText(/email address/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /you can contact me/i }));
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
  });
});

describe('dialog lifecycle', () => {
  /**
   * The session picker is seeded at open time only. Tracking the live active
   * session would silently overwrite the user's choice whenever the app switched
   * sessions behind the open dialog.
   */
  it('keeps the chosen session when the app switches sessions behind the dialog', async () => {
    const { rerender } = await openDialog();
    const picker = screen.getByLabelText(/where did this happen/i);
    fireEvent.change(picker, { target: { value: '' } });

    sessionState.activeSessionId = 'session-2';
    rerender(<BugReportDialog isOpen onClose={vi.fn()} />);

    expect(picker).toHaveValue('');
  });

  /**
   * The dialog stays mounted while closed, so a submission that resolves after
   * the user has dismissed it must not leave a result waiting on the next open.
   */
  it('discards a submission that resolves after the dialog was closed', async () => {
    let finish: (() => void) | undefined;
    submit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ success: true, data: { delivery: 'accepted' } });
        }),
    );
    const { rerender } = await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    rerender(<BugReportDialog isOpen={false} onClose={vi.fn()} />);
    finish?.();
    await waitFor(() => expect(submit).toHaveBeenCalled());
    rerender(<BugReportDialog isOpen onClose={vi.fn()} />);

    expect(screen.queryByText(/report sent/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send report/i })).toBeInTheDocument();
  });
});

describe('submission', () => {
  it('keeps send disabled until a description is entered', async () => {
    await openDialog();

    expect(screen.getByRole('button', { name: /send report/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    expect(screen.getByRole('button', { name: /send report/i })).toBeEnabled();
  });

  it('links the report to the active session and its flow run', async () => {
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submittedPayload()).toMatchObject({ runId: 'run-9', flowName: 'sprint' });
  });

  it('reports a queued delivery honestly rather than claiming it was sent', async () => {
    submit.mockResolvedValue({ success: true, data: { delivery: 'queued' } });
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    expect(await screen.findByText(/report queued/i)).toBeInTheDocument();
    expect(screen.getByText(/retried automatically/i)).toBeInTheDocument();
  });

  /**
   * The recent-error list is the one part of the diagnostics payload that can
   * change while the dialog is open, so it is echoed back from the preview
   * rather than re-collected in the main process at submit time.
   */
  it('echoes back the recent errors it showed in the preview', async () => {
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submittedPayload().recentErrors).toEqual(PREVIEW.diagnostics.recentErrors);
  });

  /**
   * Retrying must not discard the report. The handler only remembers keys it
   * actually filed, so reusing the key is also what makes the retry idempotent.
   */
  it('keeps the typed report, and its idempotency key, across a retry', async () => {
    submit.mockResolvedValue({
      success: true,
      data: { delivery: 'unavailable' as const, eventId: 'evt-1' },
    });
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));
    fireEvent.click(await screen.findByRole('button', { name: /try again/i }));

    expect(screen.getByLabelText(/what happened/i)).toHaveValue('It froze.');

    fireEvent.click(screen.getByRole('button', { name: /send report/i }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submittedPayload(1).idempotencyKey).toBe(submittedPayload(0).idempotencyKey);
  });

  /**
   * Until the preview resolves there is no log text to attach, so an enabled
   * checkbox would tell the user their logs were included while sending nothing.
   */
  it('cannot opt into logs before the preview has resolved', async () => {
    let resolvePreview: (() => void) | undefined;
    window.electronAPI.bugReport.getPreview = vi.fn(
      (): Promise<PreviewResult> =>
        new Promise((resolve) => {
          resolvePreview = () => resolve({ success: true, data: PREVIEW });
        }),
    );
    render(<BugReportDialog isOpen onClose={vi.fn()} />);

    const checkbox = screen.getByRole('checkbox', { name: /include recent log output/i });
    expect(checkbox).toBeDisabled();

    resolvePreview?.();
    await waitFor(() => expect(checkbox).toBeEnabled());
  });

  it('tells the user when the build cannot deliver at all', async () => {
    submit.mockResolvedValue({
      success: true,
      data: { delivery: 'unavailable', error: 'No Sentry DSN is configured in this build.' },
    });
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    expect(await screen.findByText(/can't send reports/i)).toBeInTheDocument();
  });
});
