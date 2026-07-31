/**
 * Migration 094_tracker_direction_modes.sql — schema + backfill + replay tests.
 *
 * Runs the FULL real migration chain via DatabaseService.initialize() (same
 * technique as migration093.test.ts). Proves:
 *   1. tracker_connections gains status_sync_mode / pull_mode / push_mode, each
 *      NOT NULL DEFAULT 'auto' with an ('auto','manual') CHECK.
 *   2. tracker_outbox.kind accepts the new 'create_issue' and still rejects an
 *      unknown kind — i.e. the CHECK was WIDENED, not dropped.
 *   3. The table recreate preserves 093's column set, its index, and its rows.
 *   4. The BACKFILL: a 093-era row is read off `two_way`
 *      (status_sync_mode = two_way ? auto : manual), pull_mode = 'auto',
 *      push_mode = 'manual' — an existing connection must not surprise-push.
 *   5. Replay convergence: a ledger-wiped re-run of the whole migrations
 *      directory is a true no-op. This is the load-bearing property behind
 *      094's ALTER-FIRST ordering — the runner tolerates a duplicate-column
 *      ALTER failure and NOTHING else, and the whole file runs in one
 *      transaction, so a leading duplicate ALTER rolls the file back wholesale
 *      instead of re-running the recreate or re-applying the backfill over a
 *      user's later setting changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration094-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function columnNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function indexNames(raw: Database.Database, table: string): string[] {
  return (raw.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>)
    .map((i) => i.name)
    .filter((name) => name.startsWith('idx_'));
}

function seedProject(raw: Database.Database, id: number, path: string): void {
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, `Proj ${id}`, path);
}

/** Wipe the file-migration ledger so the next initialize() re-applies EVERY file. */
function wipeLedger(path: string): void {
  const raw = new Database(path);
  raw.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
  raw.close();
}

