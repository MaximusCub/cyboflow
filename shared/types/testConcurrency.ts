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
 */
export function managedForkCap(cores: number, concurrentGates: number): number {
  const usable = Math.max(1, cores - 1);
  const gates = Math.max(1, concurrentGates);
  return Math.max(MIN_MANAGED_FORKS, Math.min(usable, Math.floor(cores / gates)));
}

/** Inputs `resolveForkCap` needs, injected so the resolution is unit-testable. */
export interface ForkCapInputs {
  explicit: string | undefined;
  managed: string | undefined;
  cores: number;
  /** Gates observed running, INCLUDING this one. */
  concurrentGates: number;
}

/** Resolve the fork-pool size, or `undefined` to leave vitest's default alone. */
export function resolveForkCap(inputs: ForkCapInputs): number | undefined {
  const explicit = parseExplicitForkCap(inputs.explicit);
  if (explicit !== undefined) return explicit;
  if (!isManagedTestConcurrency(inputs.managed)) return undefined;
  return managedForkCap(inputs.cores, inputs.concurrentGates);
}

/** The env slice cyboflow adds to every agent process tree it spawns. */
export function managedTestConcurrencyEnv(): Record<string, string> {
  return { [MANAGED_TEST_CONCURRENCY_ENV]: '1' };
}
