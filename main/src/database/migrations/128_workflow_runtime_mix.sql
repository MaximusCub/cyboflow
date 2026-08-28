-- Migration 128: per-workflow RUNTIME MIX + its frozen per-run stamp.
--
-- Design: docs/plans/workflow-runtime-mix.md (D2). The SECOND per-workflow dial,
-- orthogonal to migration 124's tuning level: the level decides WHICH steps run
-- and at what Claude tier·effort, the mix decides WHICH PROVIDER runs each step,
-- split along one line — execution vs. verification:
--
--   claude          Claude executes, Claude verifies  (today's default, identity)
--   claude-primary  Claude executes, Codex verifies
--   codex-primary   Codex executes,  Claude verifies
--   codex           Codex executes,  Codex verifies
--
-- WHY A COLUMN AND NOT A KEY INSIDE spec_json — the same reason 124 gives:
-- `workflowDefinitionSchema` is a plain `z.object`, so an unrecognized top-level
-- key is SILENTLY STRIPPED on every write and a mix stamp living in the spec
-- would survive exactly until the next editor save. And it is not definition
-- DATA: the mix is applied to the graph once, at createRun, and never persisted
-- into it (plan D1).
--
-- ONE DIFFERENCE FROM 124 worth stating, because it looks like an omission: an
-- Advanced-editor spec save flips `tuning_level` to 'custom' (the slot IS the
-- custom level's storage) but deliberately does NOT touch `runtime_mix`. The mix
-- is orthogonal to what the graph says — a hand-edited graph still routes its
-- verification steps to Codex if that is the flow's saved mix — so it survives
-- spec edits, resets and level flips alike.
--
-- NO BACKFILL. The DEFAULT 'claude' IS today's behaviour: `materializeForLevelAndMix`
-- short-circuits the 'claude' arm through `materializeForLevel` verbatim, so every
-- existing flow keeps freezing the byte-identical spec text (and therefore the same
-- spec_hash) it froze before this column existed.
--
-- workflow_runs.runtime_mix is NULLABLE with no backfill: it is the frozen per-run
-- stamp (the same immutable-snapshot pattern as spec_hash / tuning_level / variant_id),
-- written at createRun. NULL means "pre-feature, a VARIANT run (a variant is its own
-- frozen graph — attributing a mix to it would poison the per-mix buckets), a
-- non-built-in flow, or an omp/pi run (single-provider lanes the mix does not
-- describe)". Every reader must treat NULL as UNATTRIBUTED, never as 'claude'.
--
-- CHECK constraints (SQLite permits them on ADD COLUMN; see 124's tuning_level)
-- pin both columns to the RuntimeMix union, so a drifted writer cannot park an
-- unreadable value in a column whose TS type is the union. Keep them in lockstep
-- with RUNTIME_MIXES in shared/tuning/runtimeMix.ts.
--
-- Numbered 128: 126 (level-scoped variants) and 127 (project permission trust)
-- landed with the 2026-08-28 rebase. The ledger is filename-keyed so a collision
-- is not lost — both files would apply — but their relative order would then fall
-- out of readdir rather than being stated. Renumbering on collision is the repo's
-- standing practice; the integrator MUST verify no other 128_*.sql exists at merge
-- time (`ls main/src/database/migrations/`).
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in a
-- this.transaction(...) call. A re-run raises "duplicate column name: runtime_mix"
-- on the FIRST statement, which the runner treats as an idempotent no-op and rolls
-- back whole.

ALTER TABLE workflows
  ADD COLUMN runtime_mix TEXT NOT NULL DEFAULT 'claude'
  CHECK (runtime_mix IN ('claude','claude-primary','codex-primary','codex'));

ALTER TABLE workflow_runs
  ADD COLUMN runtime_mix TEXT
  CHECK (runtime_mix IS NULL OR runtime_mix IN ('claude','claude-primary','codex-primary','codex'));
