# Lane runbook bootstrap — verification that sets itself up

**Status:** proposal, pre-implementation
**Scope decisions locked by the user (2026-08-17):** autonomous (no human gate) at
**rung 0/1 only**; **sprint + ship lanes only** (the controller-owned `visual-verify`
step), not the orchestrated MCP path.
**Related:** `verification-setup-flow.md` (the runbook contract, the degrade gate,
the proof-by-running rule), `verification-agent-redesign.md` (§5.3 the agentless
visual-verify step, §5.4 the central scheduler, §7.2 the dependency guard).

---

## 1. The problem

A sprint lane composes a visual-verification task, the controller enqueues it, the
lane parks at `awaiting-verify` — and then, on the overwhelming majority of
projects, nothing is verified. The third pre-lease gate
(`verificationScheduler.ts:2723`) asks two questions:

```ts
const derivesEnvironment =
  (Array.isArray(task.build) && task.build.length > 0) || task.serve !== undefined;
if (derivesEnvironment && (await this.runbookStatus(row.project_id, modality)) !== 'proven') {
  return VERIFY_NO_RUNBOOK_REASON;
}
```

Any task that has to build or serve the deliverable — i.e. every real one — is
skipped unless the project already has a **proven** runbook.
`verdictDelivery.ts:376` attaches a CTA ("run verification setup for this
project"), `mergeGateLaneAdvance` advances the lane to `integrated`, and the sprint
completes with a green lane that no camera ever looked at.

The CTA points at the **Verify Setup** flow, which is a *separate flow a human must
launch*, with two human gates of its own. So the default posture of centralized
visual verification, on a project nobody has hand-configured, is: **do not verify,
tell someone to go configure it.** In practice nobody does, and the skip is
permanent. We have direct evidence of the dead end from inside the product: an
ad-hoc verification fired from a chat session comes back `skipped` for exactly this
reason, and `setup_proof` — the one request kind that *could* break the deadlock —
is refused outside the verify-setup flow.

That posture was a deliberate and correct reaction to §1 of the setup-flow
proposal: the agent engine used to guess the environment per-run with no memory and
guessed wrong every single time (0-for-5 in production — wrong serve form,
colliding singletons, wrong native ABI, blown deadline). Guessing bought nothing
but a burned deadline and a lane charged for someone else's occupied port.

**But "stop guessing" and "stop trying" are not the same rule.** The setup flow
already contains the machinery that makes an attempt safe: derive → register →
**prove by actually running it** → and *only a passing run* flips a draft to
proven. The engine, not the agent, does the flipping. What is missing is not
safety; it is an *autonomous entry point*. Today the only thing that can pull that
lever is a flow a human has to remember to run.

**This proposal makes the no-runbook skip self-healing.** When a lane's
verification is about to be skipped for want of a runbook, the lane instead drafts
one, commits it, registers it, and proves it — using the very task it was trying to
verify as the proof vehicle. A pass verifies the deliverable *and* leaves the
project permanently verifiable. A failure lands exactly where we are today: an
unproven draft, a skipped verification, an advanced lane, and an honest finding.

**The bar this must clear:** it must be impossible for this feature to make a
verification *pass* that would not otherwise have passed. It only ever converts
"skipped" into "actually ran". Every mechanism below is in service of that.

---

## 2. Design in one page

Add one conditional step to the sprint/ship lane chain, `runbook-bootstrap`,
entered **only** when the central verifier skipped a lane's request with
`VERIFY_NO_RUNBOOK_REASON`.

```
implement → write-tests → code-review → task-verify → visual-verify → awaiting-verify
                                                                            │
                                              skip: no proven runbook ──────┤
                                                                            ▼
                                                                   runbook-bootstrap
                                                                            │
                                                    draft → commit → register → prove
                                                                            │
                                    ┌───────────────────────┬───────────────┴────────┐
                                 PASS                     FAIL                  exhausted
                                    │                        │                       │
                       runbook PROVEN +          disambiguate (§6):          degrade to
                       lane VERIFIED             runbook? or code?           today's behavior
                       → integrated              → retry / loop back          (skip + CTA)
```

Five properties carry the design:

1. **The proof is engine-enforced, unchanged.** The bootstrap never marks anything
   proven. It registers a draft and fires a pinned proof request; the scheduler's
   existing `recordRunbookProof` flips the record only on a PASS with a real
   snapshot sha. A bootstrap that lies produces nothing.
2. **The lane's own task is the proof vehicle** (§6), so the happy path costs one
   deployment and simultaneously answers "does this project stand up" and "does
   this lane's change look right".
3. **One bootstrap per run per modality** (§7), so N parallel lanes cost one
   attempt, not N.
4. **The rung ceiling is mechanical, not prose** (§8) — a committed-diff guard,
   not an instruction an agent may talk itself past.
5. **Exhaustion is byte-identical to today** (§9). The feature can only add
   outcomes above the current floor.

---

## 3. Why not just widen `setup_proof`

`setup_proof: true` is exactly the capability the bootstrap needs: exempt from the
degrade gate, and a PASS flips the pinned record to proven. It is tempting to
authorize sprint runs to set it.

**Do not.** `setup_proof` carries three privileges bundled together
(`verificationScheduler.ts:1623`): degrade-gate exemption, **lifetime-budget
exemption**, and lower-priority draining. The budget exemption is safe for a flow a
human explicitly launched once per project; it is not safe for a flag any lane can
reach for on every sprint. The MCP handler's own comment names the exact hazard —
"a compound lane reaching for `setup_proof: true` because it read the verify-setup
workflow prompt once" — and the handler answers it by pinning authorization to the
run's **frozen workflow identity** (`mcpQueryHandler.ts:4607`). Widening that check
dissolves the guarantee for the case it was written to stop.

Instead, introduce a **distinct, narrower kind**:

| | `setup_proof` | `bootstrap_proof` (new) |
|---|---|---|
| Degrade gate (§3.2) | exempt | **exempt** |
| Lifetime verify budget | exempt, never charged | **counted and charged** |
| Drain priority | lower than lane traffic | ordinary lane priority |
| Flips a pinned record to proven on PASS | yes | **yes** |
| Settable over the MCP wire | yes, verify-setup runs only | **never — not a wire field at all** |
| Set by | the verify-setup orchestrator agent | the programmatic controller seam only |

The last row is the important one. `bootstrapProof` is a parameter of
`enqueueTaskVerification` (the in-process controller capability), **not** a field
`mcpQueryHandler` reads. No agent, in any flow, can request it — which is a
strictly stronger guarantee than `setup_proof`'s workflow-identity check, and it
means this proposal adds **zero** new surface an agent can talk its way past.

---

## 4. Where the bootstrap is triggered

Two candidate hook points:

- **(A) Enqueue-side pre-check** — before enqueuing, ask `runbookStatus` and
  bootstrap if unproven.
- **(B) Post-skip reaction** — enqueue normally, let the gate skip, react to the
  skip reason.

**Choose (B).** The gate predicate (`derivesEnvironment && status !== 'proven'`)
must have exactly one home. `prepareVerificationEnqueue` already documents why the
enqueue path deliberately refuses to re-implement the gate — "every unhappy path is
UNPINNED, not FAILED … the §3.2 degrade gate then gives the honest answer
downstream". Re-deriving it enqueue-side is precisely the duplication that
`enqueueFromTask.ts`'s shared-preparation header exists to prevent, and a widened
predicate on one side and not the other is a silent divergence.

So: the request is enqueued, the gate skips it as it does today, and the reaction
keys on the **already-exported** `VERIFY_NO_RUNBOOK_REASON` constant —
`verdictDelivery` already matches on that exact string, so the string is already a
load-bearing contract rather than a new one.

Concretely, `decideMergeGate` gains one action:

```ts
| { kind: 'bootstrap-runbook'; modality: VerificationModality }
```

returned in place of `advance-integrated` when **all** of:

- `status === 'skipped'` and `error_message === VERIFY_NO_RUNBOOK_REASON`; and
- the run is a programmatic sprint/ship fan-out with a live controller; and
- auto-bootstrap is enabled (§11) and not suppressed for this (project, modality)
  in the capability ledger; and
- this run has not already spent its bootstrap attempt for this modality (§7).

Any of those failing ⇒ `advance-integrated`, i.e. today's behavior, unchanged.

`verdictDelivery` correspondingly suppresses the "run verification setup" CTA for a
skip that is being bootstrapped — telling a human to go configure something we are
in the middle of configuring is noise — and files an informational finding naming
the bootstrap instead.

---

## 5. The bootstrap step

### 5.1 Lane vocabulary and chain placement

`SPRINT_LANE_STEP_IDS` (`shared/types/sprintBatch.ts:136`) gains
`'runbook-bootstrap'`, appended **last**, after `awaiting-verify`. It is a fan-out
inner step in both `sprint` and `ship` definitions
(`shared/types/workflows.ts:877` and `:1171`), marked `optional: true`:

```ts
{ id: 'runbook-bootstrap', agent: 'runbook-bootstrap', name: 'Verify setup', optional: true },
```

Ordering rationale: the array's order feeds the monotonic-forward guard in
`deriveLaneFromTaskDispatch`, which infers lane position from *agent dispatches* on
the orchestrated plane. Placing the new step last means an inferred lane can never
regress into it. The programmatic controller drives it **explicitly** via
`driveLane`, which is not subject to that guard (the visual FAIL loopback to
`implement` already regresses this way), so an explicit entry from `awaiting-verify`
is legal while an inferred one is impossible. This step is never entered on the
orchestrated plane at all — the scope decision is programmatic lanes only.

The controller's inner-step loop skips it unconditionally in normal flow (`continue`
when no bootstrap is pending), exactly as `visual-verify` skips when nothing was
composed.

