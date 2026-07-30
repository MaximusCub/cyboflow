# Verification Setup Flow

Status: PROPOSAL (2026-07-30). Follow-up to `verification-agent-redesign.md`.
Scope decisions locked with Krishna in-session; adversarial review pending.

## 1. Problem

Visual verification has effectively never worked outside a toy project.
Production DB (`~/.cyboflow/sessions.db`, 2026-07-10 → 07-26): **28 requests,
2 passed** — both on 07-10 under the legacy engine. The verification-agent
engine (default since ~07-23) is **0-for-5**: 3 `launch_failed`, 2 `timeout`.
The dev-instance DB shows 3 passes, all against a static-HTML demo. Every
production failure is cyboflow attempting to verify **itself**.

Failure taxonomy across both engines:

| Class | Count | Era |
|---|---|---|
| `no url or htmlPath provided` | 6 | legacy (unfilled `.cyboflow/verify.json`) |
| `no healthy backend available` | 4 | legacy (native-desktop TCC health-check) |
| `ERR_CONNECTION_REFUSED :4521` | 4 | legacy (guessed port, no dev server) |
| `launch_failed` | 3 | agent |
| `request timed out` (10 min) | 2 | agent |

Root causes of the agent-era failures, confirmed against code and the agents'
own reports:

- **(a) Wrong serve form.** task-verify composes the generic web spec
  (`serve: "pnpm dev --port ${PORT}"`, `target: url`) instead of the Electron
  `attach:"cdp"` form. The exemplar JSON in `sprint/agents/task-verify.md` is
  the web form; the composer follows the exemplar.
- **(b) Singleton collisions.** Vite port 4521 (`strictPort:true`), CDP 9223,
  and Electron's single-instance lock keyed on `CYBOFLOW_DIR`
  (`main/src/index.ts:528-540`, defeating `--user-data-dir`) all collide with
  the user's own running dev instance. The leased `${PORT}` is decorative —
  nothing honors it.
- **(c) ABI mismatch.** Fresh-snapshot `pnpm install` produces host-Node
  better-sqlite3 (NMV 127); `electron .` needs NMV 136. No composed runbook
  included the electron rebuild.
- **(d) Deadline vs cold install.** `DEFAULT_AGENT_REQUEST_TIMEOUT_MS` = 10 min
  (`verificationScheduler.ts:641`); a cold monorepo install consumes most of it.
- **(e) Readiness false positive.** A leased pool port (29260) was answered
  (404) by a stale Vite from an unrelated worktree. The port-pool comment
  (`shared/types/visualVerification.ts:916-928`) documents this exact risk:
  "the per-port lease guards the logical slot, NOT the OS socket."

Two prior designs failed in opposite directions: the legacy waterfall required
a **manually authored** config nobody wrote; the agent engine **guesses
per-run with no memory** and guesses wrong every time. The middle — derive
once, *prove by running*, persist, reuse, invalidate on drift — is the core of
this proposal.

Explicitly rejected: Docker/container isolation (macOS Electron under
Linux/Xvfb is fidelity loss in both directions; the observed collisions are
namespace problems solvable with leases + isolated data dirs); resurrecting
the legacy capture-backend waterfall (see §4).

## 2. Shape: four phases, dependency-ordered

The user-facing framing is three layers (global onboarding → per-project setup
→ modality coverage). The build order is the reverse, plus a phase 0:

```
Phase 0  Honest failures        (days; no UX; stops the bleeding)
Phase 1  Modality roster        (defines everything downstream)
Phase 2  Project setup flow     (derive → prove → persist per project)
Phase 3  Onboarding + health    (generated from the roster; probes not checkboxes)
```

Rationale: a grants wizard (old item 1) cannot be specified until the roster
(old item 3) fixes which modalities exist and therefore which grants matter;
the runbook schema (item 2) serializes the roster; and none of the observed
failures are fixed by any wizard — they're fixed by phase 0 + phase 2.

## 3. Phase 0 — honest failures

All independent of the wizards; each is small and scheduler/runner-local.

1. **Attribution split.** Add a failure-class taxonomy (`env` | `deliverable`)
   to the agent report path. Today snapshot-mode `build_failed`/`launch_failed`
   returns `status:'failed'` (`verificationAgentRunner.ts:~344-357`) — a
   merge-gate FAIL charged to the lane's implement-retry budget, sending an
   agent to "fix" working code because a port was taken. Env-class failures
   (bind refused, binary missing, NODE_MODULE_VERSION mismatch, install
   failure, instance-lock contention) resolve `skipped`/infra and do NOT
   increment the lane attempt counter. Deliverable-class keeps FAIL.
