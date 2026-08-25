-- Migration 121: summarizer triage-state columns on session_summaries, plus
-- the chat_run_id index the review-home board's poll needs.
--
-- WHY. The idle-gated quick-session summarizer (migration 083,
-- docs/proposals/session-summary-plan.md) already produces a rolling 1-2
-- sentence summary per session. The review-home board wants to go further:
-- classify each session's current triage state so a person can tell, without
-- opening it, whether it's still working, done, or stuck waiting on them.
-- `state` carries that verdict — one of 'working' | 'complete' |
-- 'needs_input' — and `waiting_on` carries the one-sentence "what it asked
-- you" the board shows for a 'needs_input' row (e.g. "Ship as a boot check
-- or a settings dialog?").
--
-- Both columns are NULLABLE with NO CHECK constraint. Unlike migration 117's
-- widened `priority` enum, this enum is expected to grow as the board's
-- triage vocabulary evolves, and the writer is a haiku summarizer call, not
-- app code — a CHECK constraint would turn a future added state, or a model
-- hallucinating an off-list value, into a hard INSERT/UPDATE failure instead
-- of a degraded read. So validation lives at the read boundary instead
-- (`normalizeSummaryState` / `normalizeWaitingOn` in database.ts): only the
-- three known values survive, everything else — including a bogus value that
-- reached the column some other way (a hand-edited DB, a future migration,
-- a differently-versioned binary sharing the DB) — reads back as null rather
-- than propagating garbage to callers.
--
-- The partial index covers the quick-session board's existing query pattern
-- (`sessions WHERE chat_run_id IS NOT NULL`), polled every 3s across every
-- project. Migration 040 added `chat_run_id` with no index at all; this
-- migration is the first to actually need that lookup fast.
--
-- Numbering note: prefixes 119/120 are reserved by the unmerged fresh-quail
-- branch (sessions.idle_since work) and deliberately skipped here — the
-- migration runner tracks applied migrations by FILENAME and orders by
-- numeric prefix, so a gap left by an as-yet-unmerged branch is harmless.

ALTER TABLE session_summaries ADD COLUMN state TEXT;
ALTER TABLE session_summaries ADD COLUMN waiting_on TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_chat_run_id
  ON sessions(chat_run_id) WHERE chat_run_id IS NOT NULL;
