# Implementation plan — PTY fan-out steps as dynamic workflows

Companion to `pty-dynamic-workflow-orchestration.md` (the feasibility
assessment). This is the build plan for **Option B (phase-scoped dispatch)**,
scoped to what is implementable and testable headlessly.

**Guiding constraint: default OFF.** Every plank lands inert. With
`dynamicWorkflowFanOut` unset, a run's prompt, spawn args, and on-disk worktree
are byte-identical to today. The one exception is Plank 1, which is a bug fix and
lands live (it changes behaviour only when a dynamic workflow is actually running
for the run, which today can only happen in an ultracode session).

**What this plan does NOT do:** it does not verify that workflow subagents can
reach the `cyboflow_*` MCP server (§Risk 1). That needs a live `pnpm dev` probe.
The plan is structured so that if the probe fails, only Plank 4's prompt text
changes — Planks 1–3 stand.

---

## Plank 1 — Defer rest while a dynamic workflow is running

**The defect.** `RunExecutor.registerTurnEndRest` (`runExecutor.ts:1220`) routes
every interactive turn-end through `onLifecycleTransition('drained')` →
`restAwaitingReview`. The `Workflow` tool returns immediately and runs in the
background; the agent then yields, which is a turn-end. The run gets parked in
`awaiting_review` while its workflow is still executing, and the completion
notification arrives to an already-rested run. This is live today for any
ultracode session, independent of the rest of this plan.

**Changes.**

1. `DynamicWorkflowTracker.hasRunningForRun(runId: string): boolean` — new read
   over `this.states` (`status === 'running' && runId === runId`). Trivial,
   mirrors `list()`.
2. A narrow injected predicate on `RunExecutor` — `dynamicWorkflowGuard?:
   { hasRunning(runId: string): boolean }` — wired in `index.ts` to the tracker.
   Absent (tests, boot ordering) ⇒ today's behaviour exactly. Injected, not
   `tryGetInstance()` at the call site, so `runExecutor.test.ts` can drive both
   arms without touching the singleton.
3. `registerTurnEndRest`'s handler defers instead of resting when the guard
   reports a running workflow.

**The launch-detection race — the hard part.** On the interactive substrate the
launch is detected by `WorkflowScriptWatcher`, which **polls at 1000ms**
(`POLL_INTERVAL_MS`). The turn-end that follows a `Workflow` call can easily
arrive before the poll fires, so a naive `if (guard.hasRunning(runId)) return;`
loses the race and rests anyway.

Resolution: on turn-end for a **dispatch-armed** run, schedule the rest through a
`REST_DEFER_MS = 2500` timer (> 2 poll intervals) and re-check the guard when it
fires. Re-checking, not just waiting: if no workflow materialised, rest normally
(2.5s late). "Dispatch-armed" = the run's config opt-in is on, so a run with the
feature off keeps today's synchronous rest and today's latency.

**The stuck-run inverse.** If the rest is skipped and the agent never produces
another turn-end (it died, or the notification never landed), the run stays
`running` forever. Guard with a fallback: subscribe once per run to
`dynamicWorkflowEvents` `'changed'`; on a terminal state for that runId, arm a
`REST_FALLBACK_MS = 60_000` timer that rests the run **only if** no turn-end has
arrived since. `restAwaitingReview` is already guarded on `status === 'running'`
and documented re-entrant, so a redundant fire is a swallowed no-op.

**Teardown.** Both timers and the emitter subscription are per-run and must be
cleared in the same place the turn-end listener is removed
(`runExecutor.ts:1402-1412`). A leaked timer holding a runId across a teardown is
the obvious failure mode here — cover it with a test.

**Tests** (`runExecutor.test.ts`, fake timers): rest fires normally with no
guard; rest is skipped while the guard reports running; rest fires after
`REST_DEFER_MS` when the guard stays empty; the fallback rests a run whose
workflow went terminal with no further turn-end; teardown clears both timers and
the subscription.

## Plank 2 — The script renderer (pure)

