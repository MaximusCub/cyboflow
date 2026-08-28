/**
 * databaseBackupRestore — replay archived `raw_events` shards back into a daily
 * backup, reconstituting the full database a recovery needs.
 *
 * A daily `sessions-YYYY-MM-DD.db` carries every table EXCEPT the rows of
 * `raw_events`, which are archived once into immutable shards instead of seven
 * times into the retained backups (see databaseBackupSnapshot.ts for why).
 * Recovering is therefore two steps: take the daily backup you want, then run
 * this to pour the history back in. `scripts/restore-backup.cjs` is the
 * operator-facing wrapper; docs/BACKUP-RESTORE.md is the procedure.
 *
 * WHY IT READS THE MARKER RATHER THAN JUST SCANNING THE STORE. The archive is
 * partitioned into lineages, and a backup belongs to exactly one of them. The
 * marker the strip stamped into the backup names that lineage and the id it was
 * cut at, so a restore can neither reach into a sibling timeline's shards nor
 * replay events that did not exist yet when the backup was taken.
 *
 * VALIDATES BEFORE IT WRITES. Coverage is proven complete up to the watermark
 * first; a missing or corrupt shard aborts with the target untouched rather
 * than producing a confidently partial history.
 *
 * IDEMPOTENT. Rows go in OR IGNORE, so running this twice — or against a backup
 * that still has its rows, taken before this scheme existed — adds nothing the
 * second time.
 */
import Database from 'better-sqlite3';
import {
  DELTA_ARCHIVED_TABLE,
  listShards,
  probeShardWith,
  readArchiveMarker,
  validateShards,
} from './databaseBackupArchive';

export interface RestoreResult {
  /** Lineage the backup named, or null when it carried no marker. */
  lineage: string | null;
  /** Shard files actually replayed, in the order they were applied. */
  appliedFiles: string[];
  /** Rows inserted across all shards. */
  restoredRows: number;
  /** The id cut-off taken from the backup's marker. */
  watermark: number;
  /** Set when the backup needed no restore, explaining why. */
  skipped?: string;
}

const probeShard = probeShardWith((p) => new Database(p, { readonly: true, fileMustExist: true }));

/** Column names of `table` in the given schema (`main` or an attached alias). */
function columnNames(db: Database.Database, schema: string, table: string): string[] {
  const columns = db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[];
  return columns.map((c) => c.name);
}

/**
 * Replay every applicable shard into the backup at `backupPath`, in place.
 * Throws if the backup cannot be restored — never leaves it partially filled.
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

    const existing = db.prepare(`SELECT COUNT(*) AS n FROM ${DELTA_ARCHIVED_TABLE}`).get() as { n: number };
    const marker = readArchiveMarker(db);

    if (marker === null) {
      // No marker means nothing ever stripped this database. If it still has
      // its rows it is a complete backup and needs no restore; if it is empty
      // there is no lineage to consult and guessing one could graft a foreign
      // timeline onto it.
      if (existing.n > 0) {
        return {
          lineage: null,
          appliedFiles: [],
          restoredRows: 0,
          watermark: 0,
          skipped: 'backup carries its own raw_events rows; no archive replay needed',
        };
      }
      throw new Error(
        `${backupPath} has an empty ${DELTA_ARCHIVED_TABLE} and no archive marker — cannot tell which lineage its history is in`,
      );
    }

    if (marker.watermark === 0) {
      return {
        lineage: marker.lineage,
        appliedFiles: [],
        restoredRows: 0,
        watermark: 0,
        skipped: 'the database held no events when this backup was taken',
      };
    }

    const shards = listShards(deltaDir, marker.lineage);
    if (shards.length === 0) {
      throw new Error(`archive lineage ${marker.lineage} has no shards under ${deltaDir}`);
    }

    // Prove the cover BEFORE writing anything: a partial restore that reports
    // success is worse than a refusal, because it looks like a recovered
    // database and reads as though history simply ended early.
    const integrity = validateShards(shards, probeShard);
    if (!integrity.ok) {
      throw new Error(`archive lineage ${marker.lineage} is not intact: ${integrity.reason}`);
    }
    if (integrity.coveredThrough < marker.watermark) {
      throw new Error(
        `archive lineage ${marker.lineage} covers ids up to ${integrity.coveredThrough}, but this backup needs ${marker.watermark}`,
      );
    }

    const targetColumns = columnNames(db, 'main', DELTA_ARCHIVED_TABLE);

    for (const shard of shards) {
      if (shard.lo > marker.watermark) break;
      db.exec(`ATTACH DATABASE '${shard.path.replace(/'/g, "''")}' AS shard`);
      try {
        // Intersect the column sets: a shard written before a migration added
        // a column simply does not carry it, and must still replay cleanly.
        const shardColumns = columnNames(db, 'shard', DELTA_ARCHIVED_TABLE);
        const shared = targetColumns.filter((c) => shardColumns.includes(c));
        const list = shared.map((c) => `"${c}"`).join(', ');
        const inserted = db
          .prepare(
            `INSERT OR IGNORE INTO main.${DELTA_ARCHIVED_TABLE} (${list})
             SELECT ${list} FROM shard.${DELTA_ARCHIVED_TABLE}
             WHERE id <= ?
               AND run_id IN (SELECT id FROM main.workflow_runs)`,
          )
          .run(marker.watermark);
        if (inserted.changes > 0) {
          restoredRows += inserted.changes;
          applied.push(shard.file);
        }
      } finally {
        db.exec('DETACH DATABASE shard');
      }
    }

    return { lineage: marker.lineage, appliedFiles: applied, restoredRows, watermark: marker.watermark };
  } finally {
    db.close();
  }
}
