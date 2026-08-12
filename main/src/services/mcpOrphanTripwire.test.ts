/**
 * McpOrphanTripwire unit tests.
 *
 * These drive the tripwire through its injected `listProcesses`/`resolveScriptPath`
 * seams — no real `ps` or electron `app.isPackaged` — so the detection predicate
 * (script-path match AND ppid===1 AND age > gate), `parseEtime`'s three macOS
 * shapes, and the fail-soft / non-blocking interval behavior are asserted
 * deterministically.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  McpOrphanTripwire,
  parseEtime,
  parseMcpOrphanPsOutput,
  MCP_ORPHAN_AGE_GATE_SECONDS,
  MCP_ORPHAN_SCAN_INTERVAL_MS,
  type McpOrphanProcess,
} from './mcpOrphanTripwire';
import { PARENT_WATCHDOG_INTERVAL_MS } from '../orchestrator/mcpServer/parentWatchdog';

const SCRIPT_PATH = '/Applications/Cyboflow.app/Contents/Resources/app.asar.unpacked/main/dist/main/src/orchestrator/mcpServer/cyboflowMcpServer.js';

/** Build a lister that returns a fixed process table. */
function fixedLister(rows: McpOrphanProcess[]): () => Promise<McpOrphanProcess[]> {
  return () => Promise.resolve(rows);
}

/** The command line a real orphaned cyboflowMcpServer would show in `ps`, at `etime`. */
function orphanCommand(): string {
  return `/usr/local/bin/node ${SCRIPT_PATH}`;
}

/** Age gate is derived from the watchdog interval — assert the derivation itself. */
describe('MCP_ORPHAN_AGE_GATE_SECONDS', () => {
  it('is exactly 2x PARENT_WATCHDOG_INTERVAL_MS, in seconds', () => {
    expect(MCP_ORPHAN_AGE_GATE_SECONDS).toBe((PARENT_WATCHDOG_INTERVAL_MS * 2) / 1000);
  });
});

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