### 5.2 The agent

New subagent `runbook-bootstrap`, installed into the sprint and ship bundles
(`main/src/orchestrator/workflows/{sprint,ship}/agents/runbook-bootstrap.md`).
Tools: `Read, Grep, Glob, Bash, Write, Edit`.

Its prompt body is largely a **narrowed fork of the existing
`cyboflow-verify-setup` agent** — the survey and derive halves — plus the write and
commit that the setup flow keeps in its orchestrator. The narrowing is the point:

- **One modality only** — the one the lane's task resolves to. No multi-modality
  survey, no composition of an Electron + native-screen pair.
- **Rung 0/1 only.** Rung 2 (source diffs) is not proposable. If the agent
  concludes the project cannot be stood up without a rung-2 change, it returns
  `BOOTSTRAP: NOT-POSSIBLE — <reason>` and the lane degrades (§9). Saying so is a
  success for this agent, not a failure.
- **Writes exactly two things**: `.cyboflow/verify-runbook.json`, and at most one
  rung-1 config edit. It commits them itself (the lane's shared worktree; the
  runbook must be committed before it can be proven, because the verifier runs a
  detached checkout at a sha) using `git add -f`, since `.cyboflow/` is commonly
  ignored and a plain `git add` there is a silent no-op that reports success.
