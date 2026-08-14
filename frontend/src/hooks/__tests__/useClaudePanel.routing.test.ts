import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types/session';

const mocks = vi.hoisted(() => ({
  sessionSendInput: vi.fn(),
  panelSendInput: vi.fn(),
  panelContinue: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: { sendInput: mocks.sessionSendInput },
    panels: {
      sendInput: mocks.panelSendInput,
      continue: mocks.panelContinue,
    },
  },
}));

import { dispatchQuickSessionInput } from '../useClaudePanel';

function session(agentRuntime: Session['agentRuntime']): Session {
  return { id: 'session-1', agentRuntime } as Session;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionSendInput.mockResolvedValue({ success: true });
  mocks.panelSendInput.mockResolvedValue({ success: true });
  mocks.panelContinue.mockResolvedValue({ success: true });
});

describe('dispatchQuickSessionInput', () => {
  it('routes initial Codex SDK input through sessions:input', async () => {
    await dispatchQuickSessionInput(session('codex-sdk'), 'panel-1', 'hello Codex', 'initial');

    expect(mocks.sessionSendInput).toHaveBeenCalledWith('session-1', 'hello Codex');
    expect(mocks.panelSendInput).not.toHaveBeenCalled();
  });

  it('routes continued Codex SDK input through the panel-scoped panels:continue (queue guard + interrupt parity)', async () => {
    mocks.panelContinue.mockResolvedValue({ success: true, data: { queued: true } });
    const res = await dispatchQuickSessionInput(
      session('codex-sdk'),
      'panel-1',
      'continue Codex',
      'continue',
      undefined,
      false,
      'pending-c',
    );

    expect(mocks.panelContinue).toHaveBeenCalledWith('panel-1', 'continue Codex', undefined, false, 'pending-c');
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
    // A mid-turn queued continue surfaces `queued` so the composer flips the row.
    expect(res).toEqual({ success: true, error: undefined, queued: true });
  });

  it('threads the interrupt flag into a Codex SDK continue (Interrupt & send parity)', async () => {
    await dispatchQuickSessionInput(session('codex-sdk'), 'panel-1', 'now', 'continue', undefined, true, 'pending-i');

    expect(mocks.panelContinue).toHaveBeenCalledWith('panel-1', 'now', undefined, true, 'pending-i');
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
  });

  it('preserves the Claude panel continuation path', async () => {
    await dispatchQuickSessionInput(session('claude-sdk'), 'panel-1', 'continue Claude', 'continue', 'opus');

    expect(mocks.panelContinue).toHaveBeenCalledWith('panel-1', 'continue Claude', 'opus', undefined, undefined);
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
  });

  it('threads the interrupt flag + pending id into the Claude panel continuation', async () => {
    await dispatchQuickSessionInput(session('claude-sdk'), 'panel-1', 'do it now', 'continue', 'opus', true, 'pending-9');

    expect(mocks.panelContinue).toHaveBeenCalledWith('panel-1', 'do it now', 'opus', true, 'pending-9');
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
  });

  // omp-sdk takes the SAME route as codex-sdk (docs/proposals/omp-provider-
  // integration.md §5.5): first message via sessions:input, follow-ups via the
  // panel-scoped panels:continue.
  it('routes initial OMP SDK input through sessions:input', async () => {
    await dispatchQuickSessionInput(session('omp-sdk'), 'panel-1', 'hello OMP', 'initial');

    expect(mocks.sessionSendInput).toHaveBeenCalledWith('session-1', 'hello OMP');
    expect(mocks.panelSendInput).not.toHaveBeenCalled();
  });

  it('routes continued OMP SDK input through the panel-scoped panels:continue (queue guard + interrupt parity)', async () => {
    mocks.panelContinue.mockResolvedValue({ success: true, data: { queued: true } });
    const res = await dispatchQuickSessionInput(
      session('omp-sdk'),
      'panel-1',
      'continue OMP',
      'continue',
      undefined,
      false,
      'pending-o',
    );

    expect(mocks.panelContinue).toHaveBeenCalledWith('panel-1', 'continue OMP', undefined, false, 'pending-o');
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, error: undefined, queued: true });
  });
});

/**
 * An overridden panel runs a different lane than its session, so it must never
 * take the SESSION-scoped path: sessions:input resolves the session's FIRST chat
 * panel, which would answer on the inherited lane instead of this panel's.
 */
describe('dispatchQuickSessionInput — per-panel substrate overrides', () => {
  it('keeps an INHERITED codex-sdk panel on the session-scoped initial path', async () => {
    await dispatchQuickSessionInput(session('codex-sdk'), 'panel-1', 'hi', 'initial', undefined, undefined, undefined, null);

    expect(mocks.sessionSendInput).toHaveBeenCalledWith('session-1', 'hi');
    expect(mocks.panelSendInput).not.toHaveBeenCalled();
  });

  it('sends an interactive-override panel in a Codex SDK session down the PTY path', async () => {
    await dispatchQuickSessionInput(
      session('codex-sdk'),
      'panel-2',
      'hi',
      'initial',
      undefined,
      undefined,
      undefined,
      'interactive',
    );

    // panels:send-input — main relays this into the panel's own Codex terminal.
    expect(mocks.panelSendInput).toHaveBeenCalledWith('panel-2', 'hi\n');
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
  });

  it('sends an sdk-override panel in a Codex terminal session to the panel-scoped Codex SDK path', async () => {
    await dispatchQuickSessionInput(
      session('codex-pty'),
      'panel-2',
      'hi',
      'initial',
      undefined,
      undefined,
      undefined,
      'sdk',
    );

    // Panel-scoped continue: the codex-sdk lane in main starts the app-server turn.
    expect(mocks.panelContinue).toHaveBeenCalledWith('panel-2', 'hi', undefined, undefined, undefined);
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
    expect(mocks.panelSendInput).not.toHaveBeenCalled();
  });

  it('leaves an INHERITED codex-pty panel on the PTY path', async () => {
    await dispatchQuickSessionInput(session('codex-pty'), 'panel-1', 'hi', 'initial', undefined, undefined, undefined, null);

    expect(mocks.panelSendInput).toHaveBeenCalledWith('panel-1', 'hi\n');
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
  });

  // omp-pty mirrors codex-pty identically for the panel-substrate-override case.
  it('sends an interactive-override panel in an OMP SDK session down the PTY path', async () => {
    await dispatchQuickSessionInput(
      session('omp-sdk'),
      'panel-2',
      'hi',
      'initial',
      undefined,
      undefined,
      undefined,
      'interactive',
    );

    expect(mocks.panelSendInput).toHaveBeenCalledWith('panel-2', 'hi\n');
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
  });

  it('sends an sdk-override panel in an OMP terminal session to the panel-scoped OMP SDK path', async () => {
    await dispatchQuickSessionInput(
      session('omp-pty'),
      'panel-2',
      'hi',
      'initial',
      undefined,
      undefined,
      undefined,
      'sdk',
    );

    expect(mocks.panelContinue).toHaveBeenCalledWith('panel-2', 'hi', undefined, undefined, undefined);
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
    expect(mocks.panelSendInput).not.toHaveBeenCalled();
  });

  it('leaves an INHERITED omp-pty panel on the PTY path', async () => {
    await dispatchQuickSessionInput(session('omp-pty'), 'panel-1', 'hi', 'initial', undefined, undefined, undefined, null);

    expect(mocks.panelSendInput).toHaveBeenCalledWith('panel-1', 'hi\n');
    expect(mocks.sessionSendInput).not.toHaveBeenCalled();
  });
});
