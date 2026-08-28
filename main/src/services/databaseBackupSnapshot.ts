/**
 * databaseBackupSnapshot — the heavy half of a daily backup, factored out so it
 * can run OFF the Electron main thread (see databaseBackupWorker.ts).
 *
 * WHAT IT DOES. Given a freshly-written full snapshot of `sessions.db`, it:
 *   1. archives the `raw_events` rows the delta store has not seen yet into a
 *      new immutable delta file, then
 *   2. empties `raw_events` in the snapshot and VACUUMs it down to size.
 *
 * WHY A DELTA STORE AND NOT PLAIN EXCLUSION. `raw_events` is ~80% of the
 * database, so copying it into all seven retained daily backups is where the
 * backups directory's bulk comes from. But it is NOT disposable: the `messages`
 * table is empty by design and `raw_events` is the SOURCE OF TRUTH for
 * reconstructed chat history (see shared/types/chatMessage.ts), plus the
 * context-usage view, the run inspector, and Insights all read it. Dropping it
 * from backups would mean a restore that keeps your runs and silently loses
 * every conversation in them.
 *
 * The table is append-only with an AUTOINCREMENT id, so the fix is to store it
 * ONCE rather than seven times: each tick appends the rows above the previous
 * high-water mark to a new delta file, and the daily backups carry none of it.
 * Full fidelity is preserved — restoring means replaying the deltas back into a
 * daily backup (see databaseBackupRestore.ts).
 *
 * WHY DELTA FILES ARE IMMUTABLE AND NEVER PRUNED. They are the only copy of
 * that history outside the live database. The 7-day retention applies to the
 * daily `sessions-*.db` files, which are redundant with each other; it must
 * never apply here, or history older than a week would exist nowhere.
 *
 * WHY THE FILENAMES CARRY THE ID RANGE. The delta FILES are the watermark —
 * the same principle the daily backups already use (their existence is the
 * "did today run?" record). There is no separate "last archived id" row to
 * fall out of sync with what is actually on disk, and a delta file deleted by
 * hand is simply re-created on the next tick.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';

/** The table archived into delta files and emptied from the daily backups. */
export const DELTA_ARCHIVED_TABLE = 'raw_events';

/** `raw-events-<lo>-<hi>.db` — the id range a delta file covers, inclusive. */
const DELTA_FILENAME_RE = /^raw-events-(\d+)-(\d+)\.db$/;

/** Build the canonical delta filename for an inclusive id range. */
export function deltaFileName(lo: number, hi: number): string {
  return `raw-events-${lo}-${hi}.db`;
}

export interface ProcessSnapshotOptions {
  /** Path to the full snapshot to process IN PLACE. */
  snapshotPath: string;
  /** Directory holding the immutable delta files. Created as needed. */
  deltaDir: string;
}

export interface ProcessSnapshotResult {
  /** Absolute path of the delta file written, or null when there was nothing new. */
  deltaPath: string | null;
  /** How many rows the delta captured. */
  archivedRows: number;
  /** How many rows were then emptied out of the snapshot. */
  strippedRows: number;
  /** Bytes the snapshot shrank by. */
  bytesReclaimed: number;
}

/**
 * Highest raw_events id any delta file already covers — 0 when the store is
 * empty. Files whose names do not parse are ignored rather than throwing: an
 * unrelated file in the directory must not be able to stall the archive.
 */
export function highestArchivedId(deltaDir: string): number {
  let entries: string[];
  try {
    entries = fs.readdirSync(deltaDir);
  } catch {
    return 0;
  }
  let highest = 0;
  for (const entry of entries) {
    const match = DELTA_FILENAME_RE.exec(entry);
    if (match === null) continue;
    const hi = Number(match[2]);
    if (Number.isSafeInteger(hi) && hi > highest) highest = hi;
  }
  return highest;
}

/** Column list of `table` as `"name" type` pairs, straight from the snapshot. */
function columnDefinitions(db: Database.Database, table: string): string {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
  // Types are carried over but constraints deliberately are NOT: a delta file
  // is an archive shard, so its rows must not be rejected by a foreign key to
  // a workflow_runs table the shard does not contain.
  return columns.map((c) => `"${c.name}" ${c.type === '' ? 'BLOB' : c.type}`).join(', ');
}

