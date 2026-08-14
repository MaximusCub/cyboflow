/**
 * Tests for cyboflow.omp.fleetSnapshot — the redacted read surface.
 *
 * Verifies the DTO boundary: a full snapshot carrying sentinel secrets in
 * task/lastOutput/repoPath/allowedPaths/failure output is projected down to
 * summary fields only before crossing the tRPC reply. Typecheck alone cannot
 * prove redaction; this test asserts the sentinels are absent and the summary
 * fields are present.
 */
import { describe, it, expect } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { OmpControlPlaneAdapter, RegistrySnapshot, WorkerEntry } from '../../../../../../shared/types/omp';

const SENTINEL = 'SENTINEL_SECRET_DO_NOT_CROSS_IPC';

function fullWorker(): WorkerEntry {
  return {
    id: 'wkr-1',
    paneId: 'p1',
    workspaceId: 'ws-1',
    backend: 'subprocess',
    model: 'zai/glm-5.2:high',
    task: `deploy ${SENTINEL}`,
    label: 'a-label',
    status: 'working',
    spawnedAt: '2026-08-13T00:00:00.000Z',
    lastSeenAt: '2026-08-13T00:01:00.000Z',
    leaseExpiresAt: '2026-08-13T00:10:00.000Z',
    lastOutput: `stdout: ${SENTINEL}`,
    repoPath: `/repos/${SENTINEL}`,
    allowedPaths: [`/src/${SENTINEL}.ts`],
    failureReport: {
      state: 'pending',
      idempotencyKey: 'k',
      transitionStatus: 'failed',
      output: `failure ${SENTINEL}`,
    },
  };
}

const adapter: OmpControlPlaneAdapter = {
  version: 1,
  authority: 'read',
  async getFleetSnapshot() {
    const snapshot: RegistrySnapshot = {
      version: 1,
      savedAt: '2026-08-13T00:02:00.000Z',
      workers: [fullWorker()],
    };
    return { ok: true, snapshot };
  },
};

describe('cyboflow.omp.fleetSnapshot redaction', () => {
  it('projects a full snapshot down to summary fields only (no secrets cross the boundary)', async () => {
    const caller = appRouter.createCaller(createContext({ omp: adapter }));
    const res = await caller.cyboflow.omp.fleetSnapshot();

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');

    const wire = JSON.stringify(res);

    // Summary fields present.
    expect(res.snapshot.totalWorkers).toBe(1);
    expect(res.snapshot.workers[0]).toEqual({
      id: 'wkr-1',
      label: 'a-label',
      model: 'zai/glm-5.2:high',
      status: 'working',
      backend: 'subprocess',
      spawnedAt: '2026-08-13T00:00:00.000Z',
      lastSeenAt: '2026-08-13T00:01:00.000Z',
    });

    // Secret-bearing fields absent from the wire.
    expect(wire).not.toContain(SENTINEL);
    expect(wire).not.toContain('task');
    expect(wire).not.toContain('lastOutput');
    expect(wire).not.toContain('repoPath');
    expect(wire).not.toContain('allowedPaths');
    expect(wire).not.toContain('failureReport');
    expect(wire).not.toContain('paneId');
  });

  it('surfaces unavailable when no adapter is configured', async () => {
    const caller = appRouter.createCaller(createContext({}));
    const res = await caller.cyboflow.omp.fleetSnapshot();
    expect(res).toMatchObject({ ok: false, error: 'unavailable' });
  });
});
