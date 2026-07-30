-- Migration 091: widen the artifacts.atype CHECK to include 'eval-report'.
--
-- The ad-hoc code-review eval (`cyboflow_run_eval`, migration 090's
-- run_evals.origin='adhoc') publishes its full verdict as a run artifact so a
-- quick session — which has no WorkflowSummaryPanel score surface — gets a
-- persistent report tab instead of only a review-queue one-liner. 'eval-report'
-- is SYSTEM-MINTED by EvalWorker (reportable:false in the artifact-policy
-- registry) and payload-backed markdown, rendered like
-- 'compound-recommendations'.
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql once, so editing an earlier
-- migration in place would silently never re-apply on an already-migrated DB. We
-- recreate the artifacts table with the widened CHECK and copy the rows — the
-- same recipe 035/045/060/062/063/073/089 use. The leading `PRAGMA
-- foreign_keys=OFF` is detected by the migration runner, which toggles FK
-- enforcement OFF *outside* the wrapping transaction so DROP TABLE does not
-- cascade.
--
-- Runs AFTER 089 (the previous artifacts recreate, which added
-- 'interactive-prototype' and carries `revision`), so this recreate reproduces
-- 089's FULL schema — its column set, its atype list, and the split-identity
-- indexes — changing ONLY the CHECK, which gains 'eval-report'. The `revision`
-- copy is safe on a ledger-wiped replay too: 088's revision-ensure guard
-- re-adds the column before 089 re-runs, and 089's recreate carries it forward
-- to this one (see 088's header for the replay hazard this rides on).
--
-- 'eval-report' is NOT added to the per-entity set, so it falls under
-- idx_artifacts_one_per_atype — one report per run, which is exactly what makes
-- a re-eval an UPSERT (newest verdict replaces the tab) rather than a second tab.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'interactive-prototype', 'arch-design', 'compound-recommendations', 'approve-ideas', 'approve-designs', 'eval-report')),
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
