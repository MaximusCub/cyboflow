/**
 * databaseBackupSnapshot tests — the archive-then-strip half of a daily backup.
 *
 * Every test drives REAL file-backed SQLite databases, because the whole point
 * of this module is what ends up on disk: a shard that genuinely holds the
 * rows, and a snapshot that genuinely got smaller.
 *
 * The lineage tests are the important ones. They cover the failure this design
 * exists to prevent: an archive that keeps appending across a restore, so that
 * a rollback's new events are stripped from backups and the discarded
 * timeline's rows are replayed in their place.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { processSnapshot } from '../databaseBackupSnapshot';
import { restoreRawEvents } from '../databaseBackupRestore';
import { listShards, readCurrentLineage, listLineages, readArchiveMarker } from '../databaseBackupArchive';

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
  db.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO workflow_runs (id, name) VALUES (?, ?)').run('run-1', 'alpha');
  db.prepare('INSERT INTO widgets (name) VALUES (?)').run('kept');
  db.close();
}

function addEvents(path: string, count: number, tag = 'payload', payloadBytes = 0): void {
  const db = new Database(path);
  const insert = db.prepare('INSERT INTO raw_events (run_id, event_type, payload_json) VALUES (?, ?, ?)');
  const filler = payloadBytes > 0 ? 'x'.repeat(payloadBytes) : '';
  db.transaction(() => {
    for (let i = 0; i < count; i++) insert.run('run-1', 'user', `${tag}${filler}`);
  })();
  db.close();
}

/** Take a daily backup the way the service does. */
function takeBackup(name: string): string {
  const backupPath = join(tmpDir, name);
  copyFileSync(livePath, backupPath);
  processSnapshot({ snapshotPath: backupPath, deltaDir });
  return backupPath;
}

function query<T>(path: string, sql: string): T[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function payloads(path: string): string[] {
  return query<{ payload_json: string }>(path, 'SELECT payload_json FROM raw_events ORDER BY id').map(
    (r) => r.payload_json,
  );
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-backup-snapshot-'));
  deltaDir = join(tmpDir, 'raw-events');
  livePath = join(tmpDir, 'sessions.db');
  makeLiveDb(livePath);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('processSnapshot — archiving', () => {
  it('archives every row into a shard named for its id range', () => {
    addEvents(livePath, 10);

    const result = processSnapshot({ snapshotPath: takeBackupPathOnly('b.db'), deltaDir });

    expect(result.archivedRows).toBe(10);
    expect(result.lineage).toBe('lineage-0001');
    expect(readdirSync(join(deltaDir, 'lineage-0001'))).toEqual(['raw-events-1-10.db']);
    expect(query<{ n: number }>(result.shardPath!, 'SELECT COUNT(*) AS n FROM raw_events')[0].n).toBe(10);
  });

  /** Copy the live db to a path and return it WITHOUT processing. */
  function takeBackupPathOnly(name: string): string {
    const p = join(tmpDir, name);
    copyFileSync(livePath, p);
    return p;
  }

  it('empties raw_events from the backup but keeps the table and every other table', () => {
    addEvents(livePath, 10);

    const backupPath = takeBackup('sessions-2026-08-20.db');

    expect(query<{ n: number }>(backupPath, 'SELECT COUNT(*) AS n FROM raw_events')[0].n).toBe(0);
    expect(query<{ name: string }>(backupPath, 'SELECT name FROM widgets')).toEqual([{ name: 'kept' }]);
    expect(query<{ id: string }>(backupPath, 'SELECT id FROM workflow_runs')).toEqual([{ id: 'run-1' }]);
  });

  it('stamps the backup with its lineage and watermark', () => {
    addEvents(livePath, 7);

    const backupPath = takeBackup('sessions-2026-08-20.db');

    const db = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      expect(readArchiveMarker(db)).toEqual({ lineage: 'lineage-0001', watermark: 7 });
    } finally {
      db.close();
    }
  });

  it('leaves exactly one sqlite_sequence row (the table has no unique index)', () => {
    addEvents(livePath, 7);

    const backupPath = takeBackup('sessions-2026-08-20.db');

    expect(query<{ n: number }>(backupPath, "SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name='raw_events'")).toEqual(
      [{ n: 1 }],
    );
  });

  it('archives only the rows above the previous watermark on a later run', () => {
    addEvents(livePath, 5);
    takeBackup('sessions-2026-08-26.db');
    addEvents(livePath, 3);

    const second = processSnapshot({ snapshotPath: takeBackupPathOnly('sessions-2026-08-27.db'), deltaDir });

    expect(second.archivedRows).toBe(3);
    expect(second.shardPath).toBe(join(deltaDir, 'lineage-0001', 'raw-events-6-8.db'));
    expect(readdirSync(join(deltaDir, 'lineage-0001')).sort()).toEqual([
      'raw-events-1-5.db',
      'raw-events-6-8.db',
    ]);
  });

  it('writes no shard when there is nothing new to archive', () => {
    addEvents(livePath, 5);
    takeBackup('sessions-2026-08-26.db');

    const second = processSnapshot({ snapshotPath: takeBackupPathOnly('sessions-2026-08-27.db'), deltaDir });

    expect(second.shardPath).toBeNull();
    expect(second.archivedRows).toBe(0);
    expect(second.lineageMinted).toBe(false);
    expect(readdirSync(join(deltaDir, 'lineage-0001'))).toEqual(['raw-events-1-5.db']);
  });

  it('leaves a snapshot without a raw_events table untouched', () => {
    const strayPath = join(tmpDir, 'stray.db');
    const stray = new Database(strayPath);
    stray.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)');
    stray.close();

    const result = processSnapshot({ snapshotPath: strayPath, deltaDir });

    expect(result.archivedRows).toBe(0);
    expect(result.shardPath).toBeNull();
    expect(existsSync(deltaDir)).toBe(false);
  });

  it('shrinks the snapshot by compacting after the strip', () => {
    addEvents(livePath, 2000, 'p', 2048);
    const snapshotPath = takeBackupPathOnly('sessions-2026-08-20.db');
    const before = statSync(snapshotPath).size;

    const result = processSnapshot({ snapshotPath, deltaDir });

    expect(statSync(snapshotPath).size).toBeLessThan(before / 2);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
  });

  it('leaves no .partial behind after a successful run', () => {
    addEvents(livePath, 10);

    takeBackup('sessions-2026-08-20.db');

    expect(readdirSync(join(deltaDir, 'lineage-0001')).some((f) => f.includes('.partial'))).toBe(false);
  });
});

