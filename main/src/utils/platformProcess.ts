/**
 * platformProcess — the ONE place that answers "how do I list / enumerate /
 * kill processes on this platform".
 *
 * The platform branches for the ladders live here, and only here — duplicated
 * win32 kill logic is not acceptable at a call site. Call sites may consult
 * the host platform to choose their {@link KillTreeOptions} timings, modes and
 * log wording; the kill and enumeration commands themselves may not branch.
 *
 * The one place a call site still reads the platform for behaviour is
 * runCommandManager's escapee sweep, where POSIX has an extra step with no
 * Windows equivalent: a process-group lookup that finds processes reparented
 * out of the tree. Windows has no process groups.
 *
 *   - {@link listProcessTable} / {@link listPidPpidTable} /
 *     {@link listPidPpidTableSync} — process-table listings (`ps -axo …` on
 *     POSIX, the winProcessTable.ts stand-in on win32).
 *   - {@link collectDescendantPidsAsync} / {@link collectDescendantPids} —
 *     descendant-tree enumeration (table fetch + walk).
 *   - {@link describeProcesses} — pid → a short name, for survivor reports.
 *   - {@link killWindowsTree}, {@link killPidSync}, {@link signalTree},
 *     {@link forceKillPids}, {@link killTree}, {@link killTreeImmediate} — the
 *     fire-and-forget, synchronous, group/tree-signalling, flat force-kill,
 *     ladder-shaped, and immediate-hard kills.
 *
 * Per-site zombie emission, log wording and grace timings stay at the call
 * sites via {@link KillTreeOptions} hooks — this module owns the platform
 * choice and the ladder shape, the sites own their reporting. Every primitive
 * takes a `platform` option (the `TerminalSessionManagerOptions.platform`
 * DI-seam template) so tests pin a platform regardless of the host.
 */
import { exec, execFile, execSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import {
  collectDescendantPids as walkPidPpidTable,
  parseProcessTable,
  parsePsOutput,
  type ProcessRow,
  type ProcessTableRow,
} from '../services/processTable';
import { buildWindowsProcessTableScript, execWindowsProcessTable } from '../services/winProcessTable';

/** Test seam shared by every primitive here: which platform's code path runs. */
export interface PlatformProcessOptions {
  /** Defaults to the host platform. */
  platform?: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Enumeration — the process-table listings
// ---------------------------------------------------------------------------

/**
 * Default process lister: `ps -axo pid=,ppid=,command=` on POSIX (no header,
 * all processes); the PowerShell stand-in on win32, which emits the same line
 * shape so the parser is shared unchanged.
 */
export function listProcessTable(opts: PlatformProcessOptions = {}): Promise<ProcessRow[]> {
  if ((opts.platform ?? process.platform) === 'win32') {
    return execWindowsProcessTable('pid-ppid-command').then(parsePsOutput);
  }
  return new Promise<ProcessRow[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,command='],
      // Command lines can be long; 16 MiB is comfortably above any realistic
      // full process table.
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(parsePsOutput(stdout));
      },
    );
  });
}

/** Default two-column lister: `ps -axo pid=,ppid=` (no header, all processes). */
export function listPidPpidTable(opts: PlatformProcessOptions = {}): Promise<ProcessTableRow[]> {
  if ((opts.platform ?? process.platform) === 'win32') {
    // Windows has no `ps`; the PowerShell stand-in emits the same line shape,
    // so the parser above is used unchanged.
    return execWindowsProcessTable('pid-ppid').then(parseProcessTable);
  }
  return new Promise<ProcessTableRow[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid='],
      // The full process table can be large; 16 MiB comfortably covers it.
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(parseProcessTable(stdout));
      },
    );
  });
}

/**
 * Synchronous two-column lister for the kill ladders whose enumeration happens
 * inside `execSync`-shaped code that cannot await. Windows runs the exact same
 * PowerShell query {@link execWindowsProcessTable} runs (via `execSync`); POSIX
 * makes one full-table `ps` call.
 */
