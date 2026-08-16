-- Migration 101: widen sessions.agent_runtime (+ sibling agent_provider) to
-- admit the 'omp-fleet' / 'omp' pair (OMP Phase 4).
--
-- OMP becomes a first-class quick-session runtime (docs/proposals/omp-phase4-
-- coexistence-adr.md). The session row's `agent_runtime` must be able to carry
-- 'omp-fleet' so the quick-session handler, the IPC dispatch branch, the
-- panel-lane resolver, and REPL re-spawn all agree the session runs on OMP.
--
-- SQLite has no ALTER TABLE ... DROP/ADD CONSTRAINT, so widening the CHECK
-- constraint uses the canonical create-new-table + copy + DROP + RENAME recipe
-- (same as migration 010's workflow_runs rebuild). The new table is a verbatim
-- copy of the live `sessions` schema with the `agent_runtime` CHECK list
-- widened to include 'omp-fleet' AND the sibling `agent_provider` CHECK
-- widened to include 'omp' — the two values travel together: an omp-fleet
-- session stamps providerForRuntime('omp-fleet') = 'omp' on agent_provider,
-- so a CHECK that still rejects 'omp' would break the very row this
-- migration enables. Column order, defaults, and both foreign keys are
-- preserved.
--
-- NOTE: No explicit BEGIN/COMMIT here — runFileBasedMigrations() in database.ts
-- wraps every file in a this.transaction(...) call, so an inner BEGIN would nest.
--
-- foreign_keys must be OFF for the duration: `project_id` and `folder_id` carry
-- FKs, and the runner honours the PRAGMA foreign_keys=OFF marker by toggling it
-- OUTSIDE its transaction wrapper (PRAGMA foreign_keys is a no-op inside a
-- transaction), then restoring it in a finally.

PRAGMA foreign_keys=OFF;

CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  initial_prompt TEXT NOT NULL,
  worktree_name TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_output TEXT,
  exit_code INTEGER,
  pid INTEGER,
  claude_session_id TEXT,
  archived BOOLEAN DEFAULT 0,
  last_viewed_at DATETIME,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  permission_mode TEXT DEFAULT 'approve' CHECK(permission_mode IN ('approve', 'ignore')),
  run_started_at DATETIME,
  is_main_repo BOOLEAN DEFAULT 0,
  display_order INTEGER,
  is_favorite BOOLEAN DEFAULT 0,
  auto_commit BOOLEAN DEFAULT 1,
  skip_continue_next BOOLEAN DEFAULT 0,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  tool_type TEXT DEFAULT 'claude',
  base_commit TEXT,
  base_branch TEXT,
  commit_mode TEXT,
  commit_mode_settings TEXT,
  active_panel_id TEXT,
  run_id TEXT,
  is_quick BOOLEAN DEFAULT 0,
  agent_permission_mode TEXT,
  substrate TEXT,
  effort TEXT,
  disabled_mcp_servers_json TEXT NOT NULL DEFAULT '[]',
  chat_run_id TEXT,
  in_place BOOLEAN DEFAULT 0,
  agent_provider TEXT NOT NULL DEFAULT 'claude' CHECK (agent_provider IN ('claude','codex','omp')),
  agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk' CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty','omp-fleet')),
  agent_model TEXT,
  design_idea_id TEXT,
  enabled_plugins_json TEXT DEFAULT NULL
);

-- Column list is written out (not `SELECT *`) so the copy is robust to the new
-- table having an identical, widened definition. Order matches the live table.
INSERT INTO sessions_new (
  id, name, initial_prompt, worktree_name, worktree_path, status,
  created_at, updated_at, last_output, exit_code, pid, claude_session_id,
  archived, last_viewed_at, project_id, permission_mode, run_started_at,
  is_main_repo, display_order, is_favorite, auto_commit, skip_continue_next,
  folder_id, tool_type, base_commit, base_branch, commit_mode,
  commit_mode_settings, active_panel_id, run_id, is_quick, agent_permission_mode,
  substrate, effort, disabled_mcp_servers_json, chat_run_id, in_place,
  agent_provider, agent_runtime, agent_model, design_idea_id, enabled_plugins_json
)
SELECT
  id, name, initial_prompt, worktree_name, worktree_path, status,
  created_at, updated_at, last_output, exit_code, pid, claude_session_id,
  archived, last_viewed_at, project_id, permission_mode, run_started_at,
  is_main_repo, display_order, is_favorite, auto_commit, skip_continue_next,
  folder_id, tool_type, base_commit, base_branch, commit_mode,
  commit_mode_settings, active_panel_id, run_id, is_quick, agent_permission_mode,
  substrate, effort, disabled_mcp_servers_json, chat_run_id, in_place,
  agent_provider, agent_runtime, agent_model, design_idea_id, enabled_plugins_json
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

-- Restore the five pre-existing indexes (verified against the live schema).
CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);
CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_is_main_repo ON sessions(is_main_repo, project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_display_order ON sessions(project_id, display_order);
CREATE INDEX IF NOT EXISTS idx_sessions_folder_id ON sessions(folder_id);

PRAGMA foreign_keys=ON;
