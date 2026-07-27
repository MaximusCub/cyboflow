import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const base = readFileSync(join(__dirname, '..', 'migrations', '065_agent_invocations.sql'), 'utf8');
const migration = readFileSync(
  join(__dirname, '..', 'migrations', '083_agent_invocation_panel_id.sql'),
  'utf8',
);

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      claude_session_id TEXT,
      agent_provider TEXT NOT NULL,
      agent_runtime TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.exec(base);
  // agent_invocations.run_id is a FK — seed the session's chat sentinel run.
  db.prepare(
    `INSERT INTO workflow_runs (id, agent_provider, agent_runtime)
     VALUES ('chat-run', 'codex', 'codex-sdk')`,
  ).run();
  return db;
}

function seedInvocation(
  db: Database.Database,
  id: string,
  panelId: string | null,
  externalSessionId: string,
): void {
  db.prepare(
    `INSERT INTO agent_invocations
       (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime, external_session_id, panel_id)
     VALUES (?, 'chat-run', NULL, 'codex', 'codex-sdk', ?, ?)`,
  ).run(id, externalSessionId, panelId);
}

describe('migration 083: per-panel agent invocation identity', () => {
  it('adds a nullable panel_id column and the panel-scoped index', () => {
    const db = buildDb();
    db.exec(migration);

    const column = (
      db.prepare('PRAGMA table_info(agent_invocations)').all() as Array<{ name: string; notnull: number }>
    ).find((row) => row.name === 'panel_id');
    expect(column).toMatchObject({ name: 'panel_id', notnull: 0 });

    const indexes = (db.prepare('PRAGMA index_list(agent_invocations)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(indexes).toContain('idx_agent_invocations_run_panel_latest');
    db.close();
  });

  it('leaves pre-083 rows with panel_id NULL so the run-scoped lookup is unchanged', () => {
    const db = buildDb();
    // A row written BEFORE the migration — the column does not exist yet.
    db.prepare(
      `INSERT INTO agent_invocations
         (agent_invocation_id, run_id, step_id, agent_provider, agent_runtime, external_session_id)
       VALUES ('legacy', 'chat-run', NULL, 'codex', 'codex-sdk', 'legacy-thread')`,
    ).run();

    db.exec(migration);

    expect(
      db.prepare("SELECT panel_id FROM agent_invocations WHERE agent_invocation_id = 'legacy'").get(),
    ).toEqual({ panel_id: null });
    db.close();
  });

  it('separates two chat panels that share ONE run id', () => {
    const db = buildDb();
    db.exec(migration);
    seedInvocation(db, 'inv-1', 'panel-1', 'thread-1');
    seedInvocation(db, 'inv-2', 'panel-2', 'thread-2');

    const forPanel = (panelId: string) =>
      db
        .prepare(
          `SELECT external_session_id AS t FROM agent_invocations
            WHERE run_id = 'chat-run' AND panel_id = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(panelId) as { t: string } | undefined;

    expect(forPanel('panel-1')?.t).toBe('thread-1');
    expect(forPanel('panel-2')?.t).toBe('thread-2');
    db.close();
  });

  it('is not replayable (the runner applies each migration once)', () => {
    const db = buildDb();
    db.exec(migration);
    expect(() => db.exec(migration)).toThrow(/duplicate column name/i);
    db.close();
  });
});
