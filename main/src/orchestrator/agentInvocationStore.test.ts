import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentInvocationStore } from './agentInvocationStore';
import { dbAdapter } from './__test_fixtures__/dbAdapter';

const MIGRATION = readFileSync(
  join(__dirname, '..', 'database', 'migrations', '065_agent_invocations.sql'),
  'utf-8',
);
/** 087 adds agent_invocations.panel_id — the per-chat-panel resume identity. */
const MIGRATION_PANEL_ID = readFileSync(
  join(__dirname, '..', 'database', 'migrations', '087_agent_invocation_panel_id.sql'),
  'utf-8',
);

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      agent_provider TEXT NOT NULL
        CHECK (agent_provider IN ('claude', 'codex')),
      agent_runtime TEXT NOT NULL
        CHECK (agent_runtime IN ('claude-sdk', 'claude-interactive', 'codex-sdk')),
      model TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(MIGRATION);
  db.exec(MIGRATION_PANEL_ID);
  return db;
}

function seedRun(
  db: Database.Database,
  id: string,
  input: {
    provider?: 'claude' | 'codex';
    runtime?: 'claude-sdk' | 'claude-interactive' | 'codex-sdk';
    legacyExternalSessionId?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, claude_session_id, agent_provider, agent_runtime)
     VALUES (?, ?, ?, ?)`,
  ).run(
    id,
    input.legacyExternalSessionId ?? null,
    input.provider ?? 'claude',
    input.runtime ?? 'claude-sdk',
  );
}

describe('AgentInvocationStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    seedRun(db, 'run-1');
    seedRun(db, 'run-2');
  });

  afterEach(() => {
    db.close();
  });

  it('creates append-only invocations with injected or caller-provided ids', () => {
    const store = new AgentInvocationStore(dbAdapter(db), () => 'generated-invocation');
    expect(
      store.createInvocation({
        runId: 'run-1',
        provider: 'claude',
        runtime: 'claude-sdk',
        model: 'opus',
      }),
    ).toBe('generated-invocation');
    expect(
      store.createInvocation({
        agentInvocationId: 'caller-invocation',
        runId: 'run-1',
        stepId: 'implement',
        provider: 'codex',
        runtime: 'codex-sdk',
      }),
    ).toBe('caller-invocation');

    const rows = db
      .prepare(
        `SELECT agent_invocation_id, run_id, step_id, agent_provider, agent_runtime,
                model, external_session_id
           FROM agent_invocations
          ORDER BY id`,
      )
      .all();
    expect(rows).toEqual([
      {
        agent_invocation_id: 'generated-invocation',
        run_id: 'run-1',
        step_id: null,
        agent_provider: 'claude',
        agent_runtime: 'claude-sdk',
        model: 'opus',
        external_session_id: null,
      },
      {
        agent_invocation_id: 'caller-invocation',
        run_id: 'run-1',
        step_id: 'implement',
        agent_provider: 'codex',
        agent_runtime: 'codex-sdk',
        model: null,
        external_session_id: null,
      },
    ]);
    expect(() =>
      store.createInvocation({
        agentInvocationId: 'caller-invocation',
        runId: 'run-2',
        provider: 'claude',
        runtime: 'claude-sdk',
      }),
    ).toThrow(/UNIQUE/i);
  });

  it('captures an external id once, guarded by invocation id and run id', () => {
    const store = new AgentInvocationStore(dbAdapter(db));
    store.createInvocation({
      agentInvocationId: 'inv-1',
      runId: 'run-1',
      provider: 'codex',
      runtime: 'codex-sdk',
    });

    expect(store.captureExternalSessionId('run-2', 'inv-1', 'thread-wrong')).toBe(false);
    expect(store.captureExternalSessionId('run-1', 'missing', 'thread-wrong')).toBe(false);
    expect(store.captureExternalSessionId('run-1', 'inv-1', 'thread-1')).toBe(true);
    expect(store.captureExternalSessionId('run-1', 'inv-1', 'thread-replacement')).toBe(false);
    expect(
      db
        .prepare(
          `SELECT external_session_id FROM agent_invocations
            WHERE agent_invocation_id = 'inv-1'`,
        )
        .get(),
    ).toEqual({ external_session_id: 'thread-1' });
  });

  it('returns the latest captured top-level target and ignores newer step invocations', () => {
    const store = new AgentInvocationStore(dbAdapter(db));
    store.createInvocation({
      agentInvocationId: 'top-1',
      runId: 'run-1',
      provider: 'claude',
      runtime: 'claude-interactive',
    });
    store.captureExternalSessionId('run-1', 'top-1', 'claude-session-1');
    store.createInvocation({
      agentInvocationId: 'step-1',
      runId: 'run-1',
      stepId: 'implement',
      provider: 'codex',
      runtime: 'codex-sdk',
    });
    store.captureExternalSessionId('run-1', 'step-1', 'codex-step-thread');

    expect(store.getLatestTopLevelResumeTarget('run-1')).toEqual({
      provider: 'claude',
      runtime: 'claude-interactive',
      externalSessionId: 'claude-session-1',
    });
  });

  it('falls back to the newest captured target when a newer invocation is incomplete', () => {
    const store = new AgentInvocationStore(dbAdapter(db));
    db.prepare("UPDATE workflow_runs SET claude_session_id = 'legacy-session' WHERE id = 'run-1'").run();
    store.createInvocation({
      agentInvocationId: 'top-old',
      runId: 'run-1',
      provider: 'claude',
      runtime: 'claude-sdk',
    });
    store.captureExternalSessionId('run-1', 'top-old', 'session-old');
    store.createInvocation({
      agentInvocationId: 'top-new',
      runId: 'run-1',
      provider: 'codex',
      runtime: 'codex-sdk',
    });

    expect(store.getLatestTopLevelResumeTarget('run-1')).toEqual({
      provider: 'claude',
      runtime: 'claude-sdk',
      externalSessionId: 'session-old',
    });
  });

  it('falls back to a legacy id only for Claude runs with no top-level invocation', () => {
    seedRun(db, 'run-legacy-claude', {
      runtime: 'claude-interactive',
      legacyExternalSessionId: 'legacy-claude-session',
    });
    seedRun(db, 'run-legacy-codex', {
      provider: 'codex',
      runtime: 'codex-sdk',
      legacyExternalSessionId: 'legacy-codex-thread',
    });
    const store = new AgentInvocationStore(dbAdapter(db));
    store.createInvocation({
      agentInvocationId: 'step-only',
      runId: 'run-legacy-claude',
      stepId: 'review',
      provider: 'codex',
      runtime: 'codex-sdk',
    });
    store.captureExternalSessionId('run-legacy-claude', 'step-only', 'step-thread');

    expect(store.getLatestTopLevelResumeTarget('run-legacy-claude')).toEqual({
      provider: 'claude',
      runtime: 'claude-interactive',
      externalSessionId: 'legacy-claude-session',
    });
    expect(store.getLatestTopLevelResumeTarget('run-legacy-codex')).toBeNull();
    expect(store.getLatestTopLevelResumeTarget('missing')).toBeNull();
  });

  it('uses the Claude legacy fallback when the invocation table is unavailable', () => {
    const legacyDb = new Database(':memory:');
    legacyDb.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        agent_provider TEXT NOT NULL,
        agent_runtime TEXT NOT NULL
      );
      INSERT INTO workflow_runs
        (id, claude_session_id, agent_provider, agent_runtime)
      VALUES
        ('legacy-run', 'legacy-session', 'claude', 'claude-sdk');
    `);
    const store = new AgentInvocationStore(dbAdapter(legacyDb));
    expect(store.getLatestTopLevelResumeTarget('legacy-run')).toEqual({
      provider: 'claude',
      runtime: 'claude-sdk',
      externalSessionId: 'legacy-session',
    });
    legacyDb.close();
  });
});

