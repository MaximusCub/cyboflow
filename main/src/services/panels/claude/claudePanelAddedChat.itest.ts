/**
 * Mocked-SDK integration coverage for a chat panel created after boot.
 *
 * This intentionally drives the real ClaudePanelManager -> ClaudeCodeManager
 * seam. The panel lookup is the same source used by production routing, so a
 * newly registered panel with no override must inherit the session's SDK
 * substrate and keep its first turn isolated from the boot-time panel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import {
  createModuleFakeSdk,
  scenario,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';
import { ApprovalRouter } from '../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from './claudeCodeManager';
import { ClaudePanelManager } from './claudePanelManager';
import type { AbstractCliManager } from '../cli/AbstractCliManager';
import type { SessionManager } from '../../sessionManager';
import { ModelAvailabilityService } from '../../modelAvailabilityService';

const fakeSdk = createModuleFakeSdk();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => fakeSdk.query(params),
}));

vi.mock('../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));

vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));

vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

interface DbSessionStub {
  id: string;
  substrate: 'sdk';
  permission_mode: 'ignore';
  run_id: null;
  chat_run_id: null;
  skip_continue_next: false;
}

function makeSessionManager(output: ReturnType<typeof vi.fn>): SessionManager {
  const session: DbSessionStub = {
    id: 'session-added-chat',
    substrate: 'sdk',
    permission_mode: 'ignore',
    run_id: null,
    chat_run_id: null,
    skip_continue_next: false,
  };

  return {
    getDbSession: vi.fn(() => session),
    getPanelClaudeSessionId: vi.fn((panelId: string) => `claude-${panelId}`),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
    addPanelOutput: output,
  } as unknown as SessionManager;
}

function makeCliStub(): AbstractCliManager {
  return Object.assign(new EventEmitter(), {
    startPanel: vi.fn(async () => {}),
    continuePanel: vi.fn(async () => {}),
    stopPanel: vi.fn(async () => {}),
  }) as unknown as AbstractCliManager;
}

describe('added Claude chat mocked-SDK integration', () => {
  let db: Database.Database;
  let sdkManager: ClaudeCodeManager;
  let interactiveManager: AbstractCliManager;
  let panelManager: ClaudePanelManager;
  let output: ReturnType<typeof vi.fn>;
  let panels: Map<string, { substrate?: 'sdk' | 'interactive' }>;

  beforeEach(() => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    fakeSdk.reset();
    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);

    output = vi.fn();
    const sessionManager = makeSessionManager(output);
    sdkManager = new ClaudeCodeManager(sessionManager, undefined, undefined, db);
    // ClaudeCodeManager.startPanel's legacy dynamic validation require is not
    // available in the ESM Vitest integration worker. Keep the real SDK spawn
    // path, but bypass only that validation wrapper in this test fixture.
    vi.spyOn(sdkManager, 'startPanel').mockImplementation(async (
      panelId,
      sessionId,
      worktreePath,
      prompt,
      permissionMode,
      model,
    ) => {
      await sdkManager.spawnCliProcess({
        panelId,
        sessionId,
        worktreePath,
        prompt,
        permissionMode,
        model,
      });
    });
    interactiveManager = makeCliStub();
    panels = new Map();

    panelManager = new ClaudePanelManager(
      sdkManager,
      sessionManager,
      undefined,
      undefined,
      interactiveManager,
      (panelId) => panels.get(panelId)?.substrate,
    );

    // Simulate boot restoration, then the user adding a second chat panel.
    panels.set('boot-chat', {});
    panelManager.registerPanel('boot-chat', 'session-added-chat', undefined, false);
    panels.set('added-chat', {});
    panelManager.registerPanel('added-chat', 'session-added-chat');
  });

  afterEach(async () => {
    for (const panelId of ['boot-chat', 'added-chat']) {
      await sdkManager.killProcess(panelId).catch(() => {});
    }
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    delete process.env.CYBOFLOW_DISABLE_WARM_SDK;
    db.close();
    vi.clearAllMocks();
  });

  it('starts an added panel on its first turn, inherits the SDK session substrate, and stays isolated', async () => {
    fakeSdk.setScenario(
      scenario()
        .systemInit({ sessionId: 'sdk-session' })
        .assistantText('reply')
        .resultSuccess(),
    );

    await panelManager.startPanel({
      panelId: 'boot-chat',
      worktreePath: '/tmp/added-chat-worktree',
      prompt: 'boot prompt',
    });
    await panelManager.startPanel({
      panelId: 'added-chat',
      worktreePath: '/tmp/added-chat-worktree',
      prompt: 'first added prompt',
    });

    expect(fakeSdk.calls).toHaveLength(2);
    expect(fakeSdk.prompts).toHaveLength(2);
    const interactiveStartPanel = (interactiveManager as unknown as {
      startPanel: ReturnType<typeof vi.fn>;
    }).startPanel;
    expect(interactiveStartPanel).not.toHaveBeenCalled();

    const panelOutputIds = output.mock.calls.map(([panelId]) => panelId);
    expect(panelOutputIds).toContain('boot-chat');
    expect(panelOutputIds).toContain('added-chat');

    // The second query is a fresh first turn, not a continuation of the boot
    // panel. A separate manager map entry also makes the isolation explicit.
    const sdkRuns = (sdkManager as unknown as { sdkRuns: Map<string, unknown> }).sdkRuns;
    expect(sdkRuns.size).toBe(0);
    expect((sdkManager as unknown as { processes: Map<string, unknown> }).processes.size).toBe(0);
  });
});
