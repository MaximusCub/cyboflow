/**
 * parentWatchdog — the guarantee that a cyboflowMcpServer subprocess does not
 * outlive the `claude` process that spawned it.
 *
 * WHY THIS EXISTS. The MCP server's only exit-on-peer-death path was tethered to
 * `CYBOFLOW_ORCH_SOCKET`, which is APP-GLOBAL, not per-session: the socket closes
 * when the Electron main process dies, not when the server's spawner does. Between
 * those two moments the server is a live process that nothing can reach and nothing
 * will kill. A single long-running app accumulated 40 such orphans (214 MB) in one
 * uptime. See PLAN-mcp-orphan-reaper.md §2.
 *
 * WHY PPID, AND WHY IT IS THE PRIMARY SIGNAL RATHER THAN A BACKSTOP. On macOS this
 * has no false-positive class. Darwin has no subreaper API, so an orphan reparents
 * to launchd (pid 1) unconditionally; none of these servers is ever launchd-spawned;
 * and `process.ppid` is a live `getppid()` syscall, not a value cached at startup.
 * `ppid === 1` while the spawner is alive is therefore impossible. Its companion
 * signal — exiting on stdin EOF — is strictly faster but has two identified
 * false-negative classes (the MCP SDK's `StdioServerTransport.close()` pauses stdin,
 * after which EOF is never observed; and a third party holding the write end
 * suppresses it), so stdin EOF is the optimization and this is the guarantee.
 *
 * KNOWN FALSE NEGATIVE — fail-safe, not fail-dangerous. Under a Linux
 * `PR_SET_CHILD_SUBREAPER` ancestor a dead parent reparents to the subreaper rather
 * than to 1, so this never fires. cyboflow is macOS-only; the failure mode is
 * "watchdog does not fire", never "watchdog kills a live server".
 *
 * THE ONE ASSUMPTION THAT COULD MAKE THIS FIRE ON A LIVE SERVER, pinned here so a
 * future reader can check it rather than rediscover it: `ppid === 1` means "useful
 * life over" only because the process holding our stdin pipe IS our parent. cyboflow
 * does not spawn these servers — the `claude` CLI does, from the MCP config we write
 * — so that is a property of a third party, not of this repo. It holds today (the
 * host scan that motivated this fix showed 13 correctly-parented servers). It would
 * break if a future `claude` release interposed a launcher that hands off the pipes
 * and exits without exec'ing: ppid would go to 1 while stdin stayed live, and every
 * MCP server would be killed one interval into a healthy session. That failure is
 * loud (all cyboflow_* tools stop working at once), not silent, but if this file is
 * ever touched again, re-check that assumption before trusting it.
 *
 * The polling shape is deliberate: the only event-driven parent-death notification
 * on macOS is kqueue `EVFILT_PROC`/`NOTE_EXIT`, which needs native bindings this
 * subprocess explicitly cannot have (it is bundled standalone with no node_modules,
 * see scripts/bundle-mcp-server.mjs).
 */

/** Default poll interval. The stdin-EOF fast path normally wins this race. */
export const PARENT_WATCHDOG_INTERVAL_MS = 60_000;

/**
 * Lower bound for {@link resolveWatchdogIntervalMs}. Guards against a pathological
 * override (`0`, `1`) turning the watchdog into a busy loop.
 */
export const MIN_WATCHDOG_INTERVAL_MS = 100;

/**
 * Env var overriding the poll interval, in milliseconds.
 *
 * Exists so the subprocess-level lifecycle tests can observe a watchdog firing
 * without a 60 s wall-clock wait — notably the startup-window case, where stdin is
 * not yet flowing and this watchdog is the ONLY signal that can fire.
 */
export const WATCHDOG_INTERVAL_ENV = 'CYBOFLOW_MCP_PARENT_WATCHDOG_MS';

/**
 * A timer handle that may or may not carry Node's `unref` (browser/fake timers).
 *
 * DELIBERATELY DUPLICATED in services/mcpOrphanTripwire.ts rather than shared.
 * This file is bundled STANDALONE by scripts/bundle-mcp-server.mjs, which inlines
 * imports transitively — so an import into the main-process utils tree would be
 * fine today and would silently break the subprocess bundle the moment anything
 * in that shared module reached for `electron` or a native dep. Three structural
 * lines are a cheaper price than that coupling.
 */
interface UnreffableTimer {
  unref?: () => void;
}

export interface ParentWatchdogOptions {
  /** Invoked once, when the spawner is observed to be gone. */
  onOrphaned: (reason: string) => void;
  /** Live ppid reader. Defaults to `process.ppid` (a `getppid()` syscall). */
  getPpid?: () => number;
  /** Poll interval; defaults to {@link PARENT_WATCHDOG_INTERVAL_MS}. */
  intervalMs?: number;
}

export interface ParentWatchdogHandle {
  /** Cancel the watchdog. Idempotent. */
  stop: () => void;
}

/**
 * Resolve the poll interval from an env bag, falling back to the default.
 *
 * A missing, non-numeric, non-finite, or below-floor value yields the default
 * rather than throwing — a malformed override must never prevent the watchdog
 * from running, since it is the guarantee against leaking the process forever.
 */
export function resolveWatchdogIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[WATCHDOG_INTERVAL_ENV];
  if (raw === undefined || raw.trim().length === 0) return PARENT_WATCHDOG_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return PARENT_WATCHDOG_INTERVAL_MS;
  if (parsed < MIN_WATCHDOG_INTERVAL_MS) return PARENT_WATCHDOG_INTERVAL_MS;
  return parsed;
}

/**
 * Start polling for spawner death. Fires `onOrphaned` AT MOST ONCE and stops
 * itself, so a slow/async shutdown handler cannot be re-entered on a later tick.
 *
 * The interval is `unref`'d: the watchdog must never be the reason the event loop
 * stays alive, or it would itself become a reason the process fails to exit.
 */
export function startParentWatchdog(opts: ParentWatchdogOptions): ParentWatchdogHandle {
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const intervalMs = opts.intervalMs ?? PARENT_WATCHDOG_INTERVAL_MS;

  let fired = false;
  const timer = setInterval(() => {
    // A throwing getppid must not take down the process via the uncaught handler;
    // skipping a tick is always safe because the next tick re-reads it.
    let ppid: number;
    try {
      ppid = getPpid();
    } catch {
      return;
    }
    if (ppid !== 1 || fired) return;
    fired = true;
    stop();
    opts.onOrphaned(`parent process exited (ppid=1, polled every ${intervalMs}ms)`);
  }, intervalMs);

  (timer as unknown as UnreffableTimer).unref?.();

  function stop(): void {
    clearInterval(timer);
  }

  return { stop };
}
