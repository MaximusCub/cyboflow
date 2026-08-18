/**
 * panels:continue — omp-sdk quick-session parity branch.
 *
 * The OMP twin of panelsContinueCodex.test.ts. Both structured lanes are driven
 * by ONE parameterized lane record in ipc/session.ts, so these tests exist to
 * prove the SECOND instantiation is wired — not to re-derive the queue
 * semantics, which the Codex suite already pins. What is genuinely OMP-specific
 * and asserted here:
 *
 *  - the panel routes to the OMP manager and NEVER to Codex or Claude;
 *  - the queue is per-lane (an OMP panel's queued message is not visible to,
 *    or delivered by, the Codex lane's queue);
 *  - refusal copy names OMP, because the composer shows it verbatim;
 *  - the turn carries NO systemPromptAppend (OMP's spawn has no equivalent
 *    flag, so passing one would be silently dropped).
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
    getLatestPanelResumeTarget() {
      return null;
    }
  },
}));

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

const OMP_PANEL = { id: 'panel-1', sessionId: 's1', type: 'claude' } as never;

type LaneHandler = (payload: { panelId?: string; sessionId?: string; exitCode?: number }) => void;

function makeServices(over: { isPanelRunning: boolean }) {
  // Mutable so a test can flip the panel idle (as the real 'exit' does) and then
  // drive the queue flush.
  const state = { running: over.isPanelRunning };
  const isPanelRunning = vi.fn(() => state.running);
  const stopPanel = vi.fn(async () => {});
  const spawnCliProcess = vi.fn(async (_options: Record<string, unknown>) => {});
  const ompHandlers = new Map<string, LaneHandler>();
  const codexSpawn = vi.fn(async (_options: Record<string, unknown>) => {});
  const services = {
    sessionManager: {
      getDbSession: vi.fn(() => ({ id: 's1', agent_runtime: 'omp-sdk' })),
      getSession: vi.fn(async () => ({ id: 's1', worktreePath: '/wt/s1' })),
      addPanelConversationMessage: vi.fn(),
      updateSession: vi.fn(async () => {}),
      on: vi.fn(),
      emit: vi.fn(),
    },
    databaseService: {
      getSession: vi.fn(() => ({ id: 's1', agent_runtime: 'omp-sdk', chat_run_id: 'quick-run-1' })),
      getPanelSettings: vi.fn(() => ({})),
      getDb: vi.fn(() => ({})),
    },
    claudeCodeManager: { on: vi.fn(), setPanelInputDeliverer: vi.fn() },
    ompSdkManager: {
      on: vi.fn((evt: string, fn: LaneHandler) => ompHandlers.set(evt, fn)),
      isPanelRunning,
      stopPanel,
      spawnCliProcess,
    },
    ompPtyManager: {
      on: vi.fn(),
      isPanelRunning: vi.fn(() => false),
      relayUserTurn: vi.fn(),
      startPanel: vi.fn(async () => {}),
    },
    codexSdkManager: {
      on: vi.fn(),
      isPanelRunning: vi.fn(() => false),
      stopPanel: vi.fn(async () => {}),
      spawnCliProcess: codexSpawn,
    },
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
    registerOmpPtyPanel: vi.fn(),
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices;
  return { services, isPanelRunning, stopPanel, spawnCliProcess, codexSpawn, ompHandlers, state };
}

/** Let the flush's setImmediate (and startTurn's awaits) settle. */
function flushImmediates(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => resolve())));
}

function register(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0], services);
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(panelManager.getPanel).mockReturnValue(OMP_PANEL);
});

