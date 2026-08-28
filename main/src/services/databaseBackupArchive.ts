/**
 * databaseBackupArchive — the shared vocabulary of the raw_events delta store:
 * lineages, shards, integrity, and the marker that binds a daily backup to the
 * archive it needs.
 *
 * WHY LINEAGES. The archive is an append-only continuation of an id space, and
 * a RESTORE rewinds that id space. Restore day 10, write new events, and those
 * events get ids 1001, 1002... — ids the archive already holds rows for, from
 * the timeline that was just discarded. Without a lineage the next backup sees
 * "1002 is below my watermark of 2000, nothing new to archive", strips the new
 * events, and a later restore replays the DISCARDED rows in their place. That
 * is silent history substitution on the exact path backups exist to serve.
 *
 * So the store is partitioned: shards live under `<deltaDir>/<lineage>/`, a
 * `CURRENT` file names the live one, and every tick checks whether the database
 * it is archiving is still a continuation of that lineage. When it is not, a
 * FRESH lineage is minted and archiving starts over from id 1. Old lineages are
 * never appended to and never deleted — a backup taken against one still needs
 * it. The daily backup records its own lineage in {@link ARCHIVE_MARKER_TABLE},
 * so restore can never reach for the wrong shards.
 *
 * WHY SHARDS ARE VALIDATED EVERY TICK. The filename carries the id range, which
 * makes the watermark cheap to read but trivially wrong if a shard is deleted
 * or truncated: coverage would silently skip those ids forever, stripping them
 * from every future backup while archiving them nowhere. Validation is what
 * lets the filenames stay authoritative — and it fails CLOSED, so an archive
 * that cannot be trusted downgrades the day to a full unprocessed backup rather
 * than quietly losing history.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

/** The table archived into shards and emptied from the daily backups. */
export const DELTA_ARCHIVED_TABLE = 'raw_events';

/** Single-row table stamped into every stripped backup, naming its archive. */
export const ARCHIVE_MARKER_TABLE = 'raw_events_archive';

/** Names the live lineage inside the delta directory. */
export const CURRENT_LINEAGE_FILE = 'CURRENT';

/** `raw-events-<lo>-<hi>.db` — the id range a shard covers, inclusive. */
const SHARD_FILENAME_RE = /^raw-events-(\d+)-(\d+)\.db$/;

/** `lineage-0001` — sorts lexicographically in mint order. */
const LINEAGE_DIRNAME_RE = /^lineage-(\d+)$/;

export interface ShardRef {
  /** Bare filename. */
  file: string;
  /** Absolute path. */
  path: string;
  /** First id this shard may contain, inclusive. */
  lo: number;
  /** Last id this shard may contain, inclusive. */
  hi: number;
}

export interface ArchiveMarker {
  /** Lineage directory name the backup's history lives in. */
  lineage: string;
  /** Highest id the database had issued when it was snapshotted. */
  watermark: number;
}

/** Canonical shard filename for an inclusive id range. */
export function shardFileName(lo: number, hi: number): string {
  return `raw-events-${lo}-${hi}.db`;
}

/** Canonical lineage directory name for a mint ordinal. */
export function lineageDirName(ordinal: number): string {
  return `lineage-${String(ordinal).padStart(4, '0')}`;
}

/** Every lineage directory present, in mint order. */
export function listLineages(deltaDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(deltaDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && LINEAGE_DIRNAME_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** The lineage currently being appended to, or null when the store is empty. */
export function readCurrentLineage(deltaDir: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(deltaDir, CURRENT_LINEAGE_FILE), 'utf8');
  } catch {
    return null;
  }
  const name = raw.trim();
  return LINEAGE_DIRNAME_RE.test(name) ? name : null;
}

/** Point CURRENT at `lineage`, creating the directory if needed. */
export function writeCurrentLineage(deltaDir: string, lineage: string): void {
  fs.mkdirSync(path.join(deltaDir, lineage), { recursive: true });
  fs.writeFileSync(path.join(deltaDir, CURRENT_LINEAGE_FILE), `${lineage}\n`, 'utf8');
}

/**
 * Mint a lineage one past the highest that exists. Numbering never reuses an
 * ordinal, so a second rollback cannot land back on a lineage whose shards
 * describe a different timeline.
 */
export function mintLineage(deltaDir: string): string {
  let highest = 0;
  for (const name of listLineages(deltaDir)) {
    const match = LINEAGE_DIRNAME_RE.exec(name);
    if (match === null) continue;
    const ordinal = Number(match[1]);
    if (Number.isSafeInteger(ordinal) && ordinal > highest) highest = ordinal;
  }
  const minted = lineageDirName(highest + 1);
  writeCurrentLineage(deltaDir, minted);
  return minted;
}