describe('processSnapshot — lineages across a restore', () => {
  /**
   * The regression this whole design exists for. Before lineages, the events
   * written after a rollback were stripped from the next backup and the
   * rolled-back timeline's rows were replayed in their place — silently.
   */
  it('does not lose post-rollback events or resurrect the discarded timeline', () => {
    addEvents(livePath, 10, 'ORIGINAL');
    const dayA = takeBackup('sessions-A.db');
    addEvents(livePath, 10, 'LATER-DISCARDED');
    takeBackup('sessions-B.db');

    // Disaster: roll back to day A and carry on.
    copyFileSync(dayA, livePath);
    restoreRawEvents(livePath, deltaDir);
    expect(payloads(livePath).every((p) => p === 'ORIGINAL')).toBe(true);
    addEvents(livePath, 5, 'NEW-AFTER-ROLLBACK');

    const dayC = takeBackup('sessions-C.db');
    restoreRawEvents(dayC, deltaDir);

    const restored = payloads(dayC);
    expect(restored.filter((p) => p === 'NEW-AFTER-ROLLBACK')).toHaveLength(5);
    expect(restored).not.toContain('LATER-DISCARDED');
    expect(restored.filter((p) => p === 'ORIGINAL')).toHaveLength(10);
  });

  it('mints a fresh lineage when the restored database rejoins the archive', () => {
    addEvents(livePath, 10);
    const dayA = takeBackup('sessions-A.db');
    addEvents(livePath, 10);
    takeBackup('sessions-B.db');

    copyFileSync(dayA, livePath);
    restoreRawEvents(livePath, deltaDir);
    const dayC = processSnapshot({ snapshotPath: (() => {
      const p = join(tmpDir, 'sessions-C.db');
      copyFileSync(livePath, p);
      return p;
    })(), deltaDir });

    expect(dayC.lineageMinted).toBe(true);
    expect(dayC.lineage).toBe('lineage-0002');
    expect(readCurrentLineage(deltaDir)).toBe('lineage-0002');
    // The old lineage is retained — backups still point at it.
    expect(listLineages(deltaDir)).toEqual(['lineage-0001', 'lineage-0002']);
    expect(listShards(deltaDir, 'lineage-0001')).toHaveLength(2);
  });

  it('mints the new lineage ONCE, not on every subsequent tick', () => {
    addEvents(livePath, 10);
    const dayA = takeBackup('sessions-A.db');
    addEvents(livePath, 10);
    takeBackup('sessions-B.db');

    copyFileSync(dayA, livePath);
    restoreRawEvents(livePath, deltaDir);

    // Three more days of ordinary operation after the rollback. The live
    // database keeps its marker forever, so without the consumed-origin record
    // this would mint lineage-0003, -0004, -0005 and re-archive every time.
    takeBackup('sessions-C.db');
    addEvents(livePath, 2);
    takeBackup('sessions-D.db');
    addEvents(livePath, 2);
    const dayE = processSnapshot({ snapshotPath: (() => {
      const p = join(tmpDir, 'sessions-E.db');
      copyFileSync(livePath, p);
      return p;
    })(), deltaDir });

    expect(listLineages(deltaDir)).toEqual(['lineage-0001', 'lineage-0002']);
    expect(dayE.lineageMinted).toBe(false);
    expect(dayE.lineage).toBe('lineage-0002');
  });

  it('detects a rewound id space even without a marker', () => {
    addEvents(livePath, 20);
    takeBackup('sessions-A.db');

    // A database whose id space is behind the archive, carrying no marker at
    // all — e.g. restored by a tool that copied only the tables it knew about.
    const rewound = join(tmpDir, 'rewound.db');
    makeLiveDb(rewound);
    addEvents(rewound, 5);

    const result = processSnapshot({ snapshotPath: rewound, deltaDir });

    expect(result.lineageMinted).toBe(true);
    expect(result.lineage).toBe('lineage-0002');
  });

  it('detects a database that disagrees with the archive about an archived row', () => {
    addEvents(livePath, 10);
    takeBackup('sessions-A.db');

    // Same ids, different content: a divergent timeline that happens to have
    // caught back up in row count.
    const forked = join(tmpDir, 'forked.db');
    makeLiveDb(forked);
    addEvents(forked, 12, 'DIFFERENT');

    const result = processSnapshot({ snapshotPath: forked, deltaDir });

    expect(result.lineageMinted).toBe(true);
    expect(result.lineage).toBe('lineage-0002');
  });
});