describe('Migration 094: tracker per-direction sync modes', () => {
  it('adds the three mode columns with an auto default and an auto/manual CHECK', () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');

    const columns = columnNames(raw, 'tracker_connections');
    expect(columns).toContain('status_sync_mode');
    expect(columns).toContain('pull_mode');
    expect(columns).toContain('push_mode');
    // The legacy flag is kept (permanently unread) rather than dropped.
    expect(columns).toContain('two_way');

    raw
      .prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('c1', 1, 'linear')`)
      .run();
    expect(
      raw
        .prepare('SELECT status_sync_mode, pull_mode, push_mode FROM tracker_connections WHERE id = ?')
        .get('c1'),
    ).toEqual({ status_sync_mode: 'auto', pull_mode: 'auto', push_mode: 'auto' });

    expect(() =>
      raw
        .prepare(
          `INSERT INTO tracker_connections (id, project_id, provider, pull_mode)
           VALUES ('c2', 1, 'linear', 'sometimes')`,
        )
        .run(),
    ).toThrow(/CHECK/i);

    raw.close();
  });

  it("widens tracker_outbox.kind to accept 'create_issue' without dropping the CHECK", () => {
    const svc = new DatabaseService(dbPath);
    svc.initialize();
    const raw = svc.getDb();
    seedProject(raw, 1, '/tmp/p1');
    raw
      .prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('c1', 1, 'linear')`)
      .run();

    for (const kind of ['create_sub_issue', 'create_issue', 'update_state', 'close_parent']) {
      expect(() =>
        raw.prepare(`INSERT INTO tracker_outbox (connection_id, kind) VALUES ('c1', ?)`).run(kind),
      ).not.toThrow();
    }
    expect(() =>
      raw.prepare(`INSERT INTO tracker_outbox (connection_id, kind) VALUES ('c1', 'delete_issue')`).run(),
    ).toThrow(/CHECK/i);

    // The recreate reproduced 093's shape exactly, minus the widened CHECK.
    expect(columnNames(raw, 'tracker_outbox')).toEqual([
      'id',
      'connection_id',
      'kind',
      'entity_type',
      'entity_id',
      'external_id',
      'client_key',
      'payload_json',
      'state',
      'attempts',
      'last_error',
      'next_attempt_at',
      'created_at',
      'updated_at',
    ]);
    expect(indexNames(raw, 'tracker_outbox')).toContain('idx_tracker_outbox_conn_state');

    raw.close();
  });

  it('backfills a 093-era row from two_way, and starts push HELD', () => {
    // A genuine 093-era DB. The mode columns cannot simply be reset — 094's
    // replay path rolls the whole file back on the duplicate-column ALTER, so a
    // table that still HAS them never re-runs the backfill. The 093 shape is
    // therefore reconstructed for real (the columns carry a self-referencing
    // CHECK, which sqlite refuses to DROP COLUMN through) before the ledger is
    // wound back.
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();
    const raw1 = svc1.getDb();
    seedProject(raw1, 1, '/tmp/p1');
    raw1
      .prepare(
        `INSERT INTO tracker_connections (id, project_id, provider, two_way)
         VALUES ('two-way-on', 1, 'linear', 1), ('two-way-off', 1, 'plane', 0)`,
      )
      .run();
    raw1.pragma('foreign_keys = OFF');
    raw1.exec(`
      CREATE TABLE tracker_connections_093 (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('linear','plane')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disconnected')),
        workspace_id TEXT,
        workspace_name TEXT,
        actor_label TEXT,
        base_url TEXT,
        secret_ciphertext BLOB,
        source_json TEXT,
        selection_mode TEXT NOT NULL DEFAULT 'all' CHECK (selection_mode IN ('all','assignee','manual')),
        selection_json TEXT,
        state_mapping_json TEXT NOT NULL DEFAULT '{}',
        two_way INTEGER NOT NULL DEFAULT 1,
        mirror_subissues INTEGER NOT NULL DEFAULT 1,
        conflict_mode TEXT NOT NULL DEFAULT 'auto' CHECK (conflict_mode IN ('auto','manual')),
        cursor_updated_at TEXT,
        cursor_external_id TEXT,
        last_sync_at TEXT,
        last_sync_log_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      INSERT INTO tracker_connections_093
        SELECT id, project_id, provider, status, workspace_id, workspace_name, actor_label,
               base_url, secret_ciphertext, source_json, selection_mode, selection_json,
               state_mapping_json, two_way, mirror_subissues, conflict_mode,
               cursor_updated_at, cursor_external_id, last_sync_at, last_sync_log_json,
               created_at, updated_at
          FROM tracker_connections;
      DROP TABLE tracker_connections;
      ALTER TABLE tracker_connections_093 RENAME TO tracker_connections;
    `);
    raw1.pragma('foreign_keys = ON');
    raw1
      .prepare("DELETE FROM user_preferences WHERE key = 'file_migration_applied:094_tracker_direction_modes.sql'")
      .run();
    raw1.close();

    const svc2 = new DatabaseService(dbPath);
    svc2.initialize();
    const raw2 = svc2.getDb();

    expect(
      raw2
        .prepare(
          'SELECT id, status_sync_mode, pull_mode, push_mode FROM tracker_connections ORDER BY id ASC',
        )
        .all(),
    ).toEqual([
      // two_way = 1 → status auto; import was never gated by it; push starts held.
      { id: 'two-way-off', status_sync_mode: 'manual', pull_mode: 'auto', push_mode: 'manual' },
      { id: 'two-way-on', status_sync_mode: 'auto', pull_mode: 'auto', push_mode: 'manual' },
    ]);

    raw2.close();
  });

  it('replay convergence: a ledger-wiped re-run is a no-op that preserves data and settings', () => {
    const svc1 = new DatabaseService(dbPath);
    svc1.initialize();
    const raw1 = svc1.getDb();
    seedProject(raw1, 1, '/tmp/p1');
    raw1
      .prepare(`INSERT INTO tracker_connections (id, project_id, provider) VALUES ('c1', 1, 'linear')`)
      .run();
    // The user has since changed their modes AWAY from both the column defaults
    // and the backfill values — a replay that re-ran the UPDATE would revert
    // these, which is the failure this case is really guarding.
    raw1
      .prepare(
        `UPDATE tracker_connections
            SET status_sync_mode = 'manual', pull_mode = 'manual', push_mode = 'auto'
          WHERE id = 'c1'`,
      )
      .run();
    raw1
      .prepare(
        `INSERT INTO tracker_outbox (connection_id, kind, entity_id, client_key)
         VALUES ('c1', 'create_issue', 'ide_1', 'key-1')`,
      )
      .run();
    const outboxColsBefore = columnNames(raw1, 'tracker_outbox');
    const connectionColsBefore = columnNames(raw1, 'tracker_connections');
    raw1.close();

    wipeLedger(dbPath);

    const svc2 = new DatabaseService(dbPath);
    expect(() => svc2.initialize()).not.toThrow();
    const raw2 = svc2.getDb();

    expect(
      raw2
        .prepare('SELECT status_sync_mode, pull_mode, push_mode FROM tracker_connections WHERE id = ?')
        .get('c1'),
    ).toEqual({ status_sync_mode: 'manual', pull_mode: 'manual', push_mode: 'auto' });
    expect(
      raw2.prepare('SELECT kind, entity_id, client_key FROM tracker_outbox').all(),
    ).toEqual([{ kind: 'create_issue', entity_id: 'ide_1', client_key: 'key-1' }]);

    // Schema unchanged — in particular the columns were not added twice and the
    // outbox was not recreated into a `tracker_outbox_new` left lying around.
    expect(columnNames(raw2, 'tracker_connections')).toEqual(connectionColsBefore);
    expect(columnNames(raw2, 'tracker_outbox')).toEqual(outboxColsBefore);
    expect(
      raw2
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tracker_outbox_new'")
        .get(),
    ).toBeUndefined();

    // The ledger marker is recorded again (via the duplicate-column tolerance).
    expect(
      raw2
        .prepare(
          "SELECT value FROM user_preferences WHERE key = 'file_migration_applied:094_tracker_direction_modes.sql'",
        )
        .get(),
    ).toEqual({ value: 'true' });

    raw2.close();
  });
});