export function listPidPpidTableSync(opts: PlatformProcessOptions = {}): ProcessTableRow[] {
  if ((opts.platform ?? process.platform) === 'win32') {
    const output = execSync(
      `powershell -NoProfile -NonInteractive -Command "${buildWindowsProcessTableScript('pid-ppid')}"`,
      // Full tables can total multiple MB; 64 MiB is comfortably above any
      // realistic one, matching execWindowsProcessTable's budget.
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    return parseProcessTable(output);
  }
  return parseProcessTable(execSync('ps -axo pid=,ppid=', { encoding: 'utf8', windowsHide: true }));
}

// ---------------------------------------------------------------------------
// Enumeration — the descendant-tree walker
// ---------------------------------------------------------------------------

export interface CollectDescendantPidsOptions extends PlatformProcessOptions {
  /**
   * POSIX one-level child lister. Call sites differ here
   * (`ps -o pid= --ppid N` for the session/log/run ladders, `pgrep -P N` for
   * the CLI manager — pgrep is the portable form across macOS/BSD/Linux), so a
   * site whose POSIX walk must stay byte-identical injects its own. The win32
   * arm (the shared PowerShell-table walk) is always this
   * module's and cannot be overridden.
   */
  posixChildPids?: (parentPid: number) => number[];
  /**
   * Failure reporter for a failed table fetch / walk step. Call sites
   * either stay silent or log a warning — pass the logger call here;
   * a failed walk degrades to a partial kill list, never an error.
   */
  onWalkError?: (error: unknown) => void;
}

/**
 * Default POSIX one-level lister: `ps -o pid= --ppid N`. The `2>/dev/null || true`
 * suffix keeps a "no such process" race from throwing — callers see an empty
 * child list and the recursion simply ends, never a throw.
 */
function defaultPosixChildPids(parentPid: number): number[] {
  const output = execSync(`ps -o pid= --ppid ${parentPid} 2>/dev/null || true`, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return output
    .split('\n')
    .map(line => Number.parseInt(line.trim(), 10))
    .filter(pid => Number.isInteger(pid) && pid !== parentPid);
}

/**
 * Collect every descendant of `rootPid` on this platform, synchronously.
 *
 * Production kill paths use {@link collectDescendantPidsAsync} instead — this
 * blocks the calling thread on the process-table query. Kept for callers that
 * genuinely cannot await, and as an independent enumeration in tests.
 *
 * win32: one synchronous PowerShell (pid, ppid) table fetch
 * ({@link listPidPpidTableSync}) walked by the shared BFS in
 * services/processTable.ts. POSIX: per-level DFS recursion over the injected
 * or default one-level lister (order is DFS; children-before-parents is not
 * required).
 *
 * Both arms are cycle-safe, never traverse or include pid ≤ 1, and never
 * include the root; a non-positive or non-integer root returns []. Fail-soft
 * by contract — a failed fetch or walk step reports through `onWalkError` and
 * degrades to a partial list, never a throw.
 */
export function collectDescendantPids(rootPid: number, opts: CollectDescendantPidsOptions = {}): number[] {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];

  if ((opts.platform ?? process.platform) === 'win32') {
    try {
      return walkPidPpidTable(rootPid, listPidPpidTableSync({ platform: 'win32' }));
    } catch (error) {
      opts.onWalkError?.(error);
      return [];
    }
  }

  const listChildren = opts.posixChildPids ?? defaultPosixChildPids;
  const seen = new Set<number>([rootPid]);
  const descendants: number[] = [];
  const walk = (pid: number): void => {
    let children: number[];
    try {
      children = listChildren(pid);
    } catch (error) {
      opts.onWalkError?.(error);
      return;
    }
    for (const child of children) {
      // pid<=1 is never traversed (launchd/kernel reparent guard, mirroring
      // the shared table walk); `seen` both dedupes and terminates cycles.
      if (child <= 1 || seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      walk(child);
    }
  };
  walk(rootPid);
  return descendants;
}

/**
 * Async POSIX one-level lister. Same command and the same fail-soft
 * `2>/dev/null || true` suffix as the synchronous default.
 */
async function defaultPosixChildPidsAsync(parentPid: number): Promise<number[]> {
  const { stdout } = await promisify(exec)(`ps -o pid= --ppid ${parentPid} 2>/dev/null || true`, {
    encoding: 'utf8',
    windowsHide: true,
  });
  return String(stdout)
    .split('\n')
    .map(line => Number.parseInt(line.trim(), 10))
    .filter(pid => Number.isInteger(pid) && pid !== parentPid);
}

export interface CollectDescendantPidsAsyncOptions extends PlatformProcessOptions {
  /** As {@link CollectDescendantPidsOptions.posixChildPids}, async allowed. */
  posixChildPids?: (parentPid: number) => number[] | Promise<number[]>;
  /** As {@link CollectDescendantPidsOptions.onWalkError}. */
  onWalkError?: (error: unknown) => void;
}

/**
 * {@link collectDescendantPids} without blocking the calling thread.
 *
 * Prefer this everywhere a caller can await. The synchronous twin runs the
 * win32 (pid, ppid) query through execSync, which stalls the Electron main
 * thread — and with it the renderer bridge — for as long as PowerShell takes
 * to start, or for the whole 15s timeout if the query itself hangs.
 */
export async function collectDescendantPidsAsync(
  rootPid: number,
  opts: CollectDescendantPidsAsyncOptions = {},
): Promise<number[]> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];

  if ((opts.platform ?? process.platform) === 'win32') {
    try {
      return walkPidPpidTable(rootPid, await listPidPpidTable({ platform: 'win32' }));
    } catch (error) {
      opts.onWalkError?.(error);
      return [];
    }
  }

  const listChildren = opts.posixChildPids ?? defaultPosixChildPidsAsync;
  const seen = new Set<number>([rootPid]);
  const descendants: number[] = [];
  const walk = async (pid: number): Promise<void> => {
    let children: number[];
    try {
      children = await listChildren(pid);
    } catch (error) {
      opts.onWalkError?.(error);
      return;
    }
    for (const child of children) {
      if (child <= 1 || seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      await walk(child);
    }
  };
  await walk(rootPid);
  return descendants;
}

// ---------------------------------------------------------------------------
// Kill primitives
// ---------------------------------------------------------------------------

/**
 * Forcefully kill a Windows process tree, fire-and-forget:
 * `taskkill /PID <pid> /T /F`. Windows has no process-group semantics through
 * `process.kill` (a negative pid fails EINVAL, orphaning spawned bridges/
 * servers); `taskkill /T` walks the PPID chain at call time instead. Fail-soft:
 * an already-dead or access-denied pid is ignored, like the POSIX `kill -9`
 * fallbacks it stands in for.
 */
export function killWindowsTree(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {
    // Already dead / no permission — nothing left to reap here.
  });
}

