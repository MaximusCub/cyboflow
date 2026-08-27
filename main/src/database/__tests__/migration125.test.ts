/**
 * Migration 125: widen agent_proposals.kind to admit 'create-backlog-items'
 * (the global assistant's backlog-create proposal).
 *
 * The migration REBUILDS agent_proposals rather than using 117's shadow-column
 * recipe (kind is NOT NULL with no default), so the two things worth guarding
 * are that the rebuild preserves the exact column shape 074 declared AND that
 * existing rows survive it — a silent column drop or row loss is exactly the
 * 103 hazard the recreate is otherwise exposed to.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_074 = readFileSync(join(__dirname, '..', 'migrations', '074_agent_threads.sql'), 'utf-8');
const MIGRATION_125 = readFileSync(
  join(__dirname, '..', 'migrations', '125_agent_proposal_create_backlog_kind.sql'),
  'utf-8',
);

const COLUMNS_074 = [
  'id',
  'thread_id',
  'kind',
  'payload_json',
  'preconditions_json',
  'status',
  'result_json',
  'idempotency_key',
  'created_at',
  'decided_at',
];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_074);
  db.prepare('INSERT INTO agent_threads (id) VALUES (?)').run('t1');
  return db;
}

function insertProposal(db: Database.Database, id: string, kind: string): void {
  db.prepare(
    "INSERT INTO agent_proposals (id, thread_id, kind, payload_json, status) VALUES (?, 't1', ?, '{}', 'proposed')",
  ).run(id, kind);
}

describe("Migration 125: agent_proposals.kind admits 'create-backlog-items'", () => {
  it('rejects the new kind BEFORE the migration and accepts it after', () => {
    const db = buildDb();
    expect(() => insertProposal(db, 'p-before', 'create-backlog-items')).toThrow(/CHECK constraint failed/);

    db.exec(MIGRATION_125);
    insertProposal(db, 'p-after', 'create-backlog-items');
    expect(
      db.prepare('SELECT kind FROM agent_proposals WHERE id = ?').get('p-after'),
    ).toEqual({ kind: 'create-backlog-items' });
  });

  it('keeps the four pre-existing kinds valid and still rejects an unknown one', () => {
    const db = buildDb();
    db.exec(MIGRATION_125);
    for (const kind of ['launch-run', 'reprioritize-backlog', 'edit-workflow', 'open-session']) {
      insertProposal(db, `p-${kind}`, kind);
    }
    expect(() => insertProposal(db, 'p-bogus', 'delete-everything')).toThrow(/CHECK constraint failed/);
  });

  it("preserves 074's exact column shape and every existing row through the rebuild", () => {
    const db = buildDb();
    insertProposal(db, 'p-existing', 'launch-run');
    db.prepare("UPDATE agent_proposals SET result_json = '{\"kind\":\"launch-run\"}', status = 'executed' WHERE id = ?").run(
      'p-existing',
    );

    db.exec(MIGRATION_125);

    const columns = (db.prepare('PRAGMA table_info(agent_proposals)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(columns).toEqual(COLUMNS_074);
    expect(db.prepare('SELECT id, kind, status, result_json FROM agent_proposals').all()).toEqual([
      { id: 'p-existing', kind: 'launch-run', status: 'executed', result_json: '{"kind":"launch-run"}' },
    ]);
  });

  it('keeps the ON DELETE CASCADE to agent_threads after the rebuild', () => {
    const db = buildDb();
    db.exec(MIGRATION_125);
    // The rebuild re-declares the FK; a dropped one would silently orphan rows.
    db.pragma('foreign_keys = ON');
    insertProposal(db, 'p-cascade', 'create-backlog-items');
    db.prepare('DELETE FROM agent_threads WHERE id = ?').run('t1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get()).toEqual({ n: 0 });
  });
});