2. **Degrade path.** A project with no proven runbook (or a stale one, once
   phase 2 exists) → `skipped` + a non-blocking setup CTA finding. Never a
   lane-blocking FAIL for "not configured."
3. **`unsupported` terminal state.** Distinct from unconfigured: a persisted
   per-project "cannot pass on this host, reason: X" that suppresses enqueue
   entirely (no CTA nag, no deadline burn). Re-evaluated only when the host
   roster changes. Until phase 1 ships modalities, `native-desktop` and
   `mobile-flow` requests land here with an explicit reason instead of today's
   deploy-and-fail-organically (the agent path never consults `verify_type` —
   dispatch keys solely on the run stamp, `verificationScheduler.ts:1435`, and
   `VerificationAgentRequest` has no type field).
4. **Circuit breaker.** K consecutive env-class failures for a project →
   auto-demote to skip + one non-blocking finding. (The 5 agent-era failures
   each burned the full deadline; nothing tripped.)
5. **Agent-path preflight.** The agent engine bypasses the legacy
   `selectCandidates` health gate entirely; a missing chromium currently
   surfaces *after* budget increment + snapshot provisioning + a full SDK
   deploy (`driverCore.ts:330-336`). Add a pre-deploy check (chromium
   resolvable, node resolvable, driver CLI present) that early-returns a
   structured skip, mirroring the legacy `skipReason` pattern.
6. **Budget accounting.** `judge_calls_used` sums cumulatively against
   `projects.visual_verify_budget_calls` for the project's lifetime; once
   exhausted, everything silently fail-opens to `skipped`. Setup/proof runs
   (phase 2) must be exempt or separately countered; surface budget state in
   the Verify Queue.

## 4. Phase 1 — modality roster

