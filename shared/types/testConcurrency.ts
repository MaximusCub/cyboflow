/**
 * Test-concurrency governor — the contract between cyboflow (which spawns agents)
 * and the vitest configs (which size their fork pools).
 *
 * WHY. Sprint lanes fan out into the SHARED session worktree (`sprintLaneStore`:
 * "fans out per-task subagents in the SHARED session worktree"), up to
 * `SPRINT_BATCH_CAP` = 5 at once, and an A/B experiment doubles that across two
 * arm worktrees. Every lane's verifier independently runs the project AC gate
 * (`pnpm test:unit`), and each of those runs TWO vitest suites (main + frontend)
 * whose default fork pool is `availableParallelism - 1`. On a 10-core box that is
 * 5 lanes x 2 arms x 9 forks ~= 90 concurrent workers against 10 cores. The
 * machine does not fall over — it goes into swap-thrash-grade oversubscription,
 * gates take minutes instead of seconds, agents conclude the command "hung",
 * abandon it and retry, and the retry makes it worse.
 *
 * `CYBOFLOW_TEST_MAX_FORKS` already existed as the documented lever for exactly
 * this, but nothing ever set it — it was a dead knob. Rather than have cyboflow
 * bake a fixed number into the agent env at SPAWN time (wrong by construction:
 * the five lanes of a sprint all spawn while the count is still 1, and a session
 * outlives many gates), cyboflow injects only a MODE flag
 * (`CYBOFLOW_MANAGED_TEST_CONCURRENCY`) and the vitest config resolves the cap
 * at GATE-RUN time, when the real concurrent load is observable.
 *
 * Resolution order (see `resolveForkCap`):
 *   1. An explicit `CYBOFLOW_TEST_MAX_FORKS` always wins — operator/CI override.
 *   2. Managed mode ⇒ divide the cores by the number of gates currently running.
 *   3. Otherwise ⇒ `undefined`, i.e. vitest's default. A human running the gate
 *      in a terminal, and CI, are deliberately UNCHANGED by all of this.
 */

/** Explicit operator/CI pin of the fork-pool size. Highest precedence. */
export const TEST_MAX_FORKS_ENV = 'CYBOFLOW_TEST_MAX_FORKS';

/**
 * Set to '1' by cyboflow in the environment of every agent process it spawns, so
 * a gate run from INSIDE an agent self-governs while the same command run by a
 * human in a terminal keeps vitest's default parallelism.
 */
export const MANAGED_TEST_CONCURRENCY_ENV = 'CYBOFLOW_MANAGED_TEST_CONCURRENCY';

/**
 * Floor for the managed cap. Below this the gate is serial enough that a single
 * slow suite dominates wall-clock and agents start timing out for the opposite
 * reason — so we never divide a gate down to 1 worker no matter how loaded the
 * box is.
 */
export const MIN_MANAGED_FORKS = 2;

/** True when cyboflow marked this process tree as agent-spawned. */
export function isManagedTestConcurrency(value: string | undefined): boolean {
  return value === '1';
}

/**
 * Opt-in/out of reaping orphaned pool workers at gate start (see
 * `vitestForkCap.ts`). '1' forces reaping on, '0' forces it off; unset leaves the
 * default, which is "reap only under managed mode". A human's terminal gate does
 * not kill processes out from under them unless they ask for it.
 */
export const REAP_ORPHANS_ENV = 'CYBOFLOW_TEST_REAP_ORPHANS';

/**
 * Vitest process titles. The root is `node (vitest)`; each fork-pool worker is
 * `node (vitest N)`. Counting ROOTS counts concurrent gate runs regardless of how
 * wide each one's pool is; matching WORKERS is how an abandoned fork is spotted.
 *
 * These two live here, together, because reading only the first one is precisely
 * the bug that let orphaned workers accumulate invisibly: `countRunningGates`
 * matched roots, orphaned workers are titled as workers, so a runaway fork
 * contributed ZERO to the concurrency the cap divides by while still pinning a
 * core. Whatever consumes one of these should be deliberate about the other.
 */
export const VITEST_ROOT_TITLE = /^node \(vitest\)$/;
export const VITEST_WORKER_TITLE = /^node \(vitest \d+\)$/;

