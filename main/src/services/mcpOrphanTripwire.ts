/**
 * McpOrphanTripwire — the OBSERVE-ONLY verification channel for the
 * cyboflowMcpServer spawner-death fix (parentWatchdog, commit adbe2146).
 *
 * WHY THIS EXISTS. The Phase 1 fix (ppid watchdog + stdin-EOF fast path) lives
 * entirely INSIDE the cyboflowMcpServer subprocess. If it silently stops working
 * — a future edit reintroduces a code path that skips `startParentWatchdog`, a
 * platform quirk breaks the ppid syscall, whatever — nothing outside that
 * subprocess can find out: a CLI-spawned server's stderr writes to a pipe whose
 * read end died along with its parent, so the write just fails silently (EPIPE)
 * or blocks forever, never reaching any log this app can read. This class is the
 * ONLY channel that can prove the fix is still real, by independently observing
 * the operating system's process table for the exact leak the fix eliminates.
 *
 * This class has NO kill authority — it is a tripwire, not a reaper. Compare
 * {@link ../../services/codexBrokerReaper.CodexBrokerReaper}, which reaps what it
 * finds; this class exists to prove that a DIFFERENT fix's reaping is no longer
 * necessary, so a killer seam here would defeat its own purpose (killing the
 * orphan would remove the very evidence a boot-time author of a regression needs
 * to see). Accordingly there is no `killPid` in {@link McpOrphanTripwireOptions}
 * and no kill method anywhere on {@link McpOrphanTripwire} — this is enforced by
 * the shape of the class, not by convention.
 *
 * WHY PERIODIC, NOT BOOT-ONLY. Orphans can only exist mid-uptime — they are
 * created when a `claude` process holding an MCP server subprocess dies while
 * the app stays up (crash, kill, force-quit of a session but not the app), and
 * they are cleared either by the Phase 1 fix or by the app's own exit. A scan
 * that only ran at boot would therefore read ~zero orphans FOREVER, regardless
 * of whether the fix works — a null signal dressed up as a green one. Hence: one
 * scan immediately at boot (to catch anything already stranded, e.g. from a
 * build that predates the fix) plus a recurring scan every
 * {@link MCP_ORPHAN_SCAN_INTERVAL_MS} (1 hour) to catch orphans created later in
 * the same uptime.
 *
 * WHY AGE-GATED. The parentWatchdog polls every `PARENT_WATCHDOG_INTERVAL_MS`
 * (60s) and is expected to reap its own subprocess within roughly one interval
 * of its spawner dying. A periodic scan run at an unlucky moment can therefore
 * legitimately observe an orphan that the watchdog is mid-flight to killing —
 * counting that would be a false alarm on a fix that is working exactly as
 * designed, and a false alarm here is worse than a missed one: it discredits the
 * only signal this fix has. {@link MCP_ORPHAN_AGE_GATE_SECONDS} is derived from
 * `PARENT_WATCHDOG_INTERVAL_MS` (2x, imported — never a hardcoded literal) so the
 * two constants cannot silently drift apart.
 */
import { execFile } from 'node:child_process';
import { resolveMcpServerScriptPath } from '../orchestrator/mcpServer/scriptPath';
import { PARENT_WATCHDOG_INTERVAL_MS } from '../orchestrator/mcpServer/parentWatchdog';
import type { LoggerLike } from '../orchestrator/types';

/** A single process row parsed from `ps -axo pid=,ppid=,etime=,command=`. */
export interface McpOrphanProcess {
  pid: number;
  ppid: number;
  /** Parsed process age in seconds, or null when `etime` was unparseable. */
  etimeSeconds: number | null;
  command: string;
}

/** How often the recurring scan runs, once boot's immediate scan has fired. */
export const MCP_ORPHAN_SCAN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Age gate, in seconds: a matching process younger than this is presumed to be
 * within the parentWatchdog's own reap window, not a genuine leak. Derived from
 * {@link PARENT_WATCHDOG_INTERVAL_MS} (2x) rather than a literal — see the class
 * docstring's "WHY AGE-GATED".
 */
export const MCP_ORPHAN_AGE_GATE_SECONDS = (PARENT_WATCHDOG_INTERVAL_MS * 2) / 1000;

/** Construction-time seams — the real `ps`/script-path-resolver are the defaults. */
export interface McpOrphanTripwireOptions {
  /** List host processes. Defaults to `ps -axo pid=,ppid=,etime=,command=`. */
  listProcesses?: () => Promise<McpOrphanProcess[]>;
  /**
   * Resolve this install's cyboflowMcpServer.js script path. Defaults to
   * {@link resolveMcpServerScriptPath} — injectable so tests need no electron
   * mock.
   */
  resolveScriptPath?: () => string;
  /** Optional structured logger (warn on a non-zero count, debug otherwise). */
  logger?: LoggerLike;
}

/**
 * Parse one `ps` `etime=` field into seconds. macOS emits exactly three shapes:
 * `mm:ss`, `hh:mm:ss`, and `dd-hh:mm:ss` (the `dd-` prefix appears only once
 * elapsed time crosses 24h). Returns null for anything that does not match one
 * of those shapes — an unparseable age is never guessed at, it is simply not
 * counted (see {@link McpOrphanTripwire.scan}).
 */
