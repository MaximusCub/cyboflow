/**
 * processTable unit tests — the shared (pid, ppid) table helpers and the
 * Windows tree-kill primitive the kill ladders consume.
 *
 * parseProcessTable/collectDescendantPids moved here from
 * terminalSessionManager (whose suite still covers them through its
 * re-exports); this file pins the moved implementations directly, the
 * synchronous table fetch against the REAL host process table, and — on win32
 * hosts — killWindowsTree reaping a real parent+grandchild tree.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import {
  parseProcessTable,
  collectDescendantPids,
  listPidPpidTableSync,
  killWindowsTree,
  type ProcessTableRow,
} from './processTable';

/** Signal-0 liveness probe (mirrors the production EPERM semantics). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('parseProcessTable', () => {
  it('parses "pid ppid" rows, skipping blanks and malformed lines', () => {
    const out = ['  1   0', ' 320   1', '', 'garbage', '0 5', '  99   1  '].join('\n');
    expect(parseProcessTable(out)).toEqual([
      { pid: 1, ppid: 0 },
      { pid: 320, ppid: 1 },
      { pid: 99, ppid: 1 },
    ]);
  });
});

describe('collectDescendantPids', () => {
  it('walks the ppid tree and collects every descendant, excluding the root', () => {
    const procs: ProcessTableRow[] = [
      { pid: 500, ppid: 1 },
      { pid: 501, ppid: 500 },
      { pid: 502, ppid: 501 },
      { pid: 503, ppid: 502 },
      { pid: 999, ppid: 1 },
    ];
    expect(collectDescendantPids(500, procs).sort((a, b) => a - b)).toEqual([501, 502, 503]);
  });

  it('is cycle-safe and never traverses or includes pid<=1', () => {
    expect(collectDescendantPids(10, [{ pid: 10, ppid: 11 }, { pid: 11, ppid: 10 }])).toEqual([11]);
    expect(collectDescendantPids(1, [{ pid: 1, ppid: 0 }, { pid: 10, ppid: 1 }])).toEqual([]);
  });
});

describe('listPidPpidTableSync', () => {
  it('round-trips a real spawned child into the (pid, ppid) table on this host', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      detached: true,
    });
    try {
      expect(child.pid).toBeTypeOf('number');
      const seen = await waitUntil(
        () => listPidPpidTableSync().some((row) => row.pid === child.pid && row.ppid === process.pid),
        5000,
      );
      expect(seen).toBe(true);
    } finally {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    }
  }, 10000);
});

describe('killWindowsTree', () => {
  // 99999999 is far beyond any real Windows pid; on POSIX hosts taskkill does
  // not exist at all. Either way the failure must be swallowed, not thrown.
  it('swallows a failed kill (already-dead pid / missing taskkill)', () => {
    expect(() => killWindowsTree(99999999)).not.toThrow();
  });

  it.skipIf(process.platform !== 'win32')('reaps a real spawned parent+grandchild tree on win32', async () => {
    // A node child that spawns its own long-lived detached grandchild — the
    // shape a CLI/app-server presents. taskkill /T /F must take BOTH.
    const child = spawn(
      process.execPath,
      ['-e', "require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' }).unref(); setInterval(()=>{},1000);"],
      { stdio: 'ignore', detached: true },
    );
    const pid = child.pid;
    expect(pid).toBeTypeOf('number');

    // Positive control: the grandchild really shows up in the shared table.
    let grandkids: number[] = [];
    for (let i = 0; i < 15 && grandkids.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 200));
      grandkids = collectDescendantPids(pid as number, listPidPpidTableSync());
    }
    expect(grandkids.length).toBeGreaterThanOrEqual(1);

    killWindowsTree(pid as number);

    const allDead = await waitUntil(
      () => !isAlive(pid as number) && grandkids.every((g) => !isAlive(g)),
      8000,
    );
    expect(allDead).toBe(true);
  }, 30000);
});
