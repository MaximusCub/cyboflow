-- Migration 084: dedupe key for PTY transcript ingestion into
-- conversation_messages, docs/proposals/session-summary-plan.md (PTY follow-up).
--
-- Interactive (PTY) quick sessions never write conversation_messages rows — their
-- content lives only as raw ANSI stdout blobs in session_outputs — so the
-- session-summary scheduler's watermark read (migration 083) always sees an empty
-- delta for them. The fix ingests the Claude-CLI JSONL transcript
-- (~/.claude/projects/<encodeCwd(cwd)>/<claude_session_id>.jsonl) into
-- conversation_messages on the scheduler's fire path.
--
-- `source_uuid` is the transcript entry's own top-level `uuid`. The PARTIAL UNIQUE
-- index makes re-ingestion idempotent (INSERT OR IGNORE dedupes on
-- (session_id, source_uuid)) without constraining the pre-existing SDK-written
-- rows, whose source_uuid stays NULL (SQLite treats every NULL as distinct, and
-- the `WHERE source_uuid IS NOT NULL` clause excludes them from the index
-- entirely). Additive column + index only; no table drop/rename, so no FK pragma
-- toggle is needed here (docs/CODE-PATTERNS.md).

ALTER TABLE conversation_messages ADD COLUMN source_uuid TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_session_source_uuid
  ON conversation_messages(session_id, source_uuid)
  WHERE source_uuid IS NOT NULL;
