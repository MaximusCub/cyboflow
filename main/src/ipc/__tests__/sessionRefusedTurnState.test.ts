/**
 * A refused turn must leave NO trace of a turn.
 *
 * Both quick-chat dispatch seams optimistically flip the session to 'running'
 * (and startCodexSdkTurn also persists the user turn) BEFORE the spawn that can
 * refuse. Nothing rolls either back — the turn-end listeners key off events the
 * spawn would have emitted, and a turn that never started emits none. So when the
 * provider guard refused a send, the chat kept painting a "Codex is thinking…"
 * placeholder and a live Stop button over an idle session, alongside the correctly
 * failed pending-send row.
 *
 * Two invariants, pinned here:
 *   1. A refusal happens BEFORE any side effect — no persisted user turn, no
 *      status flip. (The assert sits at the top of the dispatch, mirroring
 *      relayOrSpawnPtyPanel.)
 *   2. A dispatch that fails AFTER the flip restores the pre-turn status, so the
 *      general spawn failure (missing binary, spawn-key collision) cannot strand
 *      the session in 'running' either.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    createPanel: vi.fn(async () => ({ id: 'panel-1' })),
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
import { setAgentProviderAccessResolver } from '../../../../shared/agents/agentProviderGuard';
import { AGENT_PROVIDER_DISABLED_CODE } from '../../../../shared/types/agentRuntime';

type Handler = (...args: unknown[]) => Promise<unknown>;

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

const CODEX_PANEL = { id: 'panel-1', sessionId: 's1', type: 'claude' } as never;

function makeServices(runtime: 'codex-sdk' | 'codex-pty', status = 'waiting') {
  const dbSession = { id: 's1', agent_runtime: runtime, substrate: runtime === 'codex-pty' ? 'interactive' : 'sdk', chat_run_id: 'quick-run-1' };
  const services = {
    sessionManager: {
      getDbSession: vi.fn(() => dbSession),
      getSession: vi.fn(async () => ({ id: 's1', worktreePath: '/wt/s1', status })),
      addPanelConversationMessage: vi.fn(),
      addSessionOutput: vi.fn(async () => {}),
      updateSession: vi.fn(async () => {}),
      on: vi.fn(),
      emit: vi.fn(),
    },
    databaseService: {
      getSession: vi.fn(() => dbSession),
      getPanelSettings: vi.fn(() => ({})),
      getDb: vi.fn(() => ({})),
    },
    claudeCodeManager: { on: vi.fn(), setPanelInputDeliverer: vi.fn(), isPanelRunning: vi.fn(() => false) },
    codexSdkManager: {
      on: vi.fn(),
      isPanelRunning: vi.fn(() => false),
      stopPanel: vi.fn(async () => {}),
      spawnCliProcess: vi.fn(async () => {}),
    },
    codexPtyManager: {
      on: vi.fn(),
      isPanelRunning: vi.fn(() => true),
      relayUserTurn: vi.fn(),
      startPanel: vi.fn(async () => {}),
    },
    interactiveCliManager: { isPanelRunning: vi.fn(() => false), relayUserTurn: vi.fn(), startPanel: vi.fn(async () => {}) },
    registerLivePanel: vi.fn(),
    registerCodexPtyPanel: vi.fn(),
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices;
  return services;
}

function register(services: AppServices): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  registerSessionHandlers(ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0], services);
  return handlers;
}

/** Every updateSession call that set status to 'running'. */
function runningFlips(services: AppServices): unknown[] {
  const update = services.sessionManager.updateSession as unknown as ReturnType<typeof vi.fn>;
  return update.mock.calls.filter((call) => (call[1] as { status?: string } | undefined)?.status === 'running');
}

describe('a provider-refused turn leaves no turn state behind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanel).mockReturnValue(CODEX_PANEL);
    // Codex off, Claude on.
    setAgentProviderAccessResolver((provider) => provider !== 'codex');
  });

  afterEach(() => setAgentProviderAccessResolver(null));

  it('panels:continue refuses a codex-sdk turn without persisting it or flipping to running', async () => {
    const services = makeServices('codex-sdk');
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'hello', undefined, false, 'p-1')) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    // The reason reaches the renderer with the machine code intact, so the row
    // can offer "Open Settings → Integrations" rather than a bare retry.
    expect(result.error).toContain(AGENT_PROVIDER_DISABLED_CODE);
    expect(services.sessionManager.addPanelConversationMessage).not.toHaveBeenCalled();
    expect(runningFlips(services)).toEqual([]);
    const codexSdk = services.codexSdkManager as unknown as { spawnCliProcess: ReturnType<typeof vi.fn> };
    expect(codexSdk.spawnCliProcess).not.toHaveBeenCalled();
  });

  it('sessions:input refuses a codex-pty relay without flipping to running', async () => {
    // The session-scoped relay reaches a LIVE REPL, so no spawn guard would ever
    // see it — the seam-level assert is the only thing standing in its way.
    const services = makeServices('codex-pty');
    const handlers = register(services);

    const result = (await invoke(handlers, 'sessions:input', 's1', 'hello')) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain(AGENT_PROVIDER_DISABLED_CODE);
    const codexPty = services.codexPtyManager as unknown as { relayUserTurn: ReturnType<typeof vi.fn> };
    expect(codexPty.relayUserTurn).not.toHaveBeenCalled();
    expect(runningFlips(services)).toEqual([]);
    // Refused before the transcript write, too — nothing to reconcile away.
    expect(services.sessionManager.addSessionOutput).not.toHaveBeenCalled();
  });

  it('leaves an enabled provider entirely untouched', async () => {
    setAgentProviderAccessResolver(() => true);
    const services = makeServices('codex-sdk');
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'hello', undefined, false, 'p-1')) as {
      success: boolean;
    };

    expect(result.success).toBe(true);
    const codexSdk = services.codexSdkManager as unknown as { spawnCliProcess: ReturnType<typeof vi.fn> };
    expect(codexSdk.spawnCliProcess).toHaveBeenCalledTimes(1);
    expect(runningFlips(services)).toHaveLength(1);
  });
});

describe('a turn that fails AFTER the running flip restores the prior status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanel).mockReturnValue(CODEX_PANEL);
    setAgentProviderAccessResolver(null);
  });

  it('rolls the codex-sdk session back to its pre-turn status when the spawn throws', async () => {
    const services = makeServices('codex-sdk');
    const codexSdk = services.codexSdkManager as unknown as { spawnCliProcess: ReturnType<typeof vi.fn> };
    codexSdk.spawnCliProcess.mockRejectedValue(new Error('Codex app-server failed to start'));
    const handlers = register(services);

    const result = (await invoke(handlers, 'panels:continue', 'panel-1', 'hello', undefined, false, 'p-1')) as {
      success: boolean;
    };

    expect(result.success).toBe(false);
    const update = services.sessionManager.updateSession as unknown as ReturnType<typeof vi.fn>;
    // Flipped on, then flipped back — the session does not sit on a phantom
    // "thinking" placeholder waiting for a turn that never ran.
    expect(update.mock.calls.map((call) => (call[1] as { status?: string }).status)).toEqual([
      'running',
      'waiting',
    ]);
  });
});
