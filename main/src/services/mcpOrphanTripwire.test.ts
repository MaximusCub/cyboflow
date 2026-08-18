/**
 * McpOrphanTripwire unit tests.
 *
 * These drive the tripwire through its injected `listProcesses`/`resolveScriptPath`/
 * `now` seams — no real `ps`, no electron `app.isPackaged`, no fake timers for the
 * scan-level tests — so the detection predicate (script-path match, ppid===1,
 * CONFIRMED ACROSS SCANS rather than age-gated), `parseEtime`'s three macOS shapes,
 * and the fail-soft / non-blocking interval behavior are asserted deterministically.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  McpOrphanTripwire,
  parseEtime,
  parseMcpOrphanPsOutput,
  MCP_ORPHAN_SCAN_INTERVAL_MS,
  MCP_ORPHAN_GRACE_MS,
  MCP_ORPHAN_CONFIRM_DELAY_MS,
  MCP_ORPHAN_START_TIME_TOLERANCE_SEC,
  type McpOrphanProcess,
} from './mcpOrphanTripwire';
import { PARENT_WATCHDOG_INTERVAL_MS } from '../orchestrator/mcpServer/parentWatchdog';

const SCRIPT_PATH = '/Applications/Cyboflow.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js';

/** An arbitrary but fixed epoch-ms starting point for the clock seam. */
const START_MS = 1_700_000_000_000;

/** Build a lister that returns a fixed process table on every call. */
function fixedLister(rows: McpOrphanProcess[]): () => Promise<McpOrphanProcess[]> {
  return () => Promise.resolve(rows);
}

/**
 * A lister whose rows can be swapped out between scans, to simulate a process
 * table that changes over wall-clock time (a process aging, disappearing, or a
 * pid being reused).
 */
function mutableLister(initial: McpOrphanProcess[]): {
  listProcesses: () => Promise<McpOrphanProcess[]>;
  setRows: (rows: McpOrphanProcess[]) => void;
} {
  let rows = initial;
  return {
    listProcesses: () => Promise.resolve(rows),
    setRows: (next) => {
      rows = next;
    },
  };
}

/**
 * A no-op structured logger satisfying the now-required `logger` option.
 * Deliberately not type-annotated as `LoggerLike` here — keeping the inferred
 * vi.fn() return type lets tests that assert on call history (`.mock.calls`)
 * do so without a cast.
 */
function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** The injectable `now` seam: an explicit clock, advanced by the test, no fake timers. */
function makeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let currentMs = startMs;
  return {
    now: () => currentMs,
    advance: (ms: number) => {
      currentMs += ms;
    },
  };
}

/** The command line a real orphaned cyboflowMcpServer would show in `ps`. */
function orphanCommand(): string {
  return `/usr/local/bin/node ${SCRIPT_PATH}`;
}

/** Build an orphaned-process row: matching script path, ppid 1, at the given age. */
function orphanRow(pid: number, etimeSeconds: number): McpOrphanProcess {
  return { pid, ppid: 1, etimeSeconds, command: orphanCommand() };
}

describe('parseEtime', () => {
  it('parses mm:ss', () => {
    expect(parseEtime('05:30')).toBe(5 * 60 + 30);
    expect(parseEtime('00:01')).toBe(1);
  });

  it('parses hh:mm:ss', () => {
    expect(parseEtime('01:02:15')).toBe(1 * 3600 + 2 * 60 + 15);
    expect(parseEtime('23:59:59')).toBe(23 * 3600 + 59 * 60 + 59);
  });

  it('parses dd-hh:mm:ss', () => {
    expect(parseEtime('1-02:15:33')).toBe(1 * 86400 + 2 * 3600 + 15 * 60 + 33);
    expect(parseEtime('10-00:00:00')).toBe(10 * 86400);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseEtime('  05:30  ')).toBe(330);
  });

  it('returns null for garbage / unparseable shapes', () => {
    expect(parseEtime('garbage')).toBeNull();
    expect(parseEtime('')).toBeNull();
    expect(parseEtime('1:2:3:4')).toBeNull();
    expect(parseEtime('ab:cd')).toBeNull();
    expect(parseEtime('60:00')).toBeNull(); // out-of-range minutes
    expect(parseEtime('05:60')).toBeNull(); // out-of-range seconds
    expect(parseEtime('-05:30')).toBeNull();
    expect(parseEtime('/usr/local/bin/node')).toBeNull(); // a mis-shifted command word
  });
});

