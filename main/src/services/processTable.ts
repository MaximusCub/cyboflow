/**
 * Shared host-process-table helpers for the main process's reapers and kill
 * ladders.
 *
 * The reapers ({@link CodexBrokerReaper} for detached `openai-codex` broker
 * daemons, {@link VitestOrphanReaper} for abandoned vitest pool workers) need to
 * turn `ps` output into rows and expand a set of root pids into the full
 * descendant tree so a leaked parent's children go with it. The kill ladders
 * (`terminalSessionManager`, `sessionManager`, `runCommandManager`,
 * `logsManager`) need the same walk over the two-column `pid ppid` shape plus a
 * synchronous table fetch. Both shapes and the tree walk live here so there is
 * one parser and one walker to reason about rather than one per caller.
 *
 * Matching is deliberately plain JS over parsed rows rather than
 * `pkill -f <regex>`: the paths involved can carry regex metacharacters, and a
 * mis-escaped pattern in a kill command is not a mistake worth risking.
 */
import { execFile, execSync } from 'node:child_process';
import { buildWindowsProcessTableScript, execWindowsProcessTable } from './winProcessTable';

/** A single process row parsed from `ps` output. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** One row of the two-column (pid, ppid) process table — all a kill ladder needs. */
export interface ProcessTableRow {
  pid: number;
  ppid: number;
}

/**
 * Parse `ps -axo pid=,ppid=` output ("<pid> <ppid>" per line, no header) into
 * rows. Lines that don't match a plain numeric pair are skipped — `ps` output is
 * not a contract, and one odd line must never take down a sweep.
 */
export function parseProcessTable(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid });
  }
  return rows;
}

/**
 * Collect every descendant of `rootPid` by walking the ppid table (BFS,
 * cycle-safe). Excludes the root itself, never traverses pid<=1 (never chase
 * launchd/kernel via a stray reparent), and returns [] for a root of pid<=1.
 * Mirrors the tree-walk in {@link collectProcessTree}.
 */
export function collectDescendantPids(rootPid: number, procs: ProcessTableRow[]): number[] {
  const childrenByPpid = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid <= 1) continue;
    const list = childrenByPpid.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenByPpid.set(p.ppid, [p.pid]);
  }

  // Never traverse from a root of launchd/kernel itself (mirrors codexBrokerReaper's
  // collectProcessTree guard) — a reparented pid<=1 root has no legitimate descendants
  // to enumerate here.
  if (rootPid <= 1) return [];

  const result = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const kids = childrenByPpid.get(current);
    if (!kids) continue;
    for (const kid of kids) {
      if (kid > 1 && kid !== rootPid && !result.has(kid)) {
        result.add(kid);
        queue.push(kid);
      }
    }
  }
  return [...result];
}

/**
 * Parse `ps -axo pid=,ppid=,command=` output into rows. Each line is leading
 * whitespace + numeric pid + whitespace + numeric ppid + a space + the full
 * command line. Lines that do not match are skipped — `ps` output is not a
 * contract, and one odd line must never take down a sweep.
 */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({ pid, ppid, command: match[3] });
  }
  return rows;
}

/**
 * Collect `rootPids` plus every descendant, walking the ppid table. Guards:
 * pids ≤ 1 are never traversed or included (never chase launchd/kernel), a pid is
 * only ever visited once (cycle-safe), and a root not present in `procs` is still
 * returned (a parent whose children already exited). Returns a de-duplicated set.
 */
export function collectProcessTree(rootPids: number[], procs: ProcessRow[]): Set<number> {
  const childrenByPpid = new Map<number, number[]>();
  for (const p of procs) {
    if (p.pid <= 1) continue;
    const list = childrenByPpid.get(p.ppid);
    if (list) list.push(p.pid);
    else childrenByPpid.set(p.ppid, [p.pid]);
  }

  const result = new Set<number>();
  const queue: number[] = [];
  for (const root of rootPids) {
    if (root > 1 && !result.has(root)) {
      result.add(root);
      queue.push(root);
    }
  }
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const kids = childrenByPpid.get(pid);
    if (!kids) continue;
    for (const kid of kids) {
      if (kid > 1 && !result.has(kid)) {
        result.add(kid);
        queue.push(kid);
      }
    }
  }
  return result;
}

/** Default process lister: `ps -axo pid=,ppid=,command=` (no header, all processes). */
export function listProcessTable(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    // Windows has no `ps`; the PowerShell stand-in emits the same line shape,
    // so the parser below is used unchanged.
    return execWindowsProcessTable('pid-ppid-command').then(parsePsOutput);
  }
  return new Promise<ProcessRow[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,command='],
      // Command lines can be long; 16 MiB is comfortably above any realistic
      // full process table.
      { maxBuffer: 16 * 1024 * 1024 },
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
export function listPidPpidTable(): Promise<ProcessTableRow[]> {
  if (process.platform === 'win32') {
    // Windows has no `ps`; the PowerShell stand-in emits the same line shape,
    // so the parser above is used unchanged.
    return execWindowsProcessTable('pid-ppid').then(parseProcessTable);
  }
  return new Promise<ProcessTableRow[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid='],
      // The full process table can be large; 16 MiB comfortably covers it.
      { maxBuffer: 16 * 1024 * 1024 },
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
 * makes one full-table `ps` call. Production callers only reach the Windows arm
 * (their POSIX branches keep their historical per-level walks byte-identical);
 * the POSIX arm exists so the function is total rather than platform-guarded at
 * every call site.
 */
export function listPidPpidTableSync(): ProcessTableRow[] {
  if (process.platform === 'win32') {
    const output = execSync(
      `powershell -NoProfile -NonInteractive -Command "${buildWindowsProcessTableScript('pid-ppid')}"`,
      // Full tables can total multiple MB; 64 MiB is comfortably above any
      // realistic one, matching execWindowsProcessTable's budget.
      { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 },
    );
    return parseProcessTable(output);
  }
  return parseProcessTable(execSync('ps -axo pid=,ppid=', { encoding: 'utf8' }));
}

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
 */
export function killWindowsTree(pid: number): void {
  execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {
    // Already dead / no permission — nothing left to reap here.
  });
}
