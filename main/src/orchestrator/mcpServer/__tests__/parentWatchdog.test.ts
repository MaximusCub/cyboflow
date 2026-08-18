/**
 * Unit tests for parentWatchdog — the ppid poll that guarantees a
 * cyboflowMcpServer subprocess does not outlive the `claude` process that
 * spawned it (see parentWatchdog.ts for why ppid is the primary signal).
 *
 * The module is dependency-injected (`getPpid`, `intervalMs`), so every
 * behaviour here is exercised with fake timers and a stub ppid reader — no
 * subprocess, no wall-clock waiting, fully hermetic.
 *
 * The properties under test are exactly the ones whose failure modes are
 * dangerous rather than merely inconvenient:
 *   - fires AT MOST ONCE (a re-entered shutdown handler is a real hazard),
 *   - never fires while the spawner is alive (killing a live server is the
 *     one failure mode the design says must be impossible),
 *   - a throwing `getPpid` skips its tick WITHOUT wedging the watchdog
 *     permanently (it is the guarantee; losing it leaks the process forever),
 *   - the interval is unref'd (the watchdog must never itself be the reason
 *     the process fails to exit).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  startParentWatchdog,
  resolveWatchdogIntervalMs,
  PARENT_WATCHDOG_INTERVAL_MS,
  MIN_WATCHDOG_INTERVAL_MS,
  WATCHDOG_INTERVAL_ENV,
} from '../parentWatchdog';

const INTERVAL = 1_000;

describe('startParentWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onOrphaned exactly once when ppid is 1, and stops polling', () => {
    const onOrphaned = vi.fn();
    const getPpid = vi.fn(() => 1);

    startParentWatchdog({ onOrphaned, getPpid, intervalMs: INTERVAL });

    // Well past several intervals: a watchdog that re-armed itself, or that
    // failed to latch `fired`, would call the handler once per tick.
    vi.advanceTimersByTime(INTERVAL * 10);

    expect(onOrphaned).toHaveBeenCalledTimes(1);
    expect(onOrphaned.mock.calls[0][0]).toContain('ppid=1');
    // It stopped itself on firing, so the ppid reader is not consulted again.
    expect(getPpid).toHaveBeenCalledTimes(1);
  });

  it('never fires while getPpid returns a real (non-1) ppid', () => {
    const onOrphaned = vi.fn();
    const getPpid = vi.fn(() => 4242);

    startParentWatchdog({ onOrphaned, getPpid, intervalMs: INTERVAL });
    vi.advanceTimersByTime(INTERVAL * 20);

    expect(onOrphaned).not.toHaveBeenCalled();
    expect(getPpid).toHaveBeenCalledTimes(20);
  });

  it('fires on the first tick that observes ppid 1 after a live parent', () => {
    const onOrphaned = vi.fn();
    let ppid = 4242;
    const getPpid = () => ppid;

    startParentWatchdog({ onOrphaned, getPpid, intervalMs: INTERVAL });

    vi.advanceTimersByTime(INTERVAL * 3);
    expect(onOrphaned).not.toHaveBeenCalled();

    ppid = 1;
    vi.advanceTimersByTime(INTERVAL);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it('stop() prevents any further firing', () => {
    const onOrphaned = vi.fn();
    let ppid = 4242;

    const handle = startParentWatchdog({
      onOrphaned,
      getPpid: () => ppid,
      intervalMs: INTERVAL,
    });

    handle.stop();
    // The parent dies AFTER stop(): a cancelled watchdog must stay silent.
    ppid = 1;
    vi.advanceTimersByTime(INTERVAL * 10);

    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it('stop() is idempotent', () => {
    const onOrphaned = vi.fn();
    const handle = startParentWatchdog({
      onOrphaned,
      getPpid: () => 1,
      intervalMs: INTERVAL,
    });

    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();

    vi.advanceTimersByTime(INTERVAL * 5);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it('skips a tick whose getPpid throws, without propagating or wedging', () => {
    const onOrphaned = vi.fn();
    let mode: 'throw' | 'alive' | 'orphaned' = 'throw';
    const getPpid = vi.fn(() => {
      if (mode === 'throw') throw new Error('getppid exploded');
      return mode === 'alive' ? 4242 : 1;
    });

    startParentWatchdog({ onOrphaned, getPpid, intervalMs: INTERVAL });

    // Throwing ticks must neither reach the caller (an uncaught error here
    // would take the process down through the uncaughtException handler) nor
    // fire the handler.
    expect(() => vi.advanceTimersByTime(INTERVAL * 3)).not.toThrow();
    expect(onOrphaned).not.toHaveBeenCalled();
    expect(getPpid).toHaveBeenCalledTimes(3);

    mode = 'alive';
    vi.advanceTimersByTime(INTERVAL);
    expect(onOrphaned).not.toHaveBeenCalled();

    // The interval survived the throws: a later orphan is still detected.
    mode = 'orphaned';
    vi.advanceTimersByTime(INTERVAL);
    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it('unrefs the interval handle', () => {
    // The implementation calls `.unref?.()` on whatever setInterval returned,
    // so the only way to observe it is to wrap the handle on its way out of
    // setInterval. Under fake timers that is the fake-timers handle, which
    // carries a real unref(); we count the call and delegate.
    const originalSetInterval = globalThis.setInterval;
    let unrefCalls = 0;

    const patched = ((...args: Parameters<typeof originalSetInterval>) => {
      const timer = originalSetInterval(...args);
      const realUnref =
        typeof timer.unref === 'function' ? timer.unref.bind(timer) : undefined;
      timer.unref = () => {
        unrefCalls += 1;
        return realUnref ? realUnref() : timer;
      };
      return timer;
    }) as typeof originalSetInterval;

    globalThis.setInterval = patched;
    try {
      startParentWatchdog({
        onOrphaned: vi.fn(),
        getPpid: () => 4242,
        intervalMs: INTERVAL,
      });
    } finally {
      globalThis.setInterval = originalSetInterval;
    }

    expect(unrefCalls).toBe(1);
  });

  it('defaults getPpid to the live process.ppid (which is never 1 under vitest)', () => {
    const onOrphaned = vi.fn();
    startParentWatchdog({ onOrphaned, intervalMs: INTERVAL });

    vi.advanceTimersByTime(INTERVAL * 5);

    // The test process is itself a child of the vitest runner, so the default
    // reader must observe a real ppid and stay silent.
    expect(process.ppid).not.toBe(1);
    expect(onOrphaned).not.toHaveBeenCalled();
  });
});

describe('resolveWatchdogIntervalMs', () => {
  it('returns the default when the env var is absent', () => {
    expect(resolveWatchdogIntervalMs({})).toBe(PARENT_WATCHDOG_INTERVAL_MS);
  });

  it('returns the default for an empty / whitespace-only value', () => {
    expect(resolveWatchdogIntervalMs({ [WATCHDOG_INTERVAL_ENV]: '' })).toBe(
      PARENT_WATCHDOG_INTERVAL_MS,
    );
    expect(resolveWatchdogIntervalMs({ [WATCHDOG_INTERVAL_ENV]: '   ' })).toBe(
      PARENT_WATCHDOG_INTERVAL_MS,
    );
  });

  it('parses a valid override', () => {
    expect(resolveWatchdogIntervalMs({ [WATCHDOG_INTERVAL_ENV]: '2500' })).toBe(2500);
    // Surrounding whitespace is tolerated by Number().
    expect(resolveWatchdogIntervalMs({ [WATCHDOG_INTERVAL_ENV]: ' 750 ' })).toBe(750);
  });

  it('accepts exactly the floor', () => {
    expect(
      resolveWatchdogIntervalMs({
        [WATCHDOG_INTERVAL_ENV]: String(MIN_WATCHDOG_INTERVAL_MS),
      }),
    ).toBe(MIN_WATCHDOG_INTERVAL_MS);
  });

  it('falls back to the default for a non-numeric value', () => {
    expect(resolveWatchdogIntervalMs({ [WATCHDOG_INTERVAL_ENV]: 'soon' })).toBe(
      PARENT_WATCHDOG_INTERVAL_MS,
    );
  });

  it('falls back to the default for a non-finite value', () => {
    for (const raw of ['Infinity', '-Infinity', 'NaN']) {
      expect(resolveWatchdogIntervalMs({ [WATCHDOG_INTERVAL_ENV]: raw })).toBe(
        PARENT_WATCHDOG_INTERVAL_MS,
      );
    }
  });

  it('falls back to the default below the floor (no busy-loop watchdog)', () => {
    for (const raw of ['0', '1', '99', '-5000']) {
      expect(resolveWatchdogIntervalMs({ [WATCHDOG_INTERVAL_ENV]: raw })).toBe(
        PARENT_WATCHDOG_INTERVAL_MS,
      );
    }
  });

  it('reads process.env by default', () => {
    const previous = process.env[WATCHDOG_INTERVAL_ENV];
    process.env[WATCHDOG_INTERVAL_ENV] = '1234';
    try {
      expect(resolveWatchdogIntervalMs()).toBe(1234);
    } finally {
      if (previous === undefined) delete process.env[WATCHDOG_INTERVAL_ENV];
      else process.env[WATCHDOG_INTERVAL_ENV] = previous;
    }
  });
});
