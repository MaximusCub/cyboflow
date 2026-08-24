/**
 * Migrations 119/120 — sessions.idle_since (the quick-session board's real
 * last-REST clock) and the backfill for rows that were already at rest when
 * the column landed.
 *
 * Exercises the REAL migrations dir (migration113.test.ts's pattern): a fresh
 * boot proves the column lands, the backfill proves an existing install does
 * not spend the rest of its life on the reader-side COALESCE fallback (see
 * 120's header for why that fallback is not equivalent to a stamp), and a
 * ledger-wiped replay proves both files are idempotent — the duplicate-column
 * tolerance 119 relies on, and 120's `idle_since IS NULL` guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const ALTER_FILE = '119_session_idle_since.sql';
const BACKFILL_FILE = '120_session_idle_since_backfill.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration119-'));
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

/** Reopen the same file, re-running whatever the ledger has not recorded. */
function reopen(): DatabaseService {
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

function seedSession(
  db: Database.Database,
  id: string,
  status: string,
  updatedAt: string,
): void {
  db.prepare(
    `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, status, updated_at)
     VALUES (?, 'S', 'p', ?, '/tmp/w', ?, ?)`,
  ).run(id, `w-${id}`, status, updatedAt);
}

function idleSince(db: Database.Database, id: string): string | null {
  return (db.prepare('SELECT idle_since FROM sessions WHERE id = ?').get(id) as {
    idle_since: string | null;
  }).idle_since;
}

/** Wipe the file-migration ledger so the next initialize() re-applies EVERY file. */
function wipeLedger(path: string): void {
  const raw = new Database(path);
  raw.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
  raw.close();
}

/** Un-apply only the two idle_since files, so a reopen re-runs exactly them. */
function forgetIdleSinceMigrations(path: string): void {
  const raw = new Database(path);
  for (const name of [ALTER_FILE, BACKFILL_FILE]) {
    raw.prepare('DELETE FROM user_preferences WHERE key = ?').run(`file_migration_applied:${name}`);
  }
  raw.close();
}

describe('Migration 119: sessions.idle_since', () => {
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
});

describe('Migration 120: the idle_since backfill', () => {
  it('stamps a pre-existing RESTING row with its last known activity', () => {
    // Stand the schema up, seed a row as it would have existed pre-119, then
    // re-run the two files against it — the shape of a real upgrade.
    const svc1 = openFresh();
    seedSession(svc1.getDb(), 'rested', 'completed', '2026-01-01 00:00:00');
    svc1.getDb().prepare('UPDATE sessions SET idle_since = NULL WHERE id = ?').run('rested');
    svc1.close();

    forgetIdleSinceMigrations(dbPath);
    const svc2 = reopen();

    expect(idleSince(svc2.getDb(), 'rested')).toBe('2026-01-01 00:00:00');
    svc2.close();
  });

  it.each(['running', 'pending'])(
    'leaves a %s row NULL — the boot sweep, not the backfill, stamps those',
    (busy) => {
      const svc1 = openFresh();
      seedSession(svc1.getDb(), 'busy', busy, '2026-01-01 00:00:00');
      svc1.getDb().prepare('UPDATE sessions SET idle_since = NULL WHERE id = ?').run('busy');
      svc1.close();

      forgetIdleSinceMigrations(dbPath);
      const svc2 = reopen();

      // Migrations run before SessionManager's boot sweep, so NULL must keep
      // meaning "not resting" for the whole window.
      expect(idleSince(svc2.getDb(), 'busy')).toBeNull();
      svc2.close();
    },
  );

  it('never overwrites a row that already carries a stamp', () => {
    const svc1 = openFresh();
    seedSession(svc1.getDb(), 'stamped', 'completed', '2026-08-01 00:00:00');
    svc1
      .getDb()
      .prepare('UPDATE sessions SET idle_since = ? WHERE id = ?')
      .run('2026-02-02 03:04:05', 'stamped');
    svc1.close();

    forgetIdleSinceMigrations(dbPath);
    const svc2 = reopen();

    expect(idleSince(svc2.getDb(), 'stamped')).toBe('2026-02-02 03:04:05');
    svc2.close();
  });
});

describe('Migrations 119/120 replay', () => {
  it('a ledger-wiped replay re-applies both files cleanly and preserves stamped values', () => {
    const svc1 = openFresh();
    const db1 = svc1.getDb();
    seedSession(db1, 'sess-1', 'completed', '2026-01-01 00:00:00');
    db1
      .prepare('UPDATE sessions SET idle_since = ? WHERE id = ?')
      .run('2026-02-02 03:04:05', 'sess-1');
    svc1.close();

    wipeLedger(dbPath);

    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(MIGRATIONS_DIR);
    expect(() => svc2.initialize()).not.toThrow();

    const db2 = svc2.getDb();
    expect(columnNames(db2, 'sessions')).toContain('idle_since');
    // 119's duplicate-column ALTER must not clobber, and 120's IS NULL guard
    // must not re-stamp.
    expect(idleSince(db2, 'sess-1')).toBe('2026-02-02 03:04:05');

    for (const name of [ALTER_FILE, BACKFILL_FILE]) {
      expect(
        db2
          .prepare('SELECT value FROM user_preferences WHERE key = ?')
          .get(`file_migration_applied:${name}`),
      ).toEqual({ value: 'true' });
    }

    svc2.close();
  });
});
