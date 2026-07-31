-- Migration 096: the verification runbook's MACHINE-LOCAL half + the per-request
-- runbook pin (docs/proposals/verification-setup-flow.md §5.2 seam 1/seam 3 +
-- §5.3 "Runbook contract").
--
-- Migration 095 opened the honest-failure channel (classification + the
-- capability ledger) and left one thing structurally missing: there is no
-- runbook. `verifyConfigLoader.ts` is the SOLE reader of `.cyboflow/verify.json`
-- and there is no writer anywhere, no MCP tool, and no project-row columns for
-- it — so the phase-0 degrade gate's `runbookStatus` dependency answers
-- `'absent'` for every project by construction. This migration lands the
-- persistence side of the phase-2 contract that fills it.
--
-- THE SPLIT (§5.3 — why this is a table and not a file). A runbook has two
-- halves and they must NOT live in the same place:
--
--   * COMMITTED-PORTABLE — commands as parameterized lever templates
--     (`${PORT}`, never a resolved port), behaviors, modality declarations,
--     readiness/attestation specs. Lives in the REPO at
--     `.cyboflow/verify-runbook.json` (shared/types/verifyRunbook.ts
--     VERIFY_RUNBOOK_RELATIVE_PATH), travels with the code, is reviewed like
--     code. Nothing about it belongs in a machine's database.
--   * MACHINE-LOCAL — host capabilities and the resolved lever BINDINGS that
--     are stable per host (binary paths, the data-dir lever's name, ABI facts),
--     the proof provenance, and the fingerprints that DEMOTE the runbook when
--     they drift. Nothing about it belongs in a shared repo: "a committed
--     runbook derived on one machine must not encode another machine's lies."
--   * REQUEST-SCOPED values (ports, temp dirs) live in NEITHER half — the
--     scheduler resolves them per request after lease acquisition. A persisted
--     port goes stale, diverges from the held lease, or collides; §1's root
--     causes (b) and (e) are exactly that mistake made informally.
--
-- Two parts:
--
-- (1) Two ADDITIVE nullable columns on verification_requests (migration 055,
--     widened by 078 and 095) — the §5.2 seam-3 PIN. The verifier runs in a
--     detached snapshot at the task's sha, so the runbook can be neither read
--     from inside the snapshot (a committed runbook is absent from every branch
--     cut before it) nor read live at execution time (revision-B commands
--     executing against revision-A code yield a verdict attesting to a hybrid no
--     revision ever contained). v2's rule is content-addressing instead: BOTH
--     halves are stamped at enqueue and the runner executes exactly that
--     revision or rejects.
--
--   runbook_hash          — the portable half's content hash
--                           (runbookHash.ts runbookPortableHash: sha256 over a
--                           canonical, recursively key-sorted serialization, so
--                           reformatting the committed file never re-keys it).
--                           NULL on every pre-096 row and on every request
--                           enqueued without a proven runbook (the degrade path
--                           skips those before they ever deploy).
--   runbook_local_version — the machine-local record's CAS version at enqueue.
--                           A mismatch at execution time is a local-half CAS
--                           conflict: the runbook changed under the request, so
--                           the runner rejects with structured "runbook/sha
--                           mismatch" feedback (env-class, NON-attempt-charging
--                           — see failureClassifier's `runbookMismatch` input,
--                           which is hard-wired false until this lands) rather
--                           than improvising against live state.
--
-- (2) verify_runbook_local — the machine-local half itself, one row per
--     (project, modality). Sibling in every respect to 095's
--     verify_capability_state, including its integrity posture: NO foreign key.
--     project_id is a plain integer handle, matching the router-enforced (not
--     DB-enforced) posture `projects.visual_verify_budget_calls` and the
--     capability ledger already use.
--
--   portable_hash / portable_json — the EXACT portable half this record was
--     registered against, stored verbatim alongside its hash. Keeping the JSON
--     (not just the hash) is what makes the pin resolvable: the runner fetches
--     by (project, modality, hash) and executes THAT revision, even though the
--     snapshot's own tree may predate the file entirely.
--   version — the CAS token. Bumped by registerDraft (a NEW portable revision
--     is a new record version); NOT bumped by a drift demotion, so a pin taken
--     against this record stays resolvable while its `status` honestly reports
--     that it is no longer proven.
--   status  — 'proven' | 'unproven-draft'. There is no third state: an ABSENT
--     row is the absent state. 'unproven-draft' behaves exactly like
--     unconfigured at the degrade gate (skip + CTA) because §1's whole lesson is
--     that a written-but-unproven config is what already failed once; only a
--     real boot + screenshot through the actual verification path flips this to
--     'proven' (markProven, engine-driven, CAS-checked).
--   bindings_json — the resolved per-host lever bindings (binary paths,
--     data-dir lever name, ABI facts). NEVER ports or temp dirs.
--   proof_json    — the §5.3 proof provenance the engine assembles when it
--     flips the record proven: sha, portable hash, local version, project
--     input-hash, host fingerprint, timestamp. NULL while unproven.
--   input_hash    — the project INPUT hash at registration (dev/build scripts,
--     lockfile, electron/node versions). A fresh recomputation differing from
--     this demotes the record: the commands were proven against inputs that no
--     longer exist.
--   host_fingerprint_json — the host fingerprint at registration (chromium
--     binary, TCC grant state, node major, app binary path). Same demotion rule.
--     §5.3: "Any component changing demotes."
--
-- Demotion is a WRITE-THROUGH on read (runbookStore.status): the drift is
-- discovered by the next request that asks, and the record is corrected then and
-- there rather than left green-but-lying until someone re-runs setup.
--
-- NOTE: No `IF NOT EXISTS` on the ALTERs — SQLite does not support it there, and
-- one ADD COLUMN per statement is required. Re-running raises 'duplicate column
-- name: ...', the idempotency signal runFileBasedMigrations() keys off of (same
-- mechanism 055/078/095 rely on). The CREATE TABLE uses `IF NOT EXISTS`, which
-- SQLite DOES support — a natural no-op on re-run.
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in
-- a this.transaction(...) call.

ALTER TABLE verification_requests ADD COLUMN runbook_hash TEXT;
ALTER TABLE verification_requests ADD COLUMN runbook_local_version INTEGER;

CREATE TABLE IF NOT EXISTS verify_runbook_local (
  project_id INTEGER NOT NULL,
  modality TEXT NOT NULL,
  portable_hash TEXT NOT NULL,
  portable_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('proven','unproven-draft')),
  bindings_json TEXT,
  proof_json TEXT,
  input_hash TEXT,
  host_fingerprint_json TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, modality)
);
