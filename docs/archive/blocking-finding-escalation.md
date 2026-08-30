# Blocking-finding escalation: fix the real gaps

**Status:** IMPLEMENTED (rev 2) — all four items landed on `green-maple-20260723`
**Date:** 2026-07-24

> **Implementation note.** Items 0, 1, 3, 2 shipped as four commits
> (`1116431f`, `234b1be7`, `886ba06d`, `322511b8`). Full gate green (main 6784 +
> frontend 3234 unit tests, schema-parity, lint). Deferred follow-ups, each noted
> in its commit: (a) Item 2's per-attempt failure-TEXT accumulator (the controller
> retains none today, so the gate summary surfaces ref/step/attempts but not the
> error text); (b) Item 3's choice landed on 3a (mint-time `audience` column,
> migration 085); (c) ship.md's orchestrated closing-stage prose was left as-is
> (its default programmatic path is covered by the composer).
**Origin:** an ORCHESTRATED sprint run parked on a blocking finding whose body was
a code-review `## Blocking` defect for TASK-107. The finding offered `Resolve &
resume` / `Dismiss` / `Promote to task` — none of which fix the defect, and none
of which were the decision the situation called for.

> **Revision note.** Rev 1 claimed attempt-cap exhaustion was *silent* and built
> a lane-parking escalation gate on top of that premise. Both reviewers showed the
> premise is false — exhaustion already escalates (see §2). Rev 1 also proposed
> hiding a still-blocking finding from the queue, which both reviewers traced to a
> permanent run-wedge. This revision drops the parking machinery, keeps the
> escalation gate as a *surfacing* improvement to the gate that already exists, and
> replaces read-time suppression with a mint-time audience flag. A new **Item 0**
> covers the highest-value finding the review surfaced: the code-review → loopback
> channel does not exist on the default execution plane.

---

## 1. The observed symptom

`review_items.blocking` means exactly one thing: **park the run** until triaged.
It does not mean "a human must decide something". Because those are the same bit,
anything that parks a run renders in the human inbox with human CTAs.

In the TASK-107 incident, an ORCHESTRATED sprint's driving agent took a
code-review `## Blocking` defect and filed it as
`cyboflow_report_finding(blocking: true)` — parking the run and handing a human a
defect the chain was supposed to fix itself. The generated instructions
(`main/src/orchestrator/prompts/fan-out-instructions.ts`, `case 'code-review'`,
verified at :108-117) say to loop back to `implement`, not to file a finding — but
nothing *forbids* filing one, and the `cyboflow_report_finding` tool description
(`cyboflowMcpServer.ts:569`) actively invites it: *"set `blocking:true` only for
items that should gate run resume"* describes a must-fix defect perfectly.

## 2. Corrected baseline — what actually happens at exhaustion

Rev 1's central claim ("silent `status:'failed'` + a log line; no gate, no
notification; the sprint reports success with a dead lane in it") is **false**.
Verified on both planes:

- **Programmatic.** A lane returning `'failed'` increments `incompleteCount`
  (`workflowController.ts:1156-1159`); a non-zero count sets `skipToHumanGate`
  (`:374-380`); the step loop (`:313-332`) then skips every automated closing step
  (sprint-verify, sprint-review) and stops at the sprint's terminal pure human
  gate `human-review` (`shared/types/workflows.ts:851-859`).
- **Orchestrated.** The same rule in prose: *"the failure is surfaced at the human
  gate"* (`sprint.md:90-91`) and the closing-stage gate + *"partial-sprint
  summary"* (`sprint.md:138-146`).

So a sprint **cannot** seal with an unreviewed dead lane. The real defect is
narrower and still worth fixing: the escalation is **deferred** (to sprint end,
after all lanes settle) and **lossy** — the gate that fires is a generic
approve/reject decision whose body is the bare string *"Workflow step
'human-review' requires a human decision before the run can advance"*
(`humanStepManager.ts:157-158`, `payload: null`). It carries no per-lane attempt
history, no failure text, no CTAs beyond approve/reject. The human is told "a
sprint finished with problems" and must go spelunking in the swimlane to learn
what and why.

