# Workflow tuning levels — implementation plan

Status: DRAFT r3 (pre-implementation; design approved via the "Workflow Tuning Levels" canvas
artifact; r2 = Codex adversarial round 1 folded in (§8); r3 = user decisions: Standard =
as-authored defaults, Custom = selectable 4th level, Advanced-save three-way prompt (§9)).
Design reference: https://claude.ai/code/artifact/34cc2e25-2c27-415c-9acd-a893d68b62e1

## 1. What we're building

One dial per workflow — **Efficient / Standard / Thorough / Custom** — where Efficient and
Thorough are named presets bundling the editor's existing knobs (per-agent model +
reasoning-effort pins, optional-step toggles, per-step retries, step removal/merging, eval
depth), **Standard is exactly today's as-authored built-in behavior**, and **Custom is a real
selectable fourth slot** holding the user's own Advanced-edited definition. The deep editor
(step graph, agents, MCPs, variants, A/B) lives on an **Advanced** page; saving there prompts
overwrite-this-flow / save-as-new-flow / save-as-new-variant. The launch wizard gets a per-run
level override. Level cards show a token estimate derived from real `run_usage` history.

Per-flow calibrations (sprint + planner matrices) live in the design artifact; they are data,
not architecture — this plan is about the machinery.

## 2. Grounding: the existing seams (verified)

- **Definition storage**: `workflows.spec_json` (empty/`'{}'` ⇒ built-in fallback via
  `resolveWorkflowDefinition`). Editor saves through tRPC `cyboflow.workflows.updateSpec`
  → `WorkflowRegistry.updateSpec` (`main/src/orchestrator/workflowRegistry.ts:384`), which also
  records a `workflow_revisions` row keyed by `computeSpecHash` (sha256 of the raw string).
  `resetSpec` (registry `:411`) already implements "reset to built-in".
- **Per-agent model/effort**: `WorkflowDefinition.agentConfigs` (`shared/types/workflows.ts:628-691`)
  — `{ model?, custom?, runtime?, providerModel?, effort? }` keyed by agent key. Runtime merge
  order (builtin → project `agent_overrides` → workflow `agentConfigs` → variant delta) is already
  implemented in `main/src/orchestrator/agents/effectiveAgents.ts` and executed at
  `agentOverlayWriter.ts:195` (`resolveRunEffectiveAgents`). **No run-side change needed for
  model/effort presets.**
- **Optional + retries**: `WorkflowStep.optional` / `retries` exist and are mechanically honored on
  the programmatic plane (`workflowController.ts:462/511/596`); on the orchestrated plane they are
  prompt-level guidance (`customFlowPrompt.ts:88`). Presets just set these fields.
- **Step removal adapts the sprint lane MACHINERY automatically**: `resolveRunFanOutInner`
  (`laneChainResolution.ts:60-78`) derives the lane-step vocabulary from the run's frozen
  definition, and `cyboflow_update_sprint_task`'s `current_step` validation follows it
  (`mcpQueryHandler.ts:3283`). BUT the bundled orchestrator prompt is NOT derived: `sprint.md:18`
  hard-codes the canonical lane vocabulary (`write-tests`, `code-review`, …) in prose, so a
  definition with steps removed would hand the orchestrated-plane agent contradictory
  instructions — and a `current_step` write for a removed id would be REJECTED by the narrowed
  validation. Prompt-side derivation is therefore in scope (D9).
- **Lane retries are NOT per-inner-step**: `FanOutInnerStep` has no `retries` field (its schema
  accepts only id/agent/optional/loopback/name/firmGate), and the programmatic controller uses
  the global `FAN_OUT_LANE_ATTEMPT_CAP = 3` (`programmatic/types.ts:281`) for every lane failure.
  Presets can tune `retries` on OUTER steps only (D1).
- **Per-run spec selection**: `WorkflowRegistry.createRun` freezes
  `effectiveSpecJson = opts?.variantSpecJson ?? workflow.spec_json ?? '{}'`
  (`workflowRegistry.ts:1568`). There is **no per-run ad-hoc definition override today** — this is
  the one genuinely new seam the launch-wizard override needs.
