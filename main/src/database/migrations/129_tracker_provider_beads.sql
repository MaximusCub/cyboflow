-- Migration 129: admit 'beads' as a fourth tracker-sync provider, plus the
-- config-generation counter and the reconciliation ledger beads needs.
--
-- Design: docs/proposals/tracker-beads-provider.md ("5. Migration + mechanical
-- widenings", "4. Pull reconciliation"). 128 is the latest landed prefix, so
-- 129 is the next free one (same next-free-prefix convention 093/105/110/122
-- each record in their own header).
--
-- PART 1 — PROVIDER WIDENING. Same two hardcoded CHECK constraints 105 last
-- widened (093:61/090, widened to admit 'dart' by 105):
--   tracker_connections.provider     IN ('linear','plane','dart')
--   entity_external_links.provider   IN ('linear','plane','dart')
-- SQLite cannot ALTER a CHECK, so both are widened here via a full recreate —
-- 105's own recipe, reproduced column-for-column against the CURRENT effective
-- shape rather than 105's now-stale one. That shape is 093 + 094's three
-- direction-mode columns + 105's provider widening (a same-shape recreate,
-- contributing no new columns) + 110's `push_target` + 118's four write-back
-- columns (`content_sync_mode`/`archive_sync_mode`/`priority_mapping_json`/
-- `category_mapping_json`) — verified against each of those five files, not
-- guessed. Nothing between 118 and 122 touches either table (grepped).
--
-- WHY A FULL RECREATE rather than an ADD-COLUMN dance: 105's header makes the
-- argument once and it still holds — `provider` is NOT NULL with no default,
-- and inventing `DEFAULT 'linear'` to satisfy `ADD COLUMN`'s requirement would
-- be exactly the silent-fallback-to-the-first-provider bug this widening
-- exists to prevent.
--
-- PART 2 — `tracker_connections.config_generation`, added on the SAME
-- recreate (a second standalone `ALTER TABLE ADD COLUMN` would work too, but
-- the provider CHECK forces a recreate here regardless, so folding the new
-- column into it avoids a second full rebuild of the same table in one
-- migration). A plain counter, NOT NULL DEFAULT 0, bumped by the sync engine
-- whenever a mapping / state-mapping / selection change on the connection
-- would invalidate previously-skipped reconciliation decisions (proposal
-- "4. Pull reconciliation": "config_generation is a counter stamped on the
-- connection and bumped by any mapping/state-mapping/selection change; ledger
-- rows from an older generation are treated as absent, so a config change
-- re-evaluates previously skipped ids exactly once"). Every existing row and
-- every row copied by this recreate lands at 0 — the column is omitted from
-- both the INSERT and SELECT lists below so the table DEFAULT applies to every
-- copied row uniformly, the same "rely on DEFAULT by omitting it" style 110's
-- header describes as the alternative to listing it explicitly.
--
-- PART 3 — `tracker_reconciliation_ledger` (new table, created AFTER the
-- tracker_connections recreate so its FK targets the FINAL table rather than a
-- `_new` name about to be renamed away — same ordering argument 105's header
-- gives for entity_external_links-before-tracker_connections). Durable record
-- of the periodic full-sweep reconciliation pass's SKIPPED decisions (an id
-- seen in the remote set but not imported and not already linked — e.g. an
-- excluded issue type, or one the current mapping declines) — see proposal
-- "4. Pull reconciliation": "The ledger is new, durable state — the engine has
-- none to reuse... a subtract-the-skipped design would re-point-fetch every
-- non-imported id on every sweep". Only SKIPPED ids get a row; an imported id
-- needs no row because its link IS the record. `last_seen_revision` is the
-- adapter-derived content fingerprint the sweep already computes per id (see
-- `TrackerAdapter.listIssueRevisions` in adapterTypes.ts) — comparing it lets
-- a re-sweep tell "still the same skip" from "this id changed since we last
-- ledgered it" without a point fetch in the common (unchanged) case.
-- `config_generation` is the connection's counter AT THE TIME this row was
-- written; a row whose generation is behind the connection's current one is
-- treated as absent (config changed, re-evaluate). UNIQUE(connection_id,
-- external_id) is the natural key — one ledger entry per remote id per
-- connection, upserted (not appended) as the sweep re-visits it.
-- ON DELETE CASCADE mirrors every other tracker_connections child table
-- (tracker_outbox, tracker_conflicts, entity_external_links): a removed
-- connection takes its ledger rows with it.
--
-- REPLAY SAFETY (a ledger-wiped DB re-runs every file end to end — see
-- 088/093/105/118). The tracker_connections/entity_external_links recreates
-- are CONVERGENT the same way 105's are: every copy is column-for-column
-- verbatim with the new column omitted from both lists (so DEFAULT 0 lands
-- identically on every pass), no backfill or value rewriting anywhere.
-- `tracker_reconciliation_ledger` is a brand-new table with nothing to
-- recreate FROM, so it follows 093's convention for a first-appearance table
-- instead: `CREATE TABLE IF NOT EXISTS`, making a second pass over an
-- already-migrated DB a true no-op that keeps whatever ledger rows the
-- engine had already written — critically NOT a bare `CREATE TABLE`, which
-- would throw "table already exists" on replay and, per the runner's
-- per-statement idempotence rule (only an `ALTER … ADD COLUMN` collision is
-- tolerated), roll back this file's ENTIRE transaction — losing the two
-- widened tables above along with it, not just the ledger.

PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- entity_external_links — 093 shape, provider CHECK widened to admit 'beads'.
-- ---------------------------------------------------------------------------