- **Never registers, never fires a verification, never marks anything proven.**
  Subagents do not write cyboflow state — the controller does. It returns a fenced
  machine-readable result:

  ````
  ## Runbook bootstrap
  ```json
  { "modality": "cdp-app", "committed": "<sha>", "bindings": { ... },
    "rung": 1, "changedFiles": [".cyboflow/verify-runbook.json", "vite.config.ts"],
    "attestation": "cdp-token", "risks": ["..."] }
  ```
  ````

- The **same hard rules** as the setup agent carry over verbatim, because they are
  what make a derived runbook trustworthy at all: attestation is required per
  modality; request-scoped values (ports, temp dirs) are never persisted, only
  `${PORT}`-style placeholders; **never an install or a rebuild** in `build`/`serve`
  (already enforced independently by `findForbiddenTaskCommands`, which runs on the
  merged runbook — a runbook that smuggles one through fails closed regardless of
  the prompt); never guess a command that does not trace to a `package.json`
  script, a documented invocation, or existing source.

### 5.3 What the controller does around it

The controller owns every cyboflow write, in this order:

1. Drive the lane to `runbook-bootstrap`; spawn the agent.
2. Parse the fence. `NOT-POSSIBLE`, an unparseable fence, or an empty commit ⇒
   degrade (§9).
