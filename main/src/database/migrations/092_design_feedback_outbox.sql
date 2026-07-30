-- Migration 092: widen the feedback tables for design-prototype feedback and the
-- acknowledged durable outbox (Design Mode v1 — docs/ideas/design-mode.md,
-- "Design feedback v1 — acknowledged durable outbox").
--
-- Migration 077 CHECK-constrains `atype` on BOTH feedback tables to the two
-- document artifacts ('idea-spec','arch-design'), so element-anchored comments on
-- a design prototype cannot be stored at all today. This widens both CHECKs to
-- ('idea-spec','arch-design','ui-prototype','interactive-prototype') and gives
-- feedback_batches the outbox columns the delivery pipeline needs.
--
-- WHAT CHANGES
--
--  * feedback_batches.atype  CHECK += 'ui-prototype', 'interactive-prototype'.
--  * feedback_comments.atype CHECK += the same two (element anchors live in the
--    existing anchor_json column — see ElementCommentAnchor in
--    shared/types/feedback.ts; legacy quote anchors carry no `kind` field).
--  * feedback_batches gains six outbox columns:
--      session_id                 TEXT     — the design session the batch is bound
--                                            to (NULL for the legacy IDEA-033 doc
--                                            path, which binds to a parked run).
--      current_attempt_id         TEXT     — delivery-attempt id of the most recent
--                                            dispatch; the idempotency key the
--                                            revision turn echoes back.
--      attempt_count              INTEGER  — monotonic count of dispatch attempts.
--      blocked_reason             TEXT     — user-visible reason for status='blocked'
--                                            (link broken / session closed /
--                                            prototype missing).
--      dispatched_at              DATETIME — stamped when the SDK accepted the turn.
--      applied_prototype_revision INTEGER  — the artifact revision the acknowledged
--                                            result produced, correlating feedback
--                                            to the exact bytes that addressed it.
--  * feedback_batches.status CHECK += 'queued','dispatching','dispatched','blocked'.
--    TWO lifecycles share the column: the legacy IDEA-033 doc path stays
--    pending → applied | failed; the design outbox runs
--    queued → dispatching → dispatched → applied | failed | blocked. 'applied' is
--    terminal for both. Guarded by FeedbackRouter's explicit transition table —
--    the CHECK is only the storage-level floor.
--  * New partial index idx_feedback_batches_inflight on (status) WHERE status IN
--    ('queued','dispatching','dispatched') — the boot recovery scan that finds
--    batches a crash left mid-delivery. Partial so it stays tiny (terminal rows,
--    the overwhelming majority, are not indexed).
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the file-keyed
-- migration ledger applies each .sql once, so editing 077 in place would silently
-- never re-apply on a migrated DB. Both tables are recreated with the widened
-- CHECKs and their rows copied — the same recipe 035/045/060/062/063/073/089 use.
-- The leading `PRAGMA foreign_keys=OFF` is detected by the migration runner, which
-- toggles FK enforcement OFF *outside* the wrapping transaction so dropping
-- feedback_batches does not trip feedback_comments' FK (and so workflow_runs'
-- ON DELETE CASCADE does not fire). feedback_batches is rebuilt FIRST so the
-- rebuilt feedback_comments' REFERENCES binds to the new table.
--
-- WHY the six ALTER TABLE statements lead this file (the ensure-migration
-- landmine, cf. 088's header): this file's own INSERT..SELECT copies the six new
-- columns by name. On a ledger-wiped replay (an existing install re-running the
-- whole chain — e.g. the existing-install integration test), 077's
-- CREATE TABLE IF NOT EXISTS no-ops against the already-final table and this file
-- runs again; a copy naming only 077's columns would silently BLANK the six
-- outbox columns. Leading with the ALTERs inverts that: the whole file is one
-- transaction, so
--   * first apply — every ALTER succeeds (adding the columns to the 077-shaped
--     table), then the recreate rebuilds both tables with the widened CHECKs and
--     copies the FULL column set; all of it commits together;
--   * replay — the FIRST ALTER throws "duplicate column name: session_id", which
--     the runner treats as idempotent-ok: it rolls the transaction back and
--     ledger-marks the file. Skipping the rest is CORRECT, because the columns and
--     the widened CHECKs were added in that same single transaction, so a DB that
--     has the columns necessarily already has the CHECKs. Data is untouched.
-- The two states are therefore the only reachable ones: fully-077 or fully-092.
--
-- Timestamps stay writer-supplied ISO strings (FeedbackRouter); DEFAULT
-- CURRENT_TIMESTAMP is only a safety net.

-- Replay short-circuit + first-apply column add. MUST stay at the top of the file
-- and MUST NOT be joined by any non-ALTER statement above them.
ALTER TABLE feedback_batches ADD COLUMN session_id TEXT;
ALTER TABLE feedback_batches ADD COLUMN current_attempt_id TEXT;
ALTER TABLE feedback_batches ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feedback_batches ADD COLUMN blocked_reason TEXT;
ALTER TABLE feedback_batches ADD COLUMN dispatched_at DATETIME;
ALTER TABLE feedback_batches ADD COLUMN applied_prototype_revision INTEGER;

PRAGMA foreign_keys=OFF;

CREATE TABLE feedback_batches_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  atype TEXT NOT NULL CHECK (atype IN ('idea-spec','arch-design','ui-prototype','interactive-prototype')),
  -- Owning idea id (matches artifacts.source_ref for the per-entity atypes).
  source_ref TEXT NOT NULL,
  -- 1-based revision round per (run_id, atype, source_ref).
  round INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','applied','failed','queued','dispatching','dispatched','blocked')),
  -- Human-readable failure detail when status='failed'. Never raw stack traces.
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME,
  -- Design-outbox columns (NULL / 0 on every legacy IDEA-033 doc batch).
  session_id TEXT,
  current_attempt_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  dispatched_at DATETIME,
  applied_prototype_revision INTEGER
);

