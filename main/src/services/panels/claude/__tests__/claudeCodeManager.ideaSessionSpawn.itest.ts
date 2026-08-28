/**
 * Mocked-SDK integration coverage for idea-session spawn config
 * (idea-session.md + the per-spawn "Linked idea" line) alongside design-session
 * parity — drives the real `spawnClaudeCode` -> `buildSdkOptions` seam end to
 * end (not a single private method in isolation) so a regression in the
 * design-branch-first ordering, the tools narrowing, or the mcpScope omission
 * would show up here exactly as it would in production.
 *
 * Also covers the `agentOverlayWriter.resolveRunEffectiveAgents` LIVE branch: it
 * runs on every spawn but returns `[]` for an unseeded `workflow_runs`, so the
 * third case below seeds a run + a frozen spec with a per-workflow agent config
 * and asserts on the overlay `.md` the spawn wrote into the worktree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import {
  createModuleFakeSdk,
  scenario,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import { ClaudeCodeManager } from '../claudeCodeManager';
import type { SessionManager } from '../../../sessionManager';

const fakeSdk = createModuleFakeSdk();

/**
 * Optional per-test hook fired at the query seam — i.e. INSIDE the spawn, while
 * the worktree still carries everything the spawn wrote for the agent to read.
 * Used by the agent-overlay case, whose files are stripped again as soon as the
 * spawn drains (cleanupCliResources -> removeBundleForSession).
 */
let onQuery: ((params: FakeQueryParams) => void) | undefined;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => {
    onQuery?.(params);
    return fakeSdk.query(params);
  },
}));

vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));

vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));

interface DbSessionStub {
  id: string;
  substrate: 'sdk';
  permission_mode: 'ignore';
  run_id: null;
  chat_run_id: null;
  skip_continue_next: false;
  design_idea_id?: string | null;
  home_idea_id?: string | null;
}

function makeSessionManager(session: DbSessionStub): SessionManager {
  return {
    getDbSession: vi.fn(() => session),
    getPanelClaudeSessionId: vi.fn((panelId: string) => `claude-${panelId}`),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
    addPanelOutput: vi.fn(),
  } as unknown as SessionManager;
}

