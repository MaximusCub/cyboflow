/**
 * databaseBackupRestore tests — replaying archived raw_events shards back into
 * a daily backup.
 *
 * These are the tests that make the delta scheme trustworthy: a backup you
 * cannot restore is not a backup, so the round trip is asserted end to end
 * against real files. The refusal cases matter just as much as the happy path —
 * a restore that reports success over an incomplete archive is worse than one
 * that stops, because the result looks recovered and simply reads as though
 * history ended early.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { processSnapshot } from '../databaseBackupSnapshot';
import { restoreRawEvents } from '../databaseBackupRestore';

let tmpDir: string;
let deltaDir: string;
let livePath: string;

function makeLiveDb(path: string): void {
  const db = new Database(path);
  db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, name TEXT)');
  db.exec(
    `CREATE TABLE raw_events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       run_id TEXT NOT NULL,
       event_type TEXT NOT NULL,
       payload_json TEXT NOT NULL
     )`,
  );
  db.prepare('INSERT INTO workflow_runs (id, name) VALUES (?, ?)').run('run-1', 'alpha');
  db.close();
}

function addEvents(path: string, count: number, runId = 'run-1'): void {
  const db = new Database(path);
  const insert = db.prepare('INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run(runId, 'user', `payload-${i}`);
  })();
  db.close();
}

function events(path: string): { id: number; payload_json: string }[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT id, payload_json FROM raw_events ORDER BY id').all() as {
      id: number;
      payload_json: string;
    }[];
  } finally {
    db.close();
  }
}

/** Take a backup the way the service does: snapshot, then archive-and-strip. */
function takeBackup(name: string): string {
  const backupPath = join(tmpDir, name);
  copyFileSync(livePath, backupPath);
  processSnapshot({ snapshotPath: backupPath, deltaDir });
  return backupPath;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-backup-restore-'));
  deltaDir = join(tmpDir, 'raw-events');
  livePath = join(tmpDir, 'sessions.db');
  makeLiveDb(livePath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('restoreRawEvents', () => {
  it('round-trips: the restored backup matches the live database exactly', () => {
    addEvents(livePath, 25);
    const expected = events(livePath);
    const backupPath = takeBackup('sessions-2026-08-28.db');
    expect(events(backupPath)).toEqual([]);

    const result = restoreRawEvents(backupPath, deltaDir);

    expect(result.restoredRows).toBe(25);
    expect(result.lineage).toBe('lineage-0001');
    expect(events(backupPath)).toEqual(expected);
  });

  it('reassembles history spread across several days of shards', () => {
    addEvents(livePath, 10);
    takeBackup('sessions-2026-08-26.db');
    addEvents(livePath, 10);
    takeBackup('sessions-2026-08-27.db');
    addEvents(livePath, 10);
    const expected = events(livePath);
    const latest = takeBackup('sessions-2026-08-28.db');

    const result = restoreRawEvents(latest, deltaDir);

    expect(result.appliedFiles).toEqual([
      'raw-events-1-10.db',
      'raw-events-11-20.db',
      'raw-events-21-30.db',
    ]);
    expect(events(latest)).toEqual(expected);
  });

  it('never grafts newer events onto an older backup', () => {
    addEvents(livePath, 10);
    const older = takeBackup('sessions-2026-08-26.db');
    addEvents(livePath, 40);
    takeBackup('sessions-2026-08-28.db');

    const result = restoreRawEvents(older, deltaDir);

    expect(result.watermark).toBe(10);
    expect(result.restoredRows).toBe(10);
    expect(events(older).map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('is idempotent — a second restore adds nothing', () => {
    addEvents(livePath, 12);
    const backupPath = takeBackup('sessions-2026-08-28.db');

    restoreRawEvents(backupPath, deltaDir);
    const second = restoreRawEvents(backupPath, deltaDir);

    expect(second.restoredRows).toBe(0);
    expect(events(backupPath)).toHaveLength(12);
  });

  it('does not resurrect events whose run was deleted before the backup', () => {
    addEvents(livePath, 5);
    addEvents(livePath, 5, 'run-doomed');
    const live = new Database(livePath);
    live.prepare('DELETE FROM raw_events WHERE run_id = ?').run('run-doomed');
    live.close();
    const backupPath = takeBackup('sessions-2026-08-28.db');

    restoreRawEvents(backupPath, deltaDir);

    expect(events(backupPath).map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('skips a backup that never held any events', () => {
    const backupPath = takeBackup('sessions-2026-08-28.db');

    const result = restoreRawEvents(backupPath, deltaDir);

    expect(result.restoredRows).toBe(0);
    expect(result.skipped).toMatch(/held no events/);
  });

  it('skips a pre-scheme backup that still carries its own rows', () => {
    addEvents(livePath, 8);
    const full = join(tmpDir, 'sessions-legacy.db');
    copyFileSync(livePath, full); // never processed, so no marker and rows intact

    const result = restoreRawEvents(full, deltaDir);

    expect(result.skipped).toMatch(/carries its own raw_events rows/);
    expect(events(full)).toHaveLength(8);
  });

  it('refuses a stripped backup that carries no marker', () => {
    addEvents(livePath, 8);
    const backupPath = takeBackup('sessions-2026-08-28.db');
    const db = new Database(backupPath);
    db.exec('DROP TABLE raw_events_archive');
    db.close();

    expect(() => restoreRawEvents(backupPath, deltaDir)).toThrow(/cannot tell which lineage/);
  });

  it('refuses rather than half-restoring when a shard is missing', () => {
    addEvents(livePath, 10);
    takeBackup('sessions-2026-08-26.db');
    addEvents(livePath, 10);
    const latest = takeBackup('sessions-2026-08-28.db');
    rmSync(join(deltaDir, 'lineage-0001', 'raw-events-1-10.db'));

    expect(() => restoreRawEvents(latest, deltaDir)).toThrow(/not intact/);
    // The target is untouched — no confidently partial history.
    expect(events(latest)).toEqual([]);
  });

  it('refuses when a shard is corrupt', () => {
    addEvents(livePath, 10);
    const latest = takeBackup('sessions-2026-08-28.db');
    writeFileSync(join(deltaDir, 'lineage-0001', 'raw-events-1-10.db'), 'not a database');

    expect(() => restoreRawEvents(latest, deltaDir)).toThrow(/not intact/);
    expect(events(latest)).toEqual([]);
  });

  it('refuses when the archive does not reach the backup watermark', () => {
    addEvents(livePath, 10);
    const latest = takeBackup('sessions-2026-08-28.db');
    // Truncate the cover: drop the only shard, leaving the lineage short.
    rmSync(join(deltaDir, 'lineage-0001', 'raw-events-1-10.db'));

    expect(() => restoreRawEvents(latest, deltaDir)).toThrow(/no shards|covers ids up to/);
  });

  it('throws when the target has no raw_events table to restore into', () => {
    const strayPath = join(tmpDir, 'stray.db');
    const stray = new Database(strayPath);
    stray.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY)');
    stray.close();

    expect(() => restoreRawEvents(strayPath, deltaDir)).toThrow(/no raw_events table/);
  });
});
