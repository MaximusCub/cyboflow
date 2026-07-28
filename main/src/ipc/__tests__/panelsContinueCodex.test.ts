/**
 * panels:continue — codex-sdk quick-session parity branch.
 *
 * Codex-sdk quick sessions ride the same 'claude'-typed panel but run on the
 * Codex app-server. Before this branch, a codex continue routed through the
 * session-scoped sessions:input, which HARD-REJECTED a mid-turn send ("Codex is
 * still processing the previous message.") — surfacing a FAILED row. panels:continue
 * now gives codex the SAME affordances Claude gets:
 *
 *  - mid-turn (running, no interrupt) → buffer into the codex panel-input queue
 *    and return { queued: true } (the composer flips its optimistic row to
 *    'queued' instead of failing);
 *  - Interrupt & send (running + interrupt) → stopPanel (abort the app-server
 *    turn) then enqueue — the abort's 'exit' flushes the queue as a fresh turn;
 *  - idle → start the turn now.
 *
 * These pin the two guard paths (queue + interrupt); the idle path funnels into
 * startCodexSdkTurn (covered via the sessions:input path) and is not re-exercised
 * here to avoid its heavy app-server spawn deps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: { getSession: vi.fn(() => undefined) },
}));

vi.mock('../../orchestrator/agentInvocationStore', () => ({
  AgentInvocationStore: class {
    getLatestTopLevelResumeTarget() {
      return undefined;
    }
    /** Per-panel resume identity (083) — no prior thread for these fixtures. */
    getLatestPanelResumeTarget() {
      return null;
    }
  },
}));

// Always-valid panel/session so the handler reaches the codex branch.
vi.mock('../../utils/sessionValidation', () => ({
  validateSessionExists: vi.fn(() => ({ valid: true })),
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  validatePanelExists: vi.fn((panelId: string) => ({ valid: true, panelId, sessionId: 's1' })),
  validateSessionIsActive: vi.fn(() => ({ valid: true, sessionId: 's1' })),
  logValidationFailure: vi.fn(),
  createValidationError: vi.fn(() => ({ success: false, error: 'invalid' })),
}));

import { registerSessionHandlers } from '../session';
import type { AppServices } from '../types';
import { panelManager } from '../../services/panelManager';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

const CODEX_PANEL = { id: 'panel-1', sessionId: 's1', type: 'claude' } as never;

type CodexHandler = (payload: { panelId?: string; sessionId?: string; exitCode?: number }) => void;

function makeServices(over: { isPanelRunning: boolean }) {
  // Mutable so a test can flip the panel idle (as the real 'exit' does) and then
  // drive the queue flush.
  const state = { running: over.isPanelRunning };
  const isPanelRunning = vi.fn(() => state.running);
  const stopPanel = vi.fn(async () => {});
  const spawnCliProcess = vi.fn(async (_options: Record<string, unknown>) => {});
  const codexHandlers = new Map<string, CodexHandler>();
  const services = {
    sessionManager: {
      getDbSession: vi.fn(() => ({ id: 's1', agent_runtime: 'codex-sdk' })),
      getSession: vi.fn(async () => ({ id: 's1', worktreePath: '/wt/s1' })),
      addPanelConversationMessage: vi.fn(),
      updateSession: vi.fn(async () => {}),
      on: vi.fn(),
      emit: vi.fn(),
    },
    databaseService: {
      getSession: vi.fn(() => ({ id: 's1', agent_runtime: 'codex-sdk', chat_run_id: 'quick-run-1' })),
      getPanelSettings: vi.fn(() => ({})),
      getDb: vi.fn(() => ({})),
    },
    claudeCodeManager: { on: vi.fn(), setPanelInputDeliverer: vi.fn() },
    codexSdkManager: {
      on: vi.fn((evt: string, fn: CodexHandler) => codexHandlers.set(evt, fn)),
      isPanelRunning,
      stopPanel,
      spawnCliProcess,
    },
    // Full PTY surface: panels:continue now routes the codex-pty lane through
    // relayOrSpawnPtyPanel, which drives these directly off `services`.
    codexPtyManager: {
      on: vi.fn(),
      isPanelRunning: vi.fn(() => false),
      relayUserTurn: vi.fn(),
      startPanel: vi.fn(async () => {}),
    },
    interactiveCliManager: {
      isPanelRunning: vi.fn(() => false),
      relayUserTurn: vi.fn(),
      startPanel: vi.fn(async () => {}),
    },
    registerLivePanel: vi.fn(),
    registerCodexPtyPanel: vi.fn(),
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices;
  return { services, isPanelRunning, stopPanel, spawnCliProcess, codexHandlers, state };
}

/** Let the flush's setImmediate (and startCodexSdkTurn's awaits) settle. */
function flushImmediates(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => resolve())));
}

