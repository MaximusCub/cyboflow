/**
 * Unit tests for useInteractiveTerminalHealth — the dead-terminal detector
 * behind the stalled terminal's Retry button.
 *
 * The behaviours worth pinning are the ones that decide whether a user sees a
 * scary "not running" card over a perfectly healthy terminal:
 *   - a REPL still spawning must NEVER be called dead (hence the consecutive-
 *     probe threshold, not a single probe),
 *   - a dead REPL with a resumable conversation belongs to ResumeSessionPrompt,
 *     not to restart,
 *   - a failed probe is not evidence of death.
 *
 * The API facade is mocked; timers are fake so the poll cadence is exercised
 * deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockGetResumeState, mockRestart } = vi.hoisted(() => ({
  mockGetResumeState: vi.fn(),
  mockRestart: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getInteractiveResumeState: mockGetResumeState,
      restartInteractive: mockRestart,
    },
  },
}));

import { useInteractiveTerminalHealth } from '../useInteractiveTerminalHealth';

const POLL_MS = 5000;

/** A resume-state probe result. */
function probeResult(
  over: Partial<{ replRunning: boolean; claudeSessionId: string | null; worktreeExists: boolean }> = {},
) {
  return {
    success: true,
    data: { replRunning: false, claudeSessionId: null, worktreeExists: true, ...over },
  };
}

/** Advance N poll ticks, flushing the promise each probe returns. */
async function tick(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockGetResumeState.mockResolvedValue(probeResult({ replRunning: true }));
  mockRestart.mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useInteractiveTerminalHealth', () => {
  it('does not probe at all when disabled (Codex PTY / demo / SDK panels)', async () => {
    renderHook(() => useInteractiveTerminalHealth('s1', 'p1', false));
    await tick(4);
    expect(mockGetResumeState).not.toHaveBeenCalled();
  });

  it('stays healthy while the REPL is running', async () => {
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(4);
    expect(result.current.stalled).toBe(false);
  });

  it('does NOT stall on a single dead probe — a spawning REPL is not a dead one', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(1);
    expect(result.current.stalled).toBe(false);
  });

  it('stalls once the REPL reads dead on consecutive probes', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(2);
    expect(result.current.stalled).toBe(true);
    expect(result.current.worktreeMissing).toBe(false);
  });

  it('never stalls when a prior conversation is resumable — that is the resume prompt\'s job', async () => {
    mockGetResumeState.mockResolvedValue(probeResult({ claudeSessionId: 'uuid-1' }));
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(4);
    expect(result.current.stalled).toBe(false);
  });

  it('reports an unrecoverable stall when the worktree is gone', async () => {
    mockGetResumeState.mockResolvedValue(probeResult({ worktreeExists: false }));
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(2);
    expect(result.current.worktreeMissing).toBe(true);
  });

  it('treats a failed probe as no evidence, not as death', async () => {
    mockGetResumeState.mockRejectedValue(new Error('ipc down'));
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(4);
    expect(result.current.stalled).toBe(false);
  });

  it('a dead probe run does not accumulate across a live one', async () => {
    mockGetResumeState.mockResolvedValueOnce(probeResult());
    mockGetResumeState.mockResolvedValueOnce(probeResult({ replRunning: true }));
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    // dead, live (resets), dead → only ONE dead probe has accumulated.
    await tick(3);
    expect(result.current.stalled).toBe(false);
    await tick(1);
    expect(result.current.stalled).toBe(true);
  });

  it('clears the stall on a successful retry and calls restartInteractive for the panel', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(2);
    expect(result.current.stalled).toBe(true);

    await act(async () => {
      result.current.retry();
    });

    expect(mockRestart).toHaveBeenCalledWith('s1', 'p1');
    expect(result.current.stalled).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('surfaces a refused restart (e.g. Claude switched off) instead of silently clearing', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    mockRestart.mockResolvedValue({ success: false, error: 'Claude is turned off in Settings' });
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(2);
    expect(result.current.stalled).toBe(true);

    await act(async () => {
      result.current.retry();
    });

    expect(result.current.error).toBe('Claude is turned off in Settings');
    expect(result.current.stalled).toBe(true);
    expect(result.current.retrying).toBe(false);
  });

  it('re-stalls when the restarted REPL dies again, so a broken terminal stays visible', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await tick(2);
    expect(result.current.stalled).toBe(true);

    await act(async () => {
      result.current.retry();
    });
    expect(result.current.stalled).toBe(false);

    await tick(2);
    expect(result.current.stalled).toBe(true);
  });

  it('resets its verdict when the panel identity changes', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result, rerender } = renderHook(
      ({ panelId }: { panelId: string }) => useInteractiveTerminalHealth('s1', panelId, true),
      { initialProps: { panelId: 'p1' } },
    );
    await tick(2);
    expect(result.current.stalled).toBe(true);

    rerender({ panelId: 'p2' });
    expect(result.current.stalled).toBe(false);
  });
});
