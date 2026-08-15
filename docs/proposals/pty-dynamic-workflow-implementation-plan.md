# Implementation plan — PTY fan-out steps as dynamic workflows (v2, post-review)

Companion to `pty-dynamic-workflow-orchestration.md`.

**v1 of this plan was adversarially reviewed by two independent reviewers
(Claude Fable 5 and Codex). Both rejected it.** They converged on four defects
that invalidate its core design, and each found one the other missed. This v2
records the outcome, states what was built, and states what must be redesigned
before any of the rest is worth writing.

Status: **Planks A–C built and green. Planks 2–4 (renderer / writer / prompt
swap) NOT built — the design is wrong as specified.**

---

## What the review changed

### The dispatch shape is wrong (both reviewers, independently)

v1 proposed one `Workflow` call per fan-out step, executing the whole per-item
inner chain. That cannot work, for reasons that are structural rather than
fixable in the renderer:

- **The lane chain is not a pure agent pipeline.** Between inner steps the main
  session does entity work: it moves `current_step` via
  `cyboflow_update_sprint_task`, carries `attempt: <n>` on loopback, files
  findings with `cyboflow_report_finding`, and makes ONE git commit per task on
  success (`fan-out-instructions.ts:275-293`). One opaque phase-wide call leaves
  no control point for any of it.
- **`visual-verify` is not an agent stage at all.** The prose is explicit:
  *"there is NO subagent to delegate for this step; YOU fire the request"*
  (`fan-out-instructions.ts:141-165`). The main session calls
  `cyboflow_request_verification`, parks the lane at `awaiting-verify`, and an
  async external verdict drives it off the park. The `cyboflow-visual-verify`
  agent that exists is the *central* verifier, deployed by the main-process
  scheduler into an isolated snapshot worktree with `$VERIFY_*` env — invoked as
  a bare `agentType` in the lane's shared worktree it cannot function. Worse,
  the step is `optional: true`, so v1's "optional ⇒ skip on failure" rule would
  have silently converted the visual merge-gate into a guaranteed skip.
- **Domain failure is not promise failure** (Codex). `code-review` and
  `task-verify` return *normally* while reporting `REVIEW: BLOCKING` /
  `VERDICT: FAIL`. The programmatic controller has explicit parsers for exactly
  this (`workflowController.ts:947,1003`). A `runStage` keyed on rejection treats
  a blocking review as success.
- **Wave selection is not a concurrency cap** (Codex). The current orchestration
  dispatches dependency-ready, file-disjoint waves and re-resolves added/removed
  tasks at every wave boundary (`workflowController.ts:1124,1180,1261`). A frozen
  ID list plus a cap does none of that.

### The MCP-reach question was already answered — no (both reviewers)

v1 treated subagent MCP reach as an open probe that "decides everything". It is
closed, in the repo: every lane agent pins an explicit allowlist —
`tools: Read, Edit, Write, Bash, Grep, Glob` — and each is documented "Never
writes cyboflow state" (`sprint/agents/*.md`). Granting them `cyboflow_*` would
break the single-writer invariant that the step-reporting append states to the
model verbatim, which is the same invariant for which the feasibility doc
rejected Option C.

### The tracker could not see workflow runs at all (Codex only)

The decisive find, and the one that made Plank 1 unimplementable as designed:
the tracker resolved its watcher's worktree path only through the `sessions`
table, and a flow run has no `sessions` row. See §4.7 of the feasibility doc.

### Consequently

**The viable design is stage-major, host-controlled dispatch**, not item-major:
the top-level agent dispatches ONE ready, file-disjoint wave of ONE inner step at
a time, agents return typed structured results and write nothing, and the main
session reconciles through the router chokepoints between calls. That preserves
single-writer, keeps lane progress live, keeps `visual-verify` host-owned, and
keeps wave re-resolution. It is a materially different and larger design than v1,
and it still rests on three unverified CLI behaviours (below).

## What was built

### Plank A — the tracker blind spot (live defect, fixed)

`DynamicWorkflowRunContext.worktreePath`, passed by both managers from the
spawn's own `options.worktreePath`, with the `sessions` lookup kept as the
quick-session fallback. Without it no dynamic workflow inside a PTY *workflow
run* was ever tracked.

