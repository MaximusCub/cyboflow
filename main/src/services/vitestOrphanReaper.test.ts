/**
 * VitestOrphanReaper unit tests.
 *
 * Driven through the injected `listProcesses`/`killPid` seams — no real `ps`, no
 * real kills. The regressions that matter: a vitest ROOT must never be reaped
 * (including a legitimately detached `nohup` one at ppid 1), a live worker must
 * never be reaped, a killed worker's own spawned children must go with it, and
 * neither a `ps` failure nor a throwing kill may abort a sweep.
 */
import { describe, it, expect, vi } from 'vitest';

import { VitestOrphanReaper, VITEST_ORPHAN_SWEEP_INTERVAL_MS } from './vitestOrphanReaper';
import type { ProcessRow } from './processTable';

/** Build a lister that returns a fixed process table. */
function fixedLister(rows: ProcessRow[]): () => Promise<ProcessRow[]> {
  return () => Promise.resolve(rows);
}

/** A healthy gate: a root plus `workers` forks parented to it. */
function healthyGate(rootPid: number, workers: number): ProcessRow[] {
  const rows: ProcessRow[] = [{ pid: rootPid, ppid: 500, command: 'node (vitest)' }];
  for (let i = 1; i <= workers; i += 1) {
    rows.push({ pid: rootPid + i, ppid: rootPid, command: `node (vitest ${i})` });
  }
  return rows;
}

/** The pair actually observed in the wild, adopted by launchd. */
const ORPHANS: ProcessRow[] = [
  { pid: 19550, ppid: 1, command: 'node (vitest 2)' },
  { pid: 19555, ppid: 1, command: 'node (vitest 7)' },
];

function reaperFor(rows: ProcessRow[]) {
  const killPid = vi.fn();
  const reaper = new VitestOrphanReaper({ listProcesses: fixedLister(rows), killPid });
  return { reaper, killPid };
}

describe('VitestOrphanReaper.sweep', () => {
  it('reaps abandoned workers', async () => {
    const { reaper, killPid } = reaperFor([...ORPHANS]);
    await expect(reaper.sweep()).resolves.toBe(2);
    expect(killPid).toHaveBeenCalledWith(19550);
    expect(killPid).toHaveBeenCalledWith(19555);
  });

  it('spares a healthy gate entirely', async () => {
    const { reaper, killPid } = reaperFor(healthyGate(1000, 4));
    await expect(reaper.sweep()).resolves.toBe(0);
    expect(killPid).not.toHaveBeenCalled();
  });

  it('reaps orphans while leaving a concurrent healthy gate untouched', async () => {
    const { reaper, killPid } = reaperFor([...healthyGate(1000, 2), ...ORPHANS]);
    await reaper.sweep();
    const killed = killPid.mock.calls.map(([pid]) => pid);
    expect(killed).toEqual(expect.arrayContaining([19550, 19555]));
    expect(killed).not.toContain(1000);
    expect(killed).not.toContain(1001);
    expect(killed).not.toContain(1002);
  });

  it('never reaps a detached ROOT — nohup reparents it legitimately', async () => {
    // `nohup pnpm test:unit &` leaves a healthy root at ppid 1. Killing it would
    // destroy a running gate.
    const { reaper, killPid } = reaperFor([
      { pid: 9000, ppid: 1, command: 'node (vitest)' },
      { pid: 9001, ppid: 9000, command: 'node (vitest 1)' },
    ]);
    await expect(reaper.sweep()).resolves.toBe(0);
    expect(killPid).not.toHaveBeenCalled();
  });

  it('takes the orphan\'s own spawned children with it', async () => {
    // A test that started a server leaves that server behind too.
    const { reaper, killPid } = reaperFor([
      { pid: 19550, ppid: 1, command: 'node (vitest 2)' },
      { pid: 19600, ppid: 19550, command: 'node ./fixtures/server.js' },
      { pid: 19601, ppid: 19600, command: 'esbuild --serve' },
    ]);
    await expect(reaper.sweep()).resolves.toBe(3);
    expect(killPid.mock.calls.map(([pid]) => pid).sort()).toEqual([19550, 19600, 19601]);
  });

  it('ignores unrelated processes', async () => {
    const { reaper, killPid } = reaperFor([
      { pid: 300, ppid: 1, command: '/usr/bin/node ./server.js' },
      { pid: 301, ppid: 1, command: 'launchd' },
      { pid: 302, ppid: 1, command: 'node' },
    ]);
    await expect(reaper.sweep()).resolves.toBe(0);
    expect(killPid).not.toHaveBeenCalled();
  });

  it('fails soft when ps fails', async () => {
    const killPid = vi.fn();
    const reaper = new VitestOrphanReaper({
      listProcesses: () => Promise.reject(new Error('ps: command not found')),
      killPid,
    });
    await expect(reaper.sweep()).resolves.toBe(0);
    expect(killPid).not.toHaveBeenCalled();
  });

  it('keeps going when one kill throws', async () => {
    const killPid = vi.fn((pid: number) => {
      if (pid === 19550) throw new Error('ESRCH');
    });
    const reaper = new VitestOrphanReaper({ listProcesses: fixedLister([...ORPHANS]), killPid });
    await expect(reaper.sweep()).resolves.toBe(1);
    expect(killPid).toHaveBeenCalledTimes(2);
  });
});

describe('VitestOrphanReaper periodic sweep', () => {
  it('sweeps on the interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const { reaper, killPid } = reaperFor([...ORPHANS]);
      reaper.start();
      expect(killPid).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(VITEST_ORPHAN_SWEEP_INTERVAL_MS);
      expect(killPid).toHaveBeenCalledTimes(2);

      reaper.stop();
      killPid.mockClear();
      await vi.advanceTimersByTimeAsync(VITEST_ORPHAN_SWEEP_INTERVAL_MS * 3);
      expect(killPid).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not stack timers when started twice', async () => {
    vi.useFakeTimers();
    try {
      const { reaper, killPid } = reaperFor([...ORPHANS]);
      reaper.start();
      reaper.start();
      await vi.advanceTimersByTimeAsync(VITEST_ORPHAN_SWEEP_INTERVAL_MS);
      // Two orphans, swept once — not twice over.
      expect(killPid).toHaveBeenCalledTimes(2);
      reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates stop() without start()', () => {
    const { reaper } = reaperFor([]);
    expect(() => reaper.stop()).not.toThrow();
  });
});