/**
 * Archive-then-strip one snapshot. Throws on failure — the caller decides what
 * to publish, because a half-processed snapshot must never be passed off as a
 * complete backup.
 */
export function processSnapshot(options: ProcessSnapshotOptions): ProcessSnapshotResult {
  const { snapshotPath, deltaDir } = options;
  const sizeBefore = fs.statSync(snapshotPath).size;

  const db = new Database(snapshotPath);
  let deltaPath: string | null = null;
  let archivedRows = 0;
  let strippedRows = 0;

  try {
    const present = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(DELTA_ARCHIVED_TABLE);
    // A snapshot without the table (a much older schema) is left exactly as it
    // is: there is nothing to archive and nothing to reclaim.
    if (present === undefined) {
      return { deltaPath: null, archivedRows: 0, strippedRows: 0, bytesReclaimed: 0 };
    }

    const maxRow = db.prepare(`SELECT MAX(id) AS maxId FROM ${DELTA_ARCHIVED_TABLE}`).get() as {
      maxId: number | null;
    };
    const maxId = maxRow.maxId ?? 0;
    const lastArchived = highestArchivedId(deltaDir);

    if (maxId > lastArchived) {
      fs.mkdirSync(deltaDir, { recursive: true });
      const lo = lastArchived + 1;
      const finalPath = path.join(deltaDir, deltaFileName(lo, maxId));
      const partialPath = `${finalPath}.partial`;
      // A leftover from a crashed run is dead by definition — only one tick
      // runs at a time and the app holds a single-instance lock.
      if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);

      db.exec(`ATTACH DATABASE '${partialPath.replace(/'/g, "''")}' AS delta`);
      try {
        db.exec(`CREATE TABLE delta.${DELTA_ARCHIVED_TABLE} (${columnDefinitions(db, DELTA_ARCHIVED_TABLE)})`);
        const copied = db
          .prepare(
            `INSERT INTO delta.${DELTA_ARCHIVED_TABLE} SELECT * FROM main.${DELTA_ARCHIVED_TABLE} WHERE id > ?`,
          )
          .run(lastArchived);
        archivedRows = copied.changes;
      } finally {
        db.exec('DETACH DATABASE delta');
      }

      // Publish the delta BEFORE touching the snapshot. Until this rename
      // lands, nothing has been promised and a crash simply redoes the work;
      // after it, the rows are safe on disk and stripping them is sound.
      fs.renameSync(partialPath, finalPath);
      deltaPath = finalPath;
    }

    const remaining = db.prepare(`SELECT COUNT(*) AS n FROM ${DELTA_ARCHIVED_TABLE}`).get() as { n: number };
    strippedRows = remaining.n;

    // The high-water mark lives in sqlite_sequence, and a WHERE-less DELETE
    // takes SQLite's truncate optimisation, which drops that row along with
    // the data. It has to go back: restore reads it to decide which delta rows
    // belong to this backup, and without it a restored database would also
    // re-issue ids the live one already handed out.
    const hasSequence =
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get() !==
      undefined;
    const sequence = hasSequence
      ? (db.prepare('SELECT MAX(seq) AS seq FROM sqlite_sequence WHERE name = ?').get(DELTA_ARCHIVED_TABLE) as
          | { seq: number | null }
          | undefined)
      : undefined;

    db.exec(`DELETE FROM ${DELTA_ARCHIVED_TABLE}`);
    if (sequence?.seq != null) {
      // sqlite_sequence is an internal table with NO unique index on `name`,
      // so INSERT OR REPLACE cannot replace anything — it just appends a
      // second row for the same table and makes the watermark ambiguous.
      // Delete-then-insert is the only way to leave exactly one row, and it is
      // correct whether or not the DELETE above took the truncate optimisation
      // (which drops the row on some paths and not others).
      db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(DELTA_ARCHIVED_TABLE);
      db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(
        DELTA_ARCHIVED_TABLE,
        sequence.seq,
      );
    }

    // Deleting rows only moves their pages onto the freelist; the file stays
    // full size until VACUUM rewrites it, and shrinking it is the entire point.
    db.exec('VACUUM');
  } finally {
    db.close();
  }

  return {
    deltaPath,
    archivedRows,
    strippedRows,
    bytesReclaimed: sizeBefore - fs.statSync(snapshotPath).size,
  };
}