3. **Run the diff guard** (§8) over what the agent actually committed. A violation
   ⇒ revert the bootstrap commit and degrade. The guard reads the *committed diff*,
   not the agent's self-report of it.
4. `registerDraft(projectId, worktreePath, modality, bindingsJson)` → `{hash, version}`.
   An error (invalid shape, modality not declared, CAS conflict) ⇒ degrade, with
   the validation message in the finding — these messages name the exact failing
   path (`modalities["web"].serve.cmd: expected non-empty string`).
5. Fire the proof (§6) via `enqueueTaskVerification({ ..., bootstrapProof: true,
   runbookHash: hash, runbookLocalVersion: version })`, re-park at
   `awaiting-verify`, await the verdict.
6. Report a `verify-runbook` artifact (the existing atype) carrying the draft, the
   rung, the diff, and the proof outcome — so the human sees at the terminal
   merge gate what was auto-derived on their behalf, even though nothing blocked
   on it.

---

## 6. The proof: one stage, with a disambiguating second

The user's instruction is that the lane should "use the task they're attempting to
verify to validate it", and that is the default path. It has a real cost, though,
which the design has to answer: **a FAIL is ambiguous.** The composed task carries
both the runbook's `build`/`serve`/`attestation` and the lane's `behaviors`, so a
failure could be a wrong serve command *or* broken lane code, and the two demand
opposite responses.

### Round 1 — the lane's task, as-is

Fire the lane's composed task, merged with the freshly drafted runbook, as a
`bootstrap_proof`. On **PASS**: the engine marks the record proven, the lane has a
genuine verified verdict, and the lane advances to `integrated`. **One deployment,
both questions answered.** This is the path we expect most of the time on projects
whose lane code is fine, which is most lanes.

### Round 2 — on FAIL, an attestation-only probe

If round 1 fails, fire a second `bootstrap_proof` derived from the *same runbook*
but with the lane's behaviors **stripped to nothing** — build, serve, and
attestation only. This asks precisely one question: *does this project stand up and
identify itself as this deliverable?* It is the minimal proof a runbook needs, and
it cannot fail for a reason that lives in the lane's diff.

| Round 1 | Round 2 (attestation-only) | Conclusion | Action |
|---|---|---|---|
| PASS | — | runbook good, lane good | mark proven (engine); lane → `integrated` |
| FAIL | PASS | **runbook good, lane code is broken** | record proven; convert to a normal visual FAIL: loop the lane back to `implement` with round 1's feedback, charging the lane's attempt budget as an ordinary visual FAIL would |
| FAIL | FAIL | **runbook wrong** | re-draft (≤3 rounds total), lane budget untouched |
| FAIL | env/skipped | no information | re-draft, lane budget untouched |