describe('processSnapshot — archive integrity', () => {
  it('fails closed when a shard in the middle of the cover is missing', () => {
    addEvents(livePath, 5);
    takeBackup('sessions-A.db');
    addEvents(livePath, 5);
    takeBackup('sessions-B.db');
    rmSync(join(deltaDir, 'lineage-0001', 'raw-events-1-5.db'));
    addEvents(livePath, 5);

    expect(() => takeBackup('sessions-C.db')).toThrow(/gap or overlap/);
  });

  it('fails closed on a shard that is not a usable database', () => {
    addEvents(livePath, 5);
    takeBackup('sessions-A.db');
    // A zero-byte file is a VALID but EMPTY SQLite database — it opens fine and
    // has no tables, which is exactly how a truncated shard would present.
    writeFileSync(join(deltaDir, 'lineage-0001', 'raw-events-6-99.db'), '');
    addEvents(livePath, 5);

    expect(() => takeBackup('sessions-B.db')).toThrow(/no raw_events table/);
  });

  it('fails closed on a shard holding ids outside its declared range', () => {
    addEvents(livePath, 5);
    takeBackup('sessions-A.db');
    // Rename the shard to claim a range it does not hold.
    const dir = join(deltaDir, 'lineage-0001');
    copyFileSync(join(dir, 'raw-events-1-5.db'), join(dir, 'raw-events-1-2.db'));
    rmSync(join(dir, 'raw-events-1-5.db'));
    addEvents(livePath, 5);

    expect(() => takeBackup('sessions-B.db')).toThrow(/above its declared range/);
  });
});
