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
  BugReportRunLink,
  BugReportSubmitResponse,
} from '../../../../shared/types/bugReport';

type SubmitResult = { success: boolean; data?: BugReportSubmitResponse; error?: string };
type PreviewResult = { success: boolean; data?: BugReportPreview; error?: string };
type RunLinkResult = { success: boolean; data?: BugReportRunLink | null; error?: string };

const sessionState = {
  sessions: [
    { id: 'session-1', name: 'azure-island' },
    { id: 'session-2', name: 'quiet-harbor' },
  ],
  activeSessionId: 'session-1',
};

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (s: typeof sessionState) => unknown) => selector(sessionState),
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

/**
 * The main process owns session→run resolution, so the dialog asks rather than
 * deriving. Defaults to 'session-1' having a sprint run and every other session
 * having none.
 */
const resolveRun = vi.fn(
  async (..._args: unknown[]): Promise<RunLinkResult> => ({ success: true, data: null }),
);

let uuidCounter = 0;

beforeEach(() => {
  vi.clearAllMocks();
  sessionState.activeSessionId = 'session-1';
  submit.mockResolvedValue({ success: true, data: { delivery: 'accepted', eventId: 'evt-1' } });
  resolveRun.mockImplementation(async (...args: unknown[]): Promise<RunLinkResult> => ({
    success: true,
    data: args[0] === 'session-1' ? { runId: 'run-9', flowName: 'sprint' } : null,
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      bugReport: {
        getPreview: vi.fn(async (): Promise<PreviewResult> => ({ success: true, data: PREVIEW })),
        submit,
        resolveRun,
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

/**
 * The diagnostics panel is the "what am I about to send" surface, so it is
 * expanded from the start — a user who has to click to find out what a report
 * carries mostly does not click. Note this is the opposite default from the log
 * tail, which stays OFF: showing what is already attached costs nothing, while
 * the log tail is the one thing being attached by the user's own choice.
 */
describe('diagnostics panel', () => {
  it('shows the included details without the user expanding anything', async () => {
    await openDialog();

    expect(screen.getByText('Install ID')).toBeInTheDocument();
    expect(screen.getByText(/^Recent errors$/)).toBeInTheDocument();
  });

  it('still collapses on demand', async () => {
    await openDialog();

    fireEvent.click(screen.getByRole('button', { name: /what's included/i }));

    expect(screen.queryByText('Install ID')).not.toBeInTheDocument();
  });
});

describe('log consent', () => {
  it('leaves log inclusion off by default and does not display the log text', async () => {
    await openDialog();

    const checkbox = screen.getByRole('switch', { name: /include recent session logs/i });
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByText(/SECRET_LOG_MARKER/)).not.toBeInTheDocument();
  });

  it('shows the actual log text and a warning once the user opts in', async () => {
    await openDialog();

    fireEvent.click(screen.getByRole('switch', { name: /include recent session logs/i }));

    expect(screen.getByText(/SECRET_LOG_MARKER/)).toBeInTheDocument();
    expect(screen.getByText(/automated redaction cannot always reliably remove/i)).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('switch', { name: /include recent session logs/i }));
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submittedPayload()).toMatchObject({
      logText: 'SECRET_LOG_MARKER: something happened',
    });
  });
});

/**
 * The email field is always shown and always optional: filling it in IS the
 * consent to be contacted, so there is no checkbox gating it.
 */
describe('contact address', () => {
  it('offers the email field without any opt-in step', async () => {
    await openDialog();

    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /contact/i })).not.toBeInTheDocument();
  });

  it('sends a typed address', async () => {
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), { target: { value: 'It froze.' } });
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'someone@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submittedPayload()).toMatchObject({ email: 'someone@example.com' });
  });

  it('sends no address when the field is left blank', async () => {
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), { target: { value: 'It froze.' } });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submittedPayload().email).toBeUndefined();
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

  /**
   * The harder version of the case above, and the one a boolean open-ness ref
   * cannot catch: by the time the submission resolves the dialog is open AGAIN,
   * so the guard passes and the previous opening's result lands in a dialog the
   * user has just started filling in.
   */
  it('discards a submission that resolves after the dialog was closed and reopened', async () => {
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
    rerender(<BugReportDialog isOpen onClose={vi.fn()} />);
    finish?.();
    await waitFor(() => expect(submit).toHaveBeenCalled());

    expect(screen.queryByText(/report sent/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send report/i })).toBeInTheDocument();
  });

  /**
   * The preview is the consent surface, so it belongs to one opening. Carrying it
   * across a close would let a reopened dialog submit — and display — a log tail
   * and recorded-error list the user never reviewed in this dialog.
   */
  it('drops the previous opening’s preview instead of reusing it', async () => {
    const { rerender } = await openDialog();
    fireEvent.click(screen.getByRole('switch', { name: /include recent session logs/i }));
    expect(screen.getByText(/SECRET_LOG_MARKER/)).toBeInTheDocument();

    // The next open's preview is still in flight.
    window.electronAPI.bugReport.getPreview = vi.fn(
      (): Promise<PreviewResult> => new Promise(() => {}),
    );
    rerender(<BugReportDialog isOpen={false} onClose={vi.fn()} />);
    rerender(<BugReportDialog isOpen onClose={vi.fn()} />);

    expect(screen.queryByText(/SECRET_LOG_MARKER/)).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /include recent session logs/i })).toBeDisabled();
  });

  /**
   * Same seam on the way in: a preview from the previous opening must not be
   * attached to a report filed from the next one.
   */
  it('sends no previewed diagnostics from a stale opening', async () => {
    const staleErrors = [
      { at: '2026-08-03T00:00:00.000Z', seam: 'run-start', errorClass: 'Error', message: 'boom' },
    ];
    window.electronAPI.bugReport.getPreview = vi.fn(
      async (): Promise<PreviewResult> => ({
        success: true,
        data: { ...PREVIEW, diagnostics: { ...PREVIEW.diagnostics, recentErrors: staleErrors } },
      }),
    );
    const { rerender } = await openDialog();

    window.electronAPI.bugReport.getPreview = vi.fn(
      (): Promise<PreviewResult> => new Promise(() => {}),
    );
    rerender(<BugReportDialog isOpen={false} onClose={vi.fn()} />);
    rerender(<BugReportDialog isOpen onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'Something else.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submittedPayload().recentErrors).toEqual([]);
    expect(submittedPayload().logText).toBeUndefined();
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

  /**
   * The session id is the ONLY id the renderer sends. Deriving the run here is
   * what broke before: the dialog could only see runs the rail still retained
   * (non-terminal ones), so a report about a run that had already failed — the
   * usual case — travelled with no run id at all.
   */
  it('sends the session id alone, leaving the run for the main process to derive', async () => {
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    const payload = submittedPayload();
    expect(payload.sessionId).toBe('session-1');
    expect(payload).not.toHaveProperty('runId');
    expect(payload).not.toHaveProperty('flowName');
  });

  it('shows the run the report will be tagged with, as the main process resolves it', async () => {
    await openDialog();

    expect(await screen.findByText(/linked to the sprint run/i)).toBeInTheDocument();
    expect(resolveRun).toHaveBeenCalledWith('session-1');
  });

  it('drops the linked-run line when the chosen session has no run', async () => {
    await openDialog();
    expect(await screen.findByText(/linked to the sprint run/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/where did this happen/i), {
      target: { value: 'session-2' },
    });

    await waitFor(() => expect(screen.queryByText(/linked to the/i)).not.toBeInTheDocument());
  });

  /**
   * A quick session's run resolves with no flow name (the `__quick__` sentinel
   * is suppressed upstream), which must not blank out the whole line.
   */
  it('still reports a link when the run has no flow name', async () => {
    resolveRun.mockResolvedValue({ success: true, data: { runId: 'run-9' } });
    await openDialog();

    expect(await screen.findByText(/linked to the run in this session/i)).toBeInTheDocument();
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
   * toggle would tell the user their logs were included while sending nothing.
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

    const checkbox = screen.getByRole('switch', { name: /include recent session logs/i });
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