describe('McpOrphanTripwire.scan — detection predicate', () => {
  const OLD_AGE = MCP_ORPHAN_AGE_GATE_SECONDS + 60;
  const YOUNG_AGE = MCP_ORPHAN_AGE_GATE_SECONDS - 60;

  it('counts a genuine orphan: matching script path, ppid===1, age > gate', async () => {
    const rows: McpOrphanProcess[] = [
      { pid: 500, ppid: 1, etimeSeconds: OLD_AGE, command: orphanCommand() },
    ];
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister(rows),
      resolveScriptPath: () => SCRIPT_PATH,
    });

    await expect(tripwire.scan()).resolves.toBe(1);
  });

  it('does NOT count a matching command whose ppid is not 1 (spawner still alive)', async () => {
    const rows: McpOrphanProcess[] = [
      { pid: 500, ppid: 4242, etimeSeconds: OLD_AGE, command: orphanCommand() },
    ];
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister(rows),
      resolveScriptPath: () => SCRIPT_PATH,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('does NOT count a too-young orphan (within the watchdog reap window)', async () => {
    const rows: McpOrphanProcess[] = [
      { pid: 500, ppid: 1, etimeSeconds: YOUNG_AGE, command: orphanCommand() },
    ];
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister(rows),
      resolveScriptPath: () => SCRIPT_PATH,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('does NOT count a process exactly AT the age gate (strictly greater-than)', async () => {
    const rows: McpOrphanProcess[] = [
      { pid: 500, ppid: 1, etimeSeconds: MCP_ORPHAN_AGE_GATE_SECONDS, command: orphanCommand() },
    ];
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister(rows),
      resolveScriptPath: () => SCRIPT_PATH,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('does NOT count a command outside this install\'s resolved script path', async () => {
    const rows: McpOrphanProcess[] = [
      {
        pid: 500,
        ppid: 1,
        etimeSeconds: OLD_AGE,
        // A different install's MCP server, or an unrelated node process.
        command: '/usr/local/bin/node /some/other/install/cyboflowMcpServer.js',
      },
      { pid: 501, ppid: 1, etimeSeconds: OLD_AGE, command: '/usr/local/bin/node --eval "1"' },
    ];
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister(rows),
      resolveScriptPath: () => SCRIPT_PATH,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('does NOT count a row with an unparseable age (never guesses)', async () => {
    const rows: McpOrphanProcess[] = [
      { pid: 500, ppid: 1, etimeSeconds: null, command: orphanCommand() },
    ];
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister(rows),
      resolveScriptPath: () => SCRIPT_PATH,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('counts multiple genuine orphans and ignores non-matching rows in the same scan', async () => {
    const rows: McpOrphanProcess[] = [
      { pid: 500, ppid: 1, etimeSeconds: OLD_AGE, command: orphanCommand() },
      { pid: 501, ppid: 1, etimeSeconds: OLD_AGE, command: orphanCommand() },
      { pid: 502, ppid: 4242, etimeSeconds: OLD_AGE, command: orphanCommand() }, // spawner alive
      { pid: 503, ppid: 1, etimeSeconds: YOUNG_AGE, command: orphanCommand() }, // too young
    ];
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister(rows),
      resolveScriptPath: () => SCRIPT_PATH,
    });

    await expect(tripwire.scan()).resolves.toBe(2);
  });
});

describe('McpOrphanTripwire fail-soft', () => {
  it('does not throw and returns 0 when listing processes fails', async () => {
    const tripwire = new McpOrphanTripwire({
      listProcesses: () => Promise.reject(new Error('ps blew up')),
      resolveScriptPath: () => SCRIPT_PATH,
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('does not throw and returns 0 when resolving the script path fails', async () => {
    const tripwire = new McpOrphanTripwire({
      listProcesses: fixedLister([
        { pid: 500, ppid: 1, etimeSeconds: MCP_ORPHAN_AGE_GATE_SECONDS + 1, command: orphanCommand() },
      ]),
      resolveScriptPath: () => {
        throw new Error('electron app not ready');
      },
    });

    await expect(tripwire.scan()).resolves.toBe(0);
  });

  it('logs a warning only when count > 0, and debug when count === 0', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const quiet = new McpOrphanTripwire({ listProcesses: fixedLister([]), resolveScriptPath: () => SCRIPT_PATH, logger });
    await quiet.scan();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();

    const loud = new McpOrphanTripwire({
      listProcesses: fixedLister([
        { pid: 500, ppid: 1, etimeSeconds: MCP_ORPHAN_AGE_GATE_SECONDS + 1, command: orphanCommand() },
      ]),
      resolveScriptPath: () => SCRIPT_PATH,
      logger,
    });
    await loud.scan();
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
    const tripwire = new McpOrphanTripwire({ listProcesses, resolveScriptPath: () => SCRIPT_PATH });

    tripwire.start();
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(MCP_ORPHAN_SCAN_INTERVAL_MS);
    expect(listProcesses).toHaveBeenCalledTimes(2);

    tripwire.stop();
  });

  it('is idempotent: a second start() does not double the interval', async () => {
    vi.useFakeTimers();
    const listProcesses = vi.fn().mockResolvedValue([]);
    const tripwire = new McpOrphanTripwire({ listProcesses, resolveScriptPath: () => SCRIPT_PATH });

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
    const tripwire = new McpOrphanTripwire({ listProcesses, resolveScriptPath: () => SCRIPT_PATH });

    tripwire.start();
    await vi.waitFor(() => expect(listProcesses).toHaveBeenCalledTimes(1));

    tripwire.stop();
    tripwire.stop(); // idempotent — must not throw

    await vi.advanceTimersByTimeAsync(MCP_ORPHAN_SCAN_INTERVAL_MS * 3);
    expect(listProcesses).toHaveBeenCalledTimes(1); // no further scans after stop
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
    });
    tripwire.start();
    expect(unref).toHaveBeenCalledTimes(1);

    tripwire.stop();
    setIntervalSpy.mockRestore();
  });
});