export function parseEtime(raw: string): number | null {
  const s = raw.trim();
  const dayMatch = /^(\d+)-(.+)$/.exec(s);
  const days = dayMatch ? Number.parseInt(dayMatch[1], 10) : 0;
  const rest = dayMatch ? dayMatch[2] : s;

  const parts = rest.split(':');
  // dd- form must carry hh:mm:ss (3 fields); the bare form is mm:ss or hh:mm:ss.
  if (dayMatch && parts.length !== 3) return null;
  if (!dayMatch && parts.length !== 2 && parts.length !== 3) return null;
  if (parts.some((p) => !/^\d{1,2}$/.test(p))) return null;

  const nums = parts.map((p) => Number.parseInt(p, 10));
  const [hours, minutes, seconds] =
    nums.length === 3 ? nums : [0, nums[0], nums[1]];
  // Defensive: a genuine ps etime field never carries an out-of-range mm/ss.
  if (minutes >= 60 || seconds >= 60) return null;

  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse `ps -axo pid=,ppid=,etime=,command=` output into rows.
 *
 * Deliberately NOT sharing {@link ../../services/codexBrokerReaper.parsePsOutput}
 * — that parser is 3-column (`pid=,ppid=,command=`) and is shared with
 * PrototypeServerReaper; widening it to 4 columns here would change what both of
 * those callers receive for no benefit to them. A dedicated 4-column parser is
 * one field wider and otherwise identical.
 *
 * Each line is leading whitespace + pid + ppid + the `etime` token (a single
 * `\S+` run — `etime` never contains a space) + the remainder as `command`.
 * Lines that do not match this shape are skipped. This also defends against the
 * macOS `ps: <keyword>: keyword not found` gotcha (an unknown -o keyword still
 * exits 0 and silently omits its column, which would otherwise shift `command`'s
 * first word into the `etime` capture): a shifted capture almost never matches
 * {@link parseEtime}'s shape, so it becomes `etimeSeconds: null` and the row is
 * excluded rather than mis-counted.
 */
export function parseMcpOrphanPsOutput(stdout: string): McpOrphanProcess[] {
  const rows: McpOrphanProcess[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.length === 0) continue;
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid,
      etimeSeconds: parseEtime(match[3]),
      command: match[4],
    });
  }
  return rows;
}

/** Default process lister: `ps -axo pid=,ppid=,etime=,command=` (see macOS gotcha above — NOT `etimes`). */
function defaultListProcesses(): Promise<McpOrphanProcess[]> {
  return new Promise<McpOrphanProcess[]>((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,etime=,command='],
      // Command lines can be long; 16 MiB is comfortably above any realistic
      // full process table (mirrors CodexBrokerReaper's default lister).
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(parseMcpOrphanPsOutput(stdout));
      },
    );
  });
}

/**
 * Timer handle carrying Node's `unref`. See {@link McpOrphanTripwire.start} —
 * the recurring scan must never be the reason the process fails to exit.
 */
interface UnreffableTimer {
  unref?: () => void;
}

export class McpOrphanTripwire {
  private readonly listProcesses: () => Promise<McpOrphanProcess[]>;
  private readonly resolveScriptPath: () => string;
  private readonly logger?: LoggerLike;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: McpOrphanTripwireOptions = {}) {
    this.listProcesses = opts.listProcesses ?? defaultListProcesses;
    this.resolveScriptPath = opts.resolveScriptPath ?? resolveMcpServerScriptPath;
    this.logger = opts.logger;
  }

  /**
   * Fire one scan immediately, then a recurring scan every
   * {@link MCP_ORPHAN_SCAN_INTERVAL_MS}. The interval is `unref`'d — this
   * tripwire must never be the reason the app's event loop stays alive.
   * Idempotent: a second call while already running is a no-op.
   */
  start(): void {
    if (this.timer !== null) return;
    void this.scan();
    const timer = setInterval(() => {
      void this.scan();
    }, MCP_ORPHAN_SCAN_INTERVAL_MS);
    (timer as unknown as UnreffableTimer).unref?.();
    this.timer = timer;
  }

  /** Cancel the recurring scan. Idempotent. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run one scan pass and log the result. Public (not just interval-private) so
   * boot and tests can trigger a deterministic pass without waiting on the
   * interval. Returns the count found, purely for test convenience — callers
   * that only care about the log (boot) can ignore it.
   *
   * A row counts when ALL hold: its command contains this install's resolved
   * MCP script path, its ppid is 1 (reparented — the spawner is gone), and its
   * parsed age exceeds {@link MCP_ORPHAN_AGE_GATE_SECONDS}. Fail-soft
   * throughout: a `ps` failure or a script-path resolution failure is logged and
   * this returns 0, never throws.
   */
  async scan(): Promise<number> {
    let processes: McpOrphanProcess[];
    try {
      processes = await this.listProcesses();
    } catch (err) {
      this.logger?.error('[McpOrphanTripwire] listing processes failed — skipping scan', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    let scriptPath: string;
    try {
      scriptPath = this.resolveScriptPath();
    } catch (err) {
      this.logger?.error('[McpOrphanTripwire] resolving MCP script path failed — skipping scan', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }

    let count = 0;
    for (const proc of processes) {
      if (!proc.command.includes(scriptPath)) continue;
      if (proc.ppid !== 1) continue;
      if (proc.etimeSeconds === null) continue;
      if (proc.etimeSeconds <= MCP_ORPHAN_AGE_GATE_SECONDS) continue;
      count += 1;
    }

    if (count === 0) {
      this.logger?.debug('[McpOrphanTripwire] no orphaned cyboflowMcpServer processes found');
    } else {
      this.logger?.warn(
        '[McpOrphanTripwire] found orphaned cyboflowMcpServer process(es) — the spawner-death ' +
          'fix (parentWatchdog, commit adbe2146) appears to not be working',
        { count, ageGateSeconds: MCP_ORPHAN_AGE_GATE_SECONDS },
      );
    }
    return count;
  }
}
