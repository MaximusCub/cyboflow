/**
 * Unit tests for useSessionSummary (QuickSessionCanvas summary + history poll).
 *
 * Exercised with renderHook + a mocked API.sessions.getSummary (no real
 * Electron IPC) — mirrors useSessionMetrics.test.ts's conventions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const { mockGetSummary } = vi.hoisted(() => ({
  mockGetSummary: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      getSummary: mockGetSummary,
    },
  },
}));

import { useSessionSummary } from '../useSessionSummary';

const PAYLOAD = {
  success: true,
  data: {
    enabled: true,
    summary: 'Refactoring the auth middleware and adding tests.',
    updatedAt: '2026-07-23T10:00:00.000Z',
    entries: [{ id: 1, entry: 'Set up the auth middleware skeleton.', createdAt: '2026-07-23T09:00:00.000Z' }],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSummary.mockResolvedValue(PAYLOAD);
});

describe('useSessionSummary', () => {
  it('returns null summary and does not query when sessionId is null', () => {
    const { result } = renderHook(() => useSessionSummary(null));
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mockGetSummary).not.toHaveBeenCalled();
  });

  it('fetches on mount and surfaces the payload', async () => {
    const { result } = renderHook(() => useSessionSummary('s1'));

    expect(result.current.loading).toBe(true);
    await waitFor(() => {
      expect(result.current.summary).not.toBeNull();
    });
    expect(mockGetSummary).toHaveBeenCalledWith('s1');
    expect(result.current.summary).toEqual(PAYLOAD.data);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error message and clears it on the next success', async () => {
    // Fake timers from the start — the 30s poll interval is armed inside the
    // hook's mount effect, so switching to fake timers AFTER mount would leave
    // that interval on the real clock and never fire.
    vi.useFakeTimers();
    try {
      mockGetSummary.mockResolvedValueOnce({ success: false, error: 'boom' });
      const { result } = renderHook(() => useSessionSummary('s1'));

      await act(async () => {
        await Promise.resolve();
      });
      expect(result.current.error).toBe('boom');
      expect(result.current.summary).toBeNull();

      // Next poll succeeds — error clears, summary populates.
      mockGetSummary.mockResolvedValueOnce(PAYLOAD);
      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await Promise.resolve();
      });
      expect(result.current.error).toBeNull();
      expect(result.current.summary).toEqual(PAYLOAD.data);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pauses the 30s poll while the document is hidden, resumes with a catch-up load on re-show', async () => {
    vi.useFakeTimers();
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get');
    hiddenSpy.mockReturnValue(false);

    try {
      renderHook(() => useSessionSummary('s1'));
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockGetSummary).toHaveBeenCalledTimes(1);

      // Hide the document — the 30s poll must stop firing.
      hiddenSpy.mockReturnValue(true);
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        vi.advanceTimersByTime(90_000);
        await Promise.resolve();
      });
      expect(mockGetSummary).toHaveBeenCalledTimes(1);

      // Re-show — an immediate catch-up load fires, then the 30s cadence resumes.
      hiddenSpy.mockReturnValue(false);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await Promise.resolve();
      });
      expect(mockGetSummary).toHaveBeenCalledTimes(2);
    } finally {
      hiddenSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('drops a late response from a stale sessionId (out-of-order guard)', async () => {
    let resolveFirst!: (value: typeof PAYLOAD) => void;
    mockGetSummary.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const { result, rerender } = renderHook(({ sessionId }) => useSessionSummary(sessionId), {
      initialProps: { sessionId: 's1' as string | null },
    });

    // Switch sessions before the first (s1) fetch resolves.
    const secondPayload = {
      success: true,
      data: { ...PAYLOAD.data, summary: 'Session 2 summary.' },
    };
    mockGetSummary.mockResolvedValueOnce(secondPayload);
    rerender({ sessionId: 's2' });

    await waitFor(() => {
      expect(result.current.summary?.summary).toBe('Session 2 summary.');
    });

    // The stale s1 response now resolves — must NOT overwrite s2's data.
    resolveFirst(PAYLOAD);
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.summary?.summary).toBe('Session 2 summary.');
  });
});
