# Lane runbook bootstrap — verification that sets itself up

**Status:** proposal, v2 — rewritten after adversarial review
**Review history:** v1 was reviewed independently by Codex and by a Fable agent.
Codex returned 8 blocking defects; Fable returned 9 more that Codex missed and
judged v1 **not salvageable in its proposed shape**. Five of Codex's and two of
Fable's were verified against the code by hand. v1's design is discarded; §16
records what it got wrong, because those mistakes are the reason this version is
shaped the way it is.
**Two decisions in §15 are the user's to make** and implementation should not
start before they are answered — one of them relaxes a constraint the user locked.

**Related:** `verification-setup-flow.md` (runbook contract, §3.2 degrade gate,
proof-by-running), `verification-agent-redesign.md` (§5.3 agentless visual-verify,
§7.2 dependency guard).

---

## 1. The problem

A sprint lane composes a visual-verification task, the controller enqueues it, the
lane parks at `awaiting-verify` — and on nearly every project, nothing is verified.
The third pre-lease gate (`verificationScheduler.ts:2727`) skips any task that has
to build or serve the deliverable unless the project already has a **proven**
runbook. `verdictDelivery.ts:376` attaches a CTA pointing at the **Verify Setup**
flow — a separate flow a human must launch, with two human gates of its own — and
`mergeGateLaneAdvance` advances the lane to `integrated`. The sprint completes with
a green lane no camera looked at.

We have direct evidence of the dead end from inside the product: an ad-hoc
verification fired from a chat session comes back `skipped` for this reason, and
`setup_proof` — the one request kind that could break the deadlock — is refused
outside the verify-setup flow.

That posture was the correct reaction to a real failure: the agent engine used to
guess the environment per-run with no memory and guessed wrong every time (0-for-5
in production). But **"stop guessing" and "stop trying" are different rules.** The
setup flow already contains what makes an attempt safe — derive, register, and
*prove by actually running it*, with only a passing run flipping a draft to proven,
and the engine rather than the agent doing the flipping. What is missing is an
autonomous entry point.

**The bar.** It must be impossible for this feature to make a verification *pass*
that would not otherwise have passed. It may only convert "skipped" into "actually
ran". v1 claimed this bar and did not meet it (§16). Everything below exists to
meet it.

---

## 2. What the reviews changed

v1 tried to implement this by **adding a lane step**. That single decision put an
autonomous, file-writing agent inside four seams that each already have a strong
owner and a documented invariant:

- the **shared lane worktree and its single git index**,
- the **both-plane `fanOut.inner` contract**,
- the **merge-gate verdict path**,
- and an **idempotency scheme** that was never designed for a second request per
  lane attempt.

It broke all four. The fix is not eight patches; it is to stop threading the
bootstrap through machinery built for something else. v2 is **smaller, earlier, and
read-only where v1 was late and write-capable**:

| | v1 | v2 |
|---|---|---|
| Trigger | react to the skip in the merge gate | **preflight before enqueue**, at the controller seam |
| Who writes files | the drafting agent, into the shared worktree | **the controller**, one file, pathspec commit |
| Drafting agent tools | Read/Grep/Glob/Bash/Write/Edit | **read-only** (no Write, no Edit, no git) |
| Rung ceiling | 0/1, guarded by a committed-diff check | **rung 0 only** (see §15, decision A) |
| Proof shape | lane's full task, then a probe on failure | **one attestation-only proof** |
| Proof verdict path | the merge gate | **`awaitTerminal`, outside the merge gate entirely** |
| Waiting lanes | park, then re-fire | **degrade to today's skip; next run verifies** |
| Single-flight | in-memory mutex | **persisted run-scoped stamp** |

Every row is a defect being deleted rather than fixed.

---

## 3. The blocking discovery: the gate probes the wrong tree

The finding that most shapes v2, and which v1 had no idea about
(`main/src/index.ts:2055-2064`):