New `main/src/orchestrator/prompts/fan-out-workflow-script.ts`, a direct sibling
of `fan-out-instructions.ts` and bound by the same rules: no DB / IPC / Electron
/ fs imports, pure function of the resolved definition, fail-soft to `null`.

```ts
export function renderFanOutWorkflowScript(
  workflowName: string,
  step: WorkflowStep,
  fanOut: FanOutSpec,
): string | null
export function fanOutScriptName(workflowName: string, stepId: string): string
```

`fanOutScriptName` is the single source of truth for the `cyboflow-<flow>-<stepId>`
identity — the renderer's `meta.name`, the on-disk filename, and the prompt's
`Workflow({name})` argument all derive from it, so they cannot drift.

**Emitted shape.** `meta` is a pure literal (the tool rejects computed values):
`name` = the script name, `description` from the step, `phases` = one entry per
inner step, titles matching the `opts.phase` strings used in the body. Body:

```js
const results = await pipeline(
  args,
  (item) => runStage(item, 'implement', 'cyboflow-implement', 0),
  (prev, item) => runStage(item, 'write-tests', 'cyboflow-write-tests', 1),
  ...
)
return { results }
```

with a rendered `runStage` helper carrying the loopback budget. Hard rules the
renderer must honour, each with a test:

- **Never emit `isolation`.** Sprint lanes deliberately share one worktree
  (`CLAUDE.md`); a per-agent worktree breaks lane verification.
- **Never emit `Date.now()` / `Math.random()` / argless `new Date()`** — they
  throw inside a script body.
- **`agentType: 'cyboflow-<agent>'`** — resolves against the same registry as the
  Agent tool, which `WorkflowBundleWriter` has already populated with
  `.claude/agents/cyboflow-*.md`.
- **Loopback** → a bounded retry loop around the failing stage, target resolved
  by the same rule `fan-out-instructions.ts` uses (`step.loopback` when set, else
  the first inner step id). Bound it explicitly; an unbounded loop inside a
  script is a wedged background task with no operator surface.
- **`optional: true` inner step** → failure skips the stage, lane continues.
- **Concurrency** — `effectiveMaxConcurrency(fanOut)` is the shared authority
  (already hardened against `0` / fractional / non-finite frozen-spec values).
  `pipeline()` does not take a cap, so the renderer emits explicit batching over
  it. **Open question for review:** the workflow runtime already caps concurrent
  agents at `min(16, cpus-2)`; whether cyboflow's 5-lane cap should be enforced
  on top, or deferred to, is a real decision, not a detail — the sprint cap is
  about *review load and merge-conflict surface*, not machine capacity, so my
  read is that it must be enforced explicitly.

**Tests.** Emitted script parses through the repo's own `parseScriptMeta`
(closing the loop with the tracker that will read it back); a forbidden-construct
regex sweep; a golden-file render of the real sprint `fanOut` spec; `null` for a
spec with an empty `inner`.

## Plank 3 — Install + remove the scripts

1. `WorkflowBundleWriter` gains a third target, `.claude/workflows`, writing
   `cyboflow-<name>.js`. Same namespace rule and same "clear the prior cyboflow
   set first" contract as commands/agents. `remove` strips only `cyboflow-*.js`.
   Note the existing `removeFiles` filters on `.md` — it needs an extension
   parameter, not a second hardcoded constant.
2. `WorkflowBundle` gains `scripts: WorkflowBundleFile[]`. `resolveWorkflowBundle`
   (a pure fs reader over app assets) does **not** produce these — they are
   rendered, not read — so they are attached by the install seam, and the empty-
   bundle short-circuit in `write()` must account for the new array.
3. `installWorkflowBundle` resolves the run's definition (it currently reads only
   `workflow_path`; it needs `workflows.name` + `spec_json` from the same join)
   and renders one script per `fanOut`-bearing step. Guarded by the config
   opt-in — off ⇒ nothing rendered, nothing written, no new dir.
4. `CYBOFLOW_EXCLUDE_PATTERNS` gains `.claude/workflows/cyboflow-*.js` so the
   generated scripts never surface in a run diff.

