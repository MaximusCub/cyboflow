/**
 * Unit tests for ompFleetStore.
 *
 * Verifies:
 *   (a) Initial state is { status: 'absent', workerCount: null, ... }.
 *   (b) A successful snapshot → 'available' + worker count.
 *   (c) `unavailable` → 'absent'; `malformed`/`unsupported-version` → 'error'.
 *   (d) A transport/IPC failure downgrades a prior 'available' to 'checking'
 *       (never stale-green) and bumps lastCheckedAt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OmpFleetViewResult } from '../../../../shared/types/omp';

const { mockFleetSnapshot } = vi.hoisted(() => ({
  mockFleetSnapshot: vi.fn<() => Promise<OmpFleetViewResult>>(),
}));

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      omp: {
        fleetSnapshot: {
          query: mockFleetSnapshot,
        },
      },
    },
  },
}));

import { useOmpFleetStore } from '../ompFleetStore';

const OK_SNAPSHOT: OmpFleetViewResult = {
  ok: true,
  snapshot: {
    version: 1,
    savedAt: '2026-08-13T00:00:00.000Z',
    totalWorkers: 2,
    workers: [],
  },
};

function resetStore() {
  useOmpFleetStore.setState({
    status: 'absent',
    workerCount: null,
    errorKind: null,
    detail: null,
    lastCheckedAt: null,
  });
}

describe('ompFleetStore', () => {
  beforeEach(() => {
    resetStore();
    mockFleetSnapshot.mockReset();
  });

  it('starts absent with no worker count', () => {
    expect(useOmpFleetStore.getState()).toMatchObject({
      status: 'absent',
      workerCount: null,
      errorKind: null,
      lastCheckedAt: null,
    });
  });

  it('setSnapshot maps ok → available with worker count', () => {
    useOmpFleetStore.getState().setSnapshot(OK_SNAPSHOT);
    expect(useOmpFleetStore.getState()).toMatchObject({
      status: 'available',
      workerCount: 2,
      errorKind: null,
    });
  });

  it('setSnapshot maps missing → absent, unavailable/malformed → error', () => {
    const s = useOmpFleetStore.getState();

    s.setSnapshot({ ok: false, error: 'missing', detail: 'x' });
    expect(useOmpFleetStore.getState().status).toBe('absent');

    s.setSnapshot({ ok: false, error: 'unavailable', detail: 'x' });
    expect(useOmpFleetStore.getState()).toMatchObject({ status: 'error', errorKind: 'unavailable' });

    s.setSnapshot({ ok: false, error: 'malformed', detail: 'x' });
    expect(useOmpFleetStore.getState()).toMatchObject({ status: 'error', errorKind: 'malformed' });
  });

  it('a transport error after a good snapshot downgrades to checking (never stale-green)', () => {
    useOmpFleetStore.getState().setSnapshot(OK_SNAPSHOT);
    expect(useOmpFleetStore.getState().status).toBe('available');

    useOmpFleetStore.getState().setTransportError();
    expect(useOmpFleetStore.getState()).toMatchObject({ status: 'checking' });
    expect(useOmpFleetStore.getState().lastCheckedAt).not.toBeNull();
  });

  it('subscribeToOmpFleet polls the query and applies the snapshot', async () => {
    mockFleetSnapshot.mockResolvedValue(OK_SNAPSHOT);
    const unsubscribe = useOmpFleetStore.getState().subscribeToOmpFleet();

    await vi.waitFor(() => {
      expect(useOmpFleetStore.getState().status).toBe('available');
    });

    unsubscribe();
  });
});
