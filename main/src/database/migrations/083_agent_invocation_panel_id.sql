-- Migration 083: per-panel identity on agent invocations.
--
-- WHY. A quick session's Codex resume target was resolved by
-- `getLatestTopLevelResumeTarget(chat_run_id)`. That run id is SESSION-scoped —
-- every chat panel of a session shares one chat_run_id sentinel — so a SECOND
-- Codex SDK chat (TASK-103 Add-chat) picked up the FIRST chat's Codex thread as
-- its resumeSessionId and the two panels replayed one conversation.
--
-- NULL is deliberate and is the whole back-compat story: every pre-083 row keeps
-- panel_id NULL, and the run-scoped `getLatestTopLevelResumeTarget` still reads
-- rows regardless of panel_id, so workflow runs and existing single-panel chat
-- sessions resolve exactly the target they did before. Only the new
-- panel-scoped lookup filters on this column.
ALTER TABLE agent_invocations ADD COLUMN panel_id TEXT;

-- Mirrors idx_agent_invocations_run_step_latest for the panel-scoped
-- "newest top-level invocation for THIS panel" query.
CREATE INDEX IF NOT EXISTS idx_agent_invocations_run_panel_latest
  ON agent_invocations (run_id, panel_id, id DESC);
