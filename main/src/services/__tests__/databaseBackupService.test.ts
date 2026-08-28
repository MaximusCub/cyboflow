/**
 * DatabaseBackupService tests — daily sessions.db snapshots with 7-day
 * retention. Each test drives a REAL file-backed better-sqlite3 DB (WAL
 * mode) so the backup assertions prove a valid, complete SQLite snapshot
 * rather than a junk file copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { makeSpyLogger } from '../../orchestrator/__test_fixtures__/loggerLikeSpy';
import {
  DatabaseBackupService,
  DATABASE_BACKUP_TICK_INTERVAL_MS,
  DATABASE_BACKUP_RETAIN_COUNT,
  DATABASE_BACKUP_EXCLUDED_TABLES,
} from '../databaseBackupService';

const FIXED_NOW = () => new Date('2026-08-20T10:00:00');

let tmpDir: string;
let backupsDir: string;
let dbPath: string;
let db: Database.Database;

function seedDb(target: Database.Database): void {
  target.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
  target.prepare('INSERT INTO widgets (name) VALUES (?)').run('alpha');
  target.prepare('INSERT INTO widgets (name) VALUES (?)').run('beta');
}

function readWidgetNames(path: string): string[] {
  const snapshot = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const rows = snapshot.prepare('SELECT name FROM widgets ORDER BY id').all() as {
      name: string;
    }[];
    return rows.map((r) => r.name);
  } finally {
    snapshot.close();
  }
}

/**
 * Add a `raw_events` table shaped like the real one — AUTOINCREMENT id, one
 * fat payload column — and fill it with enough bytes that VACUUM has something
 * visible to reclaim.
 */
function seedRawEvents(target: Database.Database, rows: number): void {
  target.exec(
    'CREATE TABLE raw_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, payload_json TEXT NOT NULL)',
  );
  const insert = target.prepare('INSERT INTO raw_events (run_id, payload_json) VALUES (?, ?)');
  const payload = 'x'.repeat(2048);
  const many = target.transaction((n: number) => {
    for (let i = 0; i < n; i++) insert.run(`run-${i}`, payload);
  });
  many(rows);
}

function countRows(path: string, table: string): number {
  const snapshot = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = snapshot.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } finally {
    snapshot.close();
  }
}

