/**
 * useOmpAvailability — what the OMP picker may offer on this install.
 *
 * - `launchable`: the main side has a live fleet session manager, so a remote
 *   worker can actually be spawned.
 * - `ariaMode`: this install supervises a REMOTE fleet rather than running OMP
 *   locally. The two OMP flavors are alternatives — the picker shows
 *   `omp-sdk`/`omp-pty` OR `omp-fleet`, never both.
 *
 * Read-only: this drives the SubstrateSelector gating. The provider toggle
 * (Settings → Integrations) is a SEPARATE gate, ANDed by the caller via
 * useIsAgentProviderEnabled('omp') — mirroring the two-sided availability in
 * omp-phase4-coexistence-adr.md §2.3. The renderer read is a courtesy, never
 * the enforcement: a launch that names a half-configured bridge still fails
 * closed on the main side.
 *
 * A transport failure floors BOTH to `false` (the honest answer — we cannot
 * prove anything), never a stale `true`. Flooring `ariaMode` to false is the
 * conservative direction: it shows the LOCAL runtimes, which need no bridge.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';

export interface OmpAvailability {
  /** A remote worker can actually be spawned right now. */
  launchable: boolean;
  /** Remote-fleet install: offer `omp-fleet` instead of the local OMP runtimes. */
  ariaMode: boolean;
}

const UNAVAILABLE: OmpAvailability = { launchable: false, ariaMode: false };

export function useOmpAvailability(): OmpAvailability {
  const [availability, setAvailability] = useState<OmpAvailability>(UNAVAILABLE);

  useEffect(() => {
    let cancelled = false;
    // Null-safe: a partial `trpc` mock (component tests) may omit `cyboflow.omp`;
    // a missing router means "cannot prove anything", which is exactly the floor.
    const availabilityQuery = trpc.cyboflow?.omp?.availability?.query;
    if (typeof availabilityQuery !== 'function') {
      setAvailability(UNAVAILABLE);
      return () => {
        cancelled = true;
      };
    }
    availabilityQuery()
      .then((res) => {
        if (!cancelled) {
          setAvailability({ launchable: res.launchable === true, ariaMode: res.ariaMode === true });
        }
      })
      .catch(() => {
        if (!cancelled) setAvailability(UNAVAILABLE);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return availability;
}
