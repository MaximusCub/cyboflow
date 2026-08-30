/**
 * platformProcess — the ONE place that answers "how do I list / enumerate /
 * kill processes on this platform".
 *
 * The windows-build stack grew one `process.platform === 'win32'` arm per call
 * site (five copies of the same PowerShell-table descendant walk, four copies
 * of the same taskkill ladder, two copies of the `ps`-vs-PowerShell table
 * fetch). An adversarial review's verdict: a per-call-site arm extending a
 * visible POSIX ladder is acceptable, but DUPLICATED logic is not. This module
 * owns every platform branch for the three primitives the kill ladders need:
 *
 *   - {@link listProcessTable} / {@link listPidPpidTable} /
 *     {@link listPidPpidTableSync} — full/pair process-table listings
 *     (`ps -axo …` on POSIX, the PowerShell stand-in from winProcessTable.ts
 *     on win32). Moved here verbatim from services/processTable.ts, which
 *     keeps only the platform-blind parsing/walking helpers.
 *   - {@link collectDescendantPids} — the whole descendant-tree enumeration
 *     (platform table fetch + walk), absorbing the per-call-site
 *     `getAllDescendantPids` copies.
 *   - {@link killWindowsTree} (fire-and-forget `taskkill /T /F`),
 *     {@link killPidSync} (synchronous taskkill for execSync-shaped code) and
 *     {@link killTree} (the graceful → poll → forceful ladder shared by
 *     RunCommandManager / AbstractCliManager / TerminalSessionManager).
 *
 * Deliberately NOT here: the per-site zombie EVENT emission, log wording and
 * grace-poll timings that differ between ladders stay at the call sites as
 * injection hooks ({@link KillTreeOptions}) — this module owns the platform
 * choice and the ladder shape, the sites own their reporting.
 *
 * Every primitive takes a `platform` option (the
 * `TerminalSessionManagerOptions.platform` DI-seam template) so tests pin a
 * platform regardless of the host.
 */