/**
 * Synchronous forceful Windows tree kill: `taskkill /pid <pid> /T /F` via
 * `spawnSync` (stdio ignored, 10s cap). The execSync-shaped twin of
 * {@link killWindowsTree} — for callers that must block until the kill was
 * ISSUED before proceeding (driverCore's `defaultKillPid`, whose stop path
 * continues straight into replacement-spawn bookkeeping).
 *
 * win32-only by contract: POSIX callers signal directly through
 * `process.kill` (group kills by negative pid), which is precisely why the
 * only production caller reaches this on win32 exclusively — on every other
 * platform the call is a no-op.
 */
export function killPidSync(pid: number, opts: PlatformProcessOptions = {}): void {
  if ((opts.platform ?? process.platform) !== 'win32') return;
  spawnSync('taskkill', ['/pid', String(Math.abs(pid)), '/T', '/F'], {
    stdio: 'ignore',
    timeout: 10_000,
    windowsHide: true,
  });
}

/**
 * What {@link signalTree} managed to do, so the caller can decide whether its
 * own fallback still applies.
 *
 *  - 'signaled': the tree was signalled.
 *  - 'gone':     nothing there to signal (POSIX ESRCH).
 *  - 'failed':   the group signal was rejected for another reason.
 */
export type SignalTreeOutcome = 'signaled' | 'gone' | 'failed';

