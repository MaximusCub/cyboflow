/**
 * useInteractiveTerminalHealth — detect a DEAD interactive (PTY) terminal and
 * expose a retry.
 *
 * Why this exists: create-quick's eager REPL spawn is fire-and-forget and
 * deliberately fail-soft (the handler has already returned `success` plus a
 * `claudePanelId` by the time the spawn resolves). When that spawn dies, the
 * renderer still mounts a terminal against a `cyboflow:pty:<id>` channel that
 * will never emit a byte: the xterm opens, fits, and paints nothing but its
 * cursor — forever, with no error on any surface and no way back short of
 * typing a message (which re-spawns via sessions:input) or discarding the
 * session. That is the "blank terminal with just a cursor" a first-run user
 * hits when their very first quick session fails to boot.
 *
 * Liveness is probed from the REPL process itself (`replRunning`), NOT from
 * whether bytes have arrived: claude's startup paint can legitimately lag
 * several seconds behind a healthy spawn, so "no bytes yet" is not evidence of
 * death, while "no process" is.
 *
 * Two states are deliberately NOT stalled:
 *   - `claudeSessionId` present → the REPL died but its conversation survives on
 *     disk. That is ResumeSessionPrompt's job (resume beats restart, because a
 *     fresh start throws the history away).
 *   - `worktreeExists` false → the worktree is gone, so a restart cannot work.
 *     Reported as stalled-but-unrecoverable so the UI explains instead of
 *     offering a button that is guaranteed to fail.
 *
 * Codex PTY panels MUST NOT enable this: the probe asks Claude's
 * `interactiveCliManager.isPanelRunning`, which knows nothing about Codex
 * panels and would report every healthy Codex terminal as dead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../utils/api';

/** Liveness probe cadence. */
const POLL_MS = 5000;
/**
 * Consecutive dead probes required before declaring the terminal stalled. A
 * spawning REPL registers its process almost immediately, but two probes
 * (≥ POLL_MS × 2 after mount) buys a wide margin over a slow cold start so a
 * healthy terminal is never accused of being dead.
 */
const DEAD_PROBES_TO_STALL = 2;

export interface InteractiveTerminalHealth {
  /** The REPL is dead with no prior conversation to resume — it will never paint. */
  stalled: boolean;
  /** Stalled AND unrecoverable (worktree gone) — explain rather than offer retry. */
  worktreeMissing: boolean;
  /** A restart is in flight. */
  retrying: boolean;
  /** Why the last restart attempt failed (user-facing), or null. */
  error: string | null;
  /** Spawn a fresh REPL for this panel. */
  retry: () => void;
}

export function useInteractiveTerminalHealth(
  sessionId: string | null | undefined,
  panelId: string,
  enabled: boolean,
): InteractiveTerminalHealth {
  const [stalled, setStalled] = useState(false);
  const [worktreeMissing, setWorktreeMissing] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deadProbesRef = useRef(0);

  useEffect(() => {
    // Reset on every identity/enablement change so a panel switch never inherits
    // the previous panel's verdict.
    deadProbesRef.current = 0;
    setStalled(false);
    setWorktreeMissing(false);
    setError(null);
    if (!enabled || !sessionId) return;

    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const res = await API.sessions.getInteractiveResumeState(sessionId, panelId);
        if (cancelled) return;
        const data = res?.data;
        if (!res?.success || !data) return;
        if (data.replRunning) {
          // Alive — clear any prior verdict (covers a successful retry too).
          deadProbesRef.current = 0;
          setStalled(false);
          setWorktreeMissing(false);
          return;
        }
        if (data.claudeSessionId) {
          // Recoverable by RESUME, not restart — leave it to ResumeSessionPrompt.
          deadProbesRef.current = 0;
          setStalled(false);
          return;
        }
        deadProbesRef.current += 1;
        if (deadProbesRef.current >= DEAD_PROBES_TO_STALL) {
          setStalled(true);
          setWorktreeMissing(!data.worktreeExists);
        }
      } catch {
        // A failed probe is not evidence of a dead REPL — leave the verdict
        // unchanged and let the next tick decide.
      }
    };

    const timer = setInterval(() => void probe(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, panelId, enabled]);

  const retry = useCallback(() => {
    if (!sessionId || retrying) return;
    setRetrying(true);
    setError(null);
    void API.sessions
      .restartInteractive(sessionId, panelId)
      .then((res) => {
        if (res?.success) {
          // Optimistically clear; the next probe confirms (and re-stalls if the
          // fresh spawn dies too, so a repeatedly-failing REPL stays visible).
          deadProbesRef.current = 0;
          setStalled(false);
          return;
        }
        setError(res?.error ?? 'Failed to restart the terminal');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to restart the terminal');
      })
      .finally(() => setRetrying(false));
  }, [sessionId, panelId, retrying]);

  return { stalled, worktreeMissing, retrying, error, retry };
}