function register(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0], services);
  return handlers;
}

describe('panels:continue — codex-sdk parity branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanel).mockReturnValue(CODEX_PANEL);
  });

  it('mid-turn (running, no interrupt) queues instead of hard-rejecting, returning queued', async () => {
    const { services, stopPanel, spawnCliProcess } = makeServices({ isPanelRunning: true });
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'do more', undefined, false, 'pending-9')) as {
      success: boolean;
      data?: { queued?: boolean };
    };

    expect(result.success).toBe(true);
    expect(result.data?.queued).toBe(true);
    // A queued mid-turn send neither aborts the live turn nor spawns a new one.
    expect(stopPanel).not.toHaveBeenCalled();
    expect(spawnCliProcess).not.toHaveBeenCalled();

    // The queued entry is addressable by the client pending id (click-to-reopen).
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      success: boolean;
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([{ id: 'pending-9', text: 'do more' }]);
  });

  it('Interrupt & send (running + interrupt) aborts the app-server turn first, then queues for delivery', async () => {
    const { services, stopPanel, spawnCliProcess } = makeServices({ isPanelRunning: true });
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'now', undefined, true, 'pending-i')) as {
      success: boolean;
      data?: { queued?: boolean };
    };

    expect(result.success).toBe(true);
    // Not the queued response shape — interrupt drives a real (post-abort) turn.
    expect(result.data?.queued).toBeUndefined();
    expect(stopPanel).toHaveBeenCalledWith('panel-1');
    // isPanelRunning still reports true here (teardown outlives stopPanel in this
    // stub), so the flush is a no-op and delivery defers to the 'exit' handler —
    // no synchronous respawn.
    expect(spawnCliProcess).not.toHaveBeenCalled();

    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([{ id: 'pending-i', text: 'now' }]);
  });
});

/**
 * Lane routing at panels:continue. The handler used to test
 * `agent_runtime === 'codex-sdk'` and otherwise fall through to
 * claudePanelManager — which reaches only the two CLAUDE managers. So a Codex
 * TERMINAL panel (every panel of a codex-pty session, and an interactive
 * override on a codex-sdk one) was answered by Claude.
 */
