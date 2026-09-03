/**
 * Unit tests for `updateSessionMcps` / `updateSessionPlugins` in
 * main/src/ipc/sessionOps.ts — the ops implementations behind the
 * `cyboflow.sessions.updateSessionMcps` / `.updateSessionPlugins` tRPC
 * procedures, formerly the `sessions:update-session-mcps` /
 * `sessions:update-session-plugins` IPC handlers (Slice 5 of the per-session
 * MCP/plugin toggle work).
 *
 * Each clones the updateAgentPermissionMode shape: validate
 * the string[] payload, persist the JSON column via databaseService.updateSession
 * (disabled_mcp_servers_json = the DENY set / enabled_plugins_json = the ALLOW
 * set), mirror the parsed array onto the runtime session, and emit
 * 'session-updated'. All collaborators are stubbed at the object level (no real
 * SQLite).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Electron is imported transitively via session.ts -> panelManager etc.
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

// panelManager uses IPC at module load time - stub it.
vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
    createPanel: vi.fn(),
  },
}));

// The databaseService SINGLETON (services/database) is referenced by other
// handlers at registration; stub it so the module never opens a real sqlite file.
vi.mock('../../services/database', () => ({
  databaseService: {
    getSession: vi.fn(() => ({ id: 'sess-001', status: 'running', archived: false })),
  },
}));

import { createSessionOps } from '../sessionOps';
import type { AppServices } from '../types';

interface FakeSession {
  id: string;
  disabledMcpServers?: string[];
  enabledPlugins?: string[];
}

function makeServices() {
  const fakeSession: FakeSession = { id: 'sess-001' };
  const updateSession = vi.fn(() => fakeSession);
  const getSession = vi.fn(() => fakeSession);
  const emit = vi.fn();

  const services = {
    sessionManager: { getSession, emit },
    databaseService: { updateSession },
    taskQueue: {},
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: {},
    interactiveCliManager: {},
    killLiveSession: vi.fn(),
    registerLivePanel: vi.fn(),
    gitStatusManager: {},
    archiveProgressManager: undefined,
    configManager: { isDemoMode: () => false },
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;

  return { services, fakeSession, updateSession, getSession, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessionOps.updateSessionMcps (DENY list)', () => {
  it('persists the deny set as JSON, mirrors it, and emits session-updated', async () => {
    const { services, fakeSession, updateSession, emit } = makeServices();
    const ops = createSessionOps(services);

    const res = await ops.updateSessionMcps({
      sessionId: 'sess-001',
      disabledMcpServers: ['peekaboo', 'playwright'],
    });

    expect(res.success).toBe(true);
    expect(updateSession).toHaveBeenCalledWith('sess-001', {
      disabled_mcp_servers_json: JSON.stringify(['peekaboo', 'playwright']),
    });
    expect(fakeSession.disabledMcpServers).toEqual(['peekaboo', 'playwright']);
    expect(emit).toHaveBeenCalledWith('session-updated', fakeSession);
  });

  it('persists an empty deny set byte-identically ("[]")', async () => {
    const { services, updateSession } = makeServices();
    const ops = createSessionOps(services);

    await ops.updateSessionMcps({ sessionId: 'sess-001', disabledMcpServers: [] });

    expect(updateSession).toHaveBeenCalledWith('sess-001', { disabled_mcp_servers_json: '[]' });
  });

  it('rejects a non-string-array payload without touching the DB', async () => {
    const { services, updateSession } = makeServices();
    const ops = createSessionOps(services);

    // This exercises the DEFENSE-IN-DEPTH guard for direct ops callers. Via
    // the tRPC router the branch is unreachable — z.array(z.string()) throws
    // BAD_REQUEST first (pinned in routers/__tests__/sessions.test.ts).
    const res = await ops.updateSessionMcps({
      sessionId: 'sess-001',
      disabledMcpServers: ['ok', 42] as unknown as string[],
    });

    expect(res.success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });

  it('returns "Session not found" when the row does not update', async () => {
    const { services, updateSession, emit } = makeServices();
    updateSession.mockReturnValueOnce(undefined as unknown as FakeSession);
    const ops = createSessionOps(services);

    const res = await ops.updateSessionMcps({ sessionId: 'missing', disabledMcpServers: [] });

    expect(res).toEqual({ success: false, error: 'Session not found' });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('sessionOps.updateSessionPlugins (ALLOW list)', () => {
  it('persists the allow set as JSON, mirrors it, and emits session-updated', async () => {
    const { services, fakeSession, updateSession, emit } = makeServices();
    const ops = createSessionOps(services);

    const res = await ops.updateSessionPlugins({
      sessionId: 'sess-001',
      enabledPlugins: ['formatter@acme'],
    });

    expect(res.success).toBe(true);
    expect(updateSession).toHaveBeenCalledWith('sess-001', {
      enabled_plugins_json: JSON.stringify(['formatter@acme']),
    });
    expect(fakeSession.enabledPlugins).toEqual(['formatter@acme']);
    expect(emit).toHaveBeenCalledWith('session-updated', fakeSession);
  });

  it('rejects a non-string-array payload without touching the DB', async () => {
    const { services, updateSession } = makeServices();
    const ops = createSessionOps(services);

    const res = await ops.updateSessionPlugins({
      sessionId: 'sess-001',
      enabledPlugins: 'nope' as unknown as string[],
    });

    expect(res.success).toBe(false);
    expect(updateSession).not.toHaveBeenCalled();
  });
});
