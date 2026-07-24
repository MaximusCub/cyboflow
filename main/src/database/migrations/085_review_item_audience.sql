-- Migration 085: add an `audience` dimension to `review_items` (Item 3).
--
-- `blocking` (does this item gate run resume?) and audience (does a HUMAN need to
-- see and act on this?) are independent axes that were previously collapsed onto
-- the single `blocking` bit. That collision is what let a machine-to-machine
-- mailbox finding — the visual merge-gate's UNDER-CAP `loopback-implement` finding,
-- which exists only so the orchestrator can re-delegate — render in the human
-- review queue AND count toward the run-park blocking gate, where a crash between
-- its creation and the superseding verdict could wedge the run on a pending
-- blocking item no human surface displayed.
--
-- `audience`:
--   'human'   (default) — a human must triage it: it renders in the review queue
--             and, when blocking, parks the run (the existing behavior for every
--             item that predates this column).
--   'machine' — a durable record the ORCHESTRATOR consumes; never rendered in the
--             human queue and never counted by the aggregate-unblock gate, so it
--             can neither wedge the run nor demand human attention. Lane-level
--             gating (awaiting-verify → loopback) is unaffected — that is lane
--             state, not run-level blocking.
--
-- Backfill: every existing row is 'human' via the DEFAULT, preserving current
-- semantics exactly.
--
-- NOTE: No `IF NOT EXISTS` on the ALTER — SQLite ALTER TABLE does not support it.
-- Re-running fails with 'duplicate column name: audience', which
-- runFileBasedMigrations() treats as the idempotency signal (same mechanism as
-- 013/017/018/024/079). No explicit BEGIN/COMMIT — the runner wraps each file.
ALTER TABLE review_items ADD COLUMN audience TEXT NOT NULL DEFAULT 'human'
  CHECK (audience IN ('human', 'machine'));

-- The run-park gate probes (run_id, blocking, status); adding audience to that
-- predicate keeps the "anything still blocking the run for a HUMAN?" count fast.
CREATE INDEX IF NOT EXISTS idx_review_items_run_blocking_audience
  ON review_items(run_id, blocking, status, audience);
