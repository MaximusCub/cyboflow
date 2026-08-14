/**
 * cyboflow.omp sub-router — read-only OMP fleet awareness.
 *
 * Exposes a REDACTED fleet summary from the injected OmpControlPlaneAdapter.
 * The adapter's full snapshot carries task text, lastOutput, repoPath,
 * allowedPaths, and failure-report output — none of which may cross into the
 * renderer. This router maps it to the renderer-safe view DTO BEFORE the tRPC
 * reply, so sensitive fields never leave main.
 *
 * Read-only by construction: no mutation surface lives here (commands are a
 * separate, privileged router).
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { router, protectedProcedure } from '../trpc';
import type {
  OmpFleetViewResult,
  OmpFleetViewSnapshot,
  OmpSnapshotResult,
} from '../../../../../shared/types/omp';

/** Map a full snapshot to the renderer-safe view projection. */
function toViewSnapshot(result: OmpSnapshotResult): OmpFleetViewResult {
  if (!result.ok) {
    return result;
  }
  const s = result.snapshot;
  const view: OmpFleetViewSnapshot = {
    version: s.version,
    savedAt: s.savedAt,
    totalWorkers: s.workers.length,
    workers: s.workers.map((w) => ({
      id: w.id,
      label: w.label,
      model: w.model,
      status: w.status,
      backend: w.backend,
      spawnedAt: w.spawnedAt,
      lastSeenAt: w.lastSeenAt,
    })),
  };
  return { ok: true, snapshot: view };
}

export const ompRouter = router({
  /**
   * The latest fleet summary (redacted), or a discriminated failure.
   * An absent registry surfaces as `{ ok: false, error: 'missing' }`; an
   * unreadable (permission-denied/IO) registry as `'unavailable'`; a parse or
   * version failure as `'malformed'` / `'unsupported-version'`. Never a thrown
   * error or an empty-success.
   */
  fleetSnapshot: protectedProcedure.query(async ({ ctx }): Promise<OmpFleetViewResult> => {
    const omp = ctx.omp;
    if (!omp) {
      return {
        ok: false,
        error: 'unavailable',
        detail: 'OMP adapter not configured',
      };
    }
    const result = await omp.getFleetSnapshot();
    return toViewSnapshot(result);
  }),
});
