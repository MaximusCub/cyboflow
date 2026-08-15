/**
 * Resolve the OMP command principal for the local desktop session.
 *
 * v1: userId is hard-coded `'local'` (the auth-principal placeholder — see
 * `trpc/context.ts`). The `omp:supervise` capability is granted ONLY when
 * `CYBOFLOW_OMP_SUPERVISE` is a truthy value (a local opt-in for a machine the
 * operator is deliberately authorizing). Absent, the principal carries no
 * capabilities and every `ompCommand` mutation is FORBIDDEN at the router —
 * fail closed, never fail open.
 *
 * Standalone-typecheck invariant: no imports from electron, better-sqlite3, or
 * services/*. This module is pure.
 */
import type { OmpPrincipal } from '../../../../shared/types/ompCommand';
import { OMP_SUPERVISE_CAPABILITY } from '../../../../shared/types/ompCommand';

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed !== '' && trimmed !== '0' && trimmed !== 'false' && trimmed !== 'off' && trimmed !== 'no';
}

export function resolveOmpPrincipal(): OmpPrincipal {
  const supervise = isTruthy(process.env.CYBOFLOW_OMP_SUPERVISE);
  return {
    userId: 'local',
    capabilities: supervise ? new Set([OMP_SUPERVISE_CAPABILITY]) : new Set<string>(),
  };
}
