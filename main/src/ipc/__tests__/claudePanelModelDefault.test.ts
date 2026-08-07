/**
 * TASK-155: pins both Claude-panel model fallback sites to
 * configManager.getDefaultLaunchModel('quick') instead of getDefaultModel().
 *
 * getDefaultModel()'s floor ('sonnet') is not the Quick Session floor — these
 * are exactly the quick-session-launch surface a per-type model default
 * targets, so leaving them on getDefaultModel() produced a split-brain
 * default between this IPC path and the renderer's quick-session launcher.
 *
 * Uses a real ConfigManager (temp cyboflow dir) rather than a hand-typed mock
 * so the assertions track ConfigManager's actual getDefaultLaunchModel
 * behavior instead of a hardcoded guess about its floor value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
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
  substrate: 'interactive' as const,
  state: { isActive: true, customState: {} },
  metadata: { createdAt: '', lastActiveAt: '', position: 1 },
};

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(() => panel),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => [panel]),
    updatePanel: vi.fn(async () => {}),
  },
}));

import { claudePanelManager, registerClaudePanelHandlers } from '../claudePanel';
import type { AppServices } from '../types';
import { panelManager } from '../../services/panelManager';
import { ConfigManager } from '../../services/configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({} as unknown, ...args);
}

function makeCliManager() {
  return Object.assign(new EventEmitter(), {
    startPanel: vi.fn(async () => {}),
    continuePanel: vi.fn(async () => {}),
    stopPanel: vi.fn(async () => {}),
  });
}

function makeServices(
  configManager: ConfigManager,
  sdkManager: ReturnType<typeof makeCliManager>,
  interactiveManager: ReturnType<typeof makeCliManager>,
  panelSettings: Record<string, unknown>,
): AppServices {
  return {
    sessionManager: {
      getSession: vi.fn(() => ({ id: 'session-1', worktreePath: '/tmp/session-1' })),
      getDbSession: vi.fn(() => ({ substrate: 'sdk' })),
      getPanelConversationMessages: vi.fn(() => []),
      addPanelConversationMessage: vi.fn(),
      getPanelOutputs: vi.fn(() => []),
    },
    databaseService: {
      getActivePanels: vi.fn(() => []),
      getPanelSettings: vi.fn(() => panelSettings),
      updatePanelSettings: vi.fn(),
    },
    configManager,
    claudeCodeManager: sdkManager,
    interactiveCliManager: interactiveManager,
  } as unknown as AppServices;
}

let tempDir: string;
let configManager: ConfigManager;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(panelManager.getPanel).mockReturnValue(panel);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-claude-panel-model-default-'));
  setCyboflowDirectory(tempDir);
  configManager = new ConfigManager('/tmp/test-git-path');
  await configManager.initialize();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('claude-panels model fallback sites resolve via getDefaultLaunchModel(\'quick\')', () => {
  it('get-model (applySettingsDefaults) floors to getDefaultLaunchModel(\'quick\') with nothing configured', async () => {
    // Confirm this floor differs from getDefaultModel()'s 'sonnet' floor, so the
    // assertion below is meaningfully pinned to the launch-kind resolver.
    expect(configManager.getDefaultLaunchModel('quick')).not.toBe(configManager.getDefaultModel());

    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(configManager, sdkManager, interactiveManager, {});
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );

    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as {
      success: boolean;
      data: string;
    };

    expect(result.success).toBe(true);
    expect(result.data).toBe(configManager.getDefaultLaunchModel('quick'));
  });

  it('get-model honors a stored quick run-type default over the floor', async () => {
    await configManager.updateConfig({ runTypeDefaults: { quick: { model: 'sonnet' } } });
    expect(configManager.getDefaultLaunchModel('quick')).toBe('sonnet');

    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(configManager, sdkManager, interactiveManager, {});
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );

    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as {
      success: boolean;
      data: string;
    };

    expect(result.success).toBe(true);
    expect(result.data).toBe('sonnet');
  });

  it('claude-panels:start floors modelToUse to getDefaultLaunchModel(\'quick\') when no model is passed or stored', async () => {
    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(configManager, sdkManager, interactiveManager, {});
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );
    claudePanelManager.registerPanel('panel-1', 'session-1');

    const result = (await invoke(handlers, 'claude-panels:start', 'panel-1', 'hello')) as { success: boolean };

    expect(result.success).toBe(true);
    expect(interactiveManager.startPanel).toHaveBeenCalledWith(
      'panel-1',
      'session-1',
      '/tmp/session-1',
      'hello',
      undefined,
      configManager.getDefaultLaunchModel('quick'),
    );
    expect(sdkManager.startPanel).not.toHaveBeenCalled();
  });

  it('claude-panels:start honors a stored quick run-type default when no model is passed', async () => {
    await configManager.updateConfig({ runTypeDefaults: { quick: { model: 'sonnet' } } });

    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(configManager, sdkManager, interactiveManager, {});
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );
    claudePanelManager.registerPanel('panel-1', 'session-1');

    const result = (await invoke(handlers, 'claude-panels:start', 'panel-1', 'hello')) as { success: boolean };

    expect(result.success).toBe(true);
    expect(interactiveManager.startPanel).toHaveBeenCalledWith(
      'panel-1',
      'session-1',
      '/tmp/session-1',
      'hello',
      undefined,
      'sonnet',
    );
  });
});
