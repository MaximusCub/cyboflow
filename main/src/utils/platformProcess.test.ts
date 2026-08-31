/**
 * platformProcess — killTree's POSIX option surface + killTreeImmediate.
 *
 * Fully hermetic: every seam (execCommand / sendSignal / isPidAlive /
 * descendantPids / listDescendants) is injected, so no real `ps`/`kill`/`exec`
 * ever runs. Pins the three POSIX group-resolution shapes by their exact
 * command strings and signal order — the contract each call site's ladder was
 * moved under byte-identically:
 *  - 'lookup' (default): terminalSessionManager's shape — SIGTERM, then the
 *    `ps -o pgid=` lookup, group kills by the resolved pgid, dual-probe poll.
 *  - 'root': AbstractCliManager / sessionManager — NO lookup, the root pid IS
 *    the group id, fixed (non-probed) grace.
 *  - 'enumerate': runCommandManager — pgid resolved BEFORE any signal, group
 *    members the tree walk missed swept into the per-descendant kills.
 */
import { describe, it, expect, vi } from 'vitest';
import { killTree, killTreeImmediate } from './platformProcess';

type ExecSpy = ReturnType<typeof vi.fn<(command: string) => Promise<{ stdout: string }>>>;

/** Hermetic option defaults: no real enumeration, no real signals. */
function baseOpts() {
  return {
    platform: 'linux' as const,
    descendantPids: [] as number[],
    listDescendants: () => Promise.resolve([] as number[]),
    sendSignal: vi.fn<(pid: number, signal: NodeJS.Signals) => void>(),
    isPidAlive: vi.fn<(pid: number) => boolean>(() => false),
  };
}

