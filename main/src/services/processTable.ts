/**
 * Shared host-process-table helpers for the main process's reapers.
 *
 * Both {@link CodexBrokerReaper} (detached `openai-codex` broker daemons) and
 * {@link VitestOrphanReaper} (abandoned vitest pool workers) need the same two
 * primitives: turn `ps` output into rows, and expand a set of root pids into the
 * full descendant tree so a leaked parent's children go with it. They live here so
 * there is one parser to reason about rather than one per reaper.
 *
 * Matching is deliberately plain JS over parsed rows rather than
 * `pkill -f <regex>`: the paths involved can carry regex metacharacters, and a
 * mis-escaped pattern in a kill command is not a mistake worth risking.
 */
import { execFile } from 'node:child_process';
import { execWindowsProcessTable } from './winProcessTable';

/** A single process row parsed from `ps` output. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
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
