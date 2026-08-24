/**
 * Migration 116 — sessions.idle_since, the quick-session board's real
 * last-REST clock (see the migration file's header for why it replaces
 * updated_at as the source of "quiet for N").
 *
 * Exercises the REAL migrations dir (migration113.test.ts's pattern): a fresh
 * boot proves the column lands, a ledger-wiped replay proves the
 * duplicate-column tolerance the single-statement file relies on, and a
 * pre-existing row proves the deliberate absence of a backfill is safe —
 * NULL COALESCEs back to updated_at, which is byte-identical to the
 * pre-migration behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_FILE = '116_session_idle_since.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration116-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function openFresh(): DatabaseService {
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(MIGRATIONS_DIR);
  svc.initialize();
  return svc;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function seedSession(db: Database.Database, id: string, updatedAt: string): void {
  db.prepare(
    `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, status, updated_at)
     VALUES (?, 'S', 'p', ?, '/tmp/w', 'completed', ?)`,
  ).run(id, `w-${id}`, updatedAt);
}

/** Wipe the file-migration ledger so the next initialize() re-applies EVERY file. */
function wipeLedger(path: string): void {
  const raw = new Database(path);
  raw.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
  raw.close();
}

describe('Migration 116: sessions.idle_since', () => {
  it('a fresh apply adds the column, nullable, defaulting to NULL', () => {
    const svc = openFresh();
    const db = svc.getDb();

    expect(columnNames(db, 'sessions')).toContain('idle_since');

    const info = (
      db.prepare('PRAGMA table_info(sessions)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>
    ).find((c) => c.name === 'idle_since');
    expect(info?.notnull).toBe(0);
    expect(info?.dflt_value).toBeNull();

    svc.close();
  });

  it('leaves pre-existing rows NULL — no backfill — and they COALESCE to updated_at', () => {
    // A backfill would write exactly the value the reader's COALESCE already
    // yields, so the migration deliberately omits one. This pins that choice.
    const svc = openFresh();
    const db = svc.getDb();
    seedSession(db, 'sess-1', '2026-01-01 00:00:00');

    const row = db
      .prepare(
        `SELECT idle_since,
                strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(idle_since, updated_at)) AS idle_since_iso
           FROM sessions WHERE id = ?`,
      )
      .get('sess-1') as { idle_since: string | null; idle_since_iso: string };

    expect(row.idle_since).toBeNull();
    expect(row.idle_since_iso).toBe('2026-01-01T00:00:00Z');
    svc.close();
  });

  it('a ledger-wiped replay re-applies the file cleanly and preserves stamped values', () => {
    const svc1 = openFresh();
    const db1 = svc1.getDb();
    seedSession(db1, 'sess-1', '2026-01-01 00:00:00');
    db1.prepare('UPDATE sessions SET idle_since = ? WHERE id = ?').run('2026-02-02 03:04:05', 'sess-1');
    svc1.close();

    wipeLedger(dbPath);

    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(MIGRATIONS_DIR);
    expect(() => svc2.initialize()).not.toThrow();

    const db2 = svc2.getDb();
    expect(columnNames(db2, 'sessions')).toContain('idle_since');
    // The duplicate-column ALTER must not have clobbered the stamped value.
    expect(
      (db2.prepare('SELECT idle_since FROM sessions WHERE id = ?').get('sess-1') as {
        idle_since: string;
      }).idle_since,
    ).toBe('2026-02-02 03:04:05');

    expect(
      db2
        .prepare('SELECT value FROM user_preferences WHERE key = ?')
        .get(`file_migration_applied:${MIGRATION_FILE}`),
    ).toEqual({ value: 'true' });

    svc2.close();
  });
});
