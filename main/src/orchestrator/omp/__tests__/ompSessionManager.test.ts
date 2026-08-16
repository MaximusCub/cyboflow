/**
 * Tests for `OmpSessionManager` (OMP Phase 4, increment 3) — the sibling
 * manager beside the four `AbstractCliManager` managers.
 *
 * Verifies the ADR chat-lifecycle mapping: spawn → `fleet_spawn` (worker id
 * stored on the panel), sendInput → `fleet_send`, output → polled
 * `fleet_read` with sliding-window dedup, liveness → `fleet_state` with
 * terminal detection matching the producer's `isTerminalStatus`, stop →
 * `fleet_kill`. The adapter is a fake `OmpCommandAdapter`; no bridge is
 * reached, and timers are driven by explicit `tick()` calls (plus fake
 * timers where the interval itself is under test).
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  OmpApplyRequest,
  OmpCommandAdapter,
  OmpCommandResult,
  OmpDiscardRequest,
  OmpKillRequest,
  OmpReadRequest,
  OmpSendRequest,
  OmpSpawnRequest,
  OmpStateRequest,
  OmpVerifyRequest,
} from '../../../../../shared/types/ompCommand';
import {
  newOutputSince,
  OmpSessionManager,
  type OmpExitEvent,
  type OmpOutputEvent,
  type OmpSpawnedEvent,
} from '../ompSessionManager';

const okResult = (detail: string): OmpCommandResult => ({
  ok: true,
  operationId: 'op',
  detail,
});

const failResult = (detail: string): OmpCommandResult => ({
  ok: false,
  operationId: 'op',
  error: 'unavailable',
  detail,
});

type FakeOverride = (req: unknown) => OmpCommandResult | Promise<OmpCommandResult>;

function makeManager(overrides: Partial<Record<'spawn' | 'kill' | 'send' | 'read' | 'state', FakeOverride>> = {}) {
  const spawn = vi.fn(async (_req: OmpSpawnRequest): Promise<OmpCommandResult> => okResult('worker=w1 pane=p1 model=m [pane]'));
  const kill = vi.fn(async (_req: OmpKillRequest): Promise<OmpCommandResult> => okResult('killed'));
  const send = vi.fn(async (_req: OmpSendRequest): Promise<OmpCommandResult> => okResult('Sent to p1.'));
  const read = vi.fn(async (_req: OmpReadRequest): Promise<OmpCommandResult> => okResult('(empty)'));
  const state = vi.fn(async (_req: OmpStateRequest): Promise<OmpCommandResult> => okResult('w1 backend=pane pane=p1 model=m state=working'));

  const adapter: OmpCommandAdapter = {
    authority: 'supervise',
    spawn: (req: OmpSpawnRequest) => spawn(req),
    kill: (req: OmpKillRequest) => kill(req),
    send: (req: OmpSendRequest) => send(req),
    read: (req: OmpReadRequest) => read(req),
    state: (req: OmpStateRequest) => state(req),
    apply: (req: OmpApplyRequest) => Promise.resolve(failResult(`apply unused: ${req.proposalId}`)),
    discard: (req: OmpDiscardRequest) => Promise.resolve(failResult(`discard unused: ${req.proposalId}`)),
    verifyRun: (req: OmpVerifyRequest) => Promise.resolve(failResult(`verify unused: ${req.proposalId}`)),
  };

  const manager = new OmpSessionManager(
    { ...adapter, ...overrides } as unknown as OmpCommandAdapter,
    undefined,
    { pollMs: 60_000 }, // never fires in tests unless timers are advanced
  );
  return { manager, adapter, spawn, kill, send, read, state };
}

const collect = <T>(emitter: OmpSessionManager, event: string): T[] => {
  const seen: T[] = [];
  emitter.on(event, (payload: T) => {
    seen.push(payload);
  });
  return seen;
};

describe('OmpSessionManager — spawn', () => {
  it('spawns via fleet_spawn, stores the worker id, and emits spawned', async () => {
    const { manager, spawn } = makeManager();
    const spawned = collect<OmpSpawnedEvent>(manager, 'spawned');

    await manager.spawn('panel-1', 'session-1', 'do the thing', { model: 'zai/glm-5.2:high', workspace: 'ws-1', cwd: '/tmp/r' });

    expect(spawn).toHaveBeenCalledWith({
      model: 'zai/glm-5.2:high',
      task: 'do the thing',
      label: undefined,
      workspace: 'ws-1',
      cwd: '/tmp/r',
      operationId: expect.any(String),
    });
    expect(spawned).toEqual([{ panelId: 'panel-1', sessionId: 'session-1' }]);
    expect(manager.isPanelRunning('panel-1')).toBe(true);
    expect(manager.panelCount).toBe(1);
  });

  it('emits exit (not spawned) when fleet_spawn fails — fail-closed, nothing tracked', async () => {
    const { manager } = makeManager({
      spawn: async () => failResult('bridge offline'),
    });
    const spawned = collect<OmpSpawnedEvent>(manager, 'spawned');
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.spawn('panel-1', 'session-1', 'prompt', { model: 'm' });

    expect(spawned).toEqual([]);
    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode: 1, signal: null }]);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
    expect(manager.panelCount).toBe(0);
  });

  it('emits exit when the spawn detail carries no parseable worker id', async () => {
    const { manager } = makeManager({
      spawn: async () => okResult('unexpected detail without a worker token'),
    });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.spawn('panel-1', 'session-1', 'prompt', { model: 'm' });

    expect(exits).toHaveLength(1);
    expect(exits[0].exitCode).toBe(1);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('rejects an empty prompt and an empty model', async () => {
    const { manager } = makeManager();
    await expect(manager.spawn('panel-1', 'session-1', '   ', { model: 'm' })).rejects.toThrow(TypeError);
    await expect(manager.spawn('panel-1', 'session-1', 'prompt', { model: '' })).rejects.toThrow(TypeError);
  });

  it('rejects a double spawn of the same panel', async () => {
    const { manager } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    await expect(manager.spawn('panel-1', 'session-1', 'second', { model: 'm' })).rejects.toThrow(/already spawned/);
  });
});

describe('OmpSessionManager — sendInput', () => {
  it('forwards to fleet_send with the stored worker id', async () => {
    const { manager, send } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });

    const handed = await manager.sendInput('panel-1', 'follow up');

    expect(handed).toBe(true);
    expect(send).toHaveBeenCalledWith({
      workerId: 'w1',
      text: 'follow up',
      operationId: expect.any(String),
      keys: undefined,
    });
  });

  it('returns false for an unknown panel (spawn needed instead)', async () => {
    const { manager, send } = makeManager();
    const handed = await manager.sendInput('ghost', 'hi');
    expect(handed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('emits an error event when fleet_send fails, but the panel stays live', async () => {
    const { manager } = makeManager({
      send: async () => failResult('pane gone'),
    });
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const errors = collect<{ error: string }>(manager, 'error');

    const handed = await manager.sendInput('panel-1', 'follow up');

    expect(handed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('fleet_send failed');
    expect(manager.isPanelRunning('panel-1')).toBe(true);
  });
});

describe('OmpSessionManager — output polling (fleet_read)', () => {
  it('emits only the new output since the last read', async () => {
    const { manager, read } = makeManager();
    let transcript = 'line 1\n';
    read.mockImplementation(async () => okResult(transcript));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const outputs = collect<OmpOutputEvent>(manager, 'output');

    await manager.tick('panel-1');
    expect(outputs.map((e) => e.data)).toEqual(['line 1\n']);

    transcript = 'line 1\nline 2\n';
    await manager.tick('panel-1');
    expect(outputs.map((e) => e.data)).toEqual(['line 1\n', 'line 2\n']);

    // Unchanged window ⇒ no event.
    await manager.tick('panel-1');
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ panelId: 'panel-1', sessionId: 'session-1', type: 'stdout' });
    expect(outputs[0].timestamp).toBeInstanceOf(Date);
  });

  it('emits only the non-overlapping tail when the recent window slid', async () => {
    const { manager, read } = makeManager();
    read.mockImplementationOnce(async () => okResult('AAAA\nBBBB\n'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const outputs = collect<OmpOutputEvent>(manager, 'output');

    await manager.tick('panel-1');
    read.mockImplementationOnce(async () => okResult('BBBB\nCCCC\n'));
    await manager.tick('panel-1');
    read.mockImplementationOnce(async () => okResult('CCCC\nDDDD\n'));
    await manager.tick('panel-1');

    expect(outputs.map((e) => e.data)).toEqual(['AAAA\nBBBB\n', 'CCCC\n', 'DDDD\n']);
  });

  it('treats the producer "(empty)" rendering as an empty read', async () => {
    const { manager, read } = makeManager();
    read.mockImplementationOnce(async () => okResult('(empty)'));
    read.mockImplementationOnce(async () => okResult('hello'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const outputs = collect<OmpOutputEvent>(manager, 'output');

    await manager.tick('panel-1');
    expect(outputs).toEqual([]);
    await manager.tick('panel-1');
    expect(outputs.map((e) => e.data)).toEqual(['hello']);
  });

  it('surfaces a failed fleet_read as an error event but keeps the panel alive', async () => {
    const { manager, read } = makeManager({
      read: async () => failResult('herdr offline'),
    });
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const errors = collect<{ error: string }>(manager, 'error');

    await manager.tick('panel-1');

    expect(errors).toHaveLength(1);
    expect(errors[0].error).toContain('fleet_read failed');
    expect(manager.isPanelRunning('panel-1')).toBe(true);
  });
});

describe('OmpSessionManager — liveness and exit (fleet_state)', () => {
  it('does not exit while the worker is working or idle', async () => {
    for (const stateText of ['state=working', 'state=idle']) {
      const { manager, state } = makeManager();
      state.mockImplementation(async () => okResult(`w1 backend=pane pane=p1 model=m ${stateText}`));
      await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
      const exits = collect<OmpExitEvent>(manager, 'exit');

      await manager.tick('panel-1');

      expect(exits).toEqual([]);
      expect(manager.isPanelRunning('panel-1')).toBe(true);
    }
  });

  it.each([
    ['state=done', 0],
    ['state=failed', 1],
    ['state=dead', 1],
    ['state=evicted', 1],
  ])('exits with the right code when the worker is %s', async (stateText, exitCode) => {
    const { manager, state } = makeManager();
    state.mockImplementation(async () => okResult(`w1 backend=pane pane=p1 model=m ${stateText}`));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.tick('panel-1');

    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode, signal: null }]);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('treats a vanished worker as terminal (evicted)', async () => {
    const { manager, state } = makeManager();
    state.mockImplementation(async () => okResult('w1 backend=pane pane=- model=m state=working [not found]'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.tick('panel-1');

    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode: 1, signal: null }]);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('stops polling once terminal', async () => {
    const { manager, state, read } = makeManager();
    state.mockImplementation(async () => okResult('w1 backend=pane pane=p1 model=m state=done'));
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });

    await manager.tick('panel-1');
    expect(state).toHaveBeenCalledTimes(1);

    await manager.tick('panel-1');
    await manager.tick('panel-1');
    expect(state).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('OmpSessionManager — stop', () => {
  it('kills the worker and emits exit exactly once', async () => {
    const { manager, kill } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.stopPanel('panel-1');

    expect(kill).toHaveBeenCalledWith({ workerId: 'w1', operationId: expect.any(String), timeoutMs: undefined });
    expect(exits).toEqual([{ panelId: 'panel-1', sessionId: 'session-1', exitCode: null, signal: null }]);
    expect(manager.isPanelRunning('panel-1')).toBe(false);

    // Idempotent: a second stop is a no-op.
    await manager.stopPanel('panel-1');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(exits).toHaveLength(1);
  });

  it('still emits exit when fleet_kill fails (terminating locally)', async () => {
    const { manager } = makeManager({
      kill: async () => failResult('herdr offline'),
    });
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    const exits = collect<OmpExitEvent>(manager, 'exit');

    await manager.stopPanel('panel-1');

    expect(exits).toHaveLength(1);
    expect(manager.isPanelRunning('panel-1')).toBe(false);
  });

  it('sendInput after stop returns false (no live worker)', async () => {
    const { manager, send } = makeManager();
    await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });
    await manager.stopPanel('panel-1');

    const handed = await manager.sendInput('panel-1', 'too late');

    expect(handed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('OmpSessionManager — polling interval', () => {
  it('ticks live panels on the configured interval and stops after terminal', async () => {
    vi.useFakeTimers();
    try {
      const { manager, state } = makeManager();
      state.mockImplementation(async () => okResult('w1 backend=pane pane=p1 model=m state=working'));
      await manager.spawn('panel-1', 'session-1', 'first', { model: 'm' });

      await vi.advanceTimersByTimeAsync(160_000); // 60_000 pollMs → 2 ticks
      expect(state).toHaveBeenCalledTimes(2);

      state.mockImplementation(async () => okResult('w1 backend=pane pane=p1 model=m state=done'));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(600_000);
      expect(state).toHaveBeenCalledTimes(3); // terminal ⇒ polling stopped
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('newOutputSince', () => {
  it('returns empty for an unchanged or empty window', () => {
    expect(newOutputSince('abc', 'abc')).toBe('');
    expect(newOutputSince('abc', '')).toBe('');
    expect(newOutputSince('', 'abc')).toBe('abc');
  });

  it('returns the delta for a strict extension', () => {
    expect(newOutputSince('line 1\n', 'line 1\nline 2\n')).toBe('line 2\n');
  });

  it('returns the non-overlapping tail for a slid window', () => {
    expect(newOutputSince('AA\nBB\n', 'BB\nCC\n')).toBe('CC\n');
  });

  it('falls back to the whole window when nothing overlaps', () => {
    expect(newOutputSince('xyz\n', 'abc\n')).toBe('abc\n');
  });
});
