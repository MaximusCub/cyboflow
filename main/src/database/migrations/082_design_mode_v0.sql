-- Migration 082: Design Mode v0 (docs/ideas/design-mode.md).
--
-- Five changes backing the design-session kind, its durable design-spec
-- draft, and the Approve intent-first handoff state machine:
--
--   1. sessions.design_idea_id — nullable pointer to ideas.id linking a
--      design session to the idea it is designing. Plain ADD COLUMN, NO
--      FK/CHECK: sessions is a legacy table and SQLite FK enforcement is not
--      retrofitted onto it here — integrity (project ownership, liveness,
--      not-decomposed) is enforced at the write chokepoints instead, per
--      design-mode.md "Idea link — integrity contract". Precedent: the
--      031/021/027 family of plain nullable ADD COLUMNs on sessions.
--   2. artifacts.revision — monotonic content-revision counter, DEFAULT 1 so
--      every pre-existing artifact row starts at revision 1. Bumped by
--      ArtifactRouter on every enrich-in-place update that changes fields
--      (that bump logic is a later lane — this migration only adds the
--      column) and is the CAS material the design-spec draft binds against.
--   3. design_spec_drafts — one row per (session, draft_revision): the
--      durable, versioned design-spec markdown a design session maintains
--      across chat turns. bound_artifact_id/bound_artifact_revision are
--      NULL when the draft was written before any prototype exists yet
--      (not approvable at that point); once a prototype exists they pin the
--      artifact + its revision this draft's prose describes, so Approve can
--      CAS-check the draft against the artifact's CURRENT revision.
--   4. design_handoffs — the Approve intent-first recoverable state
--      machine's durable record (design-mode.md "Approve — intent-first
--      recoverable state machine"). state starts at 'intent' (persisted
--      before any side effect) and walks forward through
--      snapshotted -> folded -> complete, or off the happy path into
--      superseded (stale expectedIdeaVersion) / failed. Recovery resumes
--      from whatever state is on the row.
--   5. approved_designs — the read model: "current approved design for an
--      idea" = the row WHERE idea_id=? AND superseded_at IS NULL. A
--      re-approve supersedes the prior row (sets superseded_at) in the same
--      transaction as the new row's insert; that write logic lands in a
--      later lane, this migration only adds the table.
--
-- NO foreign keys anywhere in this migration, deliberately:
--   - sessions is a legacy table (see #1 above).
--   - approved_designs must survive workflow_run/artifact cascade-deletes —
--     snapshot_path holds the durable bytes on disk, so the read model stays
--     resolvable even after the run/artifact rows that produced it are gone.
-- design_spec_drafts and design_handoffs likewise skip FKs out to
-- sessions/ideas/artifacts for the same "outlive the producing run" reason
-- design_handoffs and approved_designs need; integrity is chokepoint-enforced
-- (later lane), not database-enforced, matching sessions.design_idea_id above.

ALTER TABLE sessions ADD COLUMN design_idea_id TEXT;

ALTER TABLE artifacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE design_spec_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idea_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  spec_markdown TEXT NOT NULL,
  -- NULL = draft written before any prototype exists (not approvable yet).
  bound_artifact_id TEXT,
  bound_artifact_revision INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, draft_revision)
);

CREATE TABLE design_handoffs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idea_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  draft_revision INTEGER NOT NULL,
  prototype_artifact_id TEXT NOT NULL,
  prototype_revision INTEGER NOT NULL,
  expected_idea_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'intent' CHECK (state IN ('intent','snapshotted','folded','complete','superseded','failed')),
  error TEXT,
  snapshot_path TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_design_handoffs_session ON design_handoffs(session_id);
CREATE INDEX idx_design_handoffs_state ON design_handoffs(state);

CREATE TABLE approved_designs (
  id TEXT PRIMARY KEY,
  idea_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  handoff_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  prototype_artifact_id TEXT NOT NULL,
  prototype_revision INTEGER NOT NULL,
  snapshot_path TEXT NOT NULL,
  approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  superseded_at DATETIME
);
CREATE INDEX idx_approved_designs_idea ON approved_designs(idea_id);