/**
 * Force-kill each pid outright, one command per pid, best effort: win32
 * `taskkill /PID <pid> /F`, POSIX `kill -9 <pid>`. No tree walk and no grace —
 * for a caller that has already decided exactly which processes must die.
 */
export async function forceKillPids(
  pids: number[],
  opts: PlatformProcessOptions & {
    /** Shell runner. Defaults to `exec` wrapped with `windowsHide: true`. */
    execCommand?: (command: string) => Promise<{ stdout: string }>;
    /** Called after each kill command that did not throw. */
    onKilled?: (pid: number) => void;
  } = {},
): Promise<void> {
  const win32 = (opts.platform ?? process.platform) === 'win32';
  const execCommand =
    opts.execCommand ?? ((command: string) => promisify(exec)(command, { windowsHide: true }));
  for (const pid of pids) {
    try {
      await execCommand(win32 ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`);
      opts.onKilled?.(pid);
    } catch (error) {
      // Already dead / no permission — the sweep is best effort by contract.
    }
  }
}

/**
 * A short name per pid, for a user-facing "these processes survived" report.
 *
 * POSIX asks `ps` for the comm name one pid at a time. Windows has no `ps`:
 * the shared process table supplies the command line, and its first token's
 * basename stands in for the comm name. Never throws — an unresolvable pid
 * reports 'unknown'.
 */
export async function describeProcesses(
  pids: number[],
  opts: PlatformProcessOptions & {
    execCommand?: (command: string) => Promise<{ stdout: string }>;
    onError?: (error: unknown) => void;
  } = {},
): Promise<{ pid: number; name: string }[]> {
  const platform = opts.platform ?? process.platform;
  const execCommand =
    opts.execCommand ?? ((command: string) => promisify(exec)(command, { windowsHide: true }));

  if (platform === 'win32') {
    try {
      const rows = await listProcessTable({ platform });
      const commandByPid = new Map(rows.map(row => [row.pid, row.command]));
      return pids.map((pid) => {
        const firstToken = (commandByPid.get(pid) ?? '').trim().split(/\s+/)[0] ?? '';
        return { pid, name: firstToken ? basename(firstToken) : 'unknown' };
      });
    } catch (error) {
      opts.onError?.(error);
      return pids.map(pid => ({ pid, name: 'unknown' }));
    }
  }

  const described: { pid: number; name: string }[] = [];
  for (const pid of pids) {
    try {
      const { stdout } = await execCommand(`ps -p ${pid} -o comm= 2>/dev/null || true`);
      described.push({ pid, name: String(stdout).trim() || 'unknown' });
    } catch (error) {
      described.push({ pid, name: 'unknown' });
    }
  }
  return described;
}

/**
 * Signal a process TREE, one call instead of a win32 branch at every site.
 *
 * POSIX: the process GROUP, via a negative pid, so a spawn's own children are
 * reaped rather than orphaned. win32: `taskkill /T /F`, because there are no
 * process-group semantics through `process.kill` there — a negative pid fails
 * with EINVAL — and taskkill walks the PPID chain instead.
 *
 * The win32 arm always force-kills: taskkill has no signal to deliver, so the
 * `signal` argument only applies to POSIX.
 */
export function signalTree(
  pid: number,
  signal: NodeJS.Signals,
  opts: PlatformProcessOptions & {
    /**
     * 'async' (default) fires taskkill and returns; 'sync' blocks until the
     * kill was ISSUED, for a caller that continues straight into bookkeeping
     * that assumes the tree is going away.
     */
    windowsKill?: 'async' | 'sync';
    /**
     * win32 tree killer. Defaults to the taskkill primitives above; injected
     * by tests, which must never fire a real taskkill at an arbitrary pid.
     */
    killWindows?: (pid: number) => void;
    /** Signal sender for the POSIX arm. Defaults to `process.kill`. */
    sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  } = {},
): SignalTreeOutcome {
  if ((opts.platform ?? process.platform) === 'win32') {
    const killWindows =
      opts.killWindows ??
      (opts.windowsKill === 'sync'
        ? (target: number) => killPidSync(target, { platform: 'win32' })
        : killWindowsTree);
    killWindows(pid);
    return 'signaled';
  }
  const sendSignal = opts.sendSignal ?? ((target: number, sig: NodeJS.Signals) => process.kill(target, sig));
  try {
    sendSignal(-pid, signal);
    return 'signaled';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'failed';
  }
}

/**
 * Where the ladder's own progress and failures go.
 *
 * Each call site has an identity the shared code cannot know: a `[toolName]`
 * prefix in the CLI managers, a session log line the user reads in the app.
 * The ladder emits plain sentences and the site formats and routes them.
 * Without one, failures fall back to the console, as they did before the
 * ladders were shared.
 */
export interface KillTreeLogger {
  /** A step worth showing: grace started, escalation, a signal delivered. */
  info?(message: string): void;
  /** A step that did not work. The ladder continues regardless. */
  warn?(message: string, error?: unknown): void;
}

export interface KillTreeOptions extends PlatformProcessOptions {
  /**
   * Up-front enumerated descendants to force-kill individually after the tree
   * kill. Call sites enumerate before the ladder starts (so the count is
   * logged and children orphaned mid-ladder are still reached); defaults to
   * enumerating here via {@link collectDescendantPids}.
   */
  descendantPids?: number[];
  /**
   * Shell-command runner for the taskkill/kill/pkill invocations. Defaults to
   * `child_process.exec` wrapped with `windowsHide: true` — a packaged Windows
   * app must never flash a conhost.
   */
  execCommand?: (command: string) => Promise<{ stdout: string }>;
  /**
   * Liveness probe. Defaults to the signal-0 probe (ESRCH = dead, EPERM =
   * alive). A probe that throws is treated as "still alive" so a grace poll
   * waits out safely instead of short-circuiting to the forceful kill; a throw
   * inside a per-descendant probe likewise only skips that one kill.
   */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Signal sender for the POSIX ladder. Defaults to `process.kill`. Unused on
   * win32 (no catchable signals — the ladder is entirely taskkill).
   */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Grace window after the graceful phase, in ms. Default 2000. */
  graceMs?: number;
  /** Poll interval while waiting out the grace window. Default 100ms. */
  pollIntervalMs?: number;
  /**
   * How the grace window is spent: 'poll' (default) returns as soon as the
   * root pid is dead; 'fixed' sleeps the whole window unconditionally.
   * Honored on both arms.
   */
  graceMode?: 'poll' | 'fixed';
  /**
   * POSIX process-group resolution (win32 ignores this — no groups there):
   *  - 'lookup' (default, terminalSessionManager's shape): after the SIGTERM,
   *    one `ps -o pgid=` lookup replaces the root-pid stand-in with the real
   *    pgid when it responds.
   *  - 'root' (AbstractCliManager / sessionManager): no lookup — the pty/spawned
   *    child is its own group leader, so the root pid IS the group id.
   *  - 'enumerate' (runCommandManager): BEFORE any signal, resolve the real
   *    pgid and sweep group members the up-front tree walk missed into the
   *    per-descendant kill list.
   */
  posixGroupMode?: 'lookup' | 'root' | 'enumerate';
  /**
   * Re-enumeration for the verification passes. Defaults to
   * {@link collectDescendantPids} on this platform; sites with an injected
   * process-table seam pass their own (async allowed).
   */
  listDescendants?: () => number[] | Promise<number[]>;
  /**
   * Survivor report: called (and awaited) with the pids that remain after the
   * whole ladder ran, right before `killTree` resolves false. Call sites
   * differ in what they emit here (an EventEmitter event, a CLI output
   * line, a session log) — that reporting stays at the call site. Defaults to
   * a plain console.error.
   */
  onSurvivors?: (remainingPids: number[]) => void | Promise<void>;
  /** Called when the graceful `taskkill /T` attempt fails (expected for console apps). */
  onGracefulError?: (error: unknown) => void;
  /**
   * Progress and failure reporting for the ladder itself. See
   * {@link KillTreeLogger}; defaults to the console.
   */
  logger?: KillTreeLogger;
  /** Called when the ladder itself throws unexpectedly. Defaults to console.error. */
  onError?: (error: unknown) => void;
}

/**
 * Default liveness probe: signal-0 `process.kill`. ESRCH means dead; EPERM
 * ("exists, no permission to signal") still counts as alive.
 */
function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Kill a process and its whole tree. Returns true when nothing survives the
 * ladder, false when survivors remain (after {@link KillTreeOptions.onSurvivors}
 * ran) or the ladder threw. The inline steps below own the detail; the shape:
 *
 * win32 — the taskkill ladder shared by runCommandManager,
 * AbstractCliManager and terminalSessionManager: graceful `/T`, the grace
 * window, `/T /F`, per-descendant `/F`, then a verification pass with a
 * survivors re-kill.
 *
 * POSIX — the SIGTERM → process-group ladder: SIGTERM the root, group
 * handling per {@link KillTreeOptions.posixGroupMode}, `kill -TERM -<pgid>`,
 * the grace window in {@link KillTreeOptions.graceMode} shape, SIGKILL the
 * root and group, every enumerated descendant, a `pkill -9 -P` sweep, then
 * the same verification pass (no survivors re-kill on POSIX).
 */
export async function killTree(pid: number, opts: KillTreeOptions = {}): Promise<boolean> {
  const platform = opts.platform ?? process.platform;
  // Default shell-command runner: real `exec`, wrapped with windowsHide —
  // taskkill/kill/pkill must never flash a conhost when the packaged app runs
  // windowless on Windows.
  const execCommand =
    opts.execCommand ?? ((command: string) => promisify(exec)(command, { windowsHide: true }));
  const graceMs = opts.graceMs ?? 2000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const fixedGrace = (opts.graceMode ?? 'poll') === 'fixed';
  const posixGroupMode = opts.posixGroupMode ?? 'lookup';
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  const log = {
    info: (message: string) => opts.logger?.info?.(message),
    warn: (message: string, error?: unknown) =>
      opts.logger?.warn ? opts.logger.warn(message, error) : console.warn(message, error),
  };
  // Probe contract: a throw means "could not tell" — count as alive so a poll
  // waits out its window instead of short-circuiting to the forceful kill.
  const probeAlive = (probePid: number): boolean => {
    try {
      return isPidAlive(probePid);
    } catch {
      return true;
    }
  };
  const listDescendants = async (): Promise<number[]> =>
    (opts.listDescendants
      ? await opts.listDescendants()
      : await collectDescendantPidsAsync(pid, { platform })) ?? [];

  try {
    // Copied: the POSIX 'enumerate' group mode appends group members the tree
    // walk missed — the caller's array must not be mutated as a side effect.
    const descendantPids = [
      ...(opts.descendantPids ?? (await collectDescendantPidsAsync(pid, { platform }))),
    ];
    if (platform === 'win32') {
      // Graceful attempt first (without /F, GUI apps may close cleanly).
      try {
        await execCommand(`taskkill /PID ${pid} /T`);
      } catch (error) {
        opts.onGracefulError?.(error);
      }
      if (fixedGrace) {
        await sleep(graceMs);
      } else {
        // Bounded grace poll — return the moment the pid is gone, capped at
        // the grace window.
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          if (!probeAlive(pid)) break;
          await sleep(pollIntervalMs);
        }
      }
      // Forceful: /F kills the tree immediately.
      try {
        await execCommand(`taskkill /PID ${pid} /T /F`);
        log.info(`Force-killed the tree under process ${pid}`);
      } catch (error) {
        log.info(`Process ${pid} had already terminated`);
      }
      // taskkill /T walks the PPID chain at call time, so a shell that died
      // between the graceful and /F calls — or a pid that was reused in that
      // window — can orphan children the tree walk can no longer see. Force
      // every descendant enumerated up-front that is still alive.
      for (const childPid of descendantPids) {
        try {
          if (probeAlive(childPid)) {
            await execCommand(`taskkill /PID ${childPid} /F`);
          }
        } catch (error) {
          // Already dead / no permission — the verification pass below decides.
        }
      }
    } else {
      const sendSignal = opts.sendSignal ?? ((signalPid: number, signal: NodeJS.Signals) => {
        process.kill(signalPid, signal);
      });
      let pgid = pid;

      if (posixGroupMode === 'enumerate') {
        // 'enumerate': resolve the real pgid BEFORE any signal flies and sweep
        // in group members the up-front tree walk could not see (workers
        // re-parented into the group). The bare lookup (no `|| echo ""`
        // suffix) fails soft to the root pid.
        try {
          const result = await execCommand(`ps -o pgid= -p ${pid}`);
          const foundPgid = parseInt(result.stdout.trim());
          if (!isNaN(foundPgid)) {
            pgid = foundPgid;
            if (foundPgid !== pid) {
              const pgResult = await execCommand(`ps -o pid= -g ${foundPgid} 2>/dev/null || true`);
              const pgPids = pgResult.stdout
                .split('\n')
                .map(line => parseInt(line.trim()))
                .filter(p => !isNaN(p) && p !== pid && !descendantPids.includes(p));
              descendantPids.push(...pgPids);
            }
          }
        } catch (error) {
          log.warn('Could not resolve the process group', error);
        }
      }

      // First, try SIGTERM for graceful shutdown
      try {
        sendSignal(pid, 'SIGTERM');
      } catch (error) {
        log.warn('SIGTERM failed', error);
      }

      if (posixGroupMode === 'lookup') {
        // terminalSessionManager's shape: after the SIGTERM, find the actual
        // process group id — the root's pid is only a stand-in when the
        // lookup fails.
        try {
          const pgidResult = await execCommand(`ps -o pgid= -p ${pid} 2>/dev/null || echo ""`);
          const foundPgid = parseInt(pgidResult.stdout.trim());
          if (!isNaN(foundPgid)) {
            pgid = foundPgid;
          }
        } catch (error) {
          // Use the original PID as fallback
        }
      }

      try {
        await execCommand(`kill -TERM -${pgid}`);
      } catch (error) {
        log.warn(`Could not send SIGTERM to process group ${pgid}`, error);
      }

      if (graceMs > 0) {
        log.info(`Waiting ${graceMs}ms for graceful shutdown`);
      }
      if (fixedGrace) {
        await sleep(graceMs);
      } else {
        // Poll for early exit instead of unconditionally sleeping the full grace
        // window — return the moment both the main pid and its process group are
        // gone, bounded at the grace window, before forcing SIGKILL below.
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          if (!probeAlive(pid) && !probeAlive(-pgid)) {
            break;
          }
          await sleep(pollIntervalMs);
        }
      }

      // Now forcefully kill the main process
      log.info('Grace period expired, using forceful termination');
      try {
        sendSignal(pid, 'SIGKILL');
        log.info(`Sent SIGKILL to process ${pid}`);
      } catch (error) {
        log.info(`Process ${pid} had already terminated`);
      }

      // Kill the process group with SIGKILL
      try {
        await execCommand(`kill -9 -${pgid}`);
        log.info(`Sent SIGKILL to process group ${pgid}`);
      } catch (error) {
        log.warn(`Could not send SIGKILL to process group ${pgid}`, error);
      }

      // Kill all known descendants individually to be sure
      for (const childPid of descendantPids) {
        try {
          await execCommand(`kill -9 ${childPid}`);
        } catch (error) {
          // Process already terminated
        }
      }

      // Final cleanup attempt using pkill
      try {
        await execCommand(`pkill -9 -P ${pid}`);
      } catch (error) {
        // Ignore errors - processes might already be dead
      }
    }

    // Verify all processes are actually dead
    await sleep(500);
    let remainingPids = await listDescendants();
    if (platform === 'win32' && remainingPids.length > 0) {
      // Survivors found: one direct forced kill each — the tree-level kill
      // cannot see a child whose parent link it can no longer walk — then
      // re-verify. (win32-only: on POSIX the `pkill -9 -P` sweep above
      // already plays this role.)
      for (const survivorPid of remainingPids) {
        try {
          await execCommand(`taskkill /PID ${survivorPid} /F`);
        } catch (error) {
          // Already dead / no permission — the re-check below decides.
        }
      }
      await sleep(200);
      remainingPids = await listDescendants();
    }
    if (remainingPids.length > 0) {
      if (opts.onSurvivors) {
        await opts.onSurvivors(remainingPids);
      } else {
        log.warn(`WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
      }
      return false;
    }
    return true;
  } catch (error) {
    if (opts.onError) {
      opts.onError(error);
    } else {
      log.warn('Error in killTree', error);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Immediate hard kill — the logs-panel stop shape
// ---------------------------------------------------------------------------

export interface KillTreeImmediateOptions extends PlatformProcessOptions {
  /**
   * Up-front enumerated descendants to SIGKILL alongside the root. Defaults
   * to enumerating here via {@link collectDescendantPids} (silent on walk
   * errors — the stop path this serves never reported walk failures).
   */
  descendantPids?: number[];
  /**
   * Shell-command runner for the final sweep. Defaults to `exec` wrapped with
   * `windowsHide: true`. Failures are ignored by contract — the sweep is the
   * best-effort backstop behind the direct SIGKILLs (and silently no-ops
   * through cmd.exe on win32, by contract).
   */
  execCommand?: (command: string) => Promise<{ stdout: string }>;
  /** Signal sender. Defaults to `process.kill`. */
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Called when the ladder itself throws unexpectedly. Defaults to console.error. */
  onError?: (error: unknown) => void;
}

/**
 * Immediate hard kill of a pid and its enumerated descendants — the
 * logs-panel stop shape (services/panels/logPanel/logsManager.ts): no
 * graceful phase, no grace window, no probe. SIGKILLs the root and every
 * enumerated descendant directly, then runs a best-effort shell sweep
 * (`kill -9 <all>; pkill -9 -P <pid>`, errors ignored) as the backstop.
 *
 * Deliberately unbranched: `process.kill` SIGKILL is cross-platform in Node,
 * and the sweep silently no-ops through cmd.exe on win32.
 */
export async function killTreeImmediate(
  pid: number,
  opts: KillTreeImmediateOptions = {}
): Promise<void> {
  try {
    const allPids = [pid, ...(opts.descendantPids ?? (await collectDescendantPidsAsync(pid, opts)))];
    const sendSignal =
      opts.sendSignal ??
      ((signalPid: number, signal: NodeJS.Signals) => {
        process.kill(signalPid, signal);
      });
    for (const targetPid of allPids) {
      try {
        sendSignal(targetPid, 'SIGKILL');
      } catch (error) {
        // Process might already be dead or inaccessible
      }
    }

    // Shell command as the ultimate fallback (kill -9 cannot be caught or ignored)
    const execCommand =
      opts.execCommand ?? ((command: string) => promisify(exec)(command, { windowsHide: true }));
    try {
      await execCommand(`kill -9 ${allPids.join(' ')} 2>/dev/null; pkill -9 -P ${pid} 2>/dev/null`);
    } catch (error) {
      // Processes might already be dead — the sweep is best-effort by contract.
    }
  } catch (error) {
    if (opts.onError) {
      opts.onError(error);
    } else {
      console.error('Error killing process tree:', error);
    }
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
