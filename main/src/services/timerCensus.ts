/**
 * TimerCensus — attributes main-process timer WAKEUPS to the code that scheduled
 * them.
 *
 * Why this exists (measured, not theoretical): in the Electron main process a
 * libuv timer is not cheap the way it is in plain Node. Electron drives libuv
 * from Chromium's CFRunLoop, so every timer fire costs a full
 * `__CFRunLoopDoSources0 → uv_run → uv__run_timers → RunTimers` round trip, and
 * re-arming a repeating timer adds a `uv__loop_interrupt` → `kevent` syscall. A
 * native `sample` of an IDLE cyboflow main process attributes ~all of its
 * on-CPU main-thread samples to exactly that path, while V8's own profiler
 * reports the JS inside those callbacks at ~0.1% — i.e. the cost is the WAKEUP
 * RATE, not the work per callback.
 *
 * That makes "how many times per second does each site fire, and does it do
 * anything when it does" the question that matters, and no stock tool answers
 * it. `process.getActiveResourcesInfo()` counts live handles but not their rate
 * or origin, and an unref'd timer does not even show up there.
 *
 * This module wraps `setTimeout` / `setInterval` / `setImmediate`, records the
 * app-code frame that created each one, and counts fires + callback time per
 * site. {@link drainTimerCensus} returns a per-interval snapshot that
 * {@link PerfTracer} prints alongside event-loop utilization.
 *
 * Gating: fully OFF unless `CYBOFLOW_PERF_TRACE=1`. When off, `installTimerCensus`
 * returns without touching the globals, so normal runs keep the untouched
 * built-ins and pay nothing. Capturing a creation stack per scheduled timer is
 * far too expensive to leave on in production — that cost is the reason this is
 * opt-in rather than always-on.
 *
 * Install as early as possible: sites that schedule a timer at module-import
 * time are only attributed if the census is installed before that import runs.
 */

/** Minimal logger surface — kept local so this module imports nothing heavy. */
interface CensusLogger {
  info(message: string): void;
}

const TRACE_ENABLED = process.env.CYBOFLOW_PERF_TRACE === '1';

/** Per-creation-site totals for the current interval. */
interface SiteStats {
  /** Timers created from this site during the interval. */
  created: number;
  /** Callback invocations from this site during the interval. */
  fires: number;
  /** Total wall time spent inside those callbacks, ms. */
  callbackMs: number;
  /** Shortest delay requested from this site, ms — the wakeup cadence. */
  minDelayMs: number;
  /** Kind of timer, for reading the report. */
  kind: 'interval' | 'timeout' | 'immediate';
}

const sites = new Map<string, SiteStats>();
let installed = false;

function statsFor(site: string, kind: SiteStats['kind']): SiteStats {
  let stats = sites.get(site);
  if (!stats) {
    stats = { created: 0, fires: 0, callbackMs: 0, minDelayMs: Number.POSITIVE_INFINITY, kind };
    sites.set(site, stats);
  }
  return stats;
}

/**
 * Resolve the first app-code frame that scheduled this timer.
 *
 * Skips this module and node internals so the reported site is the caller that
 * can actually be changed. Falls back to the raw first frame rather than
 * dropping the sample, so nothing goes unattributed.
 */
function callSite(): string {
  const stack = new Error().stack;
  if (!stack) return '(no stack)';
  const lines = stack.split('\n').slice(1);
  let firstFrame: string | null = null;
  for (const line of lines) {
    const match = line.match(/\(?((?:\/|[A-Za-z]:)[^():\s]+):(\d+):\d+\)?\s*$/);
    if (!match) continue;
    const [, file, lineNo] = match;
    if (firstFrame === null) firstFrame = `${file.split('/').slice(-2).join('/')}:${lineNo}`;
    if (file.includes('timerCensus')) continue;
    if (file.includes('node:')) continue;
    if (file.includes('/node_modules/')) {
      // Keep node_modules frames, but label them so app code is easy to spot.
      return `[dep] ${file.split('/node_modules/')[1]?.split('/').slice(0, 2).join('/') ?? file}:${lineNo}`;
    }
    return `${file.split('/').slice(-2).join('/')}:${lineNo}`;
  }
  return firstFrame ?? '(unresolved)';
}

/** A timer callback as node types it. */
type TimerCallback = (...args: unknown[]) => void;

/**
 * Wrap a callback so each invocation is counted against the `stats` bucket its
 * creation site owns.
 */