describe('parseMcpOrphanPsOutput', () => {
  it('parses pid, ppid, etime, and command; skips blanks and malformed lines', () => {
    const out = [
      '  1     0 00:00:01 /sbin/launchd',
      ' 320   1 01:00:00 /usr/local/bin/node /path/to/cyboflowMcpServer.js',
      '',
      'garbage',
    ].join('\n');
    const rows = parseMcpOrphanPsOutput(out);
    expect(rows).toEqual([
      { pid: 1, ppid: 0, etimeSeconds: 1, command: '/sbin/launchd' },
      {
        pid: 320,
        ppid: 1,
        etimeSeconds: 3600,
        command: '/usr/local/bin/node /path/to/cyboflowMcpServer.js',
      },
    ]);
  });

  it('yields etimeSeconds: null (not a mis-indexed row) when the etime column is missing', () => {
    // Simulates the macOS "ps: etimes: keyword not found" gotcha: ps still exits 0
    // and just omits the column, shifting the command's first word into the etime
    // capture. That word won't match parseEtime's shape, so it becomes null rather
    // than a silently wrong age.
    const out = ' 320   1 /usr/local/bin/node /path/to/cyboflowMcpServer.js';
    const rows = parseMcpOrphanPsOutput(out);
    expect(rows).toEqual([
      { pid: 320, ppid: 1, etimeSeconds: null, command: '/path/to/cyboflowMcpServer.js' },
    ]);
  });
});

describe('MCP_ORPHAN_GRACE_MS / MCP_ORPHAN_CONFIRM_DELAY_MS', () => {
  it('the grace window is exactly 2x PARENT_WATCHDOG_INTERVAL_MS', () => {
    expect(MCP_ORPHAN_GRACE_MS).toBe(PARENT_WATCHDOG_INTERVAL_MS * 2);
  });

  it('the confirm delay is past the grace window, so a scheduled rescan can always confirm', () => {
    expect(MCP_ORPHAN_CONFIRM_DELAY_MS).toBeGreaterThan(MCP_ORPHAN_GRACE_MS);
  });
});