function readSequence(path: string, table: string): number | undefined {
  const snapshot = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = snapshot.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table) as
      | { seq: number }
      | undefined;
    return row?.seq;
  } finally {
    snapshot.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-db-backup-'));
  backupsDir = join(tmpDir, 'backups');
  dbPath = join(tmpDir, 'sessions.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  seedDb(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('DatabaseBackupService', () => {
  it('creates a valid backup for today on first tick', async () => {
    const logger = makeSpyLogger();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });

    await svc.tick();

    const targetPath = join(backupsDir, 'sessions-2026-08-20.db');
    expect(existsSync(targetPath)).toBe(true);
    expect(readWidgetNames(targetPath)).toEqual(['alpha', 'beta']);
  });

  it('is a no-op on a second tick the same day', async () => {
    const logger = makeSpyLogger();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });

    await svc.tick();
    const targetPath = join(backupsDir, 'sessions-2026-08-20.db');
    expect(readWidgetNames(targetPath)).toEqual(['alpha', 'beta']);

    db.prepare('INSERT INTO widgets (name) VALUES (?)').run('gamma');
    await svc.tick();

    // The backup still reflects the ORIGINAL rows — the daily guard skipped
    // a re-backup rather than overwriting with the now-mutated live DB.
    expect(readWidgetNames(targetPath)).toEqual(['alpha', 'beta']);
    const backupFiles = readdirSync(backupsDir).filter((f) => /^sessions-\d{4}-\d{2}-\d{2}\.db$/.test(f));
    expect(backupFiles).toHaveLength(1);
  });

  it('creates a new backup on a new day', async () => {
    const logger = makeSpyLogger();
    let now = FIXED_NOW();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: () => now });

    await svc.tick();
    now = new Date('2026-08-21T10:00:00');
    await svc.tick();

    expect(existsSync(join(backupsDir, 'sessions-2026-08-20.db'))).toBe(true);
    expect(existsSync(join(backupsDir, 'sessions-2026-08-21.db'))).toBe(true);
  });

  it('prunes to the 7 lexicographically-newest backups', async () => {
    const logger = makeSpyLogger();
    // Pre-seed 9 dummy backup files for 2026-08-01 .. 2026-08-09 — plain junk
    // content is fine since pruning is name-based, not content-based.
    const dummyDays = ['01', '02', '03', '04', '05', '06', '07', '08', '09'];
    mkdirSync(backupsDir, { recursive: true });
    for (const d of dummyDays) {
      writeFileSync(join(backupsDir, `sessions-2026-08-${d}.db`), 'junk');
    }
    // A reader that opened an old backup leaves WAL sidecars beside it — they
    // must be pruned along with their backup, and only theirs.
    writeFileSync(join(backupsDir, 'sessions-2026-08-01.db-wal'), 'junk');
    writeFileSync(join(backupsDir, 'sessions-2026-08-01.db-shm'), 'junk');
    writeFileSync(join(backupsDir, 'sessions-2026-08-09.db-wal'), 'junk');

    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });
    await svc.tick();

    const remaining = readdirSync(backupsDir)
      .filter((f) => /^sessions-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort()
      .reverse();
    expect(remaining).toHaveLength(DATABASE_BACKUP_RETAIN_COUNT);
    expect(remaining).toEqual([
      'sessions-2026-08-20.db',
      'sessions-2026-08-09.db',
      'sessions-2026-08-08.db',
      'sessions-2026-08-07.db',
      'sessions-2026-08-06.db',
      'sessions-2026-08-05.db',
      'sessions-2026-08-04.db',
    ]);
    // The oldest three (01, 02, 03) must be gone, including 01's sidecars —
    // while the retained 09's sidecar survives with its backup.
    expect(existsSync(join(backupsDir, 'sessions-2026-08-01.db'))).toBe(false);
    expect(existsSync(join(backupsDir, 'sessions-2026-08-01.db-wal'))).toBe(false);
    expect(existsSync(join(backupsDir, 'sessions-2026-08-01.db-shm'))).toBe(false);
    expect(existsSync(join(backupsDir, 'sessions-2026-08-02.db'))).toBe(false);
    expect(existsSync(join(backupsDir, 'sessions-2026-08-03.db'))).toBe(false);
    expect(existsSync(join(backupsDir, 'sessions-2026-08-09.db-wal'))).toBe(true);
  });

  it('sweeps a stale .partial left over from a crash', async () => {
    const logger = makeSpyLogger();
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(join(backupsDir, 'sessions-2026-08-19.db.partial'), 'stale');

    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });
    await svc.tick();

    expect(existsSync(join(backupsDir, 'sessions-2026-08-19.db.partial'))).toBe(false);
    expect(existsSync(join(backupsDir, 'sessions-2026-08-20.db'))).toBe(true);
  });

  it('leaves no .partial behind after a successful tick', async () => {
    const logger = makeSpyLogger();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });

    await svc.tick();

    const leftoverPartials = readdirSync(backupsDir).filter((f) => f.endsWith('.partial'));
    expect(leftoverPartials).toHaveLength(0);
  });

  it('fails soft when the backup cannot be written', async () => {
    const logger = makeSpyLogger();
    // Point backupsDir at a path that already exists as a FILE — mkdirSync
    // recursive fails against it, so every tick step downstream fails too.
    const notADir = join(tmpDir, 'backups-as-file');
    writeFileSync(notADir, 'i am a file, not a directory');

    const svc = new DatabaseBackupService({ db, backupsDir: notADir, logger, now: FIXED_NOW });

    await expect(svc.tick()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  describe('start()/stop() timer behavior', () => {
    it('ticks immediately, then on each interval; start()/stop() are idempotent', () => {
      vi.useFakeTimers();
      const logger = makeSpyLogger();
      const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });
      const tickSpy = vi.spyOn(svc, 'tick').mockResolvedValue(undefined);

      svc.start();
      expect(tickSpy).toHaveBeenCalledTimes(1);

      // A second start() while already running must not arm a second timer.
      svc.start();
      vi.advanceTimersByTime(DATABASE_BACKUP_TICK_INTERVAL_MS);
      expect(tickSpy).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(DATABASE_BACKUP_TICK_INTERVAL_MS);
      expect(tickSpy).toHaveBeenCalledTimes(3);

      svc.stop();
      vi.advanceTimersByTime(DATABASE_BACKUP_TICK_INTERVAL_MS * 2);
      expect(tickSpy).toHaveBeenCalledTimes(3);

      // A second stop() must be safe (no throw).
      expect(() => svc.stop()).not.toThrow();
    });
  });
});

