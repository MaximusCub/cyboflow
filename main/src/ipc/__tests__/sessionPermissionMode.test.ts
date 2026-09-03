/**
 * Unit tests for `updateAgentPermissionMode` in main/src/ipc/sessionOps.ts — the
 * ops implementation behind the `cyboflow.sessions.updateAgentPermissionMode`
 * tRPC procedure, formerly the `sessions:update-agent-permission-mode` IPC
 * handler (Issue #1).
 *
 * It persists sessions.agent_permission_mode (next-turn re-read for the
 * SDK substrate) and fires session-updated. No settings-file side effect exists
 * anymore: the interactive PTY gating hook rides the inline `--settings` flag
 * and is recomputed from the persisted mode at every spawn
 * (interactiveClaudeManager buildCommandArgs -> resolveInlineGatingHooks), so the
 * former .claude/settings.json re-prime (and its demo/existence/fail-soft
 * guards) is gone.
 */

import { describe, it, expect, vi } from 'vitest';

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
    createPanel: vi.fn(),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: {
    getSession: vi.fn(() => ({ id: 'sess-001', status: 'running', archived: false })),
  },
}));

import { createSessionOps } from '../sessionOps';
import type { AppServices } from '../types';

const SESSION_ID = 'sess-001';
const WORKTREE = '/tmp/project/quick-test';

function makeServices(opts: {
  substrate?: string;
  isDemoMode?: boolean;
  updateReturns?: boolean;
  worktreePath?: string | undefined;
}) {
  const dbSession = {
    id: SESSION_ID,
    substrate: opts.substrate,
    worktree_path: opts.worktreePath === undefined ? WORKTREE : opts.worktreePath,
  };
  const fakeDatabaseService = {
    updateSession: vi.fn(() => (opts.updateReturns === false ? undefined : dbSession)),
    getSession: vi.fn(() => dbSession),
  };
  const fakeSessionManager = {
    getSession: vi.fn(() => ({ id: SESSION_ID, agentPermissionMode: 'default' })),
    emit: vi.fn(),
  };

  const services = {
    sessionManager: fakeSessionManager,
    databaseService: fakeDatabaseService,
    taskQueue: {},
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: { isPanelRunning: vi.fn(() => false) },
    interactiveCliManager: { isPanelRunning: vi.fn(() => false) },
    killLiveSession: vi.fn(),
    registerLivePanel: vi.fn(),
    gitStatusManager: {},
    archiveProgressManager: undefined,
    configManager: { isDemoMode: () => opts.isDemoMode ?? false },
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;

  return { services, fakeDatabaseService, fakeSessionManager };
}

describe('sessionOps.updateAgentPermissionMode — persist + emit', () => {
  it('rejects an invalid mode without persisting', async () => {
    const { services, fakeDatabaseService } = makeServices({ substrate: 'sdk' });
    const ops = createSessionOps(services);
    const result = (await ops.updateAgentPermissionMode({ sessionId: SESSION_ID, mode: 'bogus' })) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(fakeDatabaseService.updateSession).not.toHaveBeenCalled();
  });

  it('persists the mode and emits session-updated for an SDK session', async () => {
    const { services, fakeDatabaseService, fakeSessionManager } = makeServices({ substrate: 'sdk' });
    const ops = createSessionOps(services);
    const result = (await ops.updateAgentPermissionMode({ sessionId: SESSION_ID, mode: 'acceptEdits' })) as {
      success: boolean;
    };
    expect(result.success).toBe(true);
    expect(fakeDatabaseService.updateSession).toHaveBeenCalledWith(SESSION_ID, {
      agent_permission_mode: 'acceptEdits',
    });
    expect(fakeSessionManager.emit).toHaveBeenCalledWith('session-updated', expect.anything());
  });

  it('returns Session not found when the row does not update', async () => {
    const { services } = makeServices({ substrate: 'sdk', updateReturns: false });
    const ops = createSessionOps(services);
    const result = (await ops.updateAgentPermissionMode({ sessionId: SESSION_ID, mode: 'auto' })) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('Session not found');
  });
});
