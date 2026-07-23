/**
 * useSessionSummary — polls the idle-debounced quick-session summary + history
 * for the QuickSessionCanvas session node.
 *
 * Pure poll: `API.sessions.getSummary` is a read (`sessions:get-summary`), and
 * the backend's own lazy catch-up (session-summary-plan.md §2.7) does the work
 * of refreshing a stale summary when one is due — this hook has no separate
 * "kick" logic. Visibility handling mirrors `useSessionMetrics`'s stats poll
 * (`useSessionMetrics.ts:207-235`): fetch on mount, poll every 30s while the
 * document is visible, pause on `document.hidden`, and fire an immediate
 * catch-up fetch on resume so the summary isn't stale by however long the tab
 * was hidden.
 */
import { useEffect, useRef, useState } from 'react';
import { API } from '../utils/api';
import type { SessionSummaryPayload } from '../../../shared/types/sessionSummary';

/** Re-poll cadence for the summary read. */
const SUMMARY_POLL_MS = 30_000;

export interface UseSessionSummaryResult {
  /** The last-fetched summary payload, or null before the first response lands. */
  summary: SessionSummaryPayload | null;
  /** True only for the in-flight initial fetch (never re-flips true on a poll refresh). */
  loading: boolean;
  /** Message from the most recent failed fetch; cleared on the next success. */
  error: string | null;
}

export function useSessionSummary(sessionId: string | null): UseSessionSummaryResult {
  const [summary, setSummary] = useState<SessionSummaryPayload | null>(null);
  const [loading, setLoading] = useState<boolean>(sessionId !== null);
  const [error, setError] = useState<string | null>(null);
  // Guard against a late response from a previous session overwriting the new one.
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    if (sessionId === null) {
      setSummary(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const res = await API.sessions.getSummary(sessionId);
        if (cancelled || sessionIdRef.current !== sessionId) return;
        if (res.success && res.data) {
          setSummary(res.data);
          setError(null);
        } else if (!res.success) {
          setError(res.error ?? 'Failed to load session summary');
        }
      } catch (err) {
        if (cancelled || sessionIdRef.current !== sessionId) return;
        setError(err instanceof Error ? err.message : 'Failed to load session summary');
      } finally {
        if (!cancelled && sessionIdRef.current === sessionId) setLoading(false);
      }
    };

    // Pause the 30s poll while the document is hidden — mirrors useSessionMetrics's
    // stats-poll gate (an offscreen canvas re-fetching a summary every 30s is pure
    // idle churn). Cadence stays 30s while visible; resume fires an immediate
    // catch-up load so the display isn't stale by however long the tab was hidden.
    let id: number | null = null;
    const start = () => {
      if (id !== null) return;
      id = window.setInterval(() => void load(), SUMMARY_POLL_MS);
    };
    const stop = () => {
      if (id === null) return;
      window.clearInterval(id);
      id = null;
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        void load();
        start();
      }
    };

    void load();
    if (!document.hidden) {
      start();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cancelled = true;
      stop();
    };
  }, [sessionId]);

  return { summary, loading, error };
}