This is the mechanism that keeps the feature honest. **While the runbook is
unproven, a failure never charges the lane's implement budget and never sends an
agent to "fix" code.** That is the same asymmetry `classifyVerificationFailure`
already encodes for `env`-class failures, and for the same stated reason: "a
merge-gate FAIL charges the lane's implement-retry budget and sends an agent to
'fix' working code because a port was taken" (`verificationScheduler.ts:3165`). An
unproven runbook is that hazard's twin — the commands, not the code, are the
untrusted variable — and the attestation probe is what promotes a guess about which
one it was into an observation.

Cost ceiling per run per modality: **3 draft rounds, ≤2 deployments each**, and the
existing per-request deadline applies unchanged.

---

## 7. Single-flight across parallel lanes

A parallel sprint will have N lanes hit the gate within seconds of each other.
Bootstrapping N times would be N drafting agents racing to write the same file into
one shared worktree, N `registerDraft` calls whose CAS bumps invalidate each
other's pins, and N charges against the budget.

**One bootstrap attempt per (run, modality).** The controller holds the fan-out
scope already, so this is an in-process mutex on the run's controller state, not a
new distributed primitive:

- First lane to receive a `bootstrap-runbook` action **acquires** it and runs §5.3.
- Concurrent lanes **stay parked** at `awaiting-verify` and await the bootstrap's
  outcome (the same `awaitVerdict` wait they are already in, extended to also
  resolve on a bootstrap outcome).
- On bootstrap success, each waiting lane **re-fires its own ordinary request** —
  not a proof — which now finds a proven runbook and runs normally. The bootstrap
  lane does not re-fire; its round-1 proof *was* its verification.
- On bootstrap failure or exhaustion, every waiting lane degrades (§9). None of
  them re-attempts.

**Cross-run and cross-project races** are out of scope for the mutex: two sprint
runs on the same project could bootstrap concurrently. The backstop is already
present and correct — `registerDraft`'s CAS predicate means the second registration
bumps the version, and the first run's in-flight proof is then refused promotion by
`markProven`'s double CAS with `cas-conflict` ("the proof attests to content that is
no longer what the record holds"). Both runs degrade honestly; nothing false is
recorded. Accepted, and worth a log line rather than a lock.

---

## 8. The rung ceiling, enforced mechanically

The user's constraint is rung 0/1 — existing levers, plus at most a small
reversible config change. "Config-only" is a judgment call, and a judgment call
delegated to a prompt is not a ceiling. The ceiling is a **guard over the committed
diff**, run by the controller before anything is registered:

- **Path allowlist.** `.cyboflow/verify-runbook.json` always; beyond that, only
  files matching a config allowlist (`*.config.{ts,js,mjs,cjs,json}`,
  `package.json`, `.env.example`, `tsconfig*.json`, `electron-builder*`).
