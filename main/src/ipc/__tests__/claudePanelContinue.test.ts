/**
 * Regression coverage for the claude-panels:continue routing seam.
 *
 * The panel override is deliberately different from the session substrate so
 * this test proves the IPC handler reaches ClaudePanelManager, which then
 * resolves the panel's own substrate before dispatching the continuation.
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
  id: 'panel-added',
  sessionId: 'session-1',
  type: 'claude' as const,
  title: 'Chat 2',
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

function makeServices(sdkManager: ReturnType<typeof makeCliManager>, interactiveManager: ReturnType<typeof makeCliManager>): AppServices {
  const conversationHistory = [
    { id: 1, session_id: 'session-1', message_type: 'user' as const, content: 'earlier turn', timestamp: '2026-07-23' },
  ];

  return {
    sessionManager: {
      getSession: vi.fn(() => ({ id: 'session-1', worktreePath: '/tmp/session-1' })),
      getDbSession: vi.fn(() => ({ substrate: 'sdk' })),
      getPanelConversationMessages: vi.fn(() => conversationHistory),
      addPanelConversationMessage: vi.fn(),
      getPanelOutputs: vi.fn(() => []),
    },
    databaseService: {
      getActivePanels: vi.fn(() => []),
      getPanelSettings: vi.fn(() => ({})),
      updatePanelSettings: vi.fn(),
    },
    configManager: { getDefaultModel: vi.fn(() => 'sonnet') },
    claudeCodeManager: sdkManager,
    interactiveCliManager: interactiveManager,
  } as unknown as AppServices;
}

describe('claude-panels:continue — per-panel substrate override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanel).mockReturnValue(panel);
  });

  it('routes a continuation through the panel override even when the session inherits SDK', async () => {
    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(sdkManager, interactiveManager);
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );
    claudePanelManager.registerPanel('panel-added', 'session-1');

    const result = (await invoke(
      handlers,
      'claude-panels:continue',
      'panel-added',
      'first turn in the added chat',
      'opus',
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(interactiveManager.continuePanel).toHaveBeenCalledWith(
      'panel-added',
      'session-1',
      '/tmp/session-1',
      'first turn in the added chat',
      [expect.objectContaining({ message_type: 'user', content: 'earlier turn' })],
      undefined,
      'opus',
    );
    expect(sdkManager.continuePanel).not.toHaveBeenCalled();
  });
});
