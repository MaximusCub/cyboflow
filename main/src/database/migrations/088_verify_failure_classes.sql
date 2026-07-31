-- Migration 088: verification failure classification + capability ledger
-- (docs/proposals/verification-setup-flow.md §3 "Phase 0 — honest failures").
--
-- The verification-agent redesign (migration 078) gave every terminal request a
-- structured VerificationReportV1, but the SCHEDULER still collapses every
-- non-pass outcome onto the same `status='failed'` a real deliverable defect
-- gets — a taken port and a broken renderer commit are indistinguishable to the
-- merge gate, so the gate charges the lane's implement-retry budget for both.
-- This migration opens the persistence channel for the §3.1 conservative
-- three-way classifier (`env` | `deliverable` | `ambiguous`,
-- shared/types/visualVerification.ts VerificationFailureClass) and the §3.3/§3.4
-- per-modality capability ledger (`unsupported` state + circuit breaker) that
-- consumes it. Two parts:
--
-- (1) Five ADDITIVE columns on the EXISTING verification_requests queue
--     (migration 055, widened by 078), each independently a no-op for a
--     pre-upgrade reader — mirrors 078's own additive-nullable posture exactly:
--
--   failure_class        — the classifier's verdict (VerificationFailureClass),
--                           stamped on CLASSIFIED terminals: 'failed' rows,
--                           'skipped' rows produced by a pre-lease gate or an
--                           env-conversion ('env'), and 'timeout' rows
--                           ('ambiguous'). NULL on passed rows, on skips that
--                           predate classification (legacy path), and on every
--                           pre-088 row. NEVER 'env' without harness-derived
--                           provenance (see failure_evidence_json); everything
--                           else defaults conservative ('ambiguous', blocking).
--   failure_evidence_json — the VerificationFailureEvidence[] the classifier's
--                           verdict was derived from (JSON), so a health-panel
--                           audit (phase 3) can inspect WHY a request was
--                           classified 'env' rather than trust the label alone.
--                           NULL when failure_class is NULL.
--   modality              — the VerificationModality (shared type) this request
--                           resolved to (resolveTaskModality), stamped at
--                           enqueue — the key the phase-0/phase-1 capability
--                           ledger below is keyed on. NULL for a pre-088 row
--                           (the modality axis did not exist yet).
--   preflight_json        — the agent-path pre-deploy preflight result (§3.5:
--                           chromium/node/driver-cli resolvable, leased port
--                           genuinely free), captured before any budget
--                           increment or snapshot provisioning. NULL when no
--                           preflight ran (legacy path, or a pre-088 row).
--   setup_proof           — 0/1, NOT NULL DEFAULT 0. Marks a phase-2 setup/proof
--                           run (the setup flow's "test-execute the runbook"
--                           step) as EXEMPT from the project's lifetime judge
--                           budget (§3.6 / projects.visual_verify_budget_calls) —
--                           a proof run must never silently fail-open to
--                           'skipped' because ordinary lane traffic exhausted the
--                           budget first. Every pre-088 row and every ordinary
--                           lane request defaults to 0 (counted, unchanged
--                           behavior).
--
-- (2) The capability ledger — two new tables backing VerifyCapabilityStore
--     (main/src/orchestrator/verify/capabilityStore.ts):
--
--   verify_capability_state — one row per (project, modality, portable-runbook
--     hash): the §3.3 'unsupported' mark and the §3.4 circuit breaker share this
--     row (a modality is either a plain counter mid-count, or SUPPRESSED with a
--     reason — the two states are mutually exclusive per row, distinguished by
--     `status`). `runbook_hash` defaults to '' for the pre-runbook (phase-0)
--     world where no portable runbook exists yet — every project/modality has
--     exactly one ''-keyed row until phase 2 lands per-runbook keying.
--     `consecutive_env_failures` is the breaker's counter (§3.4, threshold =
--     CAPABILITY_BREAKER_THRESHOLD); `suppressed_until` + `host_generation`
--     are the SELF-REFRESHING re-probe pair (§3.3): a suppressed/unsupported
--     row is only ACTIVE while `suppressed_until` is still in the future AND
--     `host_generation` still matches the singleton `verify_host_state` row —
--     either a TTL elapsing or ANY probe observing a changed host fact
--     (bumping the generation) lets the next request re-attempt instead of
--     wedging in permanent suppression (the recovery-deadlock this proposal
--     exists to fix). No FK: this ledger must survive a deleted/archived
--     project's other rows exactly as long as the project row itself does, and
--     project_id here is a plain integer handle, matching the router-enforced
--     (not DB-enforced) integrity posture `projects.visual_verify_budget_calls`
--     already uses.
--
--   verify_host_state — a SINGLE row (id=1, CHECK-pinned) holding the host
--     capability GENERATION counter every `verify_capability_state` row's
--     `host_generation` is compared against, plus the last-observed host
--     fingerprint (chromium binary, TCC grants, node major, app binary path —
--     §5.2 proof provenance) for diagnostics. Absent (no row yet) reads back as
--     generation 0 — VerifyCapabilityStore.currentHostGeneration() defaults to
--     0 in that case, so a fresh install's pre-existing capability rows (there
--     are none) are never spuriously treated as stale.
--
-- NOTE: No `IF NOT EXISTS` on the ALTERs — SQLite ALTER TABLE does not support
-- it, and one ADD COLUMN per statement is required. Re-running raises
-- 'duplicate column name: ...', the idempotency signal runFileBasedMigrations()
-- in database.ts uses to skip an already-applied file (same mechanism 055/078
-- rely on). The two CREATE TABLE statements use `IF NOT EXISTS` instead, since
-- SQLite DOES support that clause there — re-running is a natural no-op for them,
-- independent of the ALTER-based signal the file-runner actually keys off of.
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in
-- a this.transaction(...) call.

ALTER TABLE verification_requests ADD COLUMN failure_class TEXT;
ALTER TABLE verification_requests ADD COLUMN failure_evidence_json TEXT;
ALTER TABLE verification_requests ADD COLUMN modality TEXT;
ALTER TABLE verification_requests ADD COLUMN preflight_json TEXT;
ALTER TABLE verification_requests ADD COLUMN setup_proof INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS verify_capability_state (
  project_id INTEGER NOT NULL,
  modality TEXT NOT NULL,
  runbook_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active','suppressed','unsupported')),
  reason TEXT NOT NULL DEFAULT '',
  consecutive_env_failures INTEGER NOT NULL DEFAULT 0,
  host_generation INTEGER NOT NULL DEFAULT 0,
  suppressed_until DATETIME,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, modality, runbook_hash)
);

CREATE TABLE IF NOT EXISTS verify_host_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  capability_generation INTEGER NOT NULL DEFAULT 0,
  fingerprint_json TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
