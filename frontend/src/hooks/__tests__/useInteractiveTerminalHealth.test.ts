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

/**
 * Flush the IMMEDIATE mount probe (the hook probes once on mount as well as on
 * the interval, so the first verdict does not wait a full POLL_MS).
 */
async function flushMount(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * Advance N poll ticks, flushing the promise each probe returns. Total probes
 * after `flushMount(); tick(n)` is n + 1.
 */
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

  it('probes immediately on mount, so the first verdict does not wait a full interval', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await flushMount();
    expect(mockGetResumeState).toHaveBeenCalledTimes(1);
  });

  it('does NOT stall on a single dead probe — a spawning REPL is not a dead one', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await flushMount();
    expect(result.current.stalled).toBe(false);
  });

  it('stalls once the REPL reads dead on consecutive probes', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await flushMount();
    await tick(1);
    expect(result.current.stalled).toBe(true);
    expect(result.current.worktreeMissing).toBe(false);
  });

  it('reports a dead-but-resumable REPL as resumable, never as stalled', async () => {
    // The regression this exists for: a REPL that dies MID-SESSION used to
    // surface nothing at all. `stalled` correctly defers to the resume prompt,
    // but that prompt's own eligibility is probed once at mount — when the REPL
    // was still alive — so the deferral fell into a black hole until the user
    // navigated away and back. The live `resumable` signal is what closes it.
    mockGetResumeState.mockResolvedValue(probeResult({ claudeSessionId: 'uuid-1' }));
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await flushMount();
    await tick(1);
    expect(result.current.resumable).toBe(true);
    expect(result.current.stalled).toBe(false);
  });

  it('clears resumable again once the REPL is back', async () => {
    mockGetResumeState.mockResolvedValue(probeResult({ claudeSessionId: 'uuid-1' }));
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await flushMount();
    await tick(1);
    expect(result.current.resumable).toBe(true);

    mockGetResumeState.mockResolvedValue(probeResult({ replRunning: true, claudeSessionId: 'uuid-1' }));
    await tick(1);
    expect(result.current.resumable).toBe(false);
  });

  it('a resumable REPL whose worktree is gone stalls instead — resume needs the worktree', async () => {
    mockGetResumeState.mockResolvedValue(
      probeResult({ claudeSessionId: 'uuid-1', worktreeExists: false }),
    );
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await flushMount();
    await tick(1);
    expect(result.current.resumable).toBe(false);
    expect(result.current.stalled).toBe(true);
    expect(result.current.worktreeMissing).toBe(true);
  });

  it('reports an unrecoverable stall when the worktree is gone', async () => {
    mockGetResumeState.mockResolvedValue(probeResult({ worktreeExists: false }));
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await flushMount();
    await tick(1);
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
    // probe 1 (mount) dead, probe 2 live (resets), probe 3 dead → only ONE dead
    // probe has accumulated, so no verdict yet.
    await flushMount();
    await tick(2);
    expect(result.current.stalled).toBe(false);
    await tick(1);
    expect(result.current.stalled).toBe(true);
  });

  it('clears the stall on a successful retry and calls restartInteractive for the panel', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result } = renderHook(() => useInteractiveTerminalHealth('s1', 'p1', true));
    await flushMount();
    await tick(1);
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
    await flushMount();
    await tick(1);
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
    await flushMount();
    await tick(1);
    expect(result.current.stalled).toBe(true);

    await act(async () => {
      result.current.retry();
    });
    expect(result.current.stalled).toBe(false);

    // The retry reset the dead-probe run, and there is no remount here — so the
    // threshold must be re-earned from the interval alone.
    await tick(2);
    expect(result.current.stalled).toBe(true);
  });

  it('resets its verdict when the panel identity changes', async () => {
    mockGetResumeState.mockResolvedValue(probeResult());
    const { result, rerender } = renderHook(
      ({ panelId }: { panelId: string }) => useInteractiveTerminalHealth('s1', panelId, true),
      { initialProps: { panelId: 'p1' } },
    );
    await flushMount();
    await tick(1);
    expect(result.current.stalled).toBe(true);

    rerender({ panelId: 'p2' });
    expect(result.current.stalled).toBe(false);
  });
});
