/**
 * useOmpAvailability — whether the OMP fleet runtime is launchable from this
 * app (the bridge command config resolved on the main side).
 *
 * Read-only: this drives the SubstrateSelector gating so the picker only offers
 * OMP Fleet when the backend can actually spawn a remote worker. The provider
 * toggle (Settings → Integrations) is a SEPARATE gate, ANDed by the caller via
 * useIsAgentProviderEnabled('omp') — mirroring the two-sided availability in
 * omp-phase4-coexistence-adr.md §2.3. The renderer read is a courtesy, never
 * the enforcement: a launch that names a half-configured bridge still fails
 * closed on the main side.
 *
 * A transport failure floors to `false` (the honest answer — we cannot prove
 * OMP is launchable), never a stale `true`.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';

export function useOmpAvailability(): boolean {
  const [launchable, setLaunchable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Null-safe: a partial `trpc` mock (component tests) may omit `cyboflow.omp`;
    // a missing router means "cannot prove launchable", which is exactly false.
    const availabilityQuery = trpc.cyboflow?.omp?.availability?.query;
    if (typeof availabilityQuery !== 'function') {
      setLaunchable(false);
      return () => {
        cancelled = true;
      };
    }
    availabilityQuery()
      .then((res) => {
        if (!cancelled) setLaunchable(res.launchable === true);
      })
      .catch(() => {
        if (!cancelled) setLaunchable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return launchable;
}
