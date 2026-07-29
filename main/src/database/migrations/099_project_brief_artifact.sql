-- Migration 099: widen the artifacts.atype CHECK to add 'project-brief'.
--
-- The Launch flow (main/src/orchestrator/workflows/launch.md) introduces a `project-brief`
-- templated artifact — the interview phase's synthesized project brief doc,
-- reported the same way `compound-recommendations` is (markdown-payload,
-- no entity source). The recreated CHECK carries every prior atype forward
-- (idea-spec … approve-designs) so no existing row is stranded outside the
-- constraint.
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql once, so editing an earlier
-- migration in place would silently never re-apply on an already-migrated DB. We
-- recreate the artifacts table with the widened CHECK and copy the rows — the
-- same recipe 035/045/060/062/063/073/089/091/097 use. The leading `PRAGMA foreign_keys=OFF`
-- is detected by the migration runner, which toggles FK enforcement OFF *outside*
-- the wrapping transaction so DROP TABLE does not cascade.
--
-- Runs AFTER 097 (verify-runbook, the previous artifacts recreate), so this
-- recreate reproduces the FULL current schema unchanged apart from the widened
-- CHECK — no column changes. Each recreate carries only the atypes it names, so
-- this one carries 091's 'eval-report' and 097's 'verify-runbook' forward.
-- It preserves 073's split-identity rule (idea-spec/arch-design keyed by
-- source_ref; every other atype, including project-brief, one-per-(run, atype));
-- no table-level UNIQUE.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'interactive-prototype', 'arch-design', 'compound-recommendations', 'project-brief', 'approve-ideas', 'approve-designs', 'eval-report', 'verify-runbook')),
  label        TEXT NOT NULL,
  step_origin  TEXT,
  mode         TEXT NOT NULL DEFAULT 'canvas' CHECK (mode IN ('template', 'canvas')),
  committed    INTEGER NOT NULL DEFAULT 0,
  session_only INTEGER NOT NULL DEFAULT 1,
  is_new       INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT,
  source_ref   TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  committed_at DATETIME,
  revision     INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

INSERT INTO artifacts_new (id, run_id, session_id, atype, label, step_origin, mode, committed,
                           session_only, is_new, payload_json, source_ref, created_at, committed_at, revision)
  SELECT id, run_id, session_id, atype, label, step_origin, mode, committed,
         session_only, is_new, payload_json, source_ref, created_at, committed_at, revision
  FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_committed ON artifacts(run_id, committed);

-- Split identity rule (unchanged from 073/089):
--   * every atype EXCEPT the per-entity set stays one-per-(run, atype);
--   * idea-spec AND arch-design are one-per-(run, atype, source_ref). COALESCE
--     keeps a NULL source_ref from escaping the unique check.
CREATE UNIQUE INDEX idx_artifacts_one_per_atype
  ON artifacts(run_id, atype) WHERE atype NOT IN ('idea-spec', 'arch-design');
CREATE UNIQUE INDEX idx_artifacts_per_source
  ON artifacts(run_id, atype, COALESCE(source_ref, '')) WHERE atype IN ('idea-spec', 'arch-design');

PRAGMA foreign_keys=ON;
