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
import type { BugReportPreview } from '../../../../shared/types/bugReport';

const sessionState = {
  sessions: [{ id: 'session-1', name: 'azure-island' }],
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

const submit = vi.fn(async () => ({
  success: true,
  data: { delivery: 'accepted' as const, eventId: 'evt-1' },
}));

beforeEach(() => {
  vi.clearAllMocks();
  submit.mockResolvedValue({ success: true, data: { delivery: 'accepted', eventId: 'evt-1' } });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      bugReport: {
        getPreview: vi.fn(async () => ({ success: true, data: PREVIEW })),
        submit,
      },
    },
  });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { randomUUID: () => 'idem-key-1' },
  });
});

async function openDialog() {
  render(<BugReportDialog isOpen onClose={vi.fn()} />);
  await waitFor(() => expect(window.electronAPI.bugReport.getPreview).toHaveBeenCalled());
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
    expect(submit.mock.calls[0][0]).toMatchObject({ logText: undefined });
  });

  it('sends exactly the previewed text when opted in', async () => {
    await openDialog();

    fireEvent.change(screen.getByLabelText(/what happened/i), {
      target: { value: 'It froze.' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /include recent log output/i }));
    fireEvent.click(screen.getByRole('button', { name: /send report/i }));

    await waitFor(() => expect(submit).toHaveBeenCalled());
    expect(submit.mock.calls[0][0]).toMatchObject({
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
    expect(submit.mock.calls[0][0]).toMatchObject({ runId: 'run-9', flowName: 'sprint' });
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