- **Hard denylist**, overriding everything: lockfiles, anything under `.github/`,
  anything under `.claude/`, CI configs, `scripts/`, and any file the run's own
  sprint tasks touch (an auto-edit inside a lane's own diff is indistinguishable
  from the lane's work at review time).
- **Size cap.** The non-runbook portion of the diff is ≤20 changed lines across ≤1
  file. Rung 1 is "read a port from an env var that is currently hardcoded"; it is
  not a refactor.
- **`package.json` narrowing.** Only the `scripts` object may change, and only by
  addition. A dependency edit is a rung-2 change wearing a rung-1 costume, and it
  is also the exact class of change the whole `findForbiddenTaskCommands` guard
  exists to keep out of verification snapshots.

A violation is not a negotiation: the controller reverts the bootstrap commit
(`git revert --no-edit` on the lane worktree, keeping the history honest) and
degrades, filing a finding that names the offending paths. The guard also gives the
human at the merge gate a bounded thing to review — one file plus, at most, twenty
lines of config.

---

## 9. Exhaustion is today's behavior, exactly

Every failure path — `NOT-POSSIBLE`, an unparseable fence, a diff-guard violation,
a registration error, three failed draft rounds, a disabled toggle, a suppressed
modality — resolves to the **current** outcome:

- the lane advances to `integrated` unverified,
- a **non-blocking** finding is filed, now carrying the bootstrap diagnosis (what
  was drafted, what came back, `failureClass` and feedback) instead of a bare CTA,
- the unproven draft **stays committed and registered**, behaving exactly like
  "unconfigured", which is the same posture the setup flow takes on its own
  exhaustion ("an honest unproven draft is not [the failure this flow exists to
  prevent]"),
- and the (project, modality) pair gets a **ledger suppression with a TTL** via the
  existing `VerifyCapabilityStore`, so the next run short-circuits at gate 2
  instead of re-bootstrapping. Reusing the capability ledger means the existing
  host-generation and TTL self-refresh semantics decide when it is worth trying
  again — a new chromium, a new host, a changed project input hash all reopen the
  question without anyone clearing a flag.

There is no path on which this feature makes a lane's outcome *worse* than the
skip it replaces. The strongest claim it makes on failure is "we tried, here is
what happened".

---

## 10. Data model

**Migration 105** (next free — 101/102 and 103/104 are claimed by unmerged
branches; renumber on rebase, per the standing collision hazard):

```sql
ALTER TABLE verification_requests ADD COLUMN bootstrap_proof INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verify_runbook_local  ADD COLUMN origin TEXT;  -- 'setup-flow' | 'lane-bootstrap'
```

`origin` is provenance, and it is not cosmetic: a human deciding whether to trust a
proven runbook should be able to see that it was auto-derived by a lane rather than
reviewed at a human gate. It surfaces in `VerifyHealthPanel` / `verifyHealthModel`
as a badge, and in the `verify-runbook` artifact.

Both columns are read through the existing defensive ladders
(`runbookPinForRow` / `agentGateColumnsForRow`), so a pre-105 DB degrades to
`bootstrap_proof = 0` / `origin = null` rather than throwing.

---

## 11. Settings and kill switches

- **Project setting** `visualVerify.autoBootstrapRunbook`, default **on** — this is
  the requested default posture, and the floor it degrades to is what happens
  today, so "on" cannot regress a project.
- **Env kill switch** `CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP=1`, matching the
  `CYBOFLOW_DISABLE_WARM_SDK` idiom, for a host where the drafting agent itself is
  the problem.
- Off ⇒ the merge gate returns `advance-integrated` and no code path below §4 is
  reachable. The whole feature is one branch deep.

---

## 12. Relationship to the Verify Setup flow

Verify Setup is **not** superseded and should not be. It remains the path for:
multi-modality projects, **rung 2** source changes, human review of what gets
committed, and deliberate re-derivation after drift.

The bootstrap is its zero-friction subset: one modality, rung 0/1, no gates. The
two compose cleanly through machinery that already exists — a bootstrap-proven
record is an ordinary proven record, and a later Verify Setup run over the same
project calls `registerDraft`, which bumps the version and demotes to
`unproven-draft` by design ("new portable content is by definition unproven
content"), then re-proves under human review. A human upgrading an auto-derived
runbook needs no new code path.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| **Re-introduces per-run guessing** — the 0-for-5 failure | A guess is only ever *executed* after it passes an engine-enforced proof. A wrong guess produces an unproven draft and today's skip. The historical failure was guessing and then *trusting*; nothing here trusts an unproven draft. |
| **A lane commits to the repo unreviewed** | Bounded to one JSON file + ≤20 config lines by a mechanical diff guard (§8), committed separately, visible in the branch diff at the existing terminal human-review gate, and revertible. |
| **Wall-clock cost inside a lane** | One bootstrap per run per modality; ≤3 draft rounds; ≤2 deployments per round; existing per-request deadline unchanged. Waiting lanes stay parked rather than each paying. |
| **A broken lane deliverable burns bootstrap rounds** | The attestation-only probe (§6) detects exactly this after round 1 and converts to a normal lane loopback, rather than blaming the runbook three times. |
| **Auto-derived runbook is lower quality than a reviewed one** | `origin` provenance (§10) makes that visible; the runbook is proven-by-running either way; a human can re-derive through Verify Setup at any time. |
| **Budget drain on an unbootstrappable project** | Bootstrap proofs are budget-*counted* (unlike `setup_proof`), and exhaustion writes a TTL'd ledger suppression so later runs short-circuit before spending anything. |
| **The runbook only exists on the session branch** | Already-correct semantics: `status()` answers `unproven-draft` for a probe path lacking the file **without demoting the record** — the documented pre-merge case. Dismissing the session leaves no false proof anywhere. |
| **`bootstrap_proof` becomes a new agent-reachable privilege** | It is not a wire field. Only the in-process controller seam sets it; a parity test pins that `mcpQueryHandler` never reads it. |

---

## 14. Phasing

- **Phase 0 — seam.** Migration 105; `bootstrapProof` on `enqueueTaskVerification`;
  scheduler treats it as degrade-gate-exempt + budget-counted; `recordRunbookProof`
  accepts it. No trigger wired. Fully unit-testable, ships dark.
- **Phase 1 — the decision.** `decideMergeGate` gains `bootstrap-runbook`;
  `verdictDelivery` CTA suppression; the settings toggle + kill switch. Still no
  agent — the action is logged and falls through to `advance-integrated`.
- **Phase 2 — the step.** Lane vocabulary, both workflow definitions, the
  `runbook-bootstrap` agent, the controller's step handling, the diff guard, the
  single-flight mutex.
- **Phase 3 — the loop.** Round-2 attestation probe, the §6 disambiguation table,
  retry/exhaustion, ledger suppression, the `verify-runbook` artifact and the
  `origin` badge.

## 15. Test plan

- **Unit** — `decideMergeGate` decision table (every §4 precondition, each
  independently falsified); the §6 four-row disambiguation matrix; the §8 diff
  guard (allowlist, denylist, size cap, `package.json` narrowing, overlap with lane
  task files); single-flight (N concurrent lanes ⇒ 1 bootstrap, N−1 waiters, both
  outcomes); exhaustion ⇒ byte-identical to the current skip path.
- **Tripwire** — `bootstrap_proof` is unreachable from `mcpQueryHandler`, in the
  same style as the existing `setup_proof_not_authorized` tests.
- **Migration** — `migration105.test.ts`, plus pre-105 defensive-read degradation.
- **Integration** (`*.itest.ts`, mocked SDK, blocking CI job) — the controller lane
  path end-to-end: skip → bootstrap → register → prove → integrated, and the
  failure fork back to `implement`.
- **Existing suites to update** — `acceptanceMatrix.test.ts`,
  `mergeGateLaneAdvance.test.ts`, `verdictDelivery.test.ts`,
  `builtInWorkflows.test.ts` / `workflowBundle.builtins.test.ts` (both hardcode
  built-in step and agent counts), `enqueueFromTask.test.ts`.

## 16. Open questions for review

1. **Round-1 shape.** Is firing the lane's *full* task as round 1 right, or should
   the attestation-only probe come **first** (cheaper to diagnose, but costs a
   second deployment on the happy path — which is the common path)? The proposal
   picks full-task-first deliberately; it is the closest reading of the request and
   optimizes the case we expect to dominate.
2. **Waiting lanes re-firing.** Should lanes that waited out a successful bootstrap
   re-fire immediately, or is it better to let them advance and rely on the
   *next* run being verified? Re-firing is more correct and costs N deployments in
   a burst.
3. **Ship flow.** Ship's `execute-tasks` mirrors sprint's fan-out byte-for-byte.
   Confirmed in scope — but ship runs closer to a release, and there may be an
   argument for requiring the runbook to already be proven there.
4. **Suppression TTL.** What is the right re-try horizon for a project where the
   bootstrap failed — the capability ledger's existing default, or something
   longer?
