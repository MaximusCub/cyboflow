/**
 * Migration 092_design_feedback_outbox.sql — schema + constraint + replay tests.
 *
 * 092 widens BOTH feedback tables (077) so design-prototype feedback can exist:
 * the atype CHECKs gain 'ui-prototype'/'interactive-prototype', feedback_batches
 * gains the six outbox columns, and its status CHECK gains the outbox lifecycle.
 * Proves:
 *   1. Both tables accept every doc AND prototype atype; garbage is still rejected.
 *   2. feedback_batches accepts the full status set (legacy + outbox); garbage rejected.
 *   3. The six outbox columns exist with their documented defaults and are writable.
 *   4. Pre-existing 077-shaped rows (batch + its sent comment, incl. the batch_id
 *      linkage) survive the double table-recreate verbatim.
 *   5. The indexes are recreated, including the partial in-flight recovery index.
 *   6. THE LEDGER-REPLAY PATH: re-running the whole chain against an already-092
 *      DB (the ledger-wiped existing-install case) is a no-op that preserves the
 *      outbox column DATA — the leading ALTERs short-circuit the file rather than
 *      letting a 077-column-only copy blank them. See 092's header.
 *   7. The fresh-DB initialize() path lands the same widened CHECKs.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');

/** The chain that creates projects/workflow_runs/entities and then the feedback tables. */
const THROUGH_077 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '077_artifact_feedback.sql',
];

function seedProject(db: Database.Database): void {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
}

function apply(db: Database.Database, files: string[]): void {
  for (const f of files) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
}

/**
 * Apply 092 the way the runner does: FK enforcement toggled off OUTSIDE the
 * wrapping transaction (the runner keys that off the leading PRAGMA line).
 */
