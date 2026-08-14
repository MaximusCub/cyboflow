/**
 * cyboflow.omp sub-router — read-only OMP fleet awareness.
 *
 * Exposes the durable fleet registry snapshot from the injected
 * OmpControlPlaneAdapter. Read-only by construction: no mutation surface lives
 * here (commands are a separate, privileged router that arrives later).
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { router, protectedProcedure } from '../trpc';
import type { OmpSnapshotResult } from '../../../../../shared/types/omp';

export const ompRouter = router({
  /**
   * The latest durable fleet-registry snapshot, or a discriminated failure.
   * A missing/unreadable registry surfaces as `{ ok: false, error: 'unavailable' }`,
   * never as a thrown error or an empty-success.
   */
  fleetSnapshot: protectedProcedure.query(
    ({ ctx }): Promise<OmpSnapshotResult> => {
      const omp = ctx.omp;
      if (!omp) {
        return Promise.resolve({
          ok: false,
          error: 'unavailable',
          detail: 'OMP adapter not configured',
        });
      }
      return omp.getFleetSnapshot();
    },
  ),
});
