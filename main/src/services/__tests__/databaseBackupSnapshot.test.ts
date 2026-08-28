/**
 * databaseBackupSnapshot tests — the archive-then-strip half of a daily backup.
 *
 * Every test drives REAL file-backed SQLite databases, because the whole point
 * of this module is what ends up on disk: a delta file that genuinely holds the
 * rows, and a snapshot that genuinely got smaller.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { processSnapshot, highestArchivedId, deltaFileName } from '../databaseBackupSnapshot';

let tmpDir: string;
let deltaDir: string;
let snapshotPath: string;

/** A snapshot shaped like the real one: runs, their events, and other state. */
function makeSnapshot(path: string, eventCount: number, payloadBytes = 64): void {
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
  db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO workflow_runs (id, name) VALUES (?, ?)').run('run-1', 'alpha');
  db.prepare('INSERT INTO widgets (name) VALUES (?)').run('kept');
  const insert = db.prepare('INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)');
  const payload = 'x'.repeat(payloadBytes);
  db.transaction(() => {
    for (let i = 0; i < eventCount; i++) insert.run('run-1', i % 2 === 0 ? 'user' : 'assistant', payload);
  })();
  db.close();
}

function appendEvents(path: string, count: number): void {
  const db = new Database(path);
  const insert = db.prepare('INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run('run-1', 'user', 'later');
  })();
  db.close();
}

function query<T>(path: string, sql: string): T[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-backup-snapshot-'));
  deltaDir = join(tmpDir, 'raw-events');
  snapshotPath = join(tmpDir, 'snapshot.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('highestArchivedId', () => {
  it('is 0 when the delta directory does not exist', () => {
    expect(highestArchivedId(join(tmpDir, 'nope'))).toBe(0);
  });

  it('takes the highest upper bound across delta files', () => {
    makeSnapshot(snapshotPath, 4);
    processSnapshot({ snapshotPath, deltaDir });
    writeFileSync(join(deltaDir, deltaFileName(5, 99)), '');
    expect(highestArchivedId(deltaDir)).toBe(99);
  });

  it('ignores files whose names do not parse', () => {
    makeSnapshot(snapshotPath, 4);
    processSnapshot({ snapshotPath, deltaDir });
    writeFileSync(join(deltaDir, 'README.txt'), 'not a delta');
    writeFileSync(join(deltaDir, 'raw-events-bogus.db'), '');
    expect(highestArchivedId(deltaDir)).toBe(4);
  });
});

describe('processSnapshot', () => {
  it('archives every row into a delta named for its id range', () => {
    makeSnapshot(snapshotPath, 10);

    const result = processSnapshot({ snapshotPath, deltaDir });

    expect(result.archivedRows).toBe(10);
    expect(result.deltaPath).toBe(join(deltaDir, 'raw-events-1-10.db'));
    expect(readdirSync(deltaDir)).toEqual(['raw-events-1-10.db']);
    expect(query<{ n: number }>(result.deltaPath!, 'SELECT COUNT(*) AS n FROM raw_events')[0].n).toBe(10);
  });

  it('empties raw_events from the snapshot but keeps the table and every other table', () => {
    makeSnapshot(snapshotPath, 10);

    processSnapshot({ snapshotPath, deltaDir });

    expect(query<{ n: number }>(snapshotPath, 'SELECT COUNT(*) AS n FROM raw_events')[0].n).toBe(0);
    expect(query<{ name: string }>(snapshotPath, 'SELECT name FROM widgets')).toEqual([{ name: 'kept' }]);
    expect(query<{ id: string }>(snapshotPath, 'SELECT id FROM workflow_runs')).toEqual([{ id: 'run-1' }]);
  });

  it('preserves the AUTOINCREMENT high-water mark as the restore watermark', () => {
    makeSnapshot(snapshotPath, 7);

    processSnapshot({ snapshotPath, deltaDir });

    const seq = query<{ seq: number }>(snapshotPath, "SELECT seq FROM sqlite_sequence WHERE name = 'raw_events'");
    expect(seq).toEqual([{ seq: 7 }]);
  });

  it('leaves exactly one sqlite_sequence row (the table has no unique index)', () => {
    makeSnapshot(snapshotPath, 7);

    processSnapshot({ snapshotPath, deltaDir });

    const rows = query<{ n: number }>(
      snapshotPath,
      "SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'raw_events'",
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it('archives only the rows above the previous watermark on a later run', () => {
    makeSnapshot(snapshotPath, 5);
    processSnapshot({ snapshotPath, deltaDir });

    // A fresh snapshot of a database that has kept growing.
    rmSync(snapshotPath);
    makeSnapshot(snapshotPath, 5);
    appendEvents(snapshotPath, 3);

    const second = processSnapshot({ snapshotPath, deltaDir });

    expect(second.archivedRows).toBe(3);
    expect(second.deltaPath).toBe(join(deltaDir, 'raw-events-6-8.db'));
    expect(readdirSync(deltaDir).sort()).toEqual(['raw-events-1-5.db', 'raw-events-6-8.db']);
  });

  it('writes no delta when there is nothing new to archive', () => {
    makeSnapshot(snapshotPath, 5);
    processSnapshot({ snapshotPath, deltaDir });

    rmSync(snapshotPath);
    makeSnapshot(snapshotPath, 5);
    const second = processSnapshot({ snapshotPath, deltaDir });

    expect(second.deltaPath).toBeNull();
    expect(second.archivedRows).toBe(0);
    expect(readdirSync(deltaDir)).toEqual(['raw-events-1-5.db']);
  });

  it('leaves a snapshot without a raw_events table untouched', () => {
    const db = new Database(snapshotPath);
    db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
    db.close();

    const result = processSnapshot({ snapshotPath, deltaDir });

    expect(result).toEqual({ deltaPath: null, archivedRows: 0, strippedRows: 0, bytesReclaimed: 0 });
    expect(existsSync(deltaDir)).toBe(false);
  });

  it('shrinks the snapshot by compacting after the strip', () => {
    makeSnapshot(snapshotPath, 2000, 2048);
    const before = statSync(snapshotPath).size;

    const result = processSnapshot({ snapshotPath, deltaDir });

    expect(statSync(snapshotPath).size).toBeLessThan(before / 2);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
  });

  it('leaves no .partial behind after a successful run', () => {
    makeSnapshot(snapshotPath, 10);

    processSnapshot({ snapshotPath, deltaDir });

    expect(readdirSync(deltaDir).some((f) => f.includes('.partial'))).toBe(false);
  });
});