describe('idea-session spawn config (mocked-SDK integration)', () => {
  let db: Database.Database;

  beforeEach(() => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    onQuery = undefined;
    fakeSdk.reset();
    db = createTestDb();
    // Minimal `ideas` table (the real schema's columns, no migration replay
    // needed) so resolveLinkedIdeaLine's `SELECT ref, title FROM ideas WHERE
    // id = ?` has a real row to resolve against.
    db.exec(`
      CREATE TABLE ideas (
        id    TEXT PRIMARY KEY,
        ref   TEXT NOT NULL,
        title TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO ideas (id, ref, title) VALUES (?, ?, ?)').run(
      'idea-1',
      'IDEA-009',
      'Idea Session Concept',
    );
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    fakeSdk.setScenario(
      scenario().systemInit({ sessionId: 'sdk-session' }).assistantText('reply').resultSuccess(),
    );
  });

  afterEach(async () => {
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    delete process.env.CYBOFLOW_DISABLE_WARM_SDK;
    db.close();
    vi.clearAllMocks();
  });

  it('spawns an idea session with Read/Grep/Glob tools, the idea-session prompt + linked-idea line, and no mcpScope', async () => {
    const sessionManager = makeSessionManager({
      id: 'session-idea',
      substrate: 'sdk',
      permission_mode: 'ignore',
      run_id: null,
      chat_run_id: null,
      skip_continue_next: false,
      home_idea_id: 'idea-1',
    });
    const mgr = new ClaudeCodeManager(sessionManager, undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/idea-session-test.sock');

    await mgr.spawnClaudeCode('panel-idea', 'session-idea', '/tmp/idea-worktree', 'hello');

    expect(fakeSdk.calls).toHaveLength(1);
    const opts = fakeSdk.calls[0];
    expect(opts.tools).toEqual(['Read', 'Grep', 'Glob']);

    const systemPrompt = opts.systemPrompt as { append?: string } | undefined;
    expect(systemPrompt?.append).toContain('Idea agent');
    expect(systemPrompt?.append).toContain('Linked idea: IDEA-009 (idea-1) — Idea Session Concept');

    const cyboflow = opts.mcpServers?.['cyboflow'] as { env?: Record<string, string> } | undefined;
    expect(cyboflow).toBeDefined();
    expect(cyboflow?.env?.CYBOFLOW_MCP_SCOPE).toBeUndefined();

    await mgr.killProcess('panel-idea').catch(() => {});
  });

  it('leaves a design session unchanged: mcpScope design, no tools narrowing', async () => {
    const sessionManager = makeSessionManager({
      id: 'session-design',
      substrate: 'sdk',
      permission_mode: 'ignore',
      run_id: null,
      chat_run_id: null,
      skip_continue_next: false,
      design_idea_id: 'idea-1',
    });
    const mgr = new ClaudeCodeManager(sessionManager, undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/design-session-test.sock');

    await mgr.spawnClaudeCode('panel-design', 'session-design', '/tmp/design-worktree', 'hello');

    expect(fakeSdk.calls).toHaveLength(1);
    const opts = fakeSdk.calls[0];
    expect(opts.tools).toBeUndefined();

    const cyboflow = opts.mcpServers?.['cyboflow'] as { env?: Record<string, string> } | undefined;
    expect(cyboflow?.env?.CYBOFLOW_MCP_SCOPE).toBe('design');

    await mgr.killProcess('panel-design').catch(() => {});
  });

  /**
   * `resolveRunEffectiveAgents` runs on EVERY spawn (via installWorkflowBundle ->
   * installAgentOverlay), but it short-circuits to `[]` whenever the run's
   * `workflow_runs` row is missing — which every other itest leaves unseeded, so
   * its real override-merging never executed under integration. This seeds the
   * minimum that makes it take its live branch (a run row with a project_id, and a
   * frozen spec carrying a per-workflow agent config) and asserts on the OVERLAY
   * FILE the spawn actually wrote.
   */
  it('renders the workflow agent-config override into the spawn worktree overlay (resolveRunEffectiveAgents live branch)', async () => {
    const worktreePath = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'idea-session-overlay-')),
    );
    // Minimal structurally-valid definition (parseWorkflowDefinition needs a
    // non-empty id + one phase with one step) carrying a per-agent model pin.
    const specJson = JSON.stringify({
      id: 'itest-overlay-flow',
      phases: [
        {
          id: 'phase-1',
          label: 'Build',
          color: '#8b5cf6',
          steps: [{ id: 'step-1', name: 'Implement', agent: 'implement' }],
        },
      ],
      agentConfigs: { implement: { model: 'haiku' } },
    });
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, spec_json, workflow_path) VALUES (?, ?, ?, ?, ?)`,
    ).run('wf-overlay', 7, 'itest-overlay-flow', specJson, null);
    // getRunProjectId reads workflow_runs.project_id; the id matches the panelId
    // because the session row's run_id is null (resolveGateRunId -> panelId).
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, ?, ?, ?)`,
    ).run('panel-overlay', 'wf-overlay', 7, 'running');

    const sessionManager = makeSessionManager({
      id: 'session-overlay',
      substrate: 'sdk',
      permission_mode: 'ignore',
      run_id: null,
      chat_run_id: null,
      skip_continue_next: false,
    });
    const mgr = new ClaudeCodeManager(sessionManager, undefined, undefined, db);
    mgr.setOrchSocketPath('/tmp/overlay-test.sock');

    // The overlay is installed BEFORE query() and stripped by
    // cleanupCliResources -> removeBundleForSession when the spawn drains, so the
    // files exist only WHILE the agent is running. Snapshot them from the query
    // seam — which is exactly the window the SDK auto-discovers `.claude/agents`
    // in, so this reads what the agent would actually have seen.
    const agentsDir = path.join(worktreePath, '.claude', 'agents');
    let overlayDuringQuery: Record<string, string> = {};
    onQuery = () => {
      overlayDuringQuery = Object.fromEntries(
        fs
          .readdirSync(agentsDir)
          .map((name) => [name, fs.readFileSync(path.join(agentsDir, name), 'utf8')]),
      );
    };

    try {
      await mgr.spawnClaudeCode('panel-overlay', 'session-overlay', worktreePath, 'hello');

      // The config flips the builtin to an override, so the overlay renders the
      // agent instead of writing its verbatim bundled `.md` — with the alias
      // resolved to its concrete snapshot id for the CLI subagent frontmatter.
      const pinned = overlayDuringQuery['cyboflow-implement.md'];
      expect(pinned).toBeDefined();
      expect(pinned).toContain('name: cyboflow-implement');
      expect(pinned).toContain('model: claude-haiku-4-5');

      // Control: an agent the config does not name keeps its unpinned builtin
      // body, so the assertion above is the config layer and not a blanket write.
      const untouched = overlayDuringQuery['cyboflow-code-review.md'];
      expect(untouched).toBeDefined();
      expect(untouched).not.toContain('model:');

      await mgr.killProcess('panel-overlay').catch(() => {});
    } finally {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  });
});