describe('DatabaseBackupService — excluded tables', () => {
  it('names raw_events as the excluded table', () => {
    expect([...DATABASE_BACKUP_EXCLUDED_TABLES]).toEqual(['raw_events']);
  });

  it('empties raw_events in the backup while keeping every other table intact', async () => {
    seedRawEvents(db, 200);
    const logger = makeSpyLogger();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });

    await svc.tick();

    const targetPath = join(backupsDir, 'sessions-2026-08-20.db');
    // The TABLE survives — a restored database must keep the live schema.
    expect(countRows(targetPath, 'raw_events')).toBe(0);
    expect(readWidgetNames(targetPath)).toEqual(['alpha', 'beta']);
    // ...and the live database is untouched.
    expect(db.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 200 });
  });

  it('preserves the AUTOINCREMENT high-water mark so a restore cannot re-issue ids', async () => {
    seedRawEvents(db, 50);
    const logger = makeSpyLogger();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });

    await svc.tick();

    const targetPath = join(backupsDir, 'sessions-2026-08-20.db');
    expect(readSequence(targetPath, 'raw_events')).toBe(50);
  });

  it('shrinks the backup below the live database it was taken from', async () => {
    seedRawEvents(db, 2000);
    db.pragma('wal_checkpoint(TRUNCATE)');
    const logger = makeSpyLogger();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });

    await svc.tick();

    const targetPath = join(backupsDir, 'sessions-2026-08-20.db');
    expect(statSync(targetPath).size).toBeLessThan(statSync(dbPath).size / 2);
  });

  it('leaves no sidecars beside the published backup', async () => {
    seedRawEvents(db, 20);
    const logger = makeSpyLogger();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });

    await svc.tick();

    expect(readdirSync(backupsDir)).toEqual(['sessions-2026-08-20.db']);
  });

  it('publishes the full copy when stripping fails, rather than losing the snapshot', async () => {
    seedRawEvents(db, 10);
    // A BEFORE DELETE trigger that raises makes the strip throw deterministically.
    db.exec(
      "CREATE TRIGGER raw_events_no_delete BEFORE DELETE ON raw_events BEGIN SELECT RAISE(ABORT, 'nope'); END",
    );
    const logger = makeSpyLogger();
    const svc = new DatabaseBackupService({ db, backupsDir, logger, now: FIXED_NOW });

    await svc.tick();

    const targetPath = join(backupsDir, 'sessions-2026-08-20.db');
    expect(existsSync(targetPath)).toBe(true);
    // Fail-soft: an oversized backup is still a complete backup.
    expect(countRows(targetPath, 'raw_events')).toBe(10);
    expect(readWidgetNames(targetPath)).toEqual(['alpha', 'beta']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to strip excluded tables'),
      expect.anything(),
    );
  });
});