- **Zod gate**: `workflowDefinitionSchema` (`main/src/orchestrator/workflowDefinitionSchema.ts:177`)
  is a plain `z.object` — **unrecognized top-level keys are silently stripped**. So the level stamp
  must NOT live inside `spec_json` unless the schema + `WorkflowDefinition` type are both extended.
  v1 deliberately keeps `spec_json` key-set unchanged.
- **Usage data**: `run_usage` (migration 026) has per-run token/cost rollups; `workflow_runs`
  already carries frozen per-run snapshot columns (`substrate`, `model`, `spec_hash`,
  `variant_id`, `eval_enabled`, …) — the established home for a per-run `tuning_level` stamp.
  Insights queries AVG today; median-in-JS has precedent (`verificationRequests.ts:812`).
- **Eval jury**: fixed 3-slot array wired at boot (`index.ts:2572`); only lever today is the
  binary `eval_enabled`. Juror-count-by-level is new machinery.
- **Migrations**: highest is 118 → this feature takes **119**.

## 3. Core design decisions

### D1. Levels are resolved at read/run time; Standard is the identity; spec_json is the Custom slot

The pivotal decision (r3): selecting a level writes ONLY the `tuning_level` stamp. `spec_json`
is never touched by the dial — it becomes the dedicated **Custom slot**, written exclusively by
the Advanced editor (and the MCP writer). The effective definition is resolved wherever it's
consumed:

```ts
effectiveDefinition(workflow) =
  workflow.tuning_level === 'custom'
    ? resolveWorkflowDefinition(name, workflow.spec_json)          // today's exact path
    : applyTuningPreset(builtinFor(name), name, workflow.tuning_level);
// where applyTuningPreset(def, flow, 'standard') === def (identity — as-authored)
```

Consequences, all favorable:
- **Standard = today's behavior, byte for byte.** For a standard-level run,
  `effectiveSpecJson` stays `'{}'` (built-in fallback), same spec_hash bucketing as today —
  zero behavioral or stats change for anyone who never touches the dial.
- **No divergence detection.** Custom isn't a derived "you diverged" state; it's a slot. The
  whole serialize-and-compare machinery from r2 is deleted.
- **Preset upgrades are automatic.** A recalibrated Efficient in a new app version applies on
  the next run — no stale materialized copies, no "reads as CUSTOM after upgrade" (r2 risk #5
  dissolves).
- **Lossless switching.** Efficient → Custom → Efficient round-trips; the custom slot survives
  untouched while other levels are selected.

Materialization happens once per run, at `createRun`:
`effectiveSpecJson = level === 'custom' ? spec_json : level === 'standard' ? '{}' :
serializeDefinition(applyTuningPreset(...))`, then the existing freeze
(`computeSpecHash` + idempotent `recordRevision`) proceeds unchanged, so restart/insights see a
real revision for every efficient/thorough run.

**Read paths that must route through `effectiveDefinition`** (the cost of resolve-at-read):
the editor's Advanced canvas baseline, tRPC `getDefinition`, MCP `cyboflow_get_workflow`
(returns the effective definition; response gains a `tuning_level` field so callers know what
they're looking at), prompt building, `resolveRunFanOutInner` (already reads the frozen per-run
spec — unaffected), and **`VariantResolver`'s baseline arm**, which today reads
`workflow.spec_json` raw and must instead take the materialized level (a variant row's own
frozen `spec_json` is unaffected).

**MCP write semantics:** `cyboflow_update_workflow` writes the custom slot and stamps
`tuning_level = 'custom'` in the same transaction — the exact mirror of the Advanced editor's
"overwrite" save (D3).

New module `shared/tuning/workflowTuning.ts` (shared so main + frontend agree byte-for-byte):

