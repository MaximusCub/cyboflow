/**
 * Gate-run-time resolution of the vitest fork-pool size, shared by
 * `main/vitest.config.ts` and `frontend/vitest.config.ts`.
 *
 * The policy lives in `shared/types/testConcurrency.ts`; this module supplies the
 * only impure input — how many vitest gates are running on this machine RIGHT
 * NOW — and is the reason the cap is computed here rather than baked into the
 * agent environment at spawn time. See that module's header for the full why.
 *
 * Every path is fail-soft: if `ps` is unavailable (Windows, a locked-down CI
 * image, a sandbox), we report a single gate, which resolves to vitest's normal
 * parallelism — never an error and never a hang.
 */
import { execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

import { resolveForkCap } from './shared/types/testConcurrency';

/**
 * Vitest names its root process `node (vitest)` and each pool worker
 * `node (vitest N)`. Counting ROOTS therefore counts concurrent gate runs
 * regardless of how wide each one's pool is.
 */
const VITEST_ROOT_TITLE = /^node \(vitest\)$/;

export type ListProcessCommands = () => string;

const defaultListProcessCommands: ListProcessCommands = () =>
  execFileSync('ps', ['-Ao', 'command='], { encoding: 'utf8', timeout: 5_000 });

/**
 * Count vitest root processes, including this one. Returns at least 1 — vitest
 * may not have set its process title yet when the config is evaluated, and
 * undercounting by one is the safe direction (a slightly larger pool, never a
 * divide-by-zero).
 */
export function countRunningGates(
  listProcessCommands: ListProcessCommands = defaultListProcessCommands,
): number {
  try {
    const lines = listProcessCommands().split('\n');
    let count = 0;
    for (const line of lines) {
      if (VITEST_ROOT_TITLE.test(line.trim())) count += 1;
    }
    return Math.max(1, count);
  } catch {
    return 1;
  }
}

/**
 * The `pool`/`poolOptions` slice to spread into a vitest `test` config. Empty
 * when no cap applies, so an unmanaged run keeps vitest's own pool defaults
 * untouched rather than being pinned to `forks`.
 */
export function forkPoolOptions(
  env: NodeJS.ProcessEnv = process.env,
  listProcessCommands: ListProcessCommands = defaultListProcessCommands,
):
  | Record<string, never>
  | { pool: 'forks'; poolOptions: { forks: { maxForks: number; minForks: number } } } {
  const maxForks = resolveForkCap({
    explicit: env.CYBOFLOW_TEST_MAX_FORKS,
    managed: env.CYBOFLOW_MANAGED_TEST_CONCURRENCY,
    cores: availableParallelism(),
    concurrentGates: countRunningGates(listProcessCommands),
  });
  if (maxForks === undefined) return {};
  return { pool: 'forks', poolOptions: { forks: { maxForks, minForks: 1 } } };
}
