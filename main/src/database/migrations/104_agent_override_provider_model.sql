-- Migration 104: agent_overrides.provider_model — generalize codex_model to
-- any resolved non-Claude provider.
--
-- WHY. `codex_model` (migration 070) is a provider-NAMED column on a
-- provider-neutral row: it stores the free-form model id for an agent's
-- pinned NON-CLAUDE runtime, but the name only made sense while Codex was the
-- only such provider. `provider_model` generalizes it — "the model id for
-- this agent's resolved non-Claude provider" — so a future provider (e.g.
-- OMP) reuses this same column without another rename.
--
-- `codex_model` STAYS as a read-compat column, not a dead one: code writes
-- BOTH columns on every save (rollback compat — a build that predates this
-- migration reads only `codex_model` and must keep seeing the right value),
-- and reads COALESCE(provider_model, codex_model) — an explicit
-- `provider_model` always wins, but a pre-104 row that only ever set
-- `codex_model` still resolves correctly with no backfill gap.
--
-- No CHECK constraint, mirroring `codex_model` and the router-level
-- validation the rest of this table already relies on (migrations 016/026).

ALTER TABLE agent_overrides ADD COLUMN provider_model TEXT;

UPDATE agent_overrides
   SET provider_model = codex_model
 WHERE codex_model IS NOT NULL AND provider_model IS NULL;