The deferred aggregate gate is the right shape (interrupt once, with the whole
picture, not N times mid-sprint). **This proposal improves what that gate shows;
it does not replace it with per-lane parking.**

## 3. Reference implementation already in the tree

The visual merge-gate implements the intended ladder for the *visual* path.
`isMergeGateBlocking` (`mergeGateLaneAdvance.ts:433-435`):

| Verdict | Action | Finding |
|---|---|---|
| FAIL under `MERGE_GATE_ATTEMPT_CAP` (`mergeGateLaneAdvance.ts:82`) | `loopback-implement` | blocking (fix guidance) |
| FAIL at/over cap | `mark-failed` | blocking (escalation) |
| low confidence | proceed | non-blocking (advisory) |

Two structural problems it demonstrates, which motivate Items 0 and 3:
- its **under-cap** `loopback-implement` finding is a machine-to-machine mailbox
  (the orchestrator reads it and re-delegates) that renders in the human queue
  with human CTAs — Item 3;
- it exists only because the *visual* path has a real verdict channel. The
  *code-review* path has none on the programmatic plane — Item 0.

---

## Item 0 — Give the programmatic plane a code-review verdict channel

**This is the highest-value item.** It is the actual reason the TASK-107 class of
defect has no clean home.

**Problem.** On the PROGRAMMATIC plane (the sprint default), the controller parses
**no** `## Blocking` section from a code-review turn. It parses only
`parseTaskVerifyVerdict` from `task-verify`'s text (`workflowController.ts:60-67`,
consumed at `:901`). A clean (`status:'ok'`) code-review subagent turn that
contains `## Blocking` defects is treated as success and the lane advances —
`code-review`'s `loopback: 'implement'` (`shared/types/workflows.ts:816`) only ever
fires on a *failed* step result, which a review turn that "successfully found
problems" is not. The loopback the agent doc calls *"the channel that makes review
change code"* (`.claude/agents/cyboflow-code-review.md:27`) is a **no-op on the
default plane**. It works only on the orchestrated plane, as prose the driving
agent may or may not honor — which is exactly how the TASK-107 finding got
mis-filed.

**Change.** Mirror the `task-verify` verdict channel for `code-review`:

1. `.claude/agents/cyboflow-code-review.md` — require the subagent to emit a
   machine-readable last line, e.g. `REVIEW: BLOCKING` when it populated a
   `## Blocking` section, else `REVIEW: CLEAN`. (task-verify's `VERDICT: PASS|FAIL`
   is the established pattern.)
2. `workflowController.ts` — add a `SPRINT_CODE_REVIEW_STEP` handler beside the
   `SPRINT_TASK_VERIFY_STEP` block (`:883-935`): on `REVIEW: BLOCKING`, route into
   the **same** non-systemic loopback path task-verify's FAIL uses (`:905-914`) —
   declared `loopback` → `laneAttempt` bump → 3× cap → `failed`. Thread the
   `## Blocking` text into the re-driven `implement` step as loopback feedback (the
   same one-shot section mechanism task-verify uses to pass `## Fix guidance`).
3. `shared/types/sprintBatch.ts` — add `SPRINT_CODE_REVIEW_STEP = 'code-review'`
   named const (`code-review` already exists as a lane step id at :139; promote it
   to a named const so controller/parser/tests share one source, as the other
   step ids already do).

**Interaction with Item 1.** With Item 0 in place, a programmatic code-review
blocker loops back *structurally* — it never reaches the human queue, so Item 1's
prompt guardrail is a belt-and-suspenders backstop for the orchestrated plane
rather than the sole defense. Item 0 fixes the plane where sprints actually run;
Item 1 fixes the plane where the incident happened.

