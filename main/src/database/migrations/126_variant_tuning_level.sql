-- Migration 126: scope A/B variants (and rotation experiments) to a TUNING LEVEL.
--
-- Migration 124 gave every built-in flow a tuning level (efficient / standard /
-- thorough / custom), and `createVariantFromCurrent` already snapshots the
-- workflow's EFFECTIVE definition — i.e. the graph of whichever level the flow
-- was parked on. So a variant has ALWAYS been a challenger of one level; the
-- level just was not recorded, and nothing enforced it. That left three holes:
--
--   1. a variant cut against Thorough rotated into an Efficient launch and
--      silently replaced the level the user picked (the variant carries its own
--      frozen graph, which wins over the level materialization);
--   2. a rotation experiment's arm set mixed levels, so its per-arm stats were
--      comparing different flows;
--   3. the `variant_conflict` rejection (a level override + a variant pin) was
--      the SYMPTOM of the missing dimension rather than a design choice.
--
-- The model this establishes: THE LEVEL PICKS THE POOL, rotation/baseline/pin
-- picks inside it. A variant belongs to exactly one (workflow, level) pair, and
-- every pool predicate, label-uniqueness check and rotation arm set now carries
-- the level alongside the workflow.
--
-- NULL = "flow-scoped". A non-built-in ("save as new flow") workflow is outside
-- the level system entirely — `createRun` stamps its runs with a NULL level —
-- so its variants are NULL too and rotate for every launch of that flow exactly
-- as they do today. NULL is a real member of the key, not an absence, which is
-- why the unique index below coalesces rather than relying on SQLite's
-- NULLs-are-distinct rule (which would let a custom flow hold two variants of
-- the same name).
--
-- BACKFILL. Every existing variant of a BUILT-IN flow is attributed to that
-- flow's current level stamp — the level it was in fact snapshotted from, since
-- there has only ever been one live definition per workflow. The built-in name
-- list is spelled out because "is built-in" is a code predicate
-- (CYBOFLOW_WORKFLOW_NAMES / isCyboflowWorkflowName), not a column; it is the
-- same six names 124 was written against. Variants of any other workflow keep
-- the column's NULL default.
--
-- Rotation experiments inherit their level from their own arm snapshot: any arm
-- that is a real variant (the BASELINE sentinel arm has no workflow_variants
-- row and so drops out of the join) carries the pool's level, and a rotation
-- always has >= 2 arms of which at most one is the baseline.
--
-- ⚠️ MIGRATION-NUMBER COLLISION: 122/123 were taken by main (omp-fleet + pi) and
-- 124 by the tuning-levels merge. The ledger is filename-keyed; whichever branch
-- lands second must renumber. The integrator MUST verify no other 126_*.sql
-- exists at merge time (`ls main/src/database/migrations/`).
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in
-- a this.transaction(...) call. A re-run raises "duplicate column name", which
-- the runner treats as an idempotent no-op.

ALTER TABLE workflow_variants
  ADD COLUMN tuning_level TEXT
  CHECK (tuning_level IS NULL OR tuning_level IN ('efficient','standard','thorough','custom'));

UPDATE workflow_variants
   SET tuning_level = (SELECT w.tuning_level FROM workflows w WHERE w.id = workflow_variants.workflow_id)
 WHERE workflow_id IN (
         SELECT id FROM workflows
          WHERE name IN ('planner','sprint','compound','ship','verify-setup','launch')
       );

-- Label uniqueness is now per (workflow, level): "aggressive-parallel" may exist
-- as a challenger of Standard AND of Thorough. COALESCE keeps flow-scoped
-- (NULL-level) variants under a single uniqueness bucket instead of SQLite's
-- every-NULL-is-distinct default.
DROP INDEX IF EXISTS idx_workflow_variants_wf_label;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_variants_wf_level_label
  ON workflow_variants(workflow_id, COALESCE(tuning_level, ''), label);

-- Rotation candidate scan: the pool is keyed by workflow AND level now. Plain
-- columns (not the COALESCE expression) so the resolver's
-- `tuning_level IS ?` predicate can actually use it.
DROP INDEX IF EXISTS idx_workflow_variants_wf_status;
CREATE INDEX IF NOT EXISTS idx_workflow_variants_wf_level_status
  ON workflow_variants(workflow_id, tuning_level, status);

ALTER TABLE experiments
  ADD COLUMN tuning_level TEXT
  CHECK (tuning_level IS NULL OR tuning_level IN ('efficient','standard','thorough','custom'));

UPDATE experiments
   SET tuning_level = (
         SELECT v.tuning_level
           FROM experiment_rotation_arms a
           JOIN workflow_variants v ON v.id = a.variant_id
          WHERE a.experiment_id = experiments.id
          LIMIT 1
       )
 WHERE kind = 'rotation';

-- "The open rotation for this workflow at this level" is now the uniqueness the
-- reconcile chokepoint maintains; give the lookup its own index.
CREATE INDEX IF NOT EXISTS idx_experiments_workflow_level_kind
  ON experiments(workflow_id, tuning_level, kind, status);