Tiering does not return as capture-backend rungs. The redesign collapsed the
waterfall deliberately (rungs could only *capture*, never stand the
deliverable up; fall-forward was never implemented; the doc's stated
philosophy is "build it as an agent-path capability, never resurrect a
waterfall rung"). Tiering returns as a **modality axis on the agent engine**:
the runbook declares what the project's UI is, the roster declares what this
host can do, and the request resolves against both — the only fall-through is
skip-with-reason.

Scope decision (Krishna, 2026-07-30): **Playwright/CDP + Peekaboo. Maestro/
mobile deferred** — Xcode has a new MCP coming; `mobile-flow` stays in the
type union and rests in the phase-0 `unsupported` state with reason
"deferred — pending Xcode MCP". The roster design keeps the slot open so it
lands later as a new modality entry + tool grant, no rearchitecting.

| Modality | Drives via | Drive? | Observe? | Grants | Concurrency |
|---|---|---|---|---|---|
| `web` | driver launches headless chromium (CDP) | yes | yes | none | parallel (port lease) |
| `cdp-app` | attach to app's own CDP endpoint (`attach:"cdp"`, `VERIFY_DRIVER_ATTACH_ONLY`) | yes | yes | none | parallel (port lease + isolated data dir) |
| `native-screen` | Peekaboo (drive + capture) | yes¹ | yes | Screen Recording + Accessibility | **exclusive** (`VERIFY_SCREEN_LEASE`, count 1) |
| `mobile` | — deferred | — | — | — | `unsupported (deferred — Xcode MCP)` |

¹ Peekaboo driving is newly enabled (Krishna fixed the blocking setting,
2026-07-30) and must be **smoke-verified live** before phase 1 hardcodes it —
the session's registered MCP still exposed only observe tools. If driving
doesn't hold, `native-screen` degrades to observe-only behaviors.

Design consequences the roster must pin down:

- **Behavior targeting differs by modality.** CDP behaviors address elements
  by selector; native behaviors address them descriptively (accessibility
  label / visual description / coordinates) — no DOM exists. The
  `VerificationTaskV1` behavior schema gains a modality discriminant that
  changes how task-verify composes steps. Widening happens in lockstep across
  the request row, `VerificationAgentRequest` (which gains the type/modality
  field it currently lacks), and `VerificationTaskV1`/`ReportV1` — per the
  shared-type file's "single contract split across files — widen together"
  note.
- **Modalities compose per project.** A desktop app declares `cdp-app` for
  web-view content *and* `native-screen` for OS chrome (menus, dialogs, tray).
- **Screen exclusivity is a product policy, not just a lease.** A driving
  native verification moves the user's pointer and types on their machine.
  Required in this phase: when native verifications may run (queue-until-idle
  / explicit go-ahead), and a visible "verification is driving" affordance.
  The `VERIFY_SCREEN_LEASE` seam already exists (`verificationScheduler.ts:108`),
  currently referenced only by retired code.
- **Isolation levers are part of the roster contract**, not per-project
  improvisation: leased ports, per-request temp data dir (`--user-data-dir`
  or the app's own lever, e.g. `CYBOFLOW_DIR`), electron-ABI rebuild step for
  native-dep apps, and identity-verified readiness (§7.1).
- **Driver additions for `native-screen`**: new `DriverCommand` variants (or a
  scoped Peekaboo tool grant) + harness-contract prompt update +
  `visual-verify.md` update; the retired `peekabooBackend.healthCheck()`
  (both-grants probe, never-throws) is reused as the live grant probe.

## 5. Phase 2 — project setup flow

A guided, per-project flow: **derive → prove → persist → reuse → re-derive on
drift.** The proof step is the whole difference from the failed
`.cyboflow/verify.json` model — the exit criterion is a real boot + screenshot
via the actual verification path, not a written file.

### 5.1 Flow mechanics (mostly reuse)

- A 5th registered built-in flow (`workflow_runs`-backed — a `design.md`-style
  chat prompt has no gate/verification machinery). Registration is cheap: name
  tuple + `WORKFLOW_DEFINITIONS` entry + `.md` + agent keys in
  `CANONICAL_AGENT_KEYS`; no migration (`ensureGlobalBuiltIns()` self-seeds).
- **Compound's `approve-learnings → write-back → human-review` is the 1:1
  template** for "propose runbook/diff → approve (inline AskUserQuestion) →
  apply + commit → terminal merge gate over the diff."
- Repo changes follow a **rung ladder**: rung 0 — existing levers only (env
  vars, CLI flags; most projects end here); rung 1 — config-only; rung 2 — a
  proposed diff, human-approved, never auto-applied. A tool that wants to edit
  your repo before it verifies anything is a tool people turn off.

### 5.2 New seams (build; the plan must name them or the flow will improvise)

1. **Runbook persistence.** No writer exists: `verifyConfigLoader.ts` is the
   *sole reader* of `.cyboflow/verify.json`; no MCP tool, no project-row
   columns for it. The runbook is written as an ordinary repo file edit +
   commit (the Compound write-back pattern) — plus a project-row registration
   (migration) for the machine-local half (§5.3) via the router chokepoint.
2. **Synchronous proof primitive.** `cyboflow_request_verification` is
   fire-and-continue and its only verdict delivery path is sprint-lane
   driving. The setup flow's "test-execute the runbook" step needs a
   wait-for-verdict seam (bounded, with the verdict surfaced inline).
3. **Compose-time injection.** The verifier runs in a detached snapshot at the
   task's sha (`git worktree add --detach`): an uncommitted runbook is
   invisible; a committed one is absent from every branch cut before it. The
   runbook is therefore resolved from the live worktree / project row at
   **compose time** (task-verify) and injected into the `VerificationTaskV1`
   payload — never read from inside the snapshot.

### 5.3 Runbook contract

- **Split halves.** Committed-portable: commands, behaviors, modality
  declarations, readiness spec. Machine-local (gitignored / project-row):
  resolved binary paths, ports, data-dir lever values, ABI facts. A committed
  runbook derived on one machine must not encode another machine's lies.
- **Proof provenance.** Each proof records: sha, project input-hash (dev/build
  scripts, lockfile, electron/node versions), **host fingerprint** (chromium
  binary, TCC grant state, node major, app binary path), timestamp. Either
  hash changing demotes the runbook to `unproven-draft`.
- **`unproven-draft` behaves exactly like unconfigured** (phase-0 skip + CTA).
  A failed proof persists the draft + diagnosis and exits the wizard cleanly —
  never a dead-end, never a stale-but-green runbook.
- **Proof runs in the verifier's environment class** (detached snapshot +
  prepared deps), not the setup flow's own worktree — a proof obtained in
  environment X asserted about environment Y is not a proof.
- **Install/rebuild steps are illegal in runbooks** (see §7.2); snapshots
  consume a prepared dependency set.

### 5.4 Contention + acceptance

- Setup's own test runs lease from the same port pool at lower priority with a
  shorter deadline; pool size decoupled from `SPRINT_BATCH_CAP` (both are 5
  today — setup can starve live lanes past the 15-min queued-age ceiling).
- Setup/proof runs exempt from the lifetime judge budget (phase 0 item 6).
- **Dogfood prerequisite + acceptance criterion**: parameterize cyboflow's own
  singletons (vite port env-var + strictPort relaxation for verify builds, CDP
  port flag pass-through, `CYBOFLOW_DIR`-keyed lock → per-request temp dir).
  **Done means: cyboflow verifies itself green, 3 consecutive runs,
  unassisted.** The only project generating real failure data is the one the
  rung ladder would otherwise defer.

## 6. Phase 3 — onboarding + health

Generated from the phase-1 roster; nearly invisible for most users.

- **Probes, not checkboxes.** Every row is a live probe run at open + at
  verification time, not a remembered wizard answer: TCC grants rot silently
  on any app-path/version change while a wizard's checkmark keeps saying
  "configured". For `native-screen`, the probe is a **round-trip**: perform
  one synthetic click against a harmless target and confirm the effect —
  "grant present but driving broken" was the exact live state that motivated
  this (Krishna's own fix). Probe results are recorded on the request row.
- **Chromium is provisioning, not consent**: auto-install (reviving the
  retired `playwrightInstaller.ensureChromium` pattern on the agent path) with
  a visible health row — never a deep post-deploy failure.
- **Conditional grants branch.** The Peekaboo grant pair appears only when
  some project's runbook declares `native-screen`. CDP-only users never see a
  permissions screen.
- **Health panel** on `VerifyQueueView` (the natural "verification screen"):
  per-project attempts, pass rate, failure-class histogram (needs phase 0's
  taxonomy), median duration, budget consumed, probe states, and fix-it CTAs.
  Ships **before** the setup wizard is polished, so its effect is measurable —
  the 2-for-28 baseline was discovered by hand-querying sqlite; the app
  currently reports nothing.
- UI anchors that exist today: the bare master checkbox
  (`Settings.tsx:999-1015`; the six advanced config fields have no UI),
  `VerifyQueueView` empty state, an onboarding-carousel step, the session
  wizard's Advanced verification radio.

## 7. Cross-cutting hazards (fix regardless of phases)

1. **Verified-artifact identity.** The false-ready incident is designed in:
   the port pool is an in-process mutex ("guards the logical slot, NOT the OS
   socket"); the sole TCP probe runs at teardown only; the driver's `goto`
   checks HTTP status, never identity. PID-verified readiness is insufficient
   (warm caches, the user's own running app). Fix: a per-request nonce/build
   stamp injected at build/serve time that the driver must read back from the
   live surface; no `passed` without it (else `low_confidence`).
2. **Snapshot dep-symlink write-through.** `snapshotProvisioner.
   linkDependencyDirs` symlinks `node_modules` from the live sprint worktree
   into the snapshot; any `pnpm install`/`electron:rebuild`/`playwright
   install` inside the snapshot writes **through** the symlink into the shared
   worktree — flipping better-sqlite3's ABI under sibling lanes — and
   `checkSnapshotMutated` (`git diff HEAD`, tracked files only) cannot see it.
   Prepared/per-snapshot dep dirs + runbook lint forbidding install steps.
3. **Immutable stamping.** `verify_enabled/type/chain` are stamped once at
   `createRun` with no UPDATE path: setup completing mid-sprint affects only
   subsequent runs — state this in the UI.
4. **Deadline.** Raise the agent deadline toward the existing 20-min ceiling
   for cold-install projects, or warm the snapshot's deps (which §7.2's
   prepared-deps work provides anyway).

## 8. Open questions

- Native-screen scheduling policy: queue-until-idle vs explicit user
  go-ahead per run (leaning: explicit go-ahead in v1, idle-queue later).
- Runbook machine-local half: project-row JSON column vs gitignored sibling
  file (leaning: project row, via the router chokepoint, so the entity model
  owns it).
- Whether the setup flow needs a no-seed launch path (Compound-style) —
  follow-up read of `runLauncher.ts` required.
- Proof-run cost accounting: exempt entirely vs separate counter surfaced in
  the health panel (leaning: separate counter).