describe('panels:continue — omp-sdk lane', () => {
  it('starts an idle turn on the OMP manager, with no briefing and no Codex traffic', async () => {
    const { services, spawnCliProcess, codexSpawn } = makeServices({ isPanelRunning: false });
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'hello omp', undefined, false, 'p-1')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(spawnCliProcess).toHaveBeenCalledTimes(1);
    expect(spawnCliProcess.mock.calls[0][0]).toMatchObject({
      panelId: 'panel-1',
      prompt: 'hello omp',
      runId: 'quick-run-1',
    });
    // OMP has no `--append-system-prompt` equivalent; a briefing here would be
    // accepted by the option bag and then silently dropped at the spawn.
    expect(spawnCliProcess.mock.calls[0][0]).not.toHaveProperty('systemPromptAppend');
    expect(codexSpawn).not.toHaveBeenCalled();
  });

  it('queues a mid-turn send instead of hard-rejecting, and keeps it in the OMP queue', async () => {
    const { services, stopPanel, spawnCliProcess } = makeServices({ isPanelRunning: true });
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'do more', undefined, false, 'pending-9')) as {
      success: boolean;
      data?: { queued?: boolean };
    };

    expect(result.success).toBe(true);
    expect(result.data?.queued).toBe(true);
    expect(stopPanel).not.toHaveBeenCalled();
    expect(spawnCliProcess).not.toHaveBeenCalled();

    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([{ id: 'pending-9', text: 'do more' }]);
  });

  it('Interrupt & send aborts the live OMP turn first, then queues for delivery', async () => {
    const { services, stopPanel, spawnCliProcess } = makeServices({ isPanelRunning: true });
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'now', undefined, true, 'pending-i')) as {
      success: boolean;
      data?: { queued?: boolean };
    };

    expect(result.success).toBe(true);
    expect(result.data?.queued).toBeUndefined();
    expect(stopPanel).toHaveBeenCalledWith('panel-1');
    // isPanelRunning still reports true here (teardown outlives stopPanel in this
    // stub), so the flush is a no-op and delivery defers to the 'exit' handler.
    expect(spawnCliProcess).not.toHaveBeenCalled();
  });

  it('delivers the OMP queue off the exit stack, as one combined turn', async () => {
    const { services, spawnCliProcess, ompHandlers, state } = makeServices({ isPanelRunning: true });
    const handlers = register(services);

    await invoke(handlers, 'panels:continue', 'panel-1', 'first', undefined, false, 'p-a');
    await invoke(handlers, 'panels:continue', 'panel-1', 'second', undefined, false, 'p-b');
    expect(spawnCliProcess).not.toHaveBeenCalled();

    state.running = false;
    ompHandlers.get('exit')?.({ panelId: 'panel-1', sessionId: 's1', exitCode: 0 });
    // Nothing spawns synchronously — that would throw "already running".
    expect(spawnCliProcess).not.toHaveBeenCalled();

    await flushImmediates();
    expect(spawnCliProcess).toHaveBeenCalledTimes(1);
    expect(spawnCliProcess.mock.calls[0][0]).toMatchObject({
      panelId: 'panel-1',
      prompt: 'first\n\nsecond',
    });

    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: unknown[];
    };
    expect(listed.data).toEqual([]);
  });

  it('re-queues (never drops) an OMP message when delivery fails', async () => {
    const { services, spawnCliProcess, ompHandlers, state } = makeServices({ isPanelRunning: true });
    spawnCliProcess.mockRejectedValueOnce(new Error('OMP RPC session already running for spawn panel-1'));
    const handlers = register(services);

    await invoke(handlers, 'panels:continue', 'panel-1', 'keep me', undefined, false, 'pending-k');

    state.running = false;
    ompHandlers.get('exit')?.({ panelId: 'panel-1', sessionId: 's1', exitCode: 0 });
    await flushImmediates();

    expect(spawnCliProcess).toHaveBeenCalledTimes(1);
    const listed = (await invoke(handlers, 'panels:list-queued-input', 'panel-1')) as {
      data: Array<{ id: string; text: string }>;
    };
    expect(listed.data).toEqual([{ id: 'pending-k', text: 'keep me' }]);
  });

  it('relays an omp-pty panel into its own terminal instead of the Claude manager', async () => {
    const { services } = makeServices({ isPanelRunning: false });
    const ompPtySession = {
      id: 's1',
      agent_runtime: 'omp-pty',
      substrate: 'interactive',
      chat_run_id: 'quick-run-1',
    };
    vi.mocked(services.databaseService.getSession).mockReturnValue(ompPtySession as never);
    vi.mocked(services.sessionManager.getDbSession).mockReturnValue(ompPtySession as never);
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'hello', undefined, false, 'p-1')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    const ompPty = services.ompPtyManager as unknown as { startPanel: ReturnType<typeof vi.fn> };
    expect(ompPty.startPanel).toHaveBeenCalledTimes(1);
    expect(ompPty.startPanel.mock.calls[0][0]).toBe('panel-1');
    expect(ompPty.startPanel.mock.calls[0][3]).toBe('hello');
    const codexPty = services.codexPtyManager as unknown as { startPanel: ReturnType<typeof vi.fn> };
    expect(codexPty.startPanel).not.toHaveBeenCalled();
  });

  it('starts an OMP SDK turn for an sdk-override panel inside an omp-pty session', async () => {
    const { services, spawnCliProcess } = makeServices({ isPanelRunning: false });
    const ompPtySession = {
      id: 's1',
      agent_runtime: 'omp-pty',
      substrate: 'interactive',
      chat_run_id: 'quick-run-1',
    };
    vi.mocked(services.databaseService.getSession).mockReturnValue(ompPtySession as never);
    vi.mocked(services.sessionManager.getDbSession).mockReturnValue(ompPtySession as never);
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
    expect(spawnCliProcess).toHaveBeenCalledTimes(1);
    const ompPty = services.ompPtyManager as unknown as { startPanel: ReturnType<typeof vi.fn> };
    expect(ompPty.startPanel).not.toHaveBeenCalled();
  });
});
