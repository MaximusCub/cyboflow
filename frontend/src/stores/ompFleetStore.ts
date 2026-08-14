/**
 * ompFleetStore — Zustand store for OMP fleet awareness (read-only).
 *
 * Polls `trpc.cyboflow.omp.fleetSnapshot` and collapses the discriminated
 * `OmpFleetViewResult` into a four-value UI status:
 *   'available' → green   (registry parsed; worker count shown)
 *   'absent'    → gray    (no registry / unavailable — OMP never ran here)
 *   'error'     → red     (malformed or unsupported-version)
 *   'checking'  → yellow  (transport/IPC failure — last snapshot is STALE)
 *
 * A transport failure downgrades to 'checking' and bumps `lastCheckedAt`, so the
 * indicator NEVER presents old fleet health as current. Polling pauses while
 * `document.hidden` and refreshes immediately on visibility restore.
 *
 * This is READ-ONLY awareness. No command/mutation surface is reachable from
 * the renderer; the privileged command router is a separate, capability-gated
 * surface that v1 leaves forbidden by default.
 *
 * Cold-mount guarantee: status starts 'absent', never 'available', until a real
 * snapshot returns ok.
 */
import { create } from 'zustand';
import type { OmpFleetViewResult } from '../../../shared/types/omp';
import { trpc } from '../trpc/client';

export type OmpFleetUiStatus = 'available' | 'absent' | 'error' | 'checking';

export interface OmpFleetState {
  status: OmpFleetUiStatus;
  /** Worker count when ok, else null. */
  workerCount: number | null;
  /** Error category when !ok, else null. */
  errorKind: 'unavailable' | 'unsupported-version' | 'malformed' | null;
  /** Redacted detail for the popover (already flattened by main; not raw registry data). */
  detail: string | null;
  lastCheckedAt: number | null;
}

export interface OmpFleetActions {
  setSnapshot: (result: OmpFleetViewResult) => void;
  setTransportError: () => void;
  /** Start polling; returns an unsubscribe function. */
  subscribeToOmpFleet: () => () => void;
}

const POLL_INTERVAL_MS = 10000;

export const useOmpFleetStore = create<OmpFleetState & OmpFleetActions>()((set, get) => ({
  status: 'absent',
  workerCount: null,
  errorKind: null,
  detail: null,
  lastCheckedAt: null,

  setSnapshot(result) {
    if (result.ok) {
      set({
        status: 'available',
        workerCount: result.snapshot.totalWorkers,
        errorKind: null,
        detail: null,
        lastCheckedAt: Date.now(),
      });
      return;
    }
    set({
      status: result.error === 'unavailable' ? 'absent' : 'error',
      workerCount: null,
      errorKind: result.error,
      detail: result.detail,
      lastCheckedAt: Date.now(),
    });
  },

  setTransportError() {
    // Keep the last-known worker count/detail for context, but mark the
    // snapshot stale — the UI must not show it as current.
    set((prev) => ({
      status: 'checking',
      lastCheckedAt: Date.now(),
      errorKind: prev.errorKind,
      detail: prev.detail,
    }));
  },

  subscribeToOmpFleet() {
    let alive = true;
    let intervalId: ReturnType<typeof setInterval> | undefined;

    const poll = async () => {
      try {
        const result: OmpFleetViewResult = await trpc.cyboflow.omp.fleetSnapshot.query();
        if (alive) get().setSnapshot(result);
      } catch {
        if (alive) get().setTransportError();
      }
    };

    const start = () => {
      if (intervalId !== undefined) return;
      void poll();
      intervalId = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    };

    const stop = () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
    };

    // Pause while the window is hidden; refresh immediately on restore.
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      alive = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  },
}));