```ts
// Probed against the PROJECT path — both ask a project-level question … while the
// enqueue-time injection (scheduler.resolveProvenRunbook) probes the requesting
// RUN's worktree, which is the tree whose commands would actually execute.
verifyRunbookStatus = async (projectId, modality) => {
  const projectPath = databaseService.getProject(projectId)?.path;
  if (!projectPath) return 'absent';
  return verifyRunbookStore.status(projectId, projectPath, modality);
};
```

The degrade gate probes the **project root**. The enqueue-time runbook injection
probes the **run worktree**. A runbook a lane commits to its session branch is
therefore invisible to the gate until that branch merges — so even after a
successful proof, every ordinary request in the same run still skips with
`VERIFY_NO_RUNBOOK_REASON`. Combined with the singleton-record hazard (§4), each
pre-merge run would re-bootstrap and re-demote the record: **steady-state thrash.**

v1's entire §7 payoff — waiting lanes re-firing into a now-proven runbook — was
unreachable in the current wiring, and no amount of care inside the lane would have
revealed it.

**v2 requires an explicit, reviewed semantic change: for LANE requests, the
pre-lease gate probes the requesting run's worktree** (`worktreePathForRun` already
exists), matching what the injection already does and what actually executes. This
is decision B in §15. Without it, this feature cannot work at all; with it, the
gate and the injection stop disagreeing about which tree they are talking about,
which is arguably a latent bug independent of this proposal.

---

## 4. Never bootstrap over someone else's proof

`status()` collapses three different situations into `'unproven-draft'`, and only
two of them are safe to bootstrap:

| Situation | Safe to bootstrap? |
|---|---|
| No record, no file — nothing was ever derived | **yes** |
| A record exists, marked `unproven-draft` | **yes** |
| A record is **proven**, but *this tree* lacks the portable file | **NO** |

The third is the documented pre-merge case (`runbookStore.ts:195`) — the file is
absent, and the store deliberately answers `unproven-draft` **without demoting**,
because "this tree lacks it" and "this runbook changed" are different facts. But
`registerDraft` UPSERTs a **singleton** `(project_id, modality)` row. A lane on a
branch predating the runbook merge would therefore derive a fresh runbook and
**overwrite the proven record every other branch depends on** — breaking
verification precisely for the projects that set it up properly.

**v2:** `VerifyRunbookStore` grows `statusDetail()`, returning the reason
discriminant alongside the three-valued answer
(`'no-record' | 'draft' | 'proven-file-absent-here' | 'drifted'`). The preflight
fires only on `'no-record'` and `'draft'`. `'proven-file-absent-here'` degrades to
today's skip with a finding that says so — the runbook exists, merge the branch
that carries it.

---

## 5. `bootstrap_proof`: a kind, not a privilege

`setup_proof` bundles three privileges (`verificationScheduler.ts:1623`):
degrade-gate exemption, **lifetime-budget exemption**, and lower-priority draining.
The budget exemption is safe for a flow a human launches once per project and
unsafe as something any lane can reach. The MCP handler names the exact hazard — "a
compound lane reaching for `setup_proof: true` because it read the verify-setup
workflow prompt once" — and answers it by pinning authorization to the run's frozen
workflow identity (`mcpQueryHandler.ts:4607`). Widening that dissolves the
guarantee for the case it was written to stop.

| | `setup_proof` | `bootstrap_proof` |
|---|---|---|
| Degrade gate | exempt | **exempt** |
| Lifetime budget | exempt, never charged | **counted and charged** |
| Drain priority | lower than lane traffic | ordinary |
| Flips a pinned record on PASS | yes | **yes** |
| Settable over the MCP wire | verify-setup runs only | **never — not a wire field** |
| Drives a sprint lane | no | **no — excluded by KIND (§6)** |

`bootstrapProof` is a parameter of `enqueueTaskVerification`, the in-process
controller capability. No agent in any flow can request it, which is strictly
stronger than a workflow-identity check.

---

## 6. The proof must not touch the lane

v1 assumed a proof verdict could double as a lane verdict. It cannot, for two
independently fatal reasons:

1. **`applyMergeGateVerdict` runs for every terminal carrying a taskRef**, and
   `recordRunbookProof` runs *after* it (`verificationScheduler.ts:3266-3289`). A
   FAIL charges the lane's implement budget immediately; a PASS integrates the lane
   before the record is ever promoted, and a CAS-failed promotion still leaves a
   passed verdict standing.
2. **The programmatic plane has a second, independent policy site.**
   `SchedulerVisualVerifyGate.outcomeForTerminalStatus`
   (`visualVerifyGate.ts:304-312`) returns `{kind:'advance'}` for *any* status that
   is not `'failed'`, reading no `error_message` and — by documented design —
   never consulting lane rows for non-failed outcomes. On the only plane in scope,
   a decision written into a lane row is **actuation-dead**.

**v2:** a `bootstrap_proof` request is excluded from lane driving **by kind**, at
both sites. Keying on kind rather than on an absent `taskRef` is required:
`resolveLaneForVerdict` falls back to `if (lanes.length === 1) return lanes[0]`, so
a ref-less proof in a single-lane run would still be attributed to that lane.

The controller consumes the proof through the scheduler's existing **`awaitTerminal`**
seam (verification-setup-flow §5.2 seam 2) — the synchronous primitive built for
exactly this "prove → read outcome → adjust → re-prove in one turn" shape. The
merge gate never sees the request.

---

## 7. One attestation-only proof

v1 fired the lane's full task as the proof, then a probe to disambiguate failures.
Both reviews independently destroyed the disambiguation: the probe **builds and
serves the same lane snapshot**, so a lane edit that breaks compilation, startup,
routing, or the marker breaks the probe too; and identity attestation does not
prove the runbook adequate for the behaviors. The table inferred causality it could
not observe, in both directions.

**v2 proves the runbook with an attestation-only task** — `build`, `serve`,
`attestation`, `behaviors: []` (legal per `visualVerification.ts:551`). This asks
exactly one question: *does this project stand up and identify itself as this
deliverable?* That is the minimal claim a runbook needs, and it is the only claim
this proof is allowed to make.

The lane's own task is **not** the proof vehicle. It is enqueued afterward, as an
ordinary request, exactly as it would be on a project that already had a runbook.
This inverts v1's answer to its own open question 1, and deletes the entire
disambiguation apparatus rather than repairing it. The cost is one extra deployment
on the happy path; the gain is that no failure is ever attributed to the wrong
thing, and the lane's attempt budget is never charged for a runbook defect.

---

## 8. The drafting agent writes nothing

v1 gave the agent `Bash/Write/Edit` in the shared worktree and validated the diff
*after* it committed. That cannot enforce a rung ceiling — the guard sees only the
committed diff, not deletions, ignored files, or sibling edits — and the allowed
files are **executable**: twenty lines of Vite or Electron config can change the
build entry or serve a canned attested surface, manufacturing a PASS. `git revert`
is not a rollback primitive in a shared dirty worktree either. Worse, `git add -f`
plus a bare `git commit` **sweeps whatever sibling implement agents have staged**
into the bootstrap commit, and the guard would then "safely" revert other lanes'
uncommitted work.

**v2 inverts the trust direction.** The agent (`runbook-bootstrap`, installed in
the sprint and ship bundles) has **Read/Grep/Glob and read-only Bash** — no Write,
no Edit, no git. It surveys and returns the portable runbook JSON in a fence, for
one modality, rung 0 only. If the project cannot be stood up with levers it already
honors, it returns `BOOTSTRAP: NOT-POSSIBLE — <reason>`, which is a success for
this agent.

The **controller** then validates and writes:

1. `parseVerifyRunbookV1` — strict schema, rejects on the first structural problem.
2. `findForbiddenTaskCommands` — the §7.2 dependency guard, unchanged.
3. **New mechanical rule:** every `build`/`serve` command must resolve to a
   **declared `package.json` script invocation**. This converts the setup agent's
   prose rule ("never guess a command") into a check, and is the single highest-value
   guard in this proposal — it is what makes "the agent proposed a command" and "the
   project documents that command" the same statement.