**Acceptance.** A programmatic sprint whose code-review returns `## Blocking`
re-drives `implement` with the blocking text as feedback, up to 3×, then fails the
lane (feeding the existing exhaustion gate — §2). No blocking finding is minted for
an under-cap code-review defect. `pnpm test:unit` green; new controller unit test
covering `REVIEW: BLOCKING` → loopback → cap → fail, mirroring the task-verify
verdict tests.

**Note.** Changes under `main/src/services/panels/claude/` are NOT touched here, so
the Tier-3 itest gate is not triggered; controller changes are covered by
`test:unit`.

---

## Item 1 — Prompt guardrail (rescoped)

**Problem.** The instruction to loop back is stated positively with no guardrail,
and the MCP tool description invites the wrong choice. Rev 1's fix over-reached: a
blanket *"an agent driving a fan-out lane must never set `blocking:true`"* both
contradicts Item 0/§2's own exhaustion escalation AND breaks the built-in planner,
which legitimately mints blocking gates through this same tool (`planner.md:78-79,
155-156, 264`), as do host writers (`evalWorker.ts:671-684`,
`pairwiseJudgeWorker.ts:643-657`).

**Change.** Scope the guardrail to the one thing that is actually wrong — filing a
finding for a defect the loopback is about to fix — and leave every legitimate
blocking path alone.

1. `fan-out-instructions.ts` — in the `code-review`, `write-tests`, and
   `task-verify` chain entries (and the generic `default:` fallback at :161-175),
   add: *"A `## Blocking` / failing / FAIL result here is handled by the loopback
   below — do NOT also record it as a finding. The loopback IS the response."*
2. `cyboflowMcpServer.ts:569` — replace the permissive sentence with one that
   distinguishes the axis WITHOUT forbidding legitimate gates:

   > For `kind: 'finding'`: set `blocking: true` only for a defect that no retry or
   > loopback in the current step chain will fix (e.g. a lane that has exhausted its
   > attempt budget, or a hazard in shared state that must stop the run now). If the
   > step you are on has a loopback that will address the issue, the loopback is the
   > response — do not also file a finding. Blocking `kind: 'decision'` gates
   > (planner/ship guards, eval verdicts) are unaffected by this guidance.

**Honest scope.** `buildFanOutAppend` renders only into the MAIN orchestrating
session (`workflowPromptReaderAdapter.ts:54`, `interactiveClaudeManager.ts:1305`).
On the programmatic plane the inner agents read their own `.claude/agents/*.md`
prompts, so Item 1's prompt edit is **inert there** — Item 0 is what fixes the
programmatic plane. Item 1's value is: (a) the tool-description change, which every
plane's agents see, and (b) hardening the orchestrated plane where the incident
occurred.

