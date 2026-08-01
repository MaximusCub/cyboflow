-- Migration 097: widen the artifacts.atype CHECK to include 'verify-runbook'.
--
-- The verify-setup flow's runbook PROPOSAL — per modality the build/serve
-- commands and the attestation channel, the rung ladder of repo changes it
-- wants, the risks, and later the proof outcomes — is the ONLY surface its
-- approve-runbook gate points a human at. Until now it was reported under
-- 'compound-recommendations', because no dedicated atype existed: the review
-- surface for "approve these changes to your repo" rendered labelled as a
-- Compound deliverable (found by the first live dogfood run, 2026-07-31).
-- 'verify-runbook' is agent-reportable (reportable:true) and payload-backed
-- markdown, rendered like 'compound-recommendations' and 'eval-report'.
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql once, so editing an earlier
-- migration in place would silently never re-apply on an already-migrated DB. We
-- recreate the artifacts table with the widened CHECK and copy the rows — the
-- same recipe 035/045/060/062/063/073/089/091 use. The leading `PRAGMA
-- foreign_keys=OFF` is detected by the migration runner, which toggles FK
-- enforcement OFF *outside* the wrapping transaction so DROP TABLE does not
-- cascade.
--
-- Runs AFTER 091 (the previous artifacts recreate, which added 'eval-report'),
-- so this recreate reproduces 091's FULL schema — its column set, its atype
-- list, and the split-identity indexes — changing ONLY the CHECK, which gains
-- 'verify-runbook'.
--
-- 'verify-runbook' is NOT added to the per-entity set, so it falls under
-- idx_artifacts_one_per_atype — one proposal per run, which is what makes the
-- prove step's write an UPSERT that ENRICHES the doc the gate already reviewed
-- (adding the proof outcomes) rather than opening a second, competing tab.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'interactive-prototype', 'arch-design', 'compound-recommendations', 'approve-ideas', 'approve-designs', 'eval-report', 'verify-runbook')),
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

-- Split identity rule (unchanged from 073/089/091):
--   * every atype EXCEPT the per-entity set stays one-per-(run, atype);
--   * idea-spec AND arch-design are one-per-(run, atype, source_ref). COALESCE
--     keeps a NULL source_ref from escaping the unique check.
CREATE UNIQUE INDEX idx_artifacts_one_per_atype
  ON artifacts(run_id, atype) WHERE atype NOT IN ('idea-spec', 'arch-design');
CREATE UNIQUE INDEX idx_artifacts_per_source
  ON artifacts(run_id, atype, COALESCE(source_ref, '')) WHERE atype IN ('idea-spec', 'arch-design');

PRAGMA foreign_keys=ON;
