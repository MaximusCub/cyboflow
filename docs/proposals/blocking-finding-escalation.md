# Blocking-finding escalation: fix the inverted ladder

**Status:** proposal (unreviewed)
**Date:** 2026-07-23
**Origin:** a sprint run parked on a blocking finding whose body was a code-review
`## Blocking` defect for TASK-107. The finding offered `Resolve & resume` /
`Dismiss` / `Promote to task` — none of which fix the defect, and none of which
were the decision the situation actually called for.

---

## 1. The problem

`review_items.blocking` means exactly one thing: **park the run**. It does not
mean "a human must decide something". Because those are the same bit, anything
that parks a run necessarily renders in the human inbox with human CTAs.

That collision produces an **inverted escalation ladder** in the sprint lane
chain:

| Lane event | Should be | Is today |
|---|---|---|
| `code-review` returns `## Blocking`, attempt 1–2 | silent loopback to `implement` | **loud human interrupt with three inapplicable CTAs** |
| Lane exhausts `FAN_OUT_LANE_ATTEMPT_CAP` (3) | loud human escalation | **silent `status: 'failed'` + a log line** |

Both halves are wrong, and they are wrong in opposite directions. The cheap,
auto-fixable case interrupts a human; the expensive, genuinely-stuck case is
invisible and lets the sprint report success with a dead lane in it.

### 1.1 Evidence — the escalation is designed, and the agent deviated

`main/src/orchestrator/prompts/fan-out-instructions.ts`, `case 'code-review'`,
already specifies the correct behaviour:

> For each entry in its `## Findings`, record a **non-blocking finding** via
> `cyboflow_report_finding` … If it returns a `## Blocking` defect, **loop back
> to `cyboflow-implement`** (per the loopback + attempt protocol below) to fix
> it before proceeding.

The `code-review` inner step carries `loopback: 'implement'`
(`shared/types/workflows.ts:816`). A code-review blocker is never supposed to
become a blocking review item.

Nothing, however, *forbids* it. The `cyboflow_report_finding` tool description
(`main/src/orchestrator/mcpServer/cyboflowMcpServer.ts:569`) reads:

> set `blocking:true` only for items that should gate run resume

which describes a must-fix code-review defect perfectly. The orchestrating agent
took the invitation.

### 1.2 Evidence — exhaustion is silent

`main/src/orchestrator/programmatic/workflowController.ts:864` (and the identical
`task-verify` VERDICT:FAIL path at `:917`):

```js
driver.driveLane({ runId, itemId, status: 'failed', allowedStepIds });
this.host.log?.('warn', `... lane failed (attempt cap reached)`);
return 'failed';
```

A lane-status write and a log line. No review item, no gate, no park, no
notification. The orchestrated plane says the same in prose: *"mark the lane
`failed` and continue the other lanes — a failed lane never stops the fan-out."*

No consumer escalates a failed lane. `rewindRunHandler.resetFailedLanes` can
re-queue one, but only when a human already went looking at the swimlane.

### 1.3 The visual merge-gate already got this right

`isMergeGateBlocking` (`main/src/orchestrator/verify/mergeGateLaneAdvance.ts:433`)
implements the intended ladder for the *visual* path:

| Verdict | Action | Finding |
|---|---|---|
| FAIL under cap | `loopback-implement` | blocking (carries fix guidance) |
| FAIL at/over cap | `mark-failed` | blocking (the real escalation) |
| low confidence | proceed | non-blocking (advisory) |

It also supersedes stale lower-attempt findings on every terminal verdict
(`verdictDelivery.ts:615-640`), so a recovered lane leaves no orphan blocking
item.

This is the reference implementation. Two gaps remain:

- its **under-cap** `loopback-implement` finding is a machine-to-machine mailbox
  (the orchestrator is instructed to read it and re-delegate) yet it renders in
  the human queue with human CTAs;
- the **non-visual** lane failure paths (`code-review`, `write-tests`,
  `task-verify`) have none of this — no escalation finding at exhaustion at all.

---

## 2. Proposal

Three changes, ordered by dependency and by how much bleeding each stops.

### Item 1 — Prompt guardrail: a loopback-eligible defect never mints a blocking finding

**Problem.** The instruction to loop back is stated positively with no guardrail,
and the MCP tool description actively invites the wrong choice.

**Change.**

1. `main/src/orchestrator/prompts/fan-out-instructions.ts` — in the `code-review`
   chain entry, add an explicit prohibition after the existing loopback clause:

   > Do **NOT** record a `## Blocking` defect as a finding — blocking or
   > otherwise. The loopback IS the response. A finding here would park the run
   > and hand a human a defect the chain is about to fix itself.

   Add the same prohibition to the `write-tests` entry (failing test → loop back)
   and the `task-verify` entry (VERDICT: FAIL → re-delegate).

2. Extend the generic fallback in `renderChainEntry`'s `default:` branch with the
   same sentence, so a custom/renamed inner step inherits the rule.

3. `cyboflowMcpServer.ts:569` — replace the permissive sentence with a
   restrictive one:

   > `blocking: true` is reserved for the run's own escalation seams (a lane that
   > has exhausted its attempt budget; a gate the host opened). If a retry or a
   > loopback could still fix the issue, the finding is NON-blocking — file it and
   > continue. An agent driving a fan-out lane must never set `blocking: true`.

**Why first.** Self-contained, no schema change, and it stops the observed
symptom. Items 2 and 3 are structural and can land later without blocking this.

