/**
 * Orphan-watchdog unit tests.
 *
 * Driven entirely through injected seams (title / ppid / thread / timer / exit) —
 * nothing is forked and nothing is killed. The regressions that matter here are
 * the ones where arming is WRONG: a vitest root must never self-terminate, a
 * `threads`-pool worker must never be judged by its process ppid, and a detached
 * (`nohup`) run must survive — each of those would turn a healthy gate into a
 * self-inflicted kill.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  isForkPoolWorker,
  startOrphanWatchdog,
  ORPHAN_POLL_INTERVAL_MS,
  type OrphanWatchdogDeps,
} from '../../../../../vitestOrphanWatchdog';

/** A watchdog harness whose timer is driven by hand. */
function harness(overrides: Partial<OrphanWatchdogDeps> & { ppid: number }) {
  const ticks: Array<() => void> = [];
  const exit = vi.fn();
  const cancel = vi.fn();
  const warn = vi.fn();
  let ppid = overrides.ppid;
  const deps: OrphanWatchdogDeps = {
    title: 'node (vitest 7)',
    mainThread: true,
    getPpid: () => ppid,
    exit,
    cancel,
    warn,
    schedule: (fn) => {
      ticks.push(fn);
      return { unref: vi.fn() };
    },
    ...overrides,
  };
  const disarm = startOrphanWatchdog(deps);
  return {
    disarm,
    exit,
    cancel,
    warn,
    armed: ticks.length > 0,
    tick: () => ticks.forEach((fn) => fn()),
    orphan: () => {
      ppid = 1;
    },
  };
}

describe('isForkPoolWorker', () => {
  it('accepts a fork-pool worker on its own main thread', () => {
    expect(isForkPoolWorker('node (vitest 7)', true)).toBe(true);
    expect(isForkPoolWorker('node (vitest 12)', true)).toBe(true);
  });

  it('rejects the vitest root — it is titled without an index', () => {
    expect(isForkPoolWorker('node (vitest)', true)).toBe(false);
  });

  it('rejects a threads-pool worker, which shares the root process ppid', () => {
    expect(isForkPoolWorker('node (vitest 7)', false)).toBe(false);
  });

  it('rejects unrelated processes', () => {
    expect(isForkPoolWorker('node', true)).toBe(false);
    expect(isForkPoolWorker('/usr/bin/node ./server.js', true)).toBe(false);
    expect(isForkPoolWorker('', true)).toBe(false);
  });
});

describe('startOrphanWatchdog', () => {
  it('does not arm for a vitest root, even one detached to ppid 1', () => {
    // The nohup case: `nohup pnpm test:unit &` reparents the ROOT. Arming here
    // would kill a perfectly healthy run on its first poll.
    const h = harness({ title: 'node (vitest)', ppid: 1 });
    expect(h.armed).toBe(false);
    expect(h.disarm).toBeUndefined();
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('does not arm for a threads-pool worker whose root was detached', () => {
    const h = harness({ mainThread: false, ppid: 1 });
    expect(h.armed).toBe(false);
    expect(h.exit).not.toHaveBeenCalled();
  });

  it('leaves a healthy worker alone across polls', () => {
    const h = harness({ ppid: 4242 });
    expect(h.armed).toBe(true);
    h.tick();
    h.tick();
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('exits when the root dies mid-run', () => {
    const h = harness({ ppid: 4242 });
    h.tick();
    expect(h.exit).not.toHaveBeenCalled();

    h.orphan();
    h.tick();

    expect(h.exit).toHaveBeenCalledWith(0);
    expect(h.cancel).toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('orphaned'));
  });

  it('exits immediately when already orphaned at arm time, without waiting a poll', () => {
    const h = harness({ ppid: 1 });
    expect(h.exit).toHaveBeenCalledWith(0);
    // No timer should be left behind for a process that is already exiting.
    expect(h.disarm).toBeUndefined();
  });

  it('unrefs its timer so a healthy worker is never held open by the watchdog', () => {
    const unref = vi.fn();
    startOrphanWatchdog({
      title: 'node (vitest 3)',
      mainThread: true,
      getPpid: () => 4242,
      exit: vi.fn(),
      cancel: vi.fn(),
      warn: vi.fn(),
      schedule: () => ({ unref }),
    });
    expect(unref).toHaveBeenCalled();
  });

  it('polls on a seconds-scale interval', () => {
    const schedule = vi.fn(() => ({ unref: vi.fn() }));
    startOrphanWatchdog({
      title: 'node (vitest 3)',
      mainThread: true,
      getPpid: () => 4242,
      exit: vi.fn(),
      cancel: vi.fn(),
      warn: vi.fn(),
      schedule,
    });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), ORPHAN_POLL_INTERVAL_MS);
    expect(ORPHAN_POLL_INTERVAL_MS).toBeLessThanOrEqual(10_000);
  });

  it('disarms on request', () => {
    const h = harness({ ppid: 4242 });
    h.disarm?.();
    expect(h.cancel).toHaveBeenCalled();
  });
});
