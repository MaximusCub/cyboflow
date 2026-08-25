-- migration 124: per-workflow tuning level + its frozen per-run stamp.
--
-- Design: docs/plans/workflow-tuning-levels.md (D1 resolve-at-read, D2
-- persistence). One dial per workflow — efficient / standard / thorough /
-- custom — where `standard` is the IDENTITY (today's as-authored built-in
-- behaviour, byte for byte) and `custom` resolves the workflow's own
-- `spec_json`. Selecting a level writes ONLY this stamp; `spec_json` is never
-- touched by the dial, which turns it into the dedicated CUSTOM SLOT written
-- exclusively by the Advanced editor and the MCP writer.
--
-- Numbered 124 (renumbered from 122 at merge: main took 122/123): 119-123 are claimed by
-- sibling branches in flight (fresh-quail's pair and noble-delta's triage
-- migration). The ledger is filename-keyed so a collision is not lost — both
-- files would apply — but their relative order would then fall out of readdir
-- rather than being stated. Renumbering on collision is the repo's standing
-- practice; the integrator MUST verify no other 124_*.sql exists at merge time.
--
-- WHY A COLUMN AND NOT A KEY INSIDE spec_json. `workflowDefinitionSchema` is a
-- plain `z.object`, so unrecognized top-level keys are SILENTLY STRIPPED on
-- every write. A level stamp living in the spec would survive exactly until the
-- next editor save. It is also not definition DATA: two workflows with the same
-- graph can sit at different levels, and the whole point of D1 is that the
-- level is resolved against the built-in at read time rather than materialized.
--
-- THE BACKFILL preserves every existing flow's effective behaviour exactly.
-- A row whose spec slot is empty resolves the built-in today and keeps doing so
-- through the `standard` identity; a row that carries a real edited definition
-- resolves that definition today and must keep doing so, which is precisely
-- what `custom` means. The emptiness predicate mirrors the one the read path
-- already uses (`parseWorkflowDefinition`: trim, then `'' | '{}'` ⇒ no slot) —
-- including the whitespace set, since SQLite's one-argument TRIM() strips
-- SPACES ONLY while JS `.trim()` strips tabs/newlines/CR too. A spec_json of
-- "\n{}\n" is an empty slot to every reader in the app, so it must not land on
-- 'custom' here. NULL spec_json (not reachable through the NOT NULL column, but
-- possible in a drifted DB the 006 reconciler has not rebuilt yet) is left at
-- the DEFAULT: `NULL NOT IN (...)` is NULL, which the WHERE clause treats as
-- false, and the explicit IS NOT NULL states that rather than relying on it.
--
-- workflow_runs.tuning_level is NULLABLE with no backfill: it is the frozen
-- per-run stamp (the same immutable-snapshot pattern as spec_hash / variant_id)
-- written at createRun from phase 3 onward. NULL means "pre-feature, or a
-- variant run" — a variant is its own frozen spec, and attributing a level to
-- it would poison the per-level estimate buckets. Every reader must therefore
-- treat NULL as "unattributed", never as 'standard'.
--
-- CHECK constraints (SQLite permits them on ADD COLUMN; see 118's
-- content_sync_mode) pin both columns to the TuningLevel union, so a drifted
-- writer cannot park an unreadable value in a column whose TS type is the
-- union. Keep them in lockstep with TUNING_LEVELS in shared/tuning/workflowTuning.ts.
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in
-- a this.transaction(...) call. A re-run raises "duplicate column name:
-- tuning_level" on the FIRST statement, which the runner treats as an
-- idempotent no-op and rolls back whole, so the backfill below cannot run twice
-- against already-migrated data (it is convergent anyway — the same predicate
-- over the same rows).

ALTER TABLE workflows
  ADD COLUMN tuning_level TEXT NOT NULL DEFAULT 'standard'
  CHECK (tuning_level IN ('efficient','standard','thorough','custom'));

UPDATE workflows
   SET tuning_level = 'custom'
 WHERE spec_json IS NOT NULL
   AND TRIM(spec_json, ' ' || char(9) || char(10) || char(13)) NOT IN ('', '{}');

ALTER TABLE workflow_runs
  ADD COLUMN tuning_level TEXT
  CHECK (tuning_level IS NULL OR tuning_level IN ('efficient','standard','thorough','custom'));