function countingWrapper(stats: SiteStats, callback: TimerCallback): TimerCallback {
  return function wrapped(this: unknown, ...args: unknown[]): void {
    const startedAt = performance.now();
    try {
      callback.apply(this, args);
    } finally {
      stats.fires += 1;
      stats.callbackMs += performance.now() - startedAt;
    }
  };
}

/**
 * Wrap `setTimeout` / `setInterval` / `setImmediate` on globalThis so every
 * scheduled timer is attributed to its creation site. Idempotent, and a no-op
 * unless `CYBOFLOW_PERF_TRACE=1`.
 */
export function installTimerCensus(): void {
  if (!TRACE_ENABLED || installed) return;
  installed = true;

  const globals = globalThis as unknown as {
    setTimeout: typeof setTimeout;
    setInterval: typeof setInterval;
    setImmediate: typeof setImmediate;
  };

  const realSetTimeout = globals.setTimeout;
  const realSetInterval = globals.setInterval;
  const realSetImmediate = globals.setImmediate;

  // The wrappers deliberately forward to the real builtin and return its handle
  // untouched, so `unref()` / `clearInterval()` / Timeout identity all keep
  // working exactly as before — the census only observes.
  const wrapScheduler = (
    real: typeof setTimeout | typeof setInterval,
    kind: 'timeout' | 'interval',
  ) =>
    function scheduled(callback: TimerCallback, ms?: number, ...args: unknown[]) {
      const site = callSite();
      const stats = statsFor(site, kind);
      stats.created += 1;
      stats.minDelayMs = Math.min(stats.minDelayMs, ms ?? 0);
      return (real as (cb: TimerCallback, ms?: number, ...rest: unknown[]) => NodeJS.Timeout)(
        countingWrapper(stats, callback),
        ms,
        ...args,
      );
    };

  globals.setTimeout = wrapScheduler(realSetTimeout, 'timeout') as typeof setTimeout;
  globals.setInterval = wrapScheduler(realSetInterval, 'interval') as typeof setInterval;
  globals.setImmediate = function scheduledImmediate(callback: TimerCallback, ...args: unknown[]) {
    const site = callSite();
    const stats = statsFor(site, 'immediate');
    stats.created += 1;
    stats.minDelayMs = 0;
    return realSetImmediate(
      countingWrapper(stats, callback) as unknown as (...a: unknown[]) => void,
      ...args,
    );
  } as unknown as typeof setImmediate;
}

/** One reported row, richest-first by fire count. */
export interface TimerCensusRow {
  site: string;
  kind: SiteStats['kind'];
  created: number;
  fires: number;
  callbackMs: number;
  minDelayMs: number;
}

/**
 * Drain the census into a sorted snapshot and reset the per-interval counters.
 * Sites are kept (not deleted) so a long-lived interval keeps its identity
 * across reports; only the counters reset.
 */
export function drainTimerCensus(limit = 8): TimerCensusRow[] {
  const rows: TimerCensusRow[] = [];
  for (const [site, stats] of sites) {
    if (stats.fires === 0 && stats.created === 0) continue;
    rows.push({
      site,
      kind: stats.kind,
      created: stats.created,
      fires: stats.fires,
      callbackMs: Number(stats.callbackMs.toFixed(1)),
      minDelayMs: Number.isFinite(stats.minDelayMs) ? stats.minDelayMs : 0,
    });
    stats.created = 0;
    stats.fires = 0;
    stats.callbackMs = 0;
  }
  rows.sort((a, b) => b.fires - a.fires);
  return rows.slice(0, limit);
}

/** Format a census snapshot as a single log-friendly line. */
export function formatTimerCensus(rows: TimerCensusRow[]): string {
  if (rows.length === 0) return '(no timers)';
  return rows
    .map(
      (row) =>
        `${row.site}[${row.kind === 'interval' ? 'iv' : row.kind === 'timeout' ? 'to' : 'im'}@${row.minDelayMs}ms]=` +
        `${row.fires}x/${row.callbackMs}ms`,
    )
    .join(' ');
}

/** Test-only: drop all recorded sites so cases do not leak into each other. */
export function _resetTimerCensusForTesting(): void {
  sites.clear();
}

/** Whether the census is active this process. */
export function timerCensusEnabled(): boolean {
  return TRACE_ENABLED;
}

/** Expose the logger type for the tracer's use. */
export type { CensusLogger };