4. Writes the one file and commits it **by pathspec** (`git commit -- <path>`, or a
   temporary index) with `index.lock` retry — never a bare commit, which would
   sweep siblings' staged work.

---

## 9. Restart, cancellation, and the shared worktree

v1's single-flight was an in-memory mutex in the controller closure. The controller
reconstructs state on resume and restarts lanes at inner step zero, so a crash after
commit, registration, or enqueue would re-run agents and race stale rows.

**v2 persists a run-scoped bootstrap stamp** keyed `(runId, projectId, modality)`
carrying: owner lane, commit sha, runbook pin (hash + version), request id, round,
and terminal outcome. Every sub-step below it is independently idempotent —
`registerDraft` is CAS'd, the proof's enqueue key is unique, the file write is
content-addressed — so recovery is "read the stamp, resume at the first incomplete
step", not a bespoke state machine.

Two shared-worktree interactions v1 missed:

- **The commit-integrity probe.** `beginCommitProbe` (`index.ts:3103-3120`) reports
  `headAdvanced = endHead !== startHead` on the shared worktree, built to catch a
  lane that "reported green with its changes left untracked on disk (observed
  live)". A machine commit landing mid-lane makes that true for every in-flight
  lane, so a lane that committed nothing would integrate anyway. The bootstrap commit
  sha is recorded on the stamp and **excluded** from the probe's comparison.
- **Enqueue keys.** `findLiveRequestByEnqueueKey` treats *any* non-canceled terminal
  — `skipped` included — as a dedup hit, and the key is
  `${runId}:${laneTaskRef}:${attempt}`. The proof therefore carries an explicit
  `:bootstrap:<round>` generation segment; without it the proof would silently
  return the original skipped request and deploy nothing, which is exactly what v1
  would have done.

---

## 10. Failure, and what it actually costs

v1 claimed failure was "byte-identical to today". It is not, and pretending
otherwise hid real costs. Honestly:

| Failure | State left behind |
|---|---|
| `NOT-POSSIBLE` / unparseable fence | nothing written; lane skips as today |
| Validation or script-resolution failure | nothing written; lane skips as today |
| `proven-file-absent-here` (§4) | nothing written; skip + "merge the branch carrying the runbook" |
| Proof FAIL / timeout (≤2 draft rounds) | **one commit** (the honest unproven draft), a registered draft record, budget spent, the lane delayed by the bootstrap's wall-clock |
| Toggle off / kill switch | nothing; today's path, one branch deep |

Only the fourth row differs from today, and it differs in three ways worth stating
plainly rather than burying: a commit lands on the branch, verification budget is
spent, and the owning lane waits. The lane still advances unverified with a
non-blocking finding — now carrying the diagnosis instead of a bare CTA — and the
unproven draft stays committed and registered, which is the same posture the setup
flow takes on its own exhaustion.

**Suppression.** v1 wrote the suppression under the draft's hash. The capability
ledger is keyed `(project, modality, runbook_hash)` and unpinned no-runbook requests
use the `''` bucket (`verificationScheduler.ts:2492`), so that suppression would
never have fired. v2 writes a **dedicated bootstrap-suppression record** keyed by
project, modality, project-input hash, and host fingerprint, invalidated when either
hash changes — so a real change reopens the question immediately and a dead project
stops paying.

---

## 11. Bookkeeping the reviews surfaced

- **Eval contamination.** `snapshotRunForEval.ts:17-21` exempts verify-setup from
  auto-eval *precisely because* "its diff is a verification runbook plus isolation
  levers whose real acceptance test is its own proof run". The bootstrap moves that
  diff class into sprint/ship runs, which **are** auto-eval'd and A/B-compared. The
  bootstrap commit is excised from the captured diff, or the row is flagged;
  otherwise a run gets rubric-graded on machine-written JSON its agents did not author.
