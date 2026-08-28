/**
 * databaseBackupRestore — replay archived `raw_events` deltas back into a daily
 * backup, reconstituting the full database a restore needs.
 *
 * A daily `sessions-YYYY-MM-DD.db` carries every table EXCEPT the rows of
 * `raw_events`, which are archived once into immutable delta files instead of
 * seven times into the retained backups (see databaseBackupSnapshot.ts for
 * why). Restoring is therefore two steps: take the daily backup you want, then
 * run this to pour the history back in.
 *
 * WHY THE WATERMARK MATTERS. The delta store keeps growing after a given day's
 * backup was taken, so it holds events that did not exist yet on that day.
 * Replaying those into an older backup would graft future conversations onto a
 * past snapshot. `sqlite_sequence` records the highest id the database had ever
 * issued at the moment it was snapshotted — it is preserved through the strip
 * precisely so it can serve as that cut-off here.
 *
 * IDEMPOTENT. Rows are inserted OR IGNORE, so running this twice, or against a
 * backup that still has its rows (one taken before this scheme existed), adds
 * nothing the second time.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { DELTA_ARCHIVED_TABLE } from './databaseBackupSnapshot';

/** `raw-events-<lo>-<hi>.db`, captured so deltas replay in id order. */
const DELTA_FILENAME_RE = /^raw-events-(\d+)-(\d+)\.db$/;

export interface RestoreResult {
  /** Delta files actually replayed, in the order they were applied. */
  appliedFiles: string[];
  /** Rows inserted across all deltas. */
  restoredRows: number;
  /** The id cut-off taken from the backup's sqlite_sequence. */
  watermark: number;
}

/** Delta files in ascending id order. */
function deltaFilesInOrder(deltaDir: string): { file: string; lo: number }[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(deltaDir);
  } catch {
    return [];
  }
  const parsed: { file: string; lo: number }[] = [];
  for (const entry of entries) {
    const match = DELTA_FILENAME_RE.exec(entry);
    if (match === null) continue;
    parsed.push({ file: entry, lo: Number(match[1]) });
  }
  return parsed.sort((a, b) => a.lo - b.lo);
}

/** Column names of `table` in the given schema (`main` or an attached alias). */
function columnNames(db: Database.Database, schema: string, table: string): string[] {
  const columns = db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[];
  return columns.map((c) => c.name);
}

/**
 * Replay every applicable delta into the backup at `backupPath`, in place.
 * Throws if the backup has no `raw_events` table to restore into.
 */
export function restoreRawEvents(backupPath: string, deltaDir: string): RestoreResult {
  const db = new Database(backupPath);
  const applied: string[] = [];
  let restoredRows = 0;

  try {
    const present = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(DELTA_ARCHIVED_TABLE);
    if (present === undefined) {
      throw new Error(`${backupPath} has no ${DELTA_ARCHIVED_TABLE} table to restore into`);
    }

    // MAX rather than a bare SELECT: sqlite_sequence has no unique index on
    // `name`, so a database written by other tooling can legitimately carry
    // more than one row for a table, and the watermark is the highest of them.
    const sequence = db
      .prepare('SELECT MAX(seq) AS seq FROM sqlite_sequence WHERE name = ?')
      .get(DELTA_ARCHIVED_TABLE) as { seq: number | null } | undefined;
    // No sequence row means the table was never written to in this database,
    // so there is no snapshot moment to cut the deltas at and nothing that
    // could legitimately belong to it.
    const watermark = sequence?.seq ?? 0;
    if (watermark === 0) return { appliedFiles: [], restoredRows: 0, watermark: 0 };

    const targetColumns = columnNames(db, 'main', DELTA_ARCHIVED_TABLE);

    for (const { file } of deltaFilesInOrder(deltaDir)) {
      const deltaPath = path.join(deltaDir, file);
      db.exec(`ATTACH DATABASE '${deltaPath.replace(/'/g, "''")}' AS delta`);
      try {
        // Intersect the column sets: a delta written before a migration added a
        // column simply does not carry it, and must still replay cleanly.
        const shared = targetColumns.filter((c) => columnNames(db, 'delta', DELTA_ARCHIVED_TABLE).includes(c));
        const list = shared.map((c) => `"${c}"`).join(', ');
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO main.${DELTA_ARCHIVED_TABLE} (${list})
             SELECT ${list} FROM delta.${DELTA_ARCHIVED_TABLE}
             WHERE id <= ?
               AND run_id IN (SELECT id FROM main.workflow_runs)`,
          )
          .run(watermark);
        if (inserted.changes > 0) {
          restoredRows += inserted.changes;
          applied.push(file);
        }
      } finally {
        db.exec('DETACH DATABASE delta');
      }
    }

    return { appliedFiles: applied, restoredRows, watermark };
  } finally {
    db.close();
  }
}
