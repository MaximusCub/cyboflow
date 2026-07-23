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
});
