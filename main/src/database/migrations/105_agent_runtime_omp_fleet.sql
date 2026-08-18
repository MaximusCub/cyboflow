-- Migration 105: admit 'omp-fleet' on sessions.agent_runtime and
-- workflow_runs.agent_runtime (OMP Phase 4, the fleet-supervisor runtime).
--
-- WHY A NEW FILE RATHER THAN AN EDIT TO 103. The migration ledger is keyed by
-- FILENAME and applies each .sql exactly once, so widening 103's CHECK list in
-- place would land only on fresh installs and silently never re-apply on an
-- already-migrated DB — the 062_approve_ideas_atype lesson 103's own header
-- records. Every install that already shipped 0.2.3 has 103 marked applied.
--
-- WHY NOT A CREATE-NEW/COPY/DROP/RENAME REBUILD OF `sessions`. 103 spells out
-- the hazard and it applies verbatim here: `sessions` is Crystal-legacy, ~40
-- columns accreted through ALTER TABLE, several of them added imperatively by
-- database.ts rather than by any .sql (`status_message` is the live example),
-- so "a hardcoded CREATE TABLE would silently drop any column a given install
-- has but this file does not list". It would also have to restate 103's own
-- widened CHECK lists from memory, and getting that wrong would UN-widen
-- 'omp-sdk'/'omp-pty' on the very installs that use them.
--
-- So this file reuses 103's shape-agnostic recipe: the constraint lives in a
-- column-level CHECK on a column that is in no index, no trigger, no view and
-- no other CHECK, so SQLite can DROP the column and re-ADD it with the widened
-- CHECK. It names only the column being widened, leaves every other column,
-- index and foreign key untouched, and needs no FK re-pointing. Values are
-- parked in a temp column across the drop. The sequence is idempotent, so a
-- re-run after a cleared ledger marker is harmless.
--
-- The widened sets deliberately differ per table, exactly as 103's do:
--   sessions      + 'omp-fleet'  — the fleet supervisor is a session runtime.
--   workflow_runs + 'omp-fleet'  — the quick-session SENTINEL is a workflow_runs
--                                  ROW and must carry the session's resolved
--                                  runtime; the dispatch facade reads it back to
--                                  pick the owning manager. Storable, never
--                                  launchable (WORKFLOW_LAUNCHABLE_RUNTIMES
--                                  still excludes it — a fleet supervisor has no
--                                  per-step event stream).
-- workflow_variants and agent_invocations are deliberately NOT widened: a
-- variant resolves to a workflow-launchable runtime, and an invocation row
-- records a per-step agent turn. Neither can ever be a fleet supervisor.
--
-- No `PRAGMA foreign_keys=OFF` marker: unlike 103 this file drops no table, so
-- there is nothing for a cascade or an orphan row to abort. The runner's
-- wrapping transaction is sufficient.

-- ---------------------------------------------------------------------------
-- sessions.agent_runtime  (103 list + 'omp-fleet')
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ADD COLUMN agent_runtime_widen_105 TEXT;
UPDATE sessions SET agent_runtime_widen_105 = agent_runtime;
ALTER TABLE sessions DROP COLUMN agent_runtime;
ALTER TABLE sessions
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty','omp-sdk','omp-pty','omp-fleet'));
UPDATE sessions SET agent_runtime = COALESCE(agent_runtime_widen_105, 'claude-sdk');
ALTER TABLE sessions DROP COLUMN agent_runtime_widen_105;

-- ---------------------------------------------------------------------------
-- workflow_runs.agent_runtime  (103 list + 'omp-fleet')
--
-- omp-pty stays absent for the same reason codex-pty is: a workflow run needs
-- structured events, usage, MCP progress and review-queue integration.
-- ---------------------------------------------------------------------------

ALTER TABLE workflow_runs ADD COLUMN agent_runtime_widen_105 TEXT;
UPDATE workflow_runs SET agent_runtime_widen_105 = agent_runtime;
ALTER TABLE workflow_runs DROP COLUMN agent_runtime;
ALTER TABLE workflow_runs
  ADD COLUMN agent_runtime TEXT NOT NULL DEFAULT 'claude-sdk'
    CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','omp-sdk','omp-fleet'));
UPDATE workflow_runs SET agent_runtime = COALESCE(agent_runtime_widen_105, 'claude-sdk');
ALTER TABLE workflow_runs DROP COLUMN agent_runtime_widen_105;