/**
 * Per-chat-panel resume identity (the "two Codex chats share a history" bug).
 *
 * A quick session's chat_run_id is SESSION-scoped, so every chat panel resolves
 * the same run id. Resolving the resume target by run id therefore handed a
 * SECOND Codex chat the FIRST chat's thread and both panels replayed one
 * conversation. getLatestPanelResumeTarget filters to the panel's own rows.
 */
describe('AgentInvocationStore — per-panel resume targets', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    seedRun(db, 'chat-run', { provider: 'codex', runtime: 'codex-sdk' });
  });

  afterEach(() => {
    db.close();
  });

  function captureFor(panelId: string, invocationId: string, threadId: string): void {
    const store = new AgentInvocationStore(dbAdapter(db));
    store.createInvocation({
      agentInvocationId: invocationId,
      runId: 'chat-run',
      provider: 'codex',
      runtime: 'codex-sdk',
      panelId,
    });
    store.captureExternalSessionId('chat-run', invocationId, threadId);
  }

  it('keeps two chat panels on the SAME run id pointed at their own threads', () => {
    captureFor('panel-1', 'inv-1', 'thread-panel-1');
    captureFor('panel-2', 'inv-2', 'thread-panel-2');
    const store = new AgentInvocationStore(dbAdapter(db));

    expect(store.getLatestPanelResumeTarget('chat-run', 'panel-1')?.externalSessionId).toBe(
      'thread-panel-1',
    );
    expect(store.getLatestPanelResumeTarget('chat-run', 'panel-2')?.externalSessionId).toBe(
      'thread-panel-2',
    );
    // The run-scoped lookup is what both panels used to share — it still returns
    // the newest row overall, which is exactly why it is the wrong per-panel key.
    expect(store.getLatestTopLevelResumeTarget('chat-run')?.externalSessionId).toBe(
      'thread-panel-2',
    );
  });

  it('returns null for a panel with no captured invocation (a NEW chat starts fresh)', () => {
    captureFor('panel-1', 'inv-1', 'thread-panel-1');
    const store = new AgentInvocationStore(dbAdapter(db));

    // Must NOT inherit panel-1's thread — that inheritance IS the bug.
    expect(store.getLatestPanelResumeTarget('chat-run', 'panel-2')).toBeNull();
  });

  it('returns the NEWEST captured thread for the panel across turns', () => {
    captureFor('panel-1', 'inv-old', 'thread-old');
    captureFor('panel-1', 'inv-new', 'thread-new');
    const store = new AgentInvocationStore(dbAdapter(db));

    expect(store.getLatestPanelResumeTarget('chat-run', 'panel-1')?.externalSessionId).toBe(
      'thread-new',
    );
  });

  it('ignores pre-087 rows (panel_id NULL) — they are claimed by the caller, not this query', () => {
    const store = new AgentInvocationStore(dbAdapter(db));
    store.createInvocation({
      agentInvocationId: 'inv-legacy',
      runId: 'chat-run',
      provider: 'codex',
      runtime: 'codex-sdk',
    });
    store.captureExternalSessionId('chat-run', 'inv-legacy', 'thread-legacy');

    expect(store.getLatestPanelResumeTarget('chat-run', 'panel-1')).toBeNull();
    // The run-scoped lookup still finds it, which is how the first chat panel
    // keeps resuming across the 087 upgrade.
    expect(store.getLatestTopLevelResumeTarget('chat-run')?.externalSessionId).toBe('thread-legacy');
  });

  it('ignores step invocations and uncaptured rows', () => {
    const store = new AgentInvocationStore(dbAdapter(db));
    store.createInvocation({
      agentInvocationId: 'inv-step',
      runId: 'chat-run',
      stepId: 'step-1',
      provider: 'codex',
      runtime: 'codex-sdk',
      panelId: 'panel-1',
    });
    store.captureExternalSessionId('chat-run', 'inv-step', 'thread-step');
    store.createInvocation({
      agentInvocationId: 'inv-uncaptured',
      runId: 'chat-run',
      provider: 'codex',
      runtime: 'codex-sdk',
      panelId: 'panel-1',
    });

    expect(store.getLatestPanelResumeTarget('chat-run', 'panel-1')).toBeNull();
  });

  it('fails soft to null on a pre-087 database with no panel_id column', () => {
    const legacyDb = new Database(':memory:');
    legacyDb.exec(`
      CREATE TABLE workflow_runs (
        id TEXT PRIMARY KEY,
        claude_session_id TEXT,
        agent_provider TEXT NOT NULL,
        agent_runtime TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    legacyDb.exec(MIGRATION); // 065 only — no panel_id column.

    const store = new AgentInvocationStore(dbAdapter(legacyDb));
    expect(store.getLatestPanelResumeTarget('chat-run', 'panel-1')).toBeNull();
    legacyDb.close();
  });
});