describe('killTree POSIX — group resolution shapes', () => {
  it("default 'lookup': SIGTERM, pgid lookup, group kills by pgid, dual-probe poll", async () => {
    const opts = { ...baseOpts(), descendantPids: [5001] };
    const execCommand: ExecSpy = vi.fn(() => Promise.resolve({ stdout: '' }));
    // Poll cadence: the pid is alive through the first probe pair, then gone.
    let probes = 0;
    opts.isPidAlive = vi.fn(() => {
      probes += 1;
      return probes <= 2;
    });

    await killTree(4242, {
      ...opts,
      execCommand,
      graceMs: 1000,
      pollIntervalMs: 5,
    });

    // Lookup ran (terminalSessionManager's echo-suffix shape) and, returning
    // nothing, the root pid stood in for the group id in both group kills.
    expect(execCommand).toHaveBeenCalledWith('ps -o pgid= -p 4242 2>/dev/null || echo ""');
    expect(execCommand).toHaveBeenCalledWith('kill -TERM -4242');
    expect(execCommand).toHaveBeenCalledWith('kill -9 -4242');
    // The enumerated descendant was killed individually, then the pkill sweep.
    expect(execCommand).toHaveBeenCalledWith('kill -9 5001');
    expect(execCommand).toHaveBeenCalledWith('pkill -9 -P 4242');
    // Both root and group were probed (dual probe), SIGTERM then SIGKILL.
    expect(opts.sendSignal).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(opts.sendSignal).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(probes).toBeGreaterThanOrEqual(2);
    expect(probes).toBeLessThanOrEqual(4);
  });

  it("'root': no pgid lookup — the root pid IS the group id, and the fixed grace never probes", async () => {
    const opts = { ...baseOpts() };
    const execCommand: ExecSpy = vi.fn(() => Promise.resolve({ stdout: '' }));
    const start = Date.now();

    await killTree(4242, {
      ...opts,
      execCommand,
      graceMode: 'fixed',
      graceMs: 40,
      posixGroupMode: 'root',
    });

    // No lookup in either position (post-SIGTERM or pre-signal).
    const lookupCalls = execCommand.mock.calls.filter(([cmd]) => cmd.startsWith('ps -o pgid='));
    expect(lookupCalls).toEqual([]);
    expect(execCommand).toHaveBeenCalledWith('kill -TERM -4242');
    expect(execCommand).toHaveBeenCalledWith('kill -9 -4242');
    // Fixed grace: the window was genuinely slept out, unprobed.
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    expect(opts.isPidAlive).not.toHaveBeenCalled();
    expect(opts.sendSignal).toHaveBeenCalledWith(4242, 'SIGTERM');
    expect(opts.sendSignal).toHaveBeenCalledWith(4242, 'SIGKILL');
  });

  it("'enumerate': resolves the pgid BEFORE any signal and sweeps group members into the kill list", async () => {
    const events: string[] = [];
    const opts = { ...baseOpts(), descendantPids: [5001] };
    opts.sendSignal = vi.fn((_pid, signal) => {
      events.push(`signal:${signal}`);
    });
    const execCommand: ExecSpy = vi.fn((command: string) => {
      events.push(`exec:${command}`);
      // The real pgid differs from the root pid, and its members include the
      // root (filtered), an already-enumerated descendant (filtered), and one
      // newcomer (5002) that must join the per-descendant kill list.
      if (command === 'ps -o pgid= -p 4242') return Promise.resolve({ stdout: ' 4100\n' });
      if (command.startsWith('ps -o pid= -g 4100')) {
        return Promise.resolve({ stdout: '5001\n4242\n5002\n' });
      }
      return Promise.resolve({ stdout: '' });
    });

    await killTree(4242, {
      ...opts,
      execCommand,
      graceMode: 'fixed',
      graceMs: 10,
      posixGroupMode: 'enumerate',
    });

    // pgid resolution happened before the first signal flew.
    const lookupIndex = events.findIndex(e => e === 'exec:ps -o pgid= -p 4242');
    const firstSignalIndex = events.findIndex(e => e.startsWith('signal:'));
    expect(lookupIndex).toBeGreaterThanOrEqual(0);
    expect(firstSignalIndex).toBeGreaterThan(lookupIndex);

    // Group kills target the RESOLVED pgid; the newcomer joined the
    // per-descendant kills; the bare lookup shape (no echo suffix) ran.
    expect(execCommand).toHaveBeenCalledWith('kill -TERM -4100');
    expect(execCommand).toHaveBeenCalledWith('kill -9 -4100');
    expect(execCommand).toHaveBeenCalledWith('kill -9 5002');
    const bareLookups = execCommand.mock.calls.filter(([cmd]) => cmd === 'ps -o pgid= -p 4242');
    expect(bareLookups).toHaveLength(1);
  });

  it('never mutates a caller-provided descendant array (enumerate mode appends to a copy)', async () => {
    const descendantPids = [5001];
    const execCommand: ExecSpy = vi.fn((command: string) => {
      if (command === 'ps -o pgid= -p 4242') return Promise.resolve({ stdout: ' 4100\n' });
      if (command.startsWith('ps -o pid= -g 4100')) return Promise.resolve({ stdout: '5002\n' });
      return Promise.resolve({ stdout: '' });
    });

    await killTree(4242, {
      platform: 'linux',
      descendantPids,
      execCommand,
      graceMode: 'fixed',
      graceMs: 10,
      listDescendants: () => Promise.resolve([]),
    });

    expect(descendantPids).toEqual([5001]);
  });
});

describe('killTreeImmediate', () => {
  it('SIGKILLs the root and every enumerated descendant, then runs the shell sweep', async () => {
    const sendSignal = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
    const execCommand: ExecSpy = vi.fn(() => Promise.resolve({ stdout: '' }));

    await killTreeImmediate(4242, {
      platform: 'linux',
      descendantPids: [5001, 5002],
      sendSignal,
      execCommand,
    });

    expect(sendSignal).toHaveBeenCalledTimes(3);
    expect(sendSignal).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(sendSignal).toHaveBeenCalledWith(5001, 'SIGKILL');
    expect(sendSignal).toHaveBeenCalledWith(5002, 'SIGKILL');
    expect(execCommand).toHaveBeenCalledWith(
      'kill -9 4242 5001 5002 2>/dev/null; pkill -9 -P 4242 2>/dev/null',
    );
  });

  it('is fail-soft: dead pids and a failing sweep never throw', async () => {
    const sendSignal = vi.fn<(pid: number, signal: NodeJS.Signals) => void>((pid) => {
      if (pid === 5001) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const execCommand: ExecSpy = vi.fn(() => Promise.reject(new Error('pkill matched nothing')));
    const onError = vi.fn();

    await expect(
      killTreeImmediate(4242, {
        platform: 'linux',
        descendantPids: [5001],
        sendSignal,
        execCommand,
        onError,
      }),
    ).resolves.toBeUndefined();

    // The sweep failure is ignored by contract — not surfaced through onError.
    expect(onError).not.toHaveBeenCalled();
  });
});