**Risk.** Prompt-only, so it is a compliance improvement, not a guarantee. Item 2
is what makes the invariant hold structurally.

**Acceptance.** `pnpm test:unit` green; the fan-out-instructions snapshot tests
(`main/src/orchestrator/prompts/__tests__/fan-out-instructions.test.ts`) updated
to assert the prohibition renders for each canonical inner id and for the generic
fallback.

---

### Item 2 — Escalation gate at attempt-cap exhaustion

**Problem.** The only genuine human decision point in the lane chain is silent.

**Change.** At every site that today marks a lane `failed` after exhausting
`FAN_OUT_LANE_ATTEMPT_CAP`, mint a **blocking** finding first, then park.

Sites (programmatic plane):
- `workflowController.ts:864` — required inner step failed, loopback budget spent
- `workflowController.ts:917` — `task-verify` VERDICT: FAIL at cap
- `workflowController.ts:~780` — visual merge-gate already does this via
  `verdictDelivery`; leave it, but route it through the same finding shape

Orchestrated plane: add the corresponding instruction to the *Loopback + attempt
protocol* block in `fan-out-instructions.ts` — on exhaustion, call
`cyboflow_report_finding` with `blocking: true` and the accumulated attempt
history, then leave the lane parked rather than marking it `failed`.

**Finding shape.** New `category: 'lane-exhausted'`, carrying:
- the task ref and the lane's inner-step id that kept failing
- all three attempts' failure text (the controller already threads
  `pendingLoopbackFeedback` / `lastError` per attempt)
- the files the lane touched

**Human CTAs.** The decision at exhaustion is *not* "address vs dismiss" — three
implement attempts have already failed, so a blind fourth is the weakest option
available. The decision is about the task's relationship to the sprint:

| CTA | Effect |
|---|---|
| **Drop from sprint** | resolve the finding, lane stays `failed`, task returns to backlog, remaining lanes merge clean. Today's implicit behaviour — made explicit and chosen. |
| **Retry with guidance** | human supplies the context the blind attempts lacked; resolve the finding, `resetFailedLanes` the lane, re-drive `implement` with the guidance threaded in as `pendingLoopbackFeedback`. The only CTA where a human adds *information* rather than permission. |
| **Take it myself** | resolve the finding, park the lane, human fixes in the worktree, then resumes. |

**Reuse.** `rewindRunHandler.resetFailedLanes` re-queues a failed lane;
`workflowController.ts:833` already threads a one-shot `pendingLoopbackFeedback`
prompt section into a re-driven step. "Retry with guidance" is the composition of
the two — a surfacing problem far more than a machinery problem.

**Acceptance.** A programmatic sprint whose lane fails three times parks with a
`lane-exhausted` blocking finding instead of silently completing; each of the
three CTAs drives the lane to its stated end state; `pnpm test:unit` green.

---

### Item 3 — Suppress the machine-mailbox finding from the human queue

**Problem.** The visual merge-gate's **under-cap** `loopback-implement` finding
exists so the orchestrator can read the verification report and re-delegate. It
is addressed to a machine. It renders in the human queue anyway, with CTAs whose
effect on the lane is undefined.

**Change.** Do **not** add a general `requires_human` schema axis — with Item 1
and Item 2 in place, a blocking finding is human-actionable by construction and
the axis would be dead weight. This is a single-carrier suppression:

- Keep `isMergeGateBlocking` as-is (both branches still gate lane integration).
- In `reviewItemListing` / the queue's visibility predicate, exclude findings with
  `source = 'visual-verify'` whose payload `visualVerify.attempt <
  FAN_OUT_LANE_ATTEMPT_CAP` **and** whose gate action was `loopback-implement`.
  The distinguishing datum must be persisted — today `isMergeGateBlocking`
  collapses `mark-failed` and `loopback-implement` to the same `blocking: true`
  with nothing downstream able to tell them apart. Add the gate action to the
  `visualVerify` correlation payload (`verdictDelivery.ts:665`).

**Open question for review.** An alternative is to stop making the under-cap
loopback finding blocking at all, and instead thread the report through the same
in-memory `pendingLoopbackFeedback` channel the non-visual loopbacks use. That
removes the mailbox from the DB entirely rather than hiding it. It is cleaner but
touches the async merge-gate's crash-recovery story: the finding is currently the
*durable* record that survives an app restart mid-verification. **Reviewers should
weigh these two.**

**Acceptance.** An under-cap visual FAIL still loops the lane back and still
blocks integration, but does not appear in the review queue; an at-cap visual FAIL
does appear, with Item 2's CTAs; supersession behaviour unchanged.

---

## 3. Sequencing

1. **Item 1** — independent, lands immediately, stops the observed symptom.
2. **Item 2** — depends on nothing; makes Item 1's invariant structural.
3. **Item 3** — depends on Item 2 (its CTAs are what an at-cap visual finding
   should render), and on the open question above being settled.

## 4. Explicitly out of scope

- A general `requires_human` / `audience` axis on `review_items`. Considered and
  rejected above as over-scoped.
- Changing `FAN_OUT_LANE_ATTEMPT_CAP` (3) or `MAX_STEP_LOOPBACKS` (5).
- The separate, already-known defect that `Resolve & resume` on a finding
  permanently disqualifies it from Compound (staging is guarded to
  `status='pending' AND staged_at IS NULL`). Worth its own item; not addressed
  here.