- **The sprint's own reviewers.** `code-review`, `sprint-review`, and
  `address-review` operate on the combined diff and will encounter a commit no lane
  owns; `address-review` "fixes in place", and any post-proof edit to the runbook
  file demotes it by hash drift. The runbook path is denylisted from address-review
  and the preflight is sequenced before sprint-review.
- **Input-hash instability (accepted, documented).** `status()` recomputes the
  project input hash (package.json scripts, lockfiles, node/electron ABI) and
  **demotes write-through on drift**. A sprint task that edits scripts or the
  lockfile therefore demotes the freshly-proven record. This is pre-existing
  behavior for setup-proven runbooks too, and the demotion is semantically correct —
  but the bootstrap makes proving and script-editing concurrent *by construction*.
  Accepted; documented; the next run re-bootstraps.
- **`expectedFiles` is optional.** v1's strongest denylist rule ("any file the run's
  own tasks touch") rested on metadata that is legitimately absent, and would have
  silently enforced nothing. Moot in v2 — the agent writes nothing.
- **Stale comment, unrelated to this work.** `enqueueFromTask.ts`'s
  `forbiddenCommandError` still tells agents a snapshot's `node_modules` is
  "symlinked from the live worktree"; `snapshotProvisioner.cloneDependencyDirs`
  **clones** (`cp -Rc`) precisely to kill write-through. The guard is still right;
  its stated reason is out of date. Worth a one-line fix on its own.

---

## 12. The flow, end to end

1. Lane reaches `visual-verify`; task-verify composed a task that derives an
   environment. **Before enqueue**, the controller evaluates the shared exported
   predicate (`derivesEnvironment && statusDetail(runWorktree)`).
2. Not bootstrap-eligible (§4) or toggle off ⇒ enqueue as today. Done.
3. Eligible ⇒ claim the persisted stamp. Another lane holds it ⇒ **skip as today**;
   the finding says a bootstrap is in flight and the next run will verify.
4. Spawn the read-only drafting agent. `NOT-POSSIBLE` ⇒ degrade.
5. Controller validates (§8), writes and pathspec-commits the runbook,
   `registerDraft` → `{hash, version}`.
6. Fire ONE attestation-only `bootstrap_proof`, uniquely keyed, pinned; consume via
   `awaitTerminal`. The merge gate never sees it.
7. PASS ⇒ the engine flips the record proven. FAIL ⇒ re-draft once (≤2 rounds), then
   degrade.
8. On proven: enqueue the lane's **ordinary** request, which now merges and pins the
   runbook and passes the gate (given decision B). The lane parks and proceeds
   exactly as on a configured project.
9. Sibling lanes arriving later: ordinary path, now proven. Lanes that already
   skipped during the bootstrap are **not** resurrected — `mergeGateLaneAdvance`
   never resurrects a terminal lane, and pretending otherwise was v1's §7.
10. Report a `verify-runbook` artifact carrying the draft, the proof outcome, and
    the commit, so the human sees at the terminal merge gate what was derived on
    their behalf.

---

## 13. Phasing

- **Phase 0 — seam, dark.** Migration 105 (`verification_requests.bootstrap_proof`,
  `verify_runbook_local.origin`); `bootstrapProof` on `enqueueTaskVerification`;
  budget-counted + gate-exempt + promotion-eligible; **kind-based exclusion** from
  `applyMergeGateVerdict`, `verdictDelivery`, and `SchedulerVisualVerifyGate`;
  `:bootstrap:<round>` enqueue-key generation. Fully unit-testable.
- **Phase 1 — honesty in the store.** `statusDetail()` (§4) and the gate probe-path
  change (§3, decision B), each with its own tests — this phase is independently
  valuable and lands the latent probe-path disagreement fix.
- **Phase 2 — the preflight.** Shared exported predicate, persisted stamp, toggle +
  kill switch, degrade paths and findings. No agent yet; logs and falls through.
- **Phase 3 — draft and prove.** The read-only agent, controller validation +
  pathspec commit, `registerDraft`, the attestation-only proof via `awaitTerminal`,
  re-enqueue on proven, bootstrap suppression.
