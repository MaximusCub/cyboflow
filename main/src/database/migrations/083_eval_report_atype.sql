-- Migration 083: widen the artifacts.atype CHECK to include 'eval-report'.
--
-- The ad-hoc code-review eval (`cyboflow_run_eval`, migration 082's
-- run_evals.origin='adhoc') publishes its full verdict as a run artifact so a
-- QUICK session — which has no WorkflowSummaryPanel score surface — gets a
-- persistent report tab, not just the one-line review-queue rollup. The doc is
-- payload-backed (`payload_json.markdown`, exactly like
-- 'compound-recommendations'), so it renders with source_ref NULL and needs no
-- entity source.
--
-- 'eval-report' is SYSTEM-MINTED ONLY (EvalWorker, through the ArtifactRouter
-- chokepoint) — it is deliberately absent from the `cyboflow_report_artifact`
-- MCP tool's reportable atype list, mirroring the auto-created 'arch-design' /
-- 'approve-designs' surfaces.
--
-- Runs AFTER 073_approve_designs_and_per_idea_arch (the last artifacts-table
-- recreate) and reproduces 073's FINAL shape verbatim — same columns in the same
-- order, no table-level UNIQUE (the split identity rule lives in the two partial
-- unique indexes below), same FK — and ONLY widens the CHECK. No migration
-- between 073 and here touches the artifacts table (077's feedback tables are
-- separate), so the column list below IS the table's full current shape.
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql once, so editing an earlier
-- migration in place would silently never re-apply on an already-migrated DB. We
-- recreate the artifacts table with the widened CHECK and copy the rows — the
-- same recipe 035/045/060/062/063/073 use. The leading `PRAGMA foreign_keys=OFF`
-- is detected by the migration runner, which toggles FK enforcement OFF *outside*
-- the wrapping transaction so DROP TABLE does not cascade.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'arch-design', 'compound-recommendations', 'approve-ideas', 'approve-designs', 'eval-report')),
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
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

INSERT INTO artifacts_new (id, run_id, session_id, atype, label, step_origin, mode, committed,
                           session_only, is_new, payload_json, source_ref, created_at, committed_at)
  SELECT id, run_id, session_id, atype, label, step_origin, mode, committed,
         session_only, is_new, payload_json, source_ref, created_at, committed_at
  FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_committed ON artifacts(run_id, committed);

-- Split identity rule carried forward from 073 UNCHANGED: idea-spec and
-- arch-design are one-per-(run, atype, source_ref); every OTHER atype —
-- 'eval-report' included — stays strictly one-per-(run, atype), which is what
-- makes a re-eval an UPSERT that overwrites the stored verdict markdown.
CREATE UNIQUE INDEX idx_artifacts_one_per_atype
  ON artifacts(run_id, atype) WHERE atype NOT IN ('idea-spec', 'arch-design');
CREATE UNIQUE INDEX idx_artifacts_per_source
  ON artifacts(run_id, atype, COALESCE(source_ref, '')) WHERE atype IN ('idea-spec', 'arch-design');

PRAGMA foreign_keys=ON;