/** True when `title` is a vitest fork-pool worker (`node (vitest 7)`). */
export function isVitestWorkerTitle(title: string): boolean {
  return VITEST_WORKER_TITLE.test(title.trim());
}

/** True when `title` is a vitest root (`node (vitest)`). */
export function isVitestRootTitle(title: string): boolean {
  return VITEST_ROOT_TITLE.test(title.trim());
}

/**
 * The ppid a process reports once its parent has died and init/launchd has
 * adopted it. This is the whole orphan proof — see {@link isOrphanedWorker}.
 */
export const ORPHAN_PPID = 1;

/**
 * Is this process row an ABANDONED vitest fork-pool worker?
 *
 * The invariant: a live worker ALWAYS has its vitest root as parent, because the
 * root is what forked it and tinypool keeps it in the pool for the run's whole
 * lifetime. So `ppid === 1` means the root is gone, which means nothing will ever
 * read this worker's results — it is pure waste, safe to kill, and provably not
 * mid-anything anyone cares about.
 *
 * A gate deliberately detached from its shell (`nohup pnpm test:unit &`) does NOT
 * trip this: that reparents the ROOT, whose title is `node (vitest)` and which is
 * therefore never matched here. Only workers are.
 */
export function isOrphanedWorker(title: string, ppid: number): boolean {
  return isVitestWorkerTitle(title) && ppid === ORPHAN_PPID;
}

/** Parse an explicit `CYBOFLOW_TEST_MAX_FORKS`; `undefined` when unset/invalid. */
export function parseExplicitForkCap(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * The managed cap: an even share of the cores across the gates running right now,
 * clamped to [MIN_MANAGED_FORKS, cores - 1]. One gate on a 10-core box keeps the
 * full 9 (unchanged from vitest's default); five concurrent gates get 2 each.
 *
 * `orphanWorkers` are abandoned forks that survived a previous gate (see
 * {@link isOrphanedWorker}) and could not be reaped. They answer to no root, so
 * they are not a "gate" to divide by — they are simply cores that no longer
 * exist for this run's purposes, and are subtracted before the division. Counting
 * them is the fallback for when reaping is off or the kill failed; when reaping
 * works this is 0 and the formula is exactly as it was.
 */
export function managedForkCap(
  cores: number,
  concurrentGates: number,
  orphanWorkers = 0,
): number {
  const orphans = Math.max(0, orphanWorkers);
  const effectiveCores = Math.max(1, cores - orphans);
  const usable = Math.max(1, effectiveCores - 1);
  const gates = Math.max(1, concurrentGates);
  return Math.max(MIN_MANAGED_FORKS, Math.min(usable, Math.floor(effectiveCores / gates)));
}

/** Inputs `resolveForkCap` needs, injected so the resolution is unit-testable. */
export interface ForkCapInputs {
  explicit: string | undefined;
  managed: string | undefined;
  cores: number;
  /** Gates observed running, INCLUDING this one. */
  concurrentGates: number;
  /** Abandoned forks still holding cores; 0 when they were reaped. */
  orphanWorkers?: number;
}

/** Resolve the fork-pool size, or `undefined` to leave vitest's default alone. */
export function resolveForkCap(inputs: ForkCapInputs): number | undefined {
  const explicit = parseExplicitForkCap(inputs.explicit);
  if (explicit !== undefined) return explicit;
  if (!isManagedTestConcurrency(inputs.managed)) return undefined;
  return managedForkCap(inputs.cores, inputs.concurrentGates, inputs.orphanWorkers ?? 0);
}

/**
 * Should a gate reap the orphaned workers it finds? Explicit
 * `CYBOFLOW_TEST_REAP_ORPHANS` wins in both directions; otherwise reaping follows
 * managed mode, so agent-spawned gates self-clean (that is where abandoned forks
 * come from — a harness that kills a quiet Bash command leaves the pool running)
 * while a human's terminal gate never kills anything it did not start.
 */
export function shouldReapOrphans(
  reapEnv: string | undefined,
  managedEnv: string | undefined,
): boolean {
  if (reapEnv === '1') return true;
  if (reapEnv === '0') return false;
  return isManagedTestConcurrency(managedEnv);
}

/** The env slice cyboflow adds to every agent process tree it spawns. */
export function managedTestConcurrencyEnv(): Record<string, string> {
  return { [MANAGED_TEST_CONCURRENCY_ENV]: '1' };
}