describe('panels:continue — lane routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanel).mockReturnValue(CODEX_PANEL);
  });

  it('relays a codex-pty panel into its own terminal instead of the Claude manager', async () => {
    const { services } = makeServices({ isPanelRunning: false });
    // A Codex terminal session: the panel inherits codex-pty.
    const codexPtySession = {
      id: 's1',
      agent_runtime: 'codex-pty',
      substrate: 'interactive',
      chat_run_id: 'quick-run-1',
    };
    vi.mocked(services.databaseService.getSession).mockReturnValue(codexPtySession as never);
    vi.mocked(services.sessionManager.getDbSession).mockReturnValue(codexPtySession as never);
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'hello', undefined, false, 'p-1')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    const codexPty = services.codexPtyManager as unknown as { startPanel: ReturnType<typeof vi.fn> };
    expect(codexPty.startPanel).toHaveBeenCalledTimes(1);
    expect(codexPty.startPanel.mock.calls[0][0]).toBe('panel-1');
    expect(codexPty.startPanel.mock.calls[0][3]).toBe('hello');
  });

  it('starts a Codex SDK turn for an sdk-override panel inside a codex-pty session', async () => {
    const { services, spawnCliProcess } = makeServices({ isPanelRunning: false });
    const codexPtySession = {
      id: 's1',
      agent_runtime: 'codex-pty',
      substrate: 'interactive',
      chat_run_id: 'quick-run-1',
    };
    vi.mocked(services.databaseService.getSession).mockReturnValue(codexPtySession as never);
    vi.mocked(services.sessionManager.getDbSession).mockReturnValue(codexPtySession as never);
    // The panel overrides its session onto the SDK substrate.
    vi.mocked(panelManager.getPanel).mockReturnValue({
      id: 'panel-1',
      sessionId: 's1',
      type: 'claude',
      substrate: 'sdk',
    } as never);
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'hello', undefined, false, 'p-2')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    // The app-server, not the Codex terminal it would have inherited.
    expect(spawnCliProcess).toHaveBeenCalledTimes(1);
    expect(spawnCliProcess.mock.calls[0][0]).toMatchObject({ panelId: 'panel-1', prompt: 'hello' });
    const codexPty = services.codexPtyManager as unknown as { startPanel: ReturnType<typeof vi.fn> };
    expect(codexPty.startPanel).not.toHaveBeenCalled();
  });
});

describe('codex queued-input delivery at the rest boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanel).mockReturnValue(CODEX_PANEL);
  });

  it('defers delivery off the exit stack so the spawn-key reservation can clear', async () => {
    const { services, spawnCliProcess, codexHandlers, state } = makeServices({ isPanelRunning: true });
    const handlers = register(services);

    await invoke(handlers, 'panels:continue', 'panel-1', 'do more', undefined, false, 'pending-9');
    expect(spawnCliProcess).not.toHaveBeenCalled();

    // The turn ends: processes are dropped BEFORE 'exit' is emitted, so the panel
    // reads idle — but the emit still runs inside spawnCliProcess's try block.
    state.running = false;
    codexHandlers.get('exit')?.({ panelId: 'panel-1', sessionId: 's1', exitCode: 0 });
    // Nothing spawned synchronously — that would throw "already running".
    expect(spawnCliProcess).not.toHaveBeenCalled();

    await flushImmediates();
    expect(spawnCliProcess).toHaveBeenCalledTimes(1);
    expect(spawnCliProcess.mock.calls[0][0]).toMatchObject({ panelId: 'panel-1', prompt: 'do more' });

    // Delivered — the queue is drained.
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([]);
  });

  it('re-queues (never drops) the message when delivery fails', async () => {
    const { services, spawnCliProcess, codexHandlers, state } = makeServices({ isPanelRunning: true });
    spawnCliProcess.mockRejectedValueOnce(new Error('Codex app-server process already running for spawn panel-1'));
    const handlers = register(services);

    await invoke(handlers, 'panels:continue', 'panel-1', 'keep me', undefined, false, 'pending-k');

    state.running = false;
    codexHandlers.get('exit')?.({ panelId: 'panel-1', sessionId: 's1', exitCode: 0 });
    await flushImmediates();

    expect(spawnCliProcess).toHaveBeenCalledTimes(1);
    // The user's message survives the failure and stays addressable.
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([{ id: 'pending-k', text: 'keep me' }]);
  });

  it('hands the message back when a new turn started on the deferred tick', async () => {
    const { services, spawnCliProcess, codexHandlers, state } = makeServices({ isPanelRunning: true });
    const handlers = register(services);

    await invoke(handlers, 'panels:continue', 'panel-1', 'later', undefined, false, 'pending-l');

    state.running = false;
    codexHandlers.get('exit')?.({ panelId: 'panel-1', sessionId: 's1', exitCode: 0 });
    // A fresh turn claims the panel before the deferred delivery runs.
    state.running = true;
    await flushImmediates();

    expect(spawnCliProcess).not.toHaveBeenCalled();
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([{ id: 'pending-l', text: 'later' }]);
  });
});