INSERT INTO feedback_batches_new
  (id, project_id, run_id, atype, source_ref, round, status, error, created_at, applied_at,
   session_id, current_attempt_id, attempt_count, blocked_reason, dispatched_at,
   applied_prototype_revision)
  SELECT id, project_id, run_id, atype, source_ref, round, status, error, created_at, applied_at,
         session_id, current_attempt_id, attempt_count, blocked_reason, dispatched_at,
         applied_prototype_revision
  FROM feedback_batches;

DROP TABLE feedback_batches;
ALTER TABLE feedback_batches_new RENAME TO feedback_batches;

CREATE INDEX IF NOT EXISTS idx_feedback_batches_doc
  ON feedback_batches (run_id, atype, source_ref);
-- Boot recovery scan: the batches a crash could have left mid-delivery.
CREATE INDEX IF NOT EXISTS idx_feedback_batches_inflight
  ON feedback_batches (status) WHERE status IN ('queued','dispatching','dispatched');

CREATE TABLE feedback_comments_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  atype TEXT NOT NULL CHECK (atype IN ('idea-spec','arch-design','ui-prototype','interactive-prototype')),
  source_ref TEXT NOT NULL,
  -- NULL while draft; stamped by send-batch / createDesignBatch. ON DELETE SET NULL
  -- keeps the comment record if a batch row is ever pruned.
  batch_id TEXT REFERENCES feedback_batches(id) ON DELETE SET NULL,
  -- FeedbackAnchor JSON — a quote anchor { quote, occurrence, bodyHash } for the
  -- doc atypes, or an element anchor { kind: 'element', designId, ancestorStack,
  -- pickedIndex } for the prototype atypes. See shared/types/feedback.ts.
  anchor_json TEXT NOT NULL,
  -- The comment text the user typed.
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','addressed')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at DATETIME,
  addressed_at DATETIME
);

INSERT INTO feedback_comments_new
  (id, project_id, run_id, atype, source_ref, batch_id, anchor_json, body, status,
   created_at, updated_at, sent_at, addressed_at)
  SELECT id, project_id, run_id, atype, source_ref, batch_id, anchor_json, body, status,
         created_at, updated_at, sent_at, addressed_at
  FROM feedback_comments;

DROP TABLE feedback_comments;
ALTER TABLE feedback_comments_new RENAME TO feedback_comments;

CREATE INDEX IF NOT EXISTS idx_feedback_comments_doc
  ON feedback_comments (run_id, atype, source_ref, status);

PRAGMA foreign_keys=ON;