**Tests.** Writer: namespace, merge-safety (a user's `.claude/workflows/mine.js`
survives write and remove), extension scoping (a user `.md` in the workflows dir
is untouched), idempotent remove. Install: off ⇒ no dir created; on ⇒ one script
per fan-out step; exclude patterns updated.

## Plank 4 — Prompt swap (interactive only, behind the opt-in)

The interactive substrate composes its own appends —
`interactiveClaudeManager.composePromptBody` (`:1370`) re-derives
`buildStepReportingAppend` + `buildFanOutAppend` and **prepends** them to the
prompt body, because there is no interactive `systemPrompt.append` channel. The
SDK path uses `workflowPromptReaderAdapter` instead. So this change is naturally
confined to the PTY: `workflowPromptReaderAdapter.ts` is not touched, and the SDK
substrate cannot be affected.

1. `buildFanOutAppend(def, opts?: { dispatch?: 'prose' | 'workflow' })`. Default
   `'prose'` ⇒ byte-identical output to today (assert this with a test that
   pins the existing rendering).
2. `'workflow'` emits, per fan-out step, a short block: resolve the item set as
   today, then call `Workflow({name: '<scriptName>', args: <itemIds>})`, wait for
   the completion notification, then report the step. The item-set resolution and
   the step-reporting contract are unchanged — only the *execution* of the inner
   chain moves.
3. Opt-in: `AppConfig.dynamicWorkflowFanOut?: boolean` +
   `ConfigManager.getDynamicWorkflowFanOut()` (floors `false`), following the
   `defaultExecutionModel` precedent, explicitly **not** seeded into the
   constructor defaults so existing `config.json` files stay byte-identical.
   `composePromptBody` reads it via the already-injected `configManager`.

**Deliberately not doing:** setting `effort: 'ultracode'` for workflow runs. The
prompt itself is a user turn naming a saved workflow, which is sufficient opt-in
for the tool. Turning on ultracode would additionally make the agent fan out on
its own initiative for *unrelated* steps — a much broader behavioural change than
this plan intends.

**Tests.** Default arm byte-identical; workflow arm names the script that
`fanOutScriptName` produces for the same step (the drift test that matters);
`composePromptBody` honours the config in both arms.

## Verification

- `pnpm typecheck && pnpm lint` (`any` is CI-error-enforced).
- Targeted `cd main && npx vitest run <paths>` per plank while building.
- `pnpm test:unit` once, over the settled tree, at the end.
- Nothing here touches `main/src/services/panels/claude/` behaviour under test by
  the mocked-SDK suite except `interactiveClaudeManager` — run
  `pnpm test:integration` too, since that directory is the trigger for it.
- **Manual, not covered:** the live MCP-reach probe (Risk 1), and any end-to-end
  run with the flag on. Both need `pnpm dev`.

## Risks

1. **MCP reach from workflow subagents is unverified** (the load-bearing
   assumption). If lane agents cannot reach `cyboflow_update_sprint_task`, lane
   `current_step` never advances and the sprint UI goes dark mid-fan-out. Fallback
   design: stages return structured lane results and the top-level agent performs
   the writes between `Workflow` calls — correct, but loses live lane progress.
   The flag stays off until the probe passes either way.
2. **Agent-count guideline.** 5 lanes × a 5-step chain reads as over the default
   ~15-agent guideline. Unknown whether that counts concurrent or cumulative
   agents; if cumulative, large fan-outs may be truncated. Needs the same probe.
3. **Loopback semantics drift.** Two renderers (prose and script) now encode the
   same loopback rule. They must share `loopbackTargetId`, not re-implement it.
4. **Rest deferral latency.** `REST_DEFER_MS` delays the merge-button enable by
   2.5s for dispatch-armed runs. Acceptable; called out so it is not discovered
   as a regression.

## Order

Plank 1 → 2 → 3 → 4, each with its tests green before the next. Plank 1 is
independently correct and could ship alone.