- **Phase 4 — bookkeeping.** Eval-diff excision, commit-probe exclusion,
  address-review denylist, the artifact and the `origin` badge.

## 14. Test plan

- **Unit** — the eligibility predicate over all four `statusDetail` discriminants
  (especially: `proven-file-absent-here` never bootstraps); kind-based lane-driving
  exclusion at **both** policy sites, including the single-lane
  `resolveLaneForVerdict` fallback; enqueue-key generation defeats the terminal
  dedup; command-resolves-to-a-declared-script validation; stamp claim/resume;
  suppression keying actually matching the bucket the next request reads.
- **Tripwire** — `bootstrap_proof` unreachable from `mcpQueryHandler`, in the style
  of the existing `setup_proof_not_authorized` tests.
- **Migration** — `migration105.test.ts` plus pre-105 defensive-read degradation.
- **Integration** (`*.itest.ts`, mocked SDK) — preflight → draft → commit → prove →
  ordinary enqueue → lane verified; and every degrade path leaving the lane exactly
  where today's skip leaves it.
- **Regression the reviews imply** — a proven-elsewhere project is never demoted by
  a bootstrap; a bootstrap commit does not satisfy another lane's commit probe.
- **Existing suites to update** — `acceptanceMatrix`, `mergeGateLaneAdvance`,
  `verdictDelivery`, `visualVerifyGate`, `enqueueFromTask`, `runbookStore`,
  `builtInWorkflows` / `workflowBundle.builtins`.

---

## 15. Two decisions for the user

**A. Rung 0 only — this relaxes the constraint you locked.**
You chose "autonomous, rung 0/1". Both reviews concluded independently that the
rung-1 half cannot be made safe autonomously: the allowed files are **executable**,
so a validated twenty-line config diff can change what gets built or serve a canned
attested surface — which is the no-new-PASS invariant failing, not a guard needing
tightening. Fable's judgment was explicit: if rung-1 config edits are
non-negotiable, the safety bar cannot be met autonomously. v2 therefore proposes
**rung 0 only**, with rung 1 remaining available through Verify Setup, where a human
reviews the diff. This makes the bootstrap fail on projects with a hardcoded port or
an unparameterized singleton — those still need Verify Setup. **Confirm, or tell me
to keep rung 1 and accept that the safety claim weakens to "a human reviews the
config diff at the terminal merge gate".**

**B. The gate probe-path change (§3).** Making the pre-lease gate probe the run
worktree for lane requests is *required* for this feature to work, and it changes
behavior for existing verify-setup users: a runbook committed on a branch would
start satisfying that branch's lanes before merge. I believe that is more correct
than today's disagreement between the gate and the injection — but it is a
semantic change to shipped behavior and should be your call, not a side effect.

## 16. What v1 got wrong

Recorded because the mistakes are load-bearing, not to be thorough:

1. **Claimed a safety invariant its own guard could not enforce** — the ≤20-line
   config allowlist permits edits to executable files, which is the invariant
   failing outright.
2. **Assumed the proof could double as the lane verdict** — two independent policy
   sites drive lanes off terminals, and promotion runs after delivery.
3. **Assumed a second request per lane attempt would deploy** — the enqueue key
   dedups against terminals, so the happy path was a no-op.
4. **Assumed a lane step could be programmatic-only** — `fanOut.inner` is an
   explicitly both-plane contract with a generic fallback renderer.
5. **Assumed `status() !== 'proven'` meant "no runbook"** — it also means "proven,
   just not in this tree", where bootstrapping destroys another branch's proof.
6. **Never checked which tree the gate probes** (§3) — the payoff was unreachable.
7. **Claimed failure was byte-identical to today** while proposing paths that
   commit, register, spend budget, and delay lanes.
8. **Wrote a suppression into a bucket nothing would read.**

The through-line: v1 reasoned about the feature it wanted and asserted the
properties it needed from seams it had not read closely enough. Every correction
above came from reading the seam.