CREATE TABLE entity_external_links_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('idea','epic','task')),
  entity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('linear','plane','dart','beads')),
  external_id TEXT NOT NULL,
  external_identifier TEXT,
  external_url TEXT,
  external_parent_id TEXT,
  baseline_json TEXT,
  orphaned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, entity_id, provider),
  UNIQUE (connection_id, external_id),
  FOREIGN KEY (connection_id) REFERENCES tracker_connections(id) ON DELETE CASCADE
);

INSERT INTO entity_external_links_new (
  id, connection_id, entity_type, entity_id, provider, external_id,
  external_identifier, external_url, external_parent_id, baseline_json,
  orphaned_at, created_at, updated_at
)
  SELECT id, connection_id, entity_type, entity_id, provider, external_id,
         external_identifier, external_url, external_parent_id, baseline_json,
         orphaned_at, created_at, updated_at
    FROM entity_external_links;

-- Carry AUTOINCREMENT's high-water mark across the rebuild — 105's argument,
-- reproduced verbatim: copying explicit ids only sets the new table's mark to
-- max(id) among SURVIVING rows, which regresses whenever the newest links were
-- CASCADE-deleted with their connection.
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'entity_external_links_new', 0
   WHERE EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'entity_external_links')
     AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'entity_external_links_new');

UPDATE sqlite_sequence
   SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'entity_external_links'), 0))
 WHERE name = 'entity_external_links_new';

DROP TABLE entity_external_links;
ALTER TABLE entity_external_links_new RENAME TO entity_external_links;

CREATE INDEX IF NOT EXISTS idx_entity_external_links_conn ON entity_external_links(connection_id);

-- ---------------------------------------------------------------------------
-- tracker_connections — 093 + 094 + 110 + 118 shape, provider CHECK widened to
-- admit 'beads', plus the new `config_generation` counter. TEXT PRIMARY KEY,
-- so no sqlite_sequence row to carry.
-- ---------------------------------------------------------------------------

CREATE TABLE tracker_connections_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('linear','plane','dart','beads')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disconnected')),
  workspace_id TEXT,
  workspace_name TEXT,
  actor_label TEXT,
  base_url TEXT,
  secret_ciphertext BLOB,
  source_json TEXT,
  selection_mode TEXT NOT NULL DEFAULT 'all' CHECK (selection_mode IN ('all','assignee','manual')),
  selection_json TEXT,
  state_mapping_json TEXT NOT NULL DEFAULT '{}',
  two_way INTEGER NOT NULL DEFAULT 1,
  mirror_subissues INTEGER NOT NULL DEFAULT 1,
  conflict_mode TEXT NOT NULL DEFAULT 'auto' CHECK (conflict_mode IN ('auto','manual')),
  cursor_updated_at TEXT,
  cursor_external_id TEXT,
  last_sync_at TEXT,
  last_sync_log_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  status_sync_mode TEXT NOT NULL DEFAULT 'auto' CHECK (status_sync_mode IN ('auto','manual')),
  pull_mode TEXT NOT NULL DEFAULT 'auto' CHECK (pull_mode IN ('auto','manual')),
  push_mode TEXT NOT NULL DEFAULT 'auto' CHECK (push_mode IN ('auto','manual')),
  push_target INTEGER NOT NULL DEFAULT 1,
  content_sync_mode TEXT NOT NULL DEFAULT 'off' CHECK (content_sync_mode IN ('auto','manual','off')),
  archive_sync_mode TEXT NOT NULL DEFAULT 'off' CHECK (archive_sync_mode IN ('auto','manual','off')),
  priority_mapping_json TEXT NOT NULL DEFAULT '{}',
  category_mapping_json TEXT NOT NULL DEFAULT '{}',
  -- NEW. Bumped by the sync engine on any mapping / state-mapping / selection
  -- change; the reconciliation ledger below treats a row from an older
  -- generation as absent. Omitted from the INSERT/SELECT column lists below on
  -- purpose, so every copied row takes the DEFAULT uniformly rather than being
  -- carried forward from a column that did not exist before this migration.
  config_generation INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO tracker_connections_new (
  id, project_id, provider, status, workspace_id, workspace_name, actor_label,
  base_url, secret_ciphertext, source_json, selection_mode, selection_json,
  state_mapping_json, two_way, mirror_subissues, conflict_mode, cursor_updated_at,
  cursor_external_id, last_sync_at, last_sync_log_json, created_at, updated_at,
  status_sync_mode, pull_mode, push_mode, push_target,
  content_sync_mode, archive_sync_mode, priority_mapping_json, category_mapping_json
)
  SELECT id, project_id, provider, status, workspace_id, workspace_name, actor_label,
         base_url, secret_ciphertext, source_json, selection_mode, selection_json,
         state_mapping_json, two_way, mirror_subissues, conflict_mode, cursor_updated_at,
         cursor_external_id, last_sync_at, last_sync_log_json, created_at, updated_at,
         status_sync_mode, pull_mode, push_mode, push_target,
         content_sync_mode, archive_sync_mode, priority_mapping_json, category_mapping_json
    FROM tracker_connections;

DROP TABLE tracker_connections;
ALTER TABLE tracker_connections_new RENAME TO tracker_connections;

CREATE INDEX IF NOT EXISTS idx_tracker_connections_project ON tracker_connections(project_id);

-- ---------------------------------------------------------------------------
-- tracker_reconciliation_ledger — NEW. Durable skip-record for the periodic
-- full-sweep reconciliation pass (proposal "4. Pull reconciliation"). Created
-- after tracker_connections above so its FK targets the final table name.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tracker_reconciliation_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  last_seen_revision TEXT,
  config_generation INTEGER NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (connection_id, external_id),
  FOREIGN KEY (connection_id) REFERENCES tracker_connections(id) ON DELETE CASCADE
);

PRAGMA foreign_keys=ON;