```ts
type TuningLevel = 'efficient' | 'standard' | 'thorough' | 'custom';

interface TuningPreset {
  // per-agent-key model/effort pins → merged into definition.agentConfigs
  agentConfigs: Record<string, { model?: AgentModelAlias; effort?: ReasoningEffort }>;
  // step edits keyed by "<phaseId>/<stepId>" or "<phaseId>/<stepId>/inner/<innerId>"
  removeSteps?: string[];                       // efficient: drop write-tests, code-review
  // retries is OUTER-step only — FanOutInnerStep has no retries field and lanes
  // run under the global FAN_OUT_LANE_ATTEMPT_CAP; inner patches may set only
  // optional/name. (Per-inner-step retry budgets = possible future work, out of scope.)
  outerStepPatches?: Record<string, Partial<Pick<WorkflowStep, 'retries' | 'optional' | 'name'>>>;
  innerStepPatches?: Record<string, Partial<Pick<FanOutInnerStep, 'optional' | 'name'>>>;
  promptAddenda?: Record<string, string>;       // per agent key — see D5
  evalDefault?: boolean;                        // efficient: false
}

applyTuningPreset(builtin: WorkflowDefinition, flow: CyboflowWorkflowName, level: TuningLevel): WorkflowDefinition
serializeDefinition(def: WorkflowDefinition): string   // THE canonical serializer (see D3)
```

Preset tables initially calibrated for **sprint** and **planner** (from the design matrices —
note the artifact's "standard" columns now document AS-AUTHORED behavior rather than a preset;
efficient/thorough remain calibrated deltas relative to it). Other built-ins (launch, compound,
ship, verify-setup) start with agentConfigs-only presets (model/effort tiers, no structural
edits) until individually calibrated. Custom (non-built-in, "save as new") flows have no
built-in baseline → only Standard-equivalent (their own spec) exists; the tuning selector is
hidden for them and they open straight to Advanced.

### D2. Persistence: two columns (migration 119)

```sql
ALTER TABLE workflows     ADD COLUMN tuning_level TEXT NOT NULL DEFAULT 'standard';
UPDATE workflows SET tuning_level = 'custom'
  WHERE TRIM(spec_json) != '' AND TRIM(spec_json) != '{}';   -- existing edited flows keep their behavior
ALTER TABLE workflow_runs ADD COLUMN tuning_level TEXT;      -- frozen per-run level; NULL = pre-feature/variant
```

The backfill preserves every existing flow's effective behavior exactly: untouched flows resolve
the built-in via the standard identity; already-edited flows land on `'custom'` and keep
resolving their `spec_json`.

`workflow_runs.tuning_level` is stamped once in `createRun` (same immutable-snapshot pattern as
`spec_hash`/`variant_id`): the wizard's per-run override if given, else the workflow's stamped
level. Variant-pinned/rotation runs stamp NULL (a variant is its own frozen spec — attributing a
level to it would poison the estimate buckets).

### D3. Four-slot selector + the Advanced-save three-way prompt

