-- Migration 093: tracker-sync data model (Linear + Plane issue-tracker sync).
--
-- Numbering gap 089 -> 093 is DELIBERATE: 090-092 are claimed by in-flight
-- worktrees that have not landed on this branch yet (see docs/CODE-PATTERNS.md
-- migration-numbering convention). 093 is simply the next free prefix at
-- implementation time.
--
-- Design doc: docs/proposals/tracker-sync-integration.md, "Data model" +
-- "Durability & failure semantics". Four new tables:
--
--   1. tracker_connections    — one row per provider connection (Linear/Plane).
--      Secrets are NOT stored here: secret_ciphertext holds an Electron
--      safeStorage-encrypted blob, decrypted only in the main process (see
--      the proposal's "Auth & secrets"). source_json/selection_json/
--      state_mapping_json/last_sync_log_json are opaque JSON blobs owned by
--      the sync engine, not modeled column-by-column here.
--   2. entity_external_links  — generalizes the dormant task-only
--      `task_external_links` (mig 014/015) to link BOTH ideas and tasks to a
--      tracker issue. Two independent uniqueness constraints: one entity maps
--      to at most one issue per provider, and one external issue maps to at
--      most one entity per connection. baseline_json is the last-synced field
--      snapshot the conflict engine three-way-merges against.
--   3. tracker_outbox         — durable pre-write record for every remote
--      write (create-sub-issue / update-state / close-parent), written BEFORE
--      the API call is attempted. This is the crash-safety + echo-suppression
--      seam described in "Durability & failure semantics" #1: the inbound
--      cursor cannot advance past an item with an unresolved outbox entry, so
--      a half-created sub-issue can never be double-created or re-imported.
--      client_key is the client-generated idempotency key (Linear's natively
--      idempotent issueCreate id; Plane reconciles ambiguous creates by
--      listing + matching against it instead).
--   4. tracker_conflicts      — conflict-mode 'manual' queue rows + Auto-mode
--      remote-deletion records (see "Conflict resolution"). link_id is
--      ON DELETE SET NULL (not CASCADE): a conflict row survives its link
--      being orphaned/removed so the history stays inspectable.
--
-- Plus: DROP task_external_links — superseded by entity_external_links. It
-- has been dormant since 014/015 (created, never read or written by any code
-- path); grepping the repo confirms zero live references outside migration
-- files and their parity tests.
--
-- REPLAY SAFETY (a ledger-wiped DB re-runs every file end to end — see 088's
-- header for the mechanism): every CREATE TABLE / CREATE INDEX below uses
-- IF NOT EXISTS, and the DROP uses IF EXISTS, so a second pass over an
-- already-migrated DB is a true no-op (no "table already exists" error,
-- unlike a bare CREATE TABLE first-statement, which the runner's
-- duplicate-column tolerance does NOT cover — only ALTER TABLE ADD COLUMN
-- failures are treated as idempotent-ok). This mirrors 014/015's
-- IF-NOT-EXISTS convention (both of those files predate the newer
-- table-recreate-driven migrations that instead rely on an idempotent-ALTER
-- as their first statement, a pattern that only helps when the file's very
-- first statement is that ALTER).
--
-- On a ledger-wiped replay, 014/015 recreate task_external_links (both use
-- IF NOT EXISTS / IF EXISTS already) and this file drops it again —
-- convergent either way.

CREATE TABLE IF NOT EXISTS tracker_connections (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('linear','plane')),
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
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tracker_connections_project ON tracker_connections(project_id);

CREATE TABLE IF NOT EXISTS entity_external_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('idea','epic','task')),
  entity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('linear','plane')),
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
CREATE INDEX IF NOT EXISTS idx_entity_external_links_conn ON entity_external_links(connection_id);

CREATE TABLE IF NOT EXISTS tracker_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create_sub_issue','update_state','close_parent')),
  entity_type TEXT,
  entity_id TEXT,
  external_id TEXT,
  client_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_flight','done','failed','ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES tracker_connections(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tracker_outbox_conn_state ON tracker_outbox(connection_id, state);

CREATE TABLE IF NOT EXISTS tracker_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  link_id INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('field_conflict','remote_deleted')),
  field TEXT,
  local_value TEXT,
  remote_value TEXT,
  payload_json TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved')),
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (connection_id) REFERENCES tracker_connections(id) ON DELETE CASCADE,
  FOREIGN KEY (link_id) REFERENCES entity_external_links(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tracker_conflicts_conn_state ON tracker_conflicts(connection_id, state);

DROP TABLE IF EXISTS task_external_links;
-- (dormant since 014/015, never read or written by code; superseded by
-- entity_external_links. Replay-safe: on a ledger-wiped replay 014/015
-- recreate it and this file drops it again — converges either way.)
