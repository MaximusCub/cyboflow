-- Migration 098: workflow A/B testing — per-arm QUICK-SESSION config persistence.
--
-- A side-by-side experiment arm can be an ad hoc quick session (the '__quick__'
-- arm sentinel) configured from the launch modal's quick-config sub-form
-- (substrate/runtime/model/effort/permission mode). That config previously lived
-- ONLY in the startSideBySide request: `experiments.rerun` forwards just the
-- variant ids, so "Run again" on a quick-arm experiment silently launched a
-- default Claude-SDK quick arm — a DIFFERENT matchup with no warning, and the
-- original config was unrecoverable server-side (the arm session may already be
-- dismissed once the experiment is decided). This table records each quick arm's
-- config at start so rerun can replay the same matchup.
--
-- NOT an entity table (precedent: experiment_seed_tasks, migration 051): its
-- writes are direct helpers in experimentStore (insert on start; reads are
-- fail-soft for pre-098 rows, which simply rerun with defaults as before). Rows
-- deliberately survive decide/abandon — rerun REQUIRES a settled experiment, so
-- deleting on close-out would defeat the table's purpose.
--
-- PRAGMA foreign_keys is OFF during migration (database.ts), so the experiment
-- link is SOFT (no FK clause); the ledger is filename-keyed and this runs inside
-- runFileBasedMigrations' transaction wrapper.
--
-- ⚠️ MIGRATION-NUMBER COLLISION: sibling branches have historically claimed
-- overlapping numbers. The ledger is filename-keyed; whichever lands second must
-- renumber. The integrator MUST verify no other 098_*.sql exists at merge time.

CREATE TABLE IF NOT EXISTS experiment_quick_configs (
  experiment_id TEXT NOT NULL,
  arm           TEXT NOT NULL CHECK (arm IN ('A','B')),
  config_json   TEXT NOT NULL,             -- ExperimentArmQuickConfig, JSON-encoded
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- One config per (experiment, arm) — start inserts exactly this set.
  UNIQUE (experiment_id, arm)
);

CREATE INDEX IF NOT EXISTS idx_experiment_quick_configs_experiment
  ON experiment_quick_configs(experiment_id);
