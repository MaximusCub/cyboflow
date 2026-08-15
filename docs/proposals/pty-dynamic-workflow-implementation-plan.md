# Implementation plan — PTY fan-out steps as dynamic workflows (v2, post-review)

Companion to `pty-dynamic-workflow-orchestration.md`.

**v1 of this plan was adversarially reviewed by two independent reviewers
(Claude Fable 5 and Codex). Both rejected it.** They converged on four defects
that invalidate its core design, and each found one the other missed. This v2
records the outcome, states what was built, and states what must be redesigned
before any of the rest is worth writing.

Status: **Planks A–C (defect fixes) and D–G (the stage-major redesign) built and
green, default OFF.** The three live CLI probes in "What is still unverified"
remain outstanding — the feature must not be switched on until they pass.

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

## The stage-major build (Planks D–G)

### Plank D — the stage-script renderer

`orchestrator/prompts/fanOutStageScript.ts`, a pure sibling of
`fan-out-instructions.ts`. Renders ONE inner stage of a fan-out step into a
`.claude/workflows/*.js` script that fans that stage across ONE already-chosen
wave and returns schema-validated per-item results. Every review constraint is
enforced and tested:

- **Host-owned stages are never rendered.** `HOST_OWNED_INNER_IDS` (matched on
  BOTH step id and agent id, since a custom flow may rename one) keeps
  `visual-verify` on the prose path, with its request/park protocol verbatim.
- **Domain outcome, not promise outcome.** Each agent returns
  `{outcome: ok|blocked|failed|not_applicable, summary, filesTouched, findings,
  visualTask}`. A blocking review is `blocked`, not a resolved promise. A null
  agent slot becomes a `failed` item rather than a silently dropped one.
- **Injection + traversal safety.** `slugSegment` reduces free-form
  workflow/step/agent ids to `[a-z0-9-]`, and every emitted literal goes through
  `JSON.stringify`. Tested against `../../etc/passwd`, quotes, backticks,
  `${...}`, and newlines.
- **Name drift is structurally impossible.** `fanOutStageLogicalName` (what the
  writer prefixes) and `fanOutStageWorkflowName` (`meta.name`, the on-disk
  basename, and the prompt's `Workflow({name})`) derive from one function.
- No `isolation` (lanes share one worktree), no `Date.now`/`Math.random`.
- **Real syntax validation.** Tests compile the emitted source with `vm.Script`
  in the shape the runtime consumes it (meta lifted off, body in an async
  function). `parseScriptMeta` is a fail-soft regex scanner and would accept
  broken source, so it is used only for the tracker round-trip.

### Plank E — the writer

`.claude/workflows/cyboflow-*.js` as a third target. Extension is now a
parameter, not a hardcoded `.md`, so a user's `.js` beside our `.md` is never
touched and generated scripts are actually reclaimed. `write()` reconciles
**before** the empty-bundle early return, so an on→off transition cannot strand a
stale script the CLI would still resolve by name. Target paths are containment-
checked and a name that would escape its directory is skipped, not written.

### Plank F — the install seam

Renders from `resolveRunFrozenSpec` — the run's frozen variant graph, the same
source the prompt resolves — NOT the live `workflows.spec_json` join used for
`workflow_path`; a variant run would otherwise install scripts for a different
chain than its prompt walks. The scripts glob is added to `.git/info/exclude`
only when scripts are actually installed, so dispatch-off leaves the exclude file
byte-identical. Dispatch is a threaded ARGUMENT: the SDK manager passes `'prose'`
explicitly, because this seam is substrate-shared and SDK worktrees consume no
scripts.

### Plank G — prompt + config

`buildFanOutAppend(def, opts?)` gains a `workflow` arm that replaces per-task
Agent-tool delegation with per-stage `Workflow({name, args})` dispatch and an
explicit reconcile step (advance / loopback+attempt / file findings / carry
`visualTask`). It changes only the DELEGATION — wave selection, every
`cyboflow_*` write, the loopback protocol, the visual gate, and the per-task
commit stay with the orchestrator, and the prompt says so. Defaulted to `prose`,
with a test asserting the default arm is byte-identical to an explicit prose
request. A stage whose name cannot be slugged falls back to prose per step.

Config: `FanOutDispatch` lives in `shared/` (both `AppConfig` declarations carry
the field, per the IPC type-parity rule), floors to `'prose'` on absent/invalid,
and is **snapshotted once per spawn** and threaded to both installation and
prompt composition — so a mid-run config flip can never leave a run whose prompt
cites scripts its worktree lacks.

**Gate:** `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test:integration` (25),
`pnpm test:unit` (8942 main + 3752 frontend, 0 failures). 53 new tests.

## What is still unverified

Three live CLI behaviours, none runnable headlessly, each fatal alone. **Do not
switch `fanOutDispatch` to `workflow` before these pass:**

1. Is the `Workflow` tool available without the `ultracode` setting? The design
   relies on the run prompt naming a saved workflow being sufficient opt-in.
2. Does a worktree-local `.claude/workflows/` resolve by name? The string is in
   the CLI bundle; project-scoped resolution was never exercised.
3. Does a completion notification actually re-wake a yielded PTY REPL? If not,
   the normal case is a run that never processes its stage results. Plank C's
   guard keeps such a run from being falsely rested, but it will sit `running`.

A fourth, cheaper to answer once the above pass: whether the ~15-agent workflow
size guideline counts concurrent or cumulative agents, since a 5-lane wave is
5 agents per stage.