describe('McpOrphanTripwire.scan — confirmation across scans', () => {
  it('a) FIRST SIGHTING NEVER COUNTS', async () => {
    const clock = makeClock(START_MS);
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister([orphanRow(500, 600)]),
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('b) CONFIRMED ON A LATER SCAN, at least MCP_ORPHAN_GRACE_MS after the first sighting', async () => {
    const clock = makeClock(START_MS);
    const lister = mutableLister([orphanRow(500, 600)]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0); // first sighting

    const elapsedMs = MCP_ORPHAN_GRACE_MS;
    clock.advance(elapsedMs);
    // Still alive: a real `ps` would report its age grown by the same wall time.
    lister.setRows([orphanRow(500, 600 + elapsedMs / 1000)]);

    await expect(tripwire.scan()).resolves.toBe(1);
  });

  it('c) NOT CONFIRMED when the second scan is short of the grace window', async () => {
    const clock = makeClock(START_MS);
    const lister = mutableLister([orphanRow(500, 600)]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0);

    const elapsedMs = MCP_ORPHAN_GRACE_MS - 1000;
    clock.advance(elapsedMs);
    lister.setRows([orphanRow(500, 600 + elapsedMs / 1000)]);

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('d) REGRESSION GUARD: a long-lived process that JUST became orphaned is not counted instantly', async () => {
    // Under the old age-gate semantics (etime > gate), a 3-hour-old process
    // sailed straight through on its very first sighting — exactly the false
    // alarm confirmation-across-scans replaced. A second scan only ~1s later
    // must still read 0.
    const clock = makeClock(START_MS);
    const threeHours = 3 * 3600;
    const lister = mutableLister([orphanRow(500, threeHours)]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0);

    clock.advance(1000);
    lister.setRows([orphanRow(500, threeHours + 1)]);

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('e) DISAPPEARS BEFORE CONFIRMATION (healthy watchdog case) is forgotten, not fast-tracked on reappearance', async () => {
    const clock = makeClock(START_MS);
    const lister = mutableLister([orphanRow(500, 600)]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0); // first sighting

    clock.advance(MCP_ORPHAN_GRACE_MS);
    lister.setRows([]); // the watchdog reaped it before confirmation
    await expect(tripwire.scan()).resolves.toBe(0);

    // A NEW process later reuses the pid. If the old sighting had survived,
    // this would wrongly confirm instantly — it must start over instead.
    clock.advance(MCP_ORPHAN_GRACE_MS);
    lister.setRows([orphanRow(500, 30)]);
    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('f) PID REUSE GUARD: a new process on a reused pid does not inherit the old confirmation clock', async () => {
    const clock = makeClock(START_MS);
    const lister = mutableLister([orphanRow(4242, 600)]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0); // first sighting of pid 4242

    clock.advance(MCP_ORPHAN_GRACE_MS);
    // Same pid, but its derived start time is nowhere near the remembered
    // one (a freshly-started process, not the original aged by the grace
    // window) — well beyond MCP_ORPHAN_START_TIME_TOLERANCE_SEC.
    lister.setRows([orphanRow(4242, 10)]);
    await expect(tripwire.scan()).resolves.toBe(0); // treated as a new sighting, not a confirmation

    clock.advance(MCP_ORPHAN_GRACE_MS);
    lister.setRows([orphanRow(4242, 10 + MCP_ORPHAN_GRACE_MS / 1000)]);
    await expect(tripwire.scan()).resolves.toBe(1); // confirms on its own clock
  });

  it('g) START-TIME JITTER within tolerance still confirms', async () => {
    const clock = makeClock(START_MS);
    const lister = mutableLister([orphanRow(500, 600)]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0);

    const elapsedMs = MCP_ORPHAN_GRACE_MS;
    clock.advance(elapsedMs);
    // A few seconds of jitter versus wall time (etime's 1s granularity, plus
    // non-simultaneous clock reads) — still comfortably inside tolerance.
    const jitterSec = MCP_ORPHAN_START_TIME_TOLERANCE_SEC - 2;
    lister.setRows([orphanRow(500, 600 + elapsedMs / 1000 - jitterSec)]);

    await expect(tripwire.scan()).resolves.toBe(1);
  });

  it('h) does NOT count a matching command whose ppid is not 1, across repeated scans', async () => {
    const clock = makeClock(START_MS);
    const lister = mutableLister([{ pid: 500, ppid: 4242, etimeSeconds: 600, command: orphanCommand() }]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
    clock.advance(MCP_ORPHAN_GRACE_MS);
    lister.setRows([
      { pid: 500, ppid: 4242, etimeSeconds: 600 + MCP_ORPHAN_GRACE_MS / 1000, command: orphanCommand() },
    ]);
    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it("h) does NOT count a command outside this install's resolved script path, across repeated scans", async () => {
    const clock = makeClock(START_MS);
    const otherInstallCommand = '/usr/local/bin/node /some/other/install/cyboflowMcpServer.js';
    const lister = mutableLister([{ pid: 500, ppid: 1, etimeSeconds: 600, command: otherInstallCommand }]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
    clock.advance(MCP_ORPHAN_GRACE_MS);
    lister.setRows([
      { pid: 500, ppid: 1, etimeSeconds: 600 + MCP_ORPHAN_GRACE_MS / 1000, command: otherInstallCommand },
    ]);
    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('h) does NOT count a row with an unparseable age, and never remembers it', async () => {
    const clock = makeClock(START_MS);
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister([{ pid: 500, ppid: 1, etimeSeconds: null, command: orphanCommand() }]),
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
    clock.advance(MCP_ORPHAN_GRACE_MS);
    // Still unparseable on the second scan — if it had been remembered
    // despite the null etime, this would be indistinguishable from a
    // confirmation.
    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('i) MULTIPLE GENUINE ORPHANS confirm together; non-matching rows in the same scan are ignored', async () => {
    const clock = makeClock(START_MS);
    const lister = mutableLister([
      orphanRow(500, 600),
      orphanRow(501, 600),
      { pid: 502, ppid: 4242, etimeSeconds: 600, command: orphanCommand() }, // spawner alive
      { pid: 503, ppid: 1, etimeSeconds: 600, command: '/usr/local/bin/node --eval "1"' }, // unrelated
    ]);
    const tripwire = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
      now: clock.now,
    });

    await expect(tripwire.scan()).resolves.toBe(0); // first sighting of both candidates

    const elapsedMs = MCP_ORPHAN_GRACE_MS;
    clock.advance(elapsedMs);
    lister.setRows([
      orphanRow(500, 600 + elapsedMs / 1000),
      orphanRow(501, 600 + elapsedMs / 1000),
      { pid: 502, ppid: 4242, etimeSeconds: 600 + elapsedMs / 1000, command: orphanCommand() },
      { pid: 503, ppid: 1, etimeSeconds: 600 + elapsedMs / 1000, command: '/usr/local/bin/node --eval "1"' },
    ]);

    await expect(tripwire.scan()).resolves.toBe(2);
  });
});

describe('McpOrphanTripwire fail-soft', () => {
  it('does not throw and returns 0 when listing processes fails', async () => {
    const tripwire = new McpOrphanTripwire({
      listProcesses: () => Promise.reject(new Error('ps blew up')),
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('does not throw and returns 0 when resolving the script path fails', async () => {
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister([orphanRow(500, 600)]),
      resolveScriptPath: () => {
        throw new Error('electron app not ready');
      },
      logger: fakeLogger(),
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('logs a warning only when count > 0, and debug when count === 0', async () => {
    const logger = fakeLogger();

    const quiet = new McpOrphanTripwire({ listProcesses: fixedLister([]), resolveScriptPath: () => SCRIPT_PATH, logger });
    await quiet.scan();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();

    const clock = makeClock(START_MS);
    const lister = mutableLister([orphanRow(500, 600)]);
    const loud = new McpOrphanTripwire({
      listProcesses: lister.listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger,
      now: clock.now,
    });
    await loud.scan(); // first sighting — still 0, still debug
    clock.advance(MCP_ORPHAN_GRACE_MS);
    lister.setRows([orphanRow(500, 600 + MCP_ORPHAN_GRACE_MS / 1000)]);
    await loud.scan(); // confirmed

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/orphaned/i);
  });
});

describe('McpOrphanTripwire.start/stop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scans immediately on start, then again on the hourly interval', async () => {
    vi.useFakeTimers();
    const listProcesses = vi.fn().mockResolvedValue([]);
    const tripwire = new McpOrphanTripwire({
      listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
    });

    tripwire.start();
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(MCP_ORPHAN_SCAN_INTERVAL_MS);
    expect(listProcesses).toHaveBeenCalledTimes(2);

    tripwire.stop();
  });

  it('is idempotent: a second start() does not double the interval', async () => {
    vi.useFakeTimers();
    const listProcesses = vi.fn().mockResolvedValue([]);
    const tripwire = new McpOrphanTripwire({
      listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
    });

    tripwire.start();
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1));
    tripwire.start(); // no-op

    await vi.advanceTimersByTimeAsync(MCP_ORPHAN_SCAN_INTERVAL_MS);
    // 1 (initial) + 1 (single interval tick) — a doubled interval would be 3.
    expect(listProcesses).toHaveBeenCalledTimes(2);

    tripwire.stop();
  });

  it('stop() clears the interval and is idempotent', async () => {
    vi.useFakeTimers();
    const listProcesses = vi.fn().mockResolvedValue([]);
    const tripwire = new McpOrphanTripwire({
      listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
    });

    tripwire.start();
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1));

    tripwire.stop();
    tripwire.stop(); // idempotent — must not throw

    await vi.advanceTimersByTimeAsync(MCP_ORPHAN_SCAN_INTERVAL_MS * 3);
    expect(listProcesses).toHaveBeenCalledTimes(1); // no further scans after stop
  });

  it('stop() also cancels a pending confirmation rescan', async () => {
    vi.useFakeTimers();
    // A first sighting (an unconfirmed candidate) arms a one-shot rescan at
    // MCP_ORPHAN_CONFIRM_DELAY_MS, independent of the hourly interval and of
    // start()/stop() ever having been called.
    const listProcesses = vi.fn().mockResolvedValue([orphanRow(500, 600)]);
    const tripwire = new McpOrphanTripwire({
      listProcesses,
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
    });

    await tripwire.scan();
    expect(listProcesses).toHaveBeenCalledTimes(1);

    tripwire.stop();

    await vi.advanceTimersByTimeAsync(MCP_ORPHAN_CONFIRM_DELAY_MS * 2);
    expect(listProcesses).toHaveBeenCalledTimes(1); // the armed rescan never fired
  });

  it('unref()s the interval so it never holds the event loop open', () => {
    const unref = vi.fn();
    const originalSetInterval = global.setInterval;
    // Spy on setInterval to assert the returned handle is unref'd, without
    // actually needing to wait out a real hourly timer.
    const setIntervalSpy = vi
      .spyOn(global, 'setInterval')
      .mockImplementation(((...args: Parameters<typeof setInterval>) => {
        const handle = originalSetInterval(...args);
        (handle as unknown as { unref: () => void }).unref = unref;
        return handle;
      }) as typeof setInterval);

    const tripwire = new McpOrphanTripwire({
      listProcesses: () => Promise.resolve([]),
      resolveScriptPath: () => SCRIPT_PATH,
      logger: fakeLogger(),
    });
    tripwire.start();
    expect(unref).toHaveBeenCalledTimes(1);

    tripwire.stop();
    setIntervalSpy.mockRestore();
  });
});