import { exec, execFile, execSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
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
// Enumeration — the process-table listings (moved from services/processTable.ts)
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
// Enumeration — the descendant-tree walker (absorbs the per-call-site
// getAllDescendantPids copies in sessionManager, logsManager,
// runCommandManager and AbstractCliManager)
// ---------------------------------------------------------------------------

export interface CollectDescendantPidsOptions extends PlatformProcessOptions {
  /**
   * POSIX one-level child lister. The historical call sites differ here
   * (`ps -o pid= --ppid N` for the session/log/run ladders, `pgrep -P N` for
   * the CLI manager — pgrep is the portable form across macOS/BSD/Linux), so a
   * site whose POSIX walk must stay byte-identical injects its own. The win32
   * arm (the formerly-duplicated PowerShell-table walk) is always this
   * module's and cannot be overridden.
   */
  posixChildPids?: (parentPid: number) => number[];
  /**
   * Failure reporter for a failed table fetch / walk step. The historical
   * sites either stay silent or log a warning — pass the logger call here;
   * a failed walk degrades to a partial kill list, never an error.
   */
  onWalkError?: (error: unknown) => void;
}

/**
 * Default POSIX one-level lister: `ps -o pid= --ppid N`. The `2>/dev/null || true`
 * suffix keeps a "no such process" race from throwing — callers see an empty
 * child list (recursion ends) exactly as the try/catch-wrapped historical
 * walkers did.
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
 * Collect every descendant of `rootPid` on this platform.
 *
 * win32: one synchronous PowerShell (pid, ppid) table fetch
 * ({@link listPidPpidTableSync}) walked by the shared BFS in
 * services/processTable.ts — the arm all five historical call sites ran
 * byte-identically. POSIX: the historical per-level recursion (DFS, so kill
 * order matches what the call sites did before consolidation), over the
 * injected or default one-level lister.
 *
 * Both arms are cycle-safe (a pid is never visited twice), never traverse or
 * include pid ≤ 1 (never chase launchd/kernel), and never include the root.
 * Guards mirror the strictest historical caller: a non-positive or
 * non-integer root returns []. Fail-soft by contract — a failed fetch or walk
 * step reports through `onWalkError` and degrades to a partial list, never a
 * throw.
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

// ---------------------------------------------------------------------------
// Kill primitives
// ---------------------------------------------------------------------------

/**
 * Forcefully kill a Windows process tree: `taskkill /PID <pid> /T /F`.
 *
 * Windows has no process-group semantics through `process.kill` — a negative-pid
 * call fails (EINVAL) and the caller would fall through to a bare child kill,
 * orphaning the MCP bridges/servers the child spawned. `taskkill /T` is the
 * platform's whole-tree contract: it walks the PPID chain at call time.
 *
 * Fire-and-forget and fail-soft: a pid that is already dead (or access-denied)
 * rejects and is ignored, exactly like the POSIX `kill -9` fallbacks it stands
 * in for. The signal the caller intended is irrelevant here — Windows console
 * processes have no catchable SIGTERM, so the tree kill is always forceful.
 * (Moved verbatim from services/processTable.ts.)
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
  /**
   * Grace window after the graceful phase, in ms. Default 2000 — reviewed
   * decision: give shells a real chance to exit cleanly.
   */
  graceMs?: number;
  /** Poll interval while waiting out the grace window. Default 100ms. */
  pollIntervalMs?: number;
  /**
   * How the grace window is spent: 'poll' (default) returns as soon as the
   * root pid is dead; 'fixed' sleeps the whole window unconditionally (the
   * historical RunCommandManager shape — it never probed during the wait).
   */
  graceMode?: 'poll' | 'fixed';
  /**
   * Re-enumeration for the verification passes. Defaults to
   * {@link collectDescendantPids} on this platform; sites with an injected
   * process-table seam pass their own (async allowed).
   */
  listDescendants?: () => number[] | Promise<number[]>;
  /**
   * Survivor report: called (and awaited) with the pids that remain after the
   * whole ladder ran, right before `killTree` resolves false. The historical
   * ladders differ in what they emit here (an EventEmitter event, a CLI output
   * line, a session log) — that reporting stays at the call site. Defaults to
   * a plain console.error.
   */
  onSurvivors?: (remainingPids: number[]) => void | Promise<void>;
  /** Called when the graceful `taskkill /T` attempt fails (expected for console apps). */
  onGracefulError?: (error: unknown) => void;
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
 * ran) or the ladder threw.
 *
 * win32 — the taskkill ladder (the one RunCommandManager, AbstractCliManager
 * and TerminalSessionManager each carried a copy of):
 *   1. graceful `taskkill /PID <pid> /T` (GUI apps may close cleanly; console
 *      apps always "fail" this step — expected),
 *   2. the grace window (bounded poll or fixed sleep per {@link graceMode}),
 *   3. forceful `taskkill /PID <pid> /T /F`,
 *   4. per-descendant `taskkill /PID <child> /F` for every up-front enumerated
 *      descendant still alive — taskkill /T walks the PPID chain at call time,
 *      so a shell that died between steps 1 and 3 (or a pid reused in that
 *      window) can orphan children the tree walk can no longer see,
 *   5. verification: 500ms settle, re-enumerate, one direct forced kill per
 *      survivor (taskkill /T cannot see a child whose parent link it can no
 *      longer walk), 200ms settle, re-check — survivors at this point are
 *      reported via {@link onSurvivors} and fail the ladder.
 *
 * POSIX — the SIGTERM → process-group ladder (TerminalSessionManager's shape,
 * its historical owner): SIGTERM the root, look up its real pgid
 * (`ps -o pgid=`), `kill -TERM -<pgid>`, a bounded dual probe (root AND group)
 * that returns the moment both are dead, then SIGKILL the root, `kill -9
 * -<pgid>`, every enumerated descendant, and a `pkill -9 -P` sweep before the
 * same 500ms verification pass.
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
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
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
    (opts.listDescendants ? await opts.listDescendants() : collectDescendantPids(pid, { platform })) ??
    [];
  const descendantPids = opts.descendantPids ?? collectDescendantPids(pid, { platform });

  try {
    if (platform === 'win32') {
      // Graceful attempt first (without /F, GUI apps may close cleanly).
      try {
        await execCommand(`taskkill /PID ${pid} /T`);
      } catch (error) {
        opts.onGracefulError?.(error);
      }
      if ((opts.graceMode ?? 'poll') === 'fixed') {
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
      } catch (error) {
        // Process might already be dead
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
      // First, try SIGTERM for graceful shutdown
      try {
        sendSignal(pid, 'SIGTERM');
      } catch (error) {
        console.warn('SIGTERM failed:', error);
      }

      // Kill the entire process group using negative PID. First find the
      // actual process group id — the root's pid is only a stand-in when the
      // lookup fails.
      let pgid = pid;
      try {
        const pgidResult = await execCommand(`ps -o pgid= -p ${pid} 2>/dev/null || echo ""`);
        const foundPgid = parseInt(pgidResult.stdout.trim());
        if (!isNaN(foundPgid)) {
          pgid = foundPgid;
        }
      } catch (error) {
        // Use the original PID as fallback
      }

      try {
        await execCommand(`kill -TERM -${pgid}`);
      } catch (error) {
        console.warn(`Error sending SIGTERM to process group: ${error}`);
      }

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

      // Now forcefully kill the main process
      try {
        sendSignal(pid, 'SIGKILL');
      } catch (error) {
        // Process might already be dead
      }

      // Kill the process group with SIGKILL
      try {
        await execCommand(`kill -9 -${pgid}`);
      } catch (error) {
        console.warn(`Error sending SIGKILL to process group: ${error}`);
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
      // re-verify. (win32-only: the POSIX ladder never had this extra pass,
      // and preserving its shape exactly matters more than the extra sweep.)
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
        console.error(`WARNING: ${remainingPids.length} zombie processes remain: ${remainingPids.join(', ')}`);
      }
      return false;
    }
    return true;
  } catch (error) {
    if (opts.onError) {
      opts.onError(error);
    } else {
      console.error('Error in killProcessTree:', error);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