function apply090(db: Database.Database): void {
  const sql = readFileSync(join(MIG_DIR, '092_design_feedback_outbox.sql'), 'utf-8');
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(sql);
    db.exec('COMMIT');
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, 'running', 'default')`,
  ).run(runId);
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  seedProject(db);
  apply(db, THROUGH_077);
  apply090(db);
  seedRun(db, 'run-1');
  return db;
}

function insertBatch(
  db: Database.Database,
  id: string,
  o: { atype?: string; status?: string; sourceRef?: string } = {},
): void {
  db.prepare(
    `INSERT INTO feedback_batches (id, project_id, run_id, atype, source_ref, round, status, created_at)
     VALUES (?, 1, 'run-1', ?, ?, 1, ?, '2026-07-27T00:00:00.000Z')`,
  ).run(id, o.atype ?? 'idea-spec', o.sourceRef ?? `idea-${id}`, o.status ?? 'pending');
}

function insertComment(db: Database.Database, id: string, o: { atype?: string; anchor?: string } = {}): void {
  db.prepare(
    `INSERT INTO feedback_comments (id, project_id, run_id, atype, source_ref, anchor_json, body, status,
                                    created_at, updated_at)
     VALUES (?, 1, 'run-1', ?, 'idea-1', ?, 'a comment', 'draft',
             '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z')`,
  ).run(id, o.atype ?? 'idea-spec', o.anchor ?? '{"quote":"q","occurrence":0,"bodyHash":"aabbccdd"}');
}

const ALL_ATYPES = ['idea-spec', 'arch-design', 'ui-prototype', 'interactive-prototype'];
const ALL_STATUSES = ['pending', 'applied', 'failed', 'queued', 'dispatching', 'dispatched', 'blocked'];

describe('Migration 092: design feedback outbox', () => {
  it('(a) both tables accept every doc + prototype atype, and reject a bogus one', () => {
    const db = buildDb();
    ALL_ATYPES.forEach((atype, i) => {
      expect(() => insertBatch(db, `b_${i}`, { atype })).not.toThrow();
      expect(() => insertComment(db, `c_${i}`, { atype })).not.toThrow();
    });
    expect(() => insertBatch(db, 'b_bad', { atype: 'nonsense' })).toThrow(/CHECK/i);
    expect(() => insertComment(db, 'c_bad', { atype: 'nonsense' })).toThrow(/CHECK/i);
    db.close();
  });

  it('(b) feedback_batches accepts the legacy + outbox statuses, and rejects a bogus one', () => {
    const db = buildDb();
    ALL_STATUSES.forEach((status, i) => {
      expect(() => insertBatch(db, `s_${i}`, { atype: 'interactive-prototype', status })).not.toThrow();
    });
    expect(() => insertBatch(db, 's_bad', { status: 'nonsense' })).toThrow(/CHECK/i);
    db.close();
  });

  it('(c) the six outbox columns exist with their defaults and are writable', () => {
    const db = buildDb();
    insertBatch(db, 'b_default', { atype: 'ui-prototype', status: 'queued' });
    expect(
      db.prepare('SELECT * FROM feedback_batches WHERE id = ?').get('b_default'),
    ).toMatchObject({
      session_id: null,
      current_attempt_id: null,
      attempt_count: 0,
      blocked_reason: null,
      dispatched_at: null,
      applied_prototype_revision: null,
    });

    db.prepare(
      `UPDATE feedback_batches
          SET session_id = 'sess-1', current_attempt_id = 'att-1', attempt_count = 2,
              blocked_reason = 'link broken', dispatched_at = '2026-07-27T01:00:00.000Z',
              applied_prototype_revision = 7
        WHERE id = 'b_default'`,
    ).run();
    expect(db.prepare('SELECT * FROM feedback_batches WHERE id = ?').get('b_default')).toMatchObject({
      session_id: 'sess-1',
      current_attempt_id: 'att-1',
      attempt_count: 2,
      blocked_reason: 'link broken',
      dispatched_at: '2026-07-27T01:00:00.000Z',
      applied_prototype_revision: 7,
    });
    db.close();
  });

  it('(d) pre-existing 077-shaped rows survive the double recreate verbatim', () => {
    const db = new Database(':memory:');
    seedProject(db);
    apply(db, THROUGH_077);
    seedRun(db, 'run-keep');
    db.prepare(
      `INSERT INTO feedback_batches (id, project_id, run_id, atype, source_ref, round, status, error,
                                     created_at, applied_at)
       VALUES ('b_keep', 1, 'run-keep', 'arch-design', 'idea-9', 3, 'applied', NULL,
               '2026-07-01T00:00:00.000Z', '2026-07-01T01:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO feedback_comments (id, project_id, run_id, atype, source_ref, batch_id, anchor_json,
                                      body, status, created_at, updated_at, sent_at, addressed_at)
       VALUES ('c_keep', 1, 'run-keep', 'arch-design', 'idea-9', 'b_keep',
               '{"quote":"keep me","occurrence":2,"bodyHash":"deadbeef"}', 'the note', 'addressed',
               '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:30:00.000Z',
               '2026-07-01T01:00:00.000Z')`,
    ).run();

    apply090(db);

    expect(db.prepare('SELECT * FROM feedback_batches WHERE id = ?').get('b_keep')).toMatchObject({
      id: 'b_keep',
      project_id: 1,
      run_id: 'run-keep',
      atype: 'arch-design',
      source_ref: 'idea-9',
      round: 3,
      status: 'applied',
      created_at: '2026-07-01T00:00:00.000Z',
      applied_at: '2026-07-01T01:00:00.000Z',
      // The new columns land at their defaults on a legacy row.
      session_id: null,
      attempt_count: 0,
    });
    expect(db.prepare('SELECT * FROM feedback_comments WHERE id = ?').get('c_keep')).toMatchObject({
      id: 'c_keep',
      run_id: 'run-keep',
      atype: 'arch-design',
      // The batch_id linkage must survive the batches table being dropped + renamed.
      batch_id: 'b_keep',
      anchor_json: '{"quote":"keep me","occurrence":2,"bodyHash":"deadbeef"}',
      body: 'the note',
      status: 'addressed',
      sent_at: '2026-07-01T00:30:00.000Z',
      addressed_at: '2026-07-01T01:00:00.000Z',
    });
    db.close();
  });

  it('(e) recreates the doc indexes and adds the partial in-flight recovery index', () => {
    const db = buildDb();
    const idx = (
      db
        .prepare(
          `SELECT name, tbl_name, sql FROM sqlite_master
            WHERE type = 'index' AND tbl_name IN ('feedback_batches','feedback_comments')`,
        )
        .all() as Array<{ name: string; tbl_name: string; sql: string | null }>
    );
    const names = idx.map((r) => r.name);
    expect(names).toContain('idx_feedback_batches_doc');
    expect(names).toContain('idx_feedback_comments_doc');
    expect(names).toContain('idx_feedback_batches_inflight');
    // Partial, not a full index over every terminal row.
    const inflight = idx.find((r) => r.name === 'idx_feedback_batches_inflight');
    expect(inflight?.sql).toMatch(/WHERE status IN \('queued','dispatching','dispatched'\)/);
    db.close();
  });

  it('(f) LEDGER REPLAY: re-running the chain on an already-092 DB preserves outbox data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration090-'));
    try {
      const dbPath = join(dir, 'test.db');
      const svc = new DatabaseService(dbPath);
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const db = svc.getDb();

      db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj-092')`).run();
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('run-1', 'wf-1', 1, 'running', 'default')`,
      ).run();
      db.prepare(
        `INSERT INTO feedback_batches (id, project_id, run_id, atype, source_ref, round, status,
                                       created_at, session_id, current_attempt_id, attempt_count,
                                       dispatched_at, applied_prototype_revision)
         VALUES ('b_live', 1, 'run-1', 'interactive-prototype', 'idea-1', 1, 'dispatched',
                 '2026-07-27T00:00:00.000Z', 'sess-live', 'att-live', 3,
                 '2026-07-27T00:05:00.000Z', 4)`,
      ).run();

      // Wipe THIS file's ledger marker and re-run the whole chain, exactly as an
      // existing install whose ledger was reset would.
      db.prepare('DELETE FROM user_preferences WHERE key = ?').run(
        'file_migration_applied:092_design_feedback_outbox.sql',
      );
      svc.initialize();

      // The leading ALTERs make the replay a whole-file no-op: no data blanked,
      // no error, and the widened CHECKs still stand.
      expect(svc.getDb().prepare('SELECT * FROM feedback_batches WHERE id = ?').get('b_live')).toMatchObject({
        status: 'dispatched',
        session_id: 'sess-live',
        current_attempt_id: 'att-live',
        attempt_count: 3,
        dispatched_at: '2026-07-27T00:05:00.000Z',
        applied_prototype_revision: 4,
      });
      // The ledger marker is restored (idempotent-ok), so later boots skip cleanly.
      expect(
        svc
          .getDb()
          .prepare('SELECT value FROM user_preferences WHERE key = ?')
          .get('file_migration_applied:092_design_feedback_outbox.sql'),
      ).toBeTruthy();
      svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(g) the fresh-DB initialize() path lands the widened atype + status CHECKs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cyboflow-migration090-fresh-'));
    try {
      const svc = new DatabaseService(join(dir, 'test.db'));
      svc.setMigrationsDirForTesting(MIG_DIR);
      svc.initialize();
      const db = svc.getDb();

      db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/proj-090f')`).run();
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
      ).run();
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
         VALUES ('run-1', 'wf-1', 1, 'running', 'default')`,
      ).run();

      expect(() => insertBatch(db, 'b_fresh', { atype: 'interactive-prototype', status: 'queued' })).not.toThrow();
      expect(() => insertComment(db, 'c_fresh', { atype: 'ui-prototype' })).not.toThrow();
      expect(() => insertBatch(db, 'b_fresh_bad', { atype: 'nonsense' })).toThrow(/CHECK/i);
      expect(() => insertBatch(db, 'b_fresh_bad2', { status: 'nonsense' })).toThrow(/CHECK/i);
      svc.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