The selector shows four options: **Efficient / Standard / Thorough / Custom**. Selecting any of
them is one cheap write (`tuning_level` stamp). Custom is disabled with a hint ("no custom
definition yet — open Advanced") while the custom slot is empty; it lights up once a custom
definition exists and shows the phase strip rendered from the slot's contents, exactly like the
preset levels render theirs from `applyTuningPreset` output.

**Customization and A/B both live only on the Advanced page.** The Advanced editor opens seeded
with the effective definition of the CURRENTLY SELECTED level (so "start from Efficient and
tweak" works naturally). On save, a three-way prompt:

1. **Overwrite this flow** — write the edited definition into the custom slot
   (`updateSpec`) and stamp `tuning_level = 'custom'` atomically. This is the only path that
   changes what the flow runs by default. If the slot already held a different custom
   definition, the prompt says so ("replaces your existing Custom definition").
2. **Save as new flow** — the existing "save as new" path (`createWorkflow` /
   `cyboflow_create_workflow`), unchanged: mints a separate flow seeded with the edited
   definition; the original flow and its level stamp are untouched.
3. **Save as new variant of this flow** — mints a `workflow_variants` row carrying the edited
   graph as its frozen `definition_json` (status `draft`, per the existing variant lifecycle —
   the user opts it into rotation from the variant manager). Server-side this is
   `createVariant` + the definition payload; today's create snapshots the *current* resolved
   definition and requires a follow-up `update_variant` to patch the graph, so the create seam
   gains an optional `definition` parameter (both tRPC and MCP writers). The base flow and its
   level stamp are untouched.

Cancel leaves everything as-is. This gives customization and A/B a single entry point with an
explicit blast-radius choice at save time — no silent baseline mutation from an experiment
edit, and no CUSTOM flip unless the user chose "overwrite".

**Reset:** `resetSpec` (tRPC + MCP `cyboflow_reset_workflow`) keeps its meaning — clear the
custom slot — and additionally flips `tuning_level` from `'custom'` to `'standard'` in the same
transaction when it was `'custom'` (an empty slot has nothing for Custom to select). In the UI
this surfaces as "Delete custom definition" on the Custom card / Advanced page rather than a
generic "reset". Preset levels need no reset at all — they have no stored state to reset.

### D4. Per-run override: a `tuningSpecJson` sibling of `variantSpecJson`

Extend `runs.start` input with `tuningLevel?: TuningLevel` (all four values — overriding to
`'custom'` is valid when the flow's custom slot is non-empty). `RunLauncher`/`createRun` resolve
the effective level as `override ?? workflow.tuning_level` and materialize per D1:

```ts
effectiveSpecJson =
  opts?.variantSpecJson                                   // explicit variant still wins
  ?? materializeForLevel(workflow, effectiveLevel);       // custom → slot; standard → '{}'; else preset
```

Wizard rule: the level override and an explicit variant pin are **mutually exclusive** — picking
a non-baseline variant disables the level segment (with a note), and vice versa. Rotation
(no explicit pin) with a level override forces baseline for that run (the override IS an explicit
spec choice). Override never writes the workflows row.

`spec_hash` of an override run hashes the materialized preset spec — identical to the hash of the
same level applied persistently, so revision stats bucket coherently.

**Restart semantics (review finding):** `runs.restart` reconstructs launch provenance and today
pins `baseline: true` when `variant_id` is NULL — an override run would silently restart on the
workflow's current spec, losing the graph/models/eval default it originally ran with. Fix, two
parts: (1) at override launch, record the materialized preset spec into `workflow_revisions`
(idempotent by hash — `recordRevision` already dedupes on the UNIQUE `(workflow_id, spec_hash)`),
so the frozen spec content is durably recoverable from the run's `spec_hash`; (2) restart
provenance reads `workflow_runs.tuning_level` + `spec_hash` and relaunches with the EXACT frozen
spec from `workflow_revisions` (not a re-application of the current calibration — a preset
upgrade between run and restart must not change what restarts). Restart tests must cover:
override, persistent-level, custom, variant, and post-preset-upgrade cases.

### D5. The efficient-level "implement + write tests" merge (revised per review)

The lane chain edit is trivial (remove the `write-tests` inner step). For the behavioral half —
implement also writes tests — the original draft proposed riding `WorkflowAgentConfig.custom`
(an apply-time embedded copy of the implement prompt + addendum). Codex review killed that,
correctly, on two counts: (a) `custom` REPLACES description/systemPrompt/tools/enabledMcps
wholesale in `applyWorkflowAgentConfigs`, so applying Efficient would silently erase a project's
own hardened implement override (project `agent_overrides` sits BELOW workflow `agentConfigs` in
the precedence chain) including its tool/MCP restrictions; (b) the base prompt body lives in
main-process markdown (`agentCatalogue.ts`), unreachable from a shared transform module.

Revised design: a first-class **`promptAddendum?: string`** field on `WorkflowAgentConfig`
(shared type + `workflowDefinitionSchema` extension — the same two-place edit `agentConfigs`
itself required). It is applied at the END of `resolveRunEffectiveAgents`
(`agentOverlayWriter.ts:195`), AFTER the builtin → project-override → workflow-config → variant
merge resolves the effective system prompt: the addendum is appended to whatever prompt won,
touching no other field (tools/MCPs/model preserved). The preset table carries the addendum text
("you also author the tests for your diff; run them targeted"). No frozen copies, no drift, and
it composes with project hardening instead of clobbering it.

Cost acknowledged: this IS a new definition key, so it must be added to both the TS interface and
the Zod schema or it gets silently stripped (see §2), and variant `agent_overrides_json` deltas
should be defined to preserve it (a variant delta that sets `custom` still wins wholesale —
addendum then applies on top of the variant's prompt, which is the consistent reading).

### D6. Eval depth per level

- **efficient** → eval off: preset `evalDefault: false`, consumed at launch as the default for
  `eval_enabled` when the wizard didn't explicitly override (existing per-run column, migration 044).
- **standard** → single juror; **thorough** → full 3-slot jury: new, contained change —
  `EvalWorker` reads the graded run's `workflow_runs.tuning_level` and filters its configured slot
  array (`standard` ⇒ `['claude-1']`, else all). NULL/unknown level ⇒ all slots (today's
  behavior). No config/boot wiring changes; jury composition stays hardcoded at boot.
  Ship this as its own phase — it is independently revertible.

### D7. Visual-verify depth (1 vs 3 viewports) — prompt-level only in v1

There is no mechanical viewport knob today (the task-verify subagent composes
`VerificationTaskV1.viewports` freely). v1: the lane-chain prompt instructions gain a
level-conditioned line ("capture a single desktop viewport" / "capture desktop + tablet + mobile"),
threaded from the run's `tuning_level` where fan-out instructions are built
(`prompts/fan-out-instructions.ts`). Mechanical enforcement (scheduler-side clamp) is explicitly
out of scope.

### D8. Token estimates from `run_usage`

New `insightsQueries.selectTuningLevelUsage(workflowId)`: join `workflow_runs` (completed,
`tuning_level` non-NULL, non-variant) × `run_usage`, return per-level arrays of `total_tokens`;
median computed in JS (precedent: `verificationRequests.ts:812`; SQLite has no native median).
Fallback chain per level card:
1. median of that workflow × that level (≥3 samples);
2. overall workflow median × the level's static multiplier (efficient ~0.5, thorough ~2.6);
3. static per-flow default table (fresh install).
Exposed via one tRPC read used by both the editor selector and the wizard. Estimates
self-calibrate as stamped runs accumulate. Label estimates as `~` always. The Custom card uses
only its own bucket (steps 1/3 — a multiplier over other levels says nothing about an arbitrary
custom graph).

**Scope caveat (review finding):** `run_usage` rolls up the run's own `raw_events`; eval jurors
run through separate judge queries whose SDK usage is not persisted (`run_evals` records
verdicts, not tokens). So the median systematically excludes a level-DEPENDENT cost (1 vs 3
jurors). v1 handles this honestly rather than invisibly: the cards label the number
"execution tokens (excl. eval)", and the static multipliers are calibrated on execution tokens
only. Metering + persisting jury usage (then folding it in) is listed as future work, not
silently promised.

### D9. Orchestrated-plane prompt derivation (new, from review)

`main/src/orchestrator/workflows/sprint.md:18` hard-codes the lane vocabulary in prose (and later
sections assume per-lane `code-review` output exists). An efficient run's orchestrator would get
instructions contradicting its frozen definition — and a `current_step` report for a removed id
is rejected by the definition-derived validation. Fix: scrub fixed lane vocabularies/chain
assumptions from the bundled sprint/ship prompt bodies and render them from the frozen
definition at prompt-build time (the fan-out instruction generator already derives the chain —
extend that seam to own the vocabulary sentence and the review-section conditionals). Add a test
that builds the complete effective prompt for an efficient run and asserts removed step ids
appear nowhere operative.

## 4. UI work

- **`WorkflowEditorModal`** becomes a two-page modal (matches the approved prototype, updated
  per r3 — the canvas artifact still shows the r2 derived-CUSTOM card and needs a refresh):
  - default page: FOUR-slot level selector (Efficient / Standard / Thorough / Custom, est.
    tokens + multiplier per card; Custom disabled-with-hint while its slot is empty), the "what
    runs at this level" phase strip (chips colored by model: haiku green / sonnet amber / opus
    red / fable violet, sub-label `model · effort`, struck = removed/skipped, hatched = human
    gate) rendered from `effectiveDefinition` output — no hand-maintained strip data;
    "Open advanced editor →".
  - advanced page: the ENTIRE existing editor body (canvas, inspector, agents, variants, A/B)
    moved unchanged behind a `view: 'simple' | 'advanced'` state with a "← Tuning level" back
    nav, seeded from the selected level's effective definition, plus the three-way save prompt
    (D3). Custom "save as new" flows open directly here.
- **`SessionStartWizard`**: level segment defaulting to the workflow's stamped level,
  "override for this run" affordance, est. tokens per option, mutual-exclusion with the variant
  picker; existing Advanced collapse unchanged.
- Type-parity: `WorkflowRow`/tRPC additions (`tuningLevel`, `hasCustomSlot`) follow
  `docs/CODE-PATTERNS.md` IPC rules (mirror shared types, no drift).

## 5. Phasing (each phase = independently committable + green)

| # | Phase | Contents | Size |
|---|-------|----------|------|
| 1 | Preset core | `shared/tuning/workflowTuning.ts`: types, sprint+planner preset tables, `applyTuningPreset` (standard = identity), `serializeDefinition`, `effectiveDefinition`; exhaustive unit tests incl. "every flow × level output passes `workflowDefinitionSchema`" | M |
| 2 | Persistence + resolution | migration 119 + backfill (+ test), `setTuningLevel` registry write, read-path routing through `effectiveDefinition` (tRPC `getDefinition`, MCP `get_workflow`, `VariantResolver` baseline arm), MCP `update_workflow` stamps `'custom'`, `resetSpec` slot-clear semantics | M–L |
| 3 | Run stamping + override | `runs.start.tuningLevel`, `materializeForLevel` in `createRun`, preset-launch `recordRevision`, restart provenance (D4), stamping rules (incl. variant-NULL rule), `evalDefault` consumption; lane-chain adaptation test for the efficient sprint preset | M–L |
| 4 | Prompt derivation + addendum | D9 prompt scrubbing/derivation for sprint/ship; `promptAddendum` field (type + Zod + `resolveRunEffectiveAgents` append) (D5) | M |
| 5 | Editor UI | two-page modal, four-slot selector, generated phase strip, three-way save prompt, variant-create-with-definition seam (D3) | L |
| 6 | Wizard UI | level segment, override plumbing, variant mutual exclusion | S–M |
| 7 | Estimates | `selectTuningLevelUsage` + median helper + tRPC read + both UI surfaces, "excl. eval" labeling | S–M |
| 8 | Eval juror filter | `EvalWorker` slot filter by run level (D6) | S |
| 9 | Viewport prompt guidance | fan-out instruction line by level (D7) | S |

Suggested checkpoints: after phase 4 the feature is fully functional headless (MCP/tRPC) and
safe on both planes; after phase 6 it is user-visible end-to-end; 7–9 are polish/depth.

## 6. Testing

- Unit (phase-local, per the lane test policy): transform idempotence + standard-identity +
  schema-validity sweep; `effectiveDefinition` resolution matrix (4 levels × empty/non-empty
  slot); migration 119 backfill (edited flows → `'custom'`, untouched → `'standard'`);
  `createRun` stamp + materialization matrix (override/stamped/custom/variant);
  restart matrix (override / persistent / custom / variant / post-preset-upgrade);
  `resetSpec` slot-clear + stamp-flip on tRPC + MCP; three-way save prompt paths (overwrite
  stamps custom; new-flow and new-variant leave base untouched); `VariantResolver` baseline
  materialization; efficient-sprint `resolveRunFanOutInner` + `current_step` validation
  adaptation; effective-prompt scrub test (D9); `promptAddendum` append-preserves-policy test;
  median query fixture.
- `pnpm test:unit` + `typecheck` + `lint` as the settled-tree gate per phase commit.
- Phase 4 touches `agentOverlayWriter.ts` under `main/src/services/panels/claude/` →
  `pnpm test:integration` is REQUIRED for that phase (CLAUDE.md rule), and again at the end.
- Manual smoke (dev app): apply each level on sprint, verify badge/custom/reset; run an
  efficient sprint and confirm the lane rail shows the merged chain; wizard override run stamps
  `workflow_runs.tuning_level`; estimates line appears after ≥1 stamped run.

## 7. Risks / open questions

1. **Read-path routing is the new blast radius.** Resolve-at-read means every consumer of a
   workflow's definition must go through `effectiveDefinition` — a missed call site silently
   runs Standard for an Efficient-stamped flow. Mitigate by making the raw `spec_json` read
   awkward (registry exposes only the resolved accessor; grep-audit direct `spec_json` reads in
   phase 2).
2. **`promptAddendum` is a new spec key** (D5) — it must land in the TS interface AND the Zod
   schema in the same commit or every writer strips it; older app versions reading a newer
   spec_json will also strip it on their next save (acceptable: level re-apply restores it).
3. **Orchestrated plane is advisory** for retries/optional-skips (prompt guidance, not mechanics) —
   levels are strictly enforced only on the programmatic plane. Acceptable: same asymmetry the
   editor's existing knobs already have.
4. **Estimate bucket pollution**: failed/interrupted runs drag the median down. Filter to
   completed runs; consider trimming later.
5. **Preset upgrades change run behavior silently.** Resolve-at-read means a recalibrated
   Efficient in a new app version changes what the next Efficient run does without any user
   action. Intended (r3 decision — presets are the app's calibration), and each run still
   freezes its exact spec (hash + revision), so history stays attributable; surface calibration
   changes in release notes.
6. **Launch wizard variant rotation × override** (D4's "force baseline") removes a run from
   rotation stats — acceptable since the user explicitly overrode, but Insights should exclude
   override runs from rotation experiment counts (they already will: no `rotation_experiment_id`).

## 8. Adversarial review log (Codex, round 1 — 2026-08-25)

Verdict: needs-attention; 4 high + 2 medium, all confirmed against the repo and folded in:

| Finding | Disposition |
|---|---|
| [high] Inner-lane `retries` not representable (`FanOutInnerStep` has no field; global `FAN_OUT_LANE_ATTEMPT_CAP`) | Fixed — D1 scopes retries to outer steps; inner patches limited to optional/name |
| [high] Removed lane steps remain in `sprint.md`'s hard-coded prose vocabulary | Fixed — new D9 (prompt derivation/scrub + effective-prompt test), new phase 4 |
| [high] `custom`-copy merge clobbers project agent policy; shared module can't read main-side prompt bodies | Fixed — D5 rewritten around a first-class `promptAddendum` applied after effective-agent resolution |
| [high] `runs.restart` loses a per-run tuning override (pins baseline when `variant_id` NULL) | Fixed — D4 restart semantics: revision-record at override launch + frozen-spec relaunch |
| [medium] Existing `resetSpec` would strand a stale `tuning_level` → contradictory CUSTOM state | Fixed — D3: resetSpec atomically clears the stamp; dual reset actions |
| [medium] `run_usage` medians exclude eval-jury tokens (level-dependent cost, unmetered) | Fixed — D8 labels estimates "execution tokens (excl. eval)"; jury metering = explicit future work |

## 9. r3 revisions (user decisions, 2026-08-25)

1. **Standard = today's as-authored defaults** — the standard preset is the identity transform;
   `effectiveSpecJson` stays `'{}'` for standard runs (zero change for users who never touch the
   dial). The design artifact's "standard" matrix columns are re-read as documentation of
   as-authored behavior, not a calibration to apply.
2. **Custom is a selectable 4th level**, not a derived divergence state. This flipped the
   architecture from materialize-on-apply to **resolve-at-read** (D1): `spec_json` is now the
   dedicated Custom slot, the dial writes only the `tuning_level` stamp, and the r2
   divergence-detection/serialize-compare machinery is deleted. r2's reset-coherence and
   preset-upgrade-reads-as-CUSTOM problems dissolve; the new cost is routing every definition
   read path through `effectiveDefinition` (risk #1).
3. **Advanced-save three-way prompt** (D3): customization and A/B live only on the Advanced
   page; saving prompts overwrite-this-flow (writes the custom slot + stamps `'custom'`) /
   save-as-new-flow (existing path) / save-as-new-variant (variant create gains an optional
   definition payload).

The canvas artifact predates r3 (shows a derived-CUSTOM card, 3-segment selector, no save
prompt) — refresh it before implementation kickoff.
