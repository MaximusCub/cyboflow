-- Migration 083: idle-gated quick-session summaries (rolling summary +
-- append-only history), docs/proposals/session-summary-plan.md §4.
--
-- Separate tables, not `sessions` columns: summary writes must never bump
-- `sessions.updated_at` (the activity clock — see
-- main/src/database/__tests__/sessionUpdatedAtSemantics.test.ts), and this
-- keeps cascade-delete clean when a session is removed.
--
--  - session_summaries: one row per session, upserted in place. `summary` is
--    the current 1-2 sentence rolling summary. `last_turn_id` is the content
--    watermark — the highest conversation_messages.id already folded into the
--    summary (§2.4). `calls_count` / `cost_usd_total` accumulate across every
--    summarizer call for the session (observability, §3).
--  - session_summary_entries: the append-only per-sitting history sentences
--    (§1), oldest first via `id ASC`.
--
-- Runtime FK enforcement is live (`PRAGMA foreign_keys = ON`,
-- database.ts:132), so `ON DELETE CASCADE` on both tables' session_id FK is
-- sufficient — no FK pragma toggle needed here (this migration only adds new
-- tables/indexes, it never drops or renames a table with FK children; see
-- docs/CODE-PATTERNS.md "SQLite migrations: PRAGMA foreign_keys must toggle
-- outside db.transaction()").

CREATE TABLE IF NOT EXISTS session_summaries (
  session_id     TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  summary        TEXT NOT NULL DEFAULT '',
  last_turn_id   INTEGER NOT NULL DEFAULT 0,
  calls_count    INTEGER NOT NULL DEFAULT 0,
  cost_usd_total REAL NOT NULL DEFAULT 0,
  updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session_summary_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  entry      TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_session_summary_entries_session
  ON session_summary_entries(session_id, id);

-- conversation_messages currently has only single-column indexes
-- (schema.sql:40-41); the watermark read (`WHERE session_id = ? AND id > ?
-- ORDER BY id ASC`, §2.4) needs the composite (session_id, id).
CREATE INDEX IF NOT EXISTS idx_conversation_messages_session_id_id
  ON conversation_messages(session_id, id);
