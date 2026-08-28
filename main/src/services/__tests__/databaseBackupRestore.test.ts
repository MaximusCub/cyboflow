/**
 * databaseBackupRestore tests — replaying archived raw_events deltas back into
 * a daily backup.
 *
 * These are the tests that make the delta scheme trustworthy: a backup you
 * cannot restore is not a backup, so the round trip is asserted end to end
 * against real files rather than mocked out.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
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
       payload_json TEXT NOT NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    expect(events(backupPath)).toEqual(expected);
  });

  it('reassembles history spread across several days of deltas', () => {
    addEvents(livePath, 10);
    takeBackup('sessions-2026-08-26.db');
    addEvents(livePath, 10);
    takeBackup('sessions-2026-08-27.db');
    addEvents(livePath, 10);
    const expected = events(livePath);
    const latest = takeBackup('sessions-2026-08-28.db');

    const result = restoreRawEvents(latest, deltaDir);

    expect(result.appliedFiles).toEqual(['raw-events-1-10.db', 'raw-events-11-20.db', 'raw-events-21-30.db']);
    expect(events(latest)).toEqual(expected);
  });

  it('never grafts newer events onto an older backup', () => {
    addEvents(livePath, 10);
    const older = takeBackup('sessions-2026-08-26.db');
    // The delta store keeps growing after that backup was taken.
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
    // The run is removed from the live database; its events are archived
    // already, but the backup has no row to hang them on.
    const live = new Database(livePath);
    live.prepare('DELETE FROM raw_events WHERE run_id = ?').run('run-doomed');
    live.close();
    const backupPath = takeBackup('sessions-2026-08-28.db');

    restoreRawEvents(backupPath, deltaDir);

    expect(events(backupPath).map((e) => e.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it('restores nothing when the backup never held any events', () => {
    const backupPath = takeBackup('sessions-2026-08-28.db');

    const result = restoreRawEvents(backupPath, deltaDir);

    expect(result).toEqual({ appliedFiles: [], restoredRows: 0, watermark: 0 });
  });

  it('throws when the target has no raw_events table to restore into', () => {
    const strayPath = join(tmpDir, 'stray.db');
    const stray = new Database(strayPath);
    stray.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY)');
    stray.close();

    expect(() => restoreRawEvents(strayPath, deltaDir)).toThrow(/no raw_events table/);
  });
});
