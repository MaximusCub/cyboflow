/**
 * Self-termination for vitest fork-pool workers whose root has died.
 *
 * WHY THIS EXISTS. A vitest fork-pool worker is an ordinary child process with no
 * lifetime link to its parent. macOS has no `PDEATHSIG` (Linux-only), and
 * tinypool's pool teardown — the thing that would normally kill the workers — only
 * runs if the ROOT exits gracefully. In agent contexts the root is essentially
 * never allowed to: the Claude harness abandons a Bash command after ~180s with no
 * output (and vitest is silent for long stretches), a stopped session hard-kills
 * the tree, and cyboflow's own teardown is a `killProcessTree` SIGKILL. A SIGKILL'd
 * root cannot clean up after itself, so its workers are adopted by launchd and keep
 * running — spinning at ~100% CPU on a full test file's heap, forever, with nobody
 * left to read their results. Two of them were observed holding ~2 GB and two cores
 * for 24 minutes, which is what motivated this file.
 *
 * WHY IT LIVES IN THE WORKER rather than in a reaper. This is the only layer that
 * fires at the MOMENT the root dies instead of at the next gate or the next app
 * boot, and the only one that works when cyboflow is not running at all. The
 * companion layers — orphan reaping in `vitestForkCap.ts` and `VitestOrphanReaper`
 * in the main process — are defence in depth for workers that predate this code or
 * that somehow miss their own poll.
 *
 * SAFETY. Arming is gated on two independently-verified facts (see
 * {@link isForkPoolWorker}), and the orphan test itself is `ppid === 1`, which is a
 * proof rather than a heuristic: a live worker always has its root as parent. A
 * deliberately detached run (`nohup pnpm test:unit &`) reparents the ROOT, which is
 * titled `node (vitest)` and never matches the worker pattern.
 */
import { isMainThread } from 'node:worker_threads';

import { isVitestWorkerTitle, ORPHAN_PPID } from './shared/types/testConcurrency';

/**
 * How often a worker checks whether it has been orphaned. Short enough that a
 * runaway fork is measured in seconds rather than the 24 minutes we observed,
 * long enough to be free: this is one integer read off `process`, no syscall.
 */
export const ORPHAN_POLL_INTERVAL_MS = 5_000;

/** Injectable seams so the watchdog is unit-testable without forking anything. */
export interface OrphanWatchdogDeps {
  /** This process's title. Defaults to `process.title`. */
  title?: string;
  /** Current parent pid, re-read on every poll. Defaults to `() => process.ppid`. */
  getPpid?: () => number;
  /** True when this is the main thread of its process. Defaults to node's value. */
  mainThread?: boolean;
  /** Exit the process. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Timer factory. Defaults to `setInterval` (the handle is unref'd when it can be). */
  schedule?: (fn: () => void, ms: number) => { unref?: () => void };
  /** Cancel a timer. Defaults to `clearInterval`. */
  cancel?: (handle: unknown) => void;
  /** Where to announce a self-terminate. Defaults to `process.stderr`. */
  warn?: (message: string) => void;
}

/**
 * Is this process a vitest FORK-pool worker — the one class of process that can
 * be orphaned by a dead root?
 *
 * Both conditions matter:
 *  - the title must be `node (vitest N)`, which excludes the root (`node (vitest)`)
 *    and anything that is not vitest at all; and
 *  - it must be the main thread of its own process, which excludes the `threads`
 *    pool. A worker THREAD shares the root's pid, so it would inherit the root's
 *    ppid — and a detached (`nohup`) root has ppid 1, which would otherwise read as
 *    "orphaned" and make a healthy run kill itself.
 */
export function isForkPoolWorker(title: string, mainThread: boolean): boolean {
  return mainThread && isVitestWorkerTitle(title);
}

/**
 * Arm the orphan watchdog for this process. A no-op returning `undefined` unless
 * this really is a fork-pool worker, so it is safe to call unconditionally from a
 * setup file — including from the frontend's jsdom suite and from a human's
 * terminal run.
 *
 * Returns a disarm function when armed (used by the tests; a real worker simply
 * exits with the process).
 */
export function startOrphanWatchdog(deps: OrphanWatchdogDeps = {}): (() => void) | undefined {
  const title = deps.title ?? process.title;
  const mainThread = deps.mainThread ?? isMainThread;
  if (!isForkPoolWorker(title, mainThread)) return undefined;

  const getPpid = deps.getPpid ?? (() => process.ppid);
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const schedule = deps.schedule ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = deps.cancel ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  const warn = deps.warn ?? ((message: string) => process.stderr.write(message + '\n'));

  // A worker can be orphaned before its first poll — check once up front so a
  // fork that starts life parentless does not linger a full interval.
  if (getPpid() === ORPHAN_PPID) {
    warn(`[vitest] worker ${process.pid} orphaned (root gone) — exiting`);
    exit(0);
    return undefined;
  }

  const handle = schedule(() => {
    if (getPpid() !== ORPHAN_PPID) return;
    warn(`[vitest] worker ${process.pid} orphaned (root gone) — exiting`);
    cancel(handle);
    exit(0);
  }, ORPHAN_POLL_INTERVAL_MS);

  // Never let the watchdog itself be the reason the process stays alive: a
  // healthy worker must still exit the instant its pool releases it.
  handle.unref?.();

  return () => cancel(handle);
}