**Preserved escape hatch (from review).** The guardrail deliberately does NOT say
"never block mid-chain". A code-review discovery that a lane's uncommitted diff is
destructive in the SHARED worktree (a deleted migration, a committed secret about
to be swept into a sibling's per-task commit) is a legitimate stop-everything-now
that an async 3-turn loopback does not provide, as is a `post-merge-bug` finding
targeting already-merged code. The rule is "not for defects the loopback will
fix", not "never".

**Acceptance.** `pnpm test:unit` green; `fan-out-instructions.test.ts` snapshots
updated to assert the guardrail renders for each canonical inner id and the generic
fallback; a check that the new MCP description does not contain the words the
planner's gate-minting would trip on.

---

## Item 2 — Enrich the existing exhaustion gate (surfacing only, no new lane state)

**Decision (user, rev 2):** the deferred aggregate gate is good enough. Do **not**
add a parked lane state or per-lane escalation machinery. Improve what the gate
that already fires (§2) shows.

**Problem.** When a sprint reaches `human-review` with failed lanes, the
programmatic gate body is the generic string *"Workflow step 'human-review'
requires a human decision…"* (`humanStepManager.ts:157-158`) with `payload: null`.
The human has to open the swimlane to learn which lanes failed and why.

**Change.** When the terminal `human-review` gate opens for a sprint run that has
`incompleteCount > 0`, compose a **partial-sprint summary** as the decision item's
body/payload:

- per failed lane: task ref + title, the inner step that kept failing, the
  `laneAttempt` reached, and the captured failure text from each attempt;
- the files each failed lane touched.

Sites:
- **Programmatic.** `humanStepManager.openHumanGate` currently hard-codes the body.
  Give it (or a sprint-aware caller) access to the batch's failed-lane summary so
  the `human-review` decision item carries it. This requires the controller to
  RETAIN per-attempt failure text, which today it does **not** — the only capture
  is `lastSystemicError` (systemic-only) and the visual-only
  `pendingLoopbackFeedback` closure local. Add a per-lane failure-text accumulator
  in `driveItem` and surface it on the lane row (or a batch-scoped side table) that
  the gate builder reads. This is the one piece of genuinely new machinery in
  Item 2, and it is additive read-model plumbing — no new lane STATUS, no change to
  settlement, resume, or close-out.
- **Orchestrated.** `sprint.md:138-146` already tells the agent to present a
  "partial-sprint summary". Tighten that prose to enumerate the per-lane attempt
  history above, so both planes present the same content.

**CTAs.** The gate stays a single approve/reject decision (its existing shape). The
enrichment is informational: the human reads the failure history and decides
approve (seal the partial sprint; failed lanes' tasks revert to backlog via the
existing close-out recompute, `git.ts:200-207`) or reject (end the run). Per-lane
"retry with guidance" / "drop" / "take it myself" CTAs are **out of scope** —
review showed they would need per-lane reset (today's `resetFailedLanes` is
batch-wide, `sprintLaneStore.ts:1151-1176`), a park-across-resolution protocol that
does not fight aggregate-unblock auto-resume (`resolveReviewItemHandler.ts:553-578`),
and shared-worktree rollback ownership that does not exist. The existing
`retryRunHandler` rewind path remains the way to re-drive failed lanes.

**Acceptance.** A programmatic sprint with ≥1 failed lane opens `human-review` with
a body enumerating each failed lane's ref, failing step, attempts, and failure
text; a clean sprint's gate body is unchanged. `pnpm test:unit` green; unit test
on the summary builder.

---

## Item 3 — Machine-mailbox findings: mint-time audience flag (not read-time hiding)

**Problem.** The visual merge-gate's under-cap `loopback-implement` finding is
addressed to a machine (the orchestrator reads it and re-delegates) but renders in
the human queue with human CTAs. Rev 1 proposed hiding it via a read-time predicate
on the queue list. **Both reviewers traced that to a permanent run-wedge**, and I
verified the mechanism:

The run-park gate counts **raw** pending blocking rows —
`hasPendingBlockingItems` → the aggregate SQL in `reviewItemListing.ts:451-458`,
consumed by `blockingItemsGate.awaitClear`, which resumes only when that count
reaches zero (`blockingItemsGate.ts:102-115`). Read-time queue hiding
(`trpc/routers/reviewItems.ts`, the list query — NOT `reviewItemListing.ts`, which
Rev 1 miscited) leaves the row `blocking=1 pending`, so the gate still counts it.
Concrete wedge: visual FAIL at attempt 2 → hidden blocking loopback finding → lane
loops back → re-run `task-verify` returns NOT-APPLICABLE (the fix removed the
visual surface) → no later verdict ever fires → supersession
(`verdictDelivery.ts:618-641`, which only runs on a LATER terminal verdict for the
same taskRef) never resolves it → fan-out settles → the next outer-boundary
blocking gate (`workflowController.ts:301`) parks the run on a pending blocking item
**the queue does not display**. Wedged `awaiting_review` forever, and it violates
the code's own documented invariant that *"BLOCKING FINDINGS must reach the Review
Queue"* (`trpc/routers/reviewItems.ts:694-697`).

**Change.** Introduce the audience distinction as a **first-class, mint-time**
datum at the single `ReviewItemRouter` chokepoint — the axis Rev 1 wrongly rejected
as over-scoped. Two viable forms; **reviewers/impl to choose**:

- **(3a) Audience flag.** Add `audience: 'human' | 'machine'` (default `'human'`)
  to the review-item create path, written once at mint. A `'machine'` finding is
  excluded from BOTH the human queue AND the blocking-count gate — i.e. it never
  parks the run and never shows a card; it is purely the durable, crash-safe record
  the orchestrator reads to re-delegate. The gate's "run is blocked" semantics and
  the queue's visibility then derive from ONE column, so they cannot desynchronize
  (the desync is exactly what produced the wedge).
- **(3b) Non-blocking + auto-resolve.** Make the under-cap loopback finding
  `blocking: false` and auto-resolve it when the loopback is consumed (the
  re-driven attempt starts). Simpler schema, but the finding stops being the
  durable crash-recovery record — the report must survive an app restart
  mid-verification some other way (the reason it is blocking+durable today).

**Recommendation:** 3a. It names the axis the system already has *de facto* (eval
catastrophic = human; systemic-pause = human; visual under-cap = machine; planner
gates = human) and keeps the three consuming surfaces (queue list, blocking count,
gate) consistent by construction. 3b trades a schema column for a new durability
problem.

**Keep `isMergeGateBlocking`'s LANE gating.** Under either form, an under-cap
visual FAIL must still hold THIS lane's integration until re-verified. That is lane
state (`awaiting-verify` park), not run-level blocking — do not conflate them.

**Acceptance.** An under-cap visual FAIL still loops the lane back and still holds
lane integration, but never parks the run and never appears in the human queue; an
at-cap visual FAIL is `audience:'human'`, appears in the queue, and (with Item 2)
lands in the enriched exhaustion picture; the wedge trace above cannot occur (no
hidden row is ever counted by the gate). `pnpm test:unit` green; a regression test
asserting a `'machine'` finding is absent from both the queue list and
`hasPendingBlockingItems`.

---

## 4. Sequencing

1. **Item 0** — the real correctness fix; independent; highest value. Land first.
2. **Item 1** — independent; small; hardens the plane where the incident occurred.
   Word it so it cannot contradict Item 0/§2 or the planner (see Item 1).
3. **Item 3** — schema/chokepoint change; unblocks safe machine-mailbox findings.
   Independent of 0/1.
4. **Item 2** — depends on the per-lane failure-text accumulator; benefits from
   Item 3 (so at-cap findings are the only human-audience ones in the picture).
   Land last.

## 5. Explicitly out of scope

- Per-lane retry/drop/take-over CTAs and any parked lane STATUS
  (`SprintBatchTaskStatus` has none: `shared/types/sprintBatch.ts:38-44`; crash
  resume re-dispatches any non-`integrated`/`failed` lane at attempt 1:
  `index.ts:~2343`). The existing `retryRunHandler` rewind is the re-drive path.
- Changing `FAN_OUT_LANE_ATTEMPT_CAP` (3), `MERGE_GATE_ATTEMPT_CAP` (3), or
  `MAX_STEP_LOOPBACKS` (5).
- The separate known defect that resolving a finding disqualifies it from Compound
  (staging is guarded to `status='pending' AND staged_at IS NULL`,
  `reviewItemRouter.ts:148-167`). Note the interaction: an Item-2 exhaustion picture
  is the richest failure telemetry the system produces, yet resolving the gate
  would exclude it from Compound. Worth its own item; not addressed here.
- Migrations: Item 3a needs one (new column); Items 0/1/2 need none (free-text
  category, JSON payload, prompt text). Stated so it is not left open.