/** Shards of `lineage`, ascending by id. Unparseable filenames are ignored. */
export function listShards(deltaDir: string, lineage: string): ShardRef[] {
  const dir = path.join(deltaDir, lineage);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const shards: ShardRef[] = [];
  for (const file of entries) {
    const match = SHARD_FILENAME_RE.exec(file);
    if (match === null) continue;
    const lo = Number(match[1]);
    const hi = Number(match[2]);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) continue;
    shards.push({ file, path: path.join(dir, file), lo, hi });
  }
  return shards.sort((a, b) => a.lo - b.lo);
}

export interface ShardProbe {
  minId: number | null;
  maxId: number | null;
  hasTable: boolean;
}

export type ShardIntegrity = { ok: true; coveredThrough: number } | { ok: false; reason: string };

/**
 * Prove the shard set is a complete, honest cover of ids 1..hi.
 *
 * `openShard` is injected so this module needs no better-sqlite3 VALUE import:
 * it is pulled in by the restore CLI as well as the backup worker.
 *
 * Note what is NOT required: that a shard's rows fill its declared range. Ids
 * go missing legitimately — a run deleted before its events were archived
 * cascades them away — so the check is that every row present falls INSIDE the
 * declared range, and that the ranges themselves tile without gap or overlap.
 */
export function validateShards(
  shards: ShardRef[],
  openShard: (shardPath: string) => ShardProbe,
): ShardIntegrity {
  let expectedLo = 1;
  for (const shard of shards) {
    if (shard.lo !== expectedLo) {
      return {
        ok: false,
        reason: `${shard.file} starts at ${shard.lo}, expected ${expectedLo} — the archive has a gap or overlap`,
      };
    }
    if (shard.hi < shard.lo) {
      return { ok: false, reason: `${shard.file} declares an inverted range` };
    }

    let probe: ShardProbe;
    try {
      probe = openShard(shard.path);
    } catch (err) {
      return {
        ok: false,
        reason: `${shard.file} could not be opened: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!probe.hasTable) {
      return { ok: false, reason: `${shard.file} has no ${DELTA_ARCHIVED_TABLE} table — it is empty or corrupt` };
    }
    if (probe.minId !== null && probe.minId < shard.lo) {
      return { ok: false, reason: `${shard.file} holds id ${probe.minId}, below its declared range` };
    }
    if (probe.maxId !== null && probe.maxId > shard.hi) {
      return { ok: false, reason: `${shard.file} holds id ${probe.maxId}, above its declared range` };
    }

    expectedLo = shard.hi + 1;
  }
  return { ok: true, coveredThrough: expectedLo - 1 };
}

/** Read the archive marker a strip stamped into a backup, if present. */
export function readArchiveMarker(db: Database.Database): ArchiveMarker | null {
  const present = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(ARCHIVE_MARKER_TABLE);
  if (present === undefined) return null;
  const row = db.prepare(`SELECT lineage, watermark FROM ${ARCHIVE_MARKER_TABLE} LIMIT 1`).get() as
    | ArchiveMarker
    | undefined;
  return row ?? null;
}

/** Stamp (or restamp) the archive marker on a stripped backup. */
export function writeArchiveMarker(db: Database.Database, marker: ArchiveMarker): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS ${ARCHIVE_MARKER_TABLE} (
       lineage TEXT NOT NULL,
       watermark INTEGER NOT NULL,
       archived_at TEXT NOT NULL
     )`,
  );
  db.exec(`DELETE FROM ${ARCHIVE_MARKER_TABLE}`);
  db.prepare(`INSERT INTO ${ARCHIVE_MARKER_TABLE} (lineage, watermark, archived_at) VALUES (?, ?, ?)`).run(
    marker.lineage,
    marker.watermark,
    new Date().toISOString(),
  );
}

/** Standard probe used by both the worker and the CLI. */
export function probeShardWith(open: (p: string) => Database.Database): (shardPath: string) => ShardProbe {
  return (shardPath: string): ShardProbe => {
    const db = open(shardPath);
    try {
      const hasTable =
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(DELTA_ARCHIVED_TABLE) !==
        undefined;
      if (!hasTable) return { minId: null, maxId: null, hasTable: false };
      const row = db
        .prepare(`SELECT MIN(id) AS minId, MAX(id) AS maxId FROM ${DELTA_ARCHIVED_TABLE}`)
        .get() as { minId: number | null; maxId: number | null };
      return { minId: row.minId, maxId: row.maxId, hasTable: true };
    } finally {
      db.close();
    }
  };
}