Tests: `dynamicWorkflows/__tests__/dynamicWorkflowTrackerWatcher.test.ts` (8),
including a case pinning the pre-fix behaviour (no watcher for a flow run that
supplies no path).

### Plank B — quick-session premature completion (live defect, fixed)

`index.ts`'s quick-session turn-end listener flipped `sessions.status` to
`'completed'` on the turn-end that follows a `Workflow` launch. This is reachable
**today**: the Ultracode wizard card launches quick PTY sessions with
`--settings '{"ultracode":true}'`, which is precisely the setting that makes the
agent fan work out as dynamic workflows. Now guarded on
`hasRunningForRun(runId)`.

No stuck-session risk: a live agent turns again on the completion notification
(that turn-end rests it), and a dead agent is covered by the process-exit handler
that already writes `'completed'`/`'stopped'` (`events.ts:435-500`).

Not unit-tested — it is a guard clause inside the composition root's inline
listener, which has no existing test harness. Its predicate is tested.

### Plank C — the workflow-run rest guard

`RunExecutor` takes an optional `hasRunningDynamicWorkflow` probe (slot 17) and
skips the event-driven rest while it holds.

Two review findings shaped this:

- Codex disproved v1's premise that a redundant rest is harmless.
  `onLifecycleTransition` runs its side effects — task-stage derivation, usage
  rollup, compound-findings close-out — *even when the status transition is
  rejected as a race* (documented at its `catch`), and the compound close-out
  clears `selected` on still-pending seeded findings.
- Both reviewers showed v1's 2500ms defer timer is unsafe: a question ask is
  itself a turn-end, so a timer armed before the human answers can fire while the
  run is legitimately mid-turn again — and `restAwaitingReview`'s
  `status === 'running'` guard *passes* in exactly that state.

So the guard ships **without** the defer timer. This leaves a known residual: the
launch is observed by a 1s-poll watcher, so a turn-end inside that window still
rests. Closing it needs a deferred re-check gated on a per-run execution epoch +
turn generation + `hasTurnInFlightForSession`, which belongs with the change that
makes dispatch routine. Documented at the call site.

Tests: 2 added to `runExecutor.test.ts` (guarded arm; no-probe arm byte-identical).

**Gate:** `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test:integration`
(25), `pnpm test:unit` (8890 main + 3752 frontend, 0 failures).

## What must happen before Planks 2–4

1. **Redesign to stage-major dispatch** (above). This is the real work and it
   is not a renderer detail.
2. **Three live probes**, none runnable headlessly, each fatal alone:
   - Is the `Workflow` tool available without the `ultracode` setting? v1 asserted
     yes from a reading of tool policy; it was never observed.
   - Does a worktree-local `.claude/workflows/` resolve by name? The string is in
     the CLI bundle; project-scoped resolution was never exercised.
   - Does a completion notification actually re-wake a yielded PTY REPL? The whole
     design assumes it. If not, the normal case is a run that never processes its
     results.
3. **Then** the renderer, with the constraints both reviewers added to v1's list:
   structured per-stage output schemas with domain-outcome parsing;
   `JSON.stringify` for every emitted literal and a filename-safe slug with path
   containment (workflow names and step ids are free-form — slashes escape the
   directory, quotes break the script); AST-level validation, since
   `parseScriptMeta` is a fail-soft regex scanner that will happily accept
   syntactically invalid JavaScript.
4. **Writer caveats** found in review: `installWorkflowBundle` is substrate-shared
   (the SDK calls it too, so "confined to interactive" holds only for the prompt);
   `ensureBundleExcluded` runs unconditionally, so adding a glob mutates
   `.git/info/exclude` even with the feature off; `write()` returns before
   `remove()` on an empty bundle, so stale scripts survive an on→off transition;
   and the writer's `cyboflow-` prefix would double up on a `fanOutScriptName`
   that already carries it.
5. **Config threading**: a global `AppConfig` flag read at three different times
   is not enough — resolve a typed dispatch mode ONCE per run and thread that
   snapshot to prompt composition, installation, and the rest guard. `AppConfig`
   is declared separately in main and frontend and needs parity.
