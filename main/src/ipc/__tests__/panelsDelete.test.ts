/**
 * panels:delete — routes stop by the panel's ACTUAL lane.
 *
 * Every agent panel (Claude, Codex, OMP) keeps the legacy `type: 'claude'`
 * panel row and registers into ClaudePanelManager at create time. But
 * ClaudePanelManager.getCliManager only ever resolves the two CLAUDE
 * substrates (sdk / interactive) — it has no notion of Codex or OMP. Before
 * this fix, panels:delete routed EVERY 'claude'-typed panel's stop through
 * claudePanelManager alone, so deleting a live Codex/OMP panel never reached
 * its real manager: the stop silently missed (wrong manager, panel id not
 * found there) and the live process leaked.
 *
 * NOTE on scope: the handler's claudePanelManager branch goes through a
 * dynamic `require('./claudePanel')` that vitest's `vi.mock` does NOT
 * intercept (see gitDestructiveHandlers.test.ts's identical note on the same
 * pattern in git.ts) — a plain Node `require` shim, not vite-node's module
 * graph, resolves it, and fails to find the extensionless `.ts` sibling. The
 * fix in panels.ts scopes that require to ONLY the branches that need it
 * (the claude-lane stop, and the always-run unregister), so it never gates
 * the codex/omp stop path this test exercises — but it does mean this file
 * cannot assert on claudePanelManager's own stop/unregister calls under
 * vitest. Those calls are exercised instead via the real singleton in
 * claudePanelContinue.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

const panel = {
  id: 'panel-1',
  sessionId: 'session-1',
  type: 'claude' as const,
  title: 'Chat',
  state: { isActive: true, customState: {} },
  metadata: { createdAt: '', lastActiveAt: '', position: 0 },
};

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(() => panel),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => [panel]),
    updatePanel: vi.fn(async () => {}),
    deletePanel: vi.fn(async () => {}),
  },
}));

vi.mock('../../services/terminalPanelManager', () => ({
  terminalPanelManager: { destroyTerminal: vi.fn() },
}));

const getSessionMock = vi.fn();
vi.mock('../../services/database', () => ({
  databaseService: { getSession: (...args: unknown[]) => getSessionMock(...args) },
}));

import { registerPanelHandlers } from '../panels';
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

/** A CLI-manager-shaped fake: EventEmitter + the seams panels.ts touches. */
function makeCliManager() {
  return Object.assign(new EventEmitter(), {
    stopPanel: vi.fn(async () => {}),
    isPanelRunning: vi.fn(() => false),
  });
}

function makeServices() {
  const codexSdkManager = makeCliManager();
  const codexPtyManager = makeCliManager();
  const ompSdkManager = makeCliManager();
  const ompPtyManager = makeCliManager();

  const services = {
    codexSdkManager,
    codexPtyManager,
    ompSdkManager,
    ompPtyManager,
  } as unknown as AppServices;

  return { services, codexSdkManager, codexPtyManager, ompSdkManager, ompPtyManager };
}

describe('panels:delete — routes a live Codex/OMP panel to its own manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
  });

  it.each([
    ['codex-sdk', 'sdk', 'codexSdkManager'],
    ['codex-pty', 'interactive', 'codexPtyManager'],
    ['omp-sdk', 'sdk', 'ompSdkManager'],
    ['omp-pty', 'interactive', 'ompPtyManager'],
  ] as const)('deleting a live %s panel stops it via its OWN manager', async (agentRuntime, substrate, ownerKey) => {
    getSessionMock.mockReturnValue({ id: 'session-1', agent_runtime: agentRuntime, substrate });
    const made = makeServices();
    made[ownerKey].isPanelRunning.mockReturnValue(true);

    const { ipcMain, handlers } = makeHandlerCapture();
    registerPanelHandlers(ipcMain as unknown as Parameters<typeof registerPanelHandlers>[0], made.services);

    const result = (await invoke(handlers, 'panels:delete', 'panel-1')) as { success: boolean };

    expect(result.success).toBe(true);
    expect(made[ownerKey].stopPanel).toHaveBeenCalledWith('panel-1');
    for (const other of ['codexSdkManager', 'codexPtyManager', 'ompSdkManager', 'ompPtyManager'] as const) {
      if (other === ownerKey) continue;
      expect(made[other].stopPanel).not.toHaveBeenCalled();
    }
    expect(panelManager.deletePanel).toHaveBeenCalledWith('panel-1');
  });

  it('does not stop a live Codex panel via a DIFFERENT lane\'s manager when it is not actually running there', async () => {
    // A codex-sdk panel: only codexSdkManager should ever be probed/stopped.
    getSessionMock.mockReturnValue({ id: 'session-1', agent_runtime: 'codex-sdk', substrate: 'sdk' });
    const made = makeServices();
    made.codexSdkManager.isPanelRunning.mockReturnValue(false); // not actually running

    const { ipcMain, handlers } = makeHandlerCapture();
    registerPanelHandlers(ipcMain as unknown as Parameters<typeof registerPanelHandlers>[0], made.services);

    const result = (await invoke(handlers, 'panels:delete', 'panel-1')) as { success: boolean };

    expect(result.success).toBe(true);
    // Not running -> stopPanel is never called (isPanelRunning gates it), but
    // it must have been ASKED — proving the lane was resolved to codexSdkManager.
    expect(made.codexSdkManager.isPanelRunning).toHaveBeenCalledWith('panel-1');
    expect(made.codexSdkManager.stopPanel).not.toHaveBeenCalled();
    for (const other of ['codexPtyManager', 'ompSdkManager', 'ompPtyManager'] as const) {
      expect(made[other].isPanelRunning).not.toHaveBeenCalled();
      expect(made[other].stopPanel).not.toHaveBeenCalled();
    }
  });
});
