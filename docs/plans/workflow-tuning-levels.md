# Workflow tuning levels — implementation plan

Status: DRAFT (pre-implementation; design approved via the "Workflow Tuning Levels" canvas artifact).
Design reference: https://claude.ai/code/artifact/34cc2e25-2c27-415c-9acd-a893d68b62e1

## 1. What we're building

One dial per workflow — **Efficient / Standard / Thorough** — that bundles the editor's existing
knobs (per-agent model + reasoning-effort pins, optional-step toggles, per-step retries, step
removal/merging, eval depth) into named presets. The deep editor (step graph, agents, MCPs,
variants) moves behind an **Advanced** page. Any Advanced edit flips the workflow to **CUSTOM**
with one-click reset back to the last applied level. The launch wizard gets a per-run level
override. Level cards show a token estimate derived from real `run_usage` history.

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
- **Step removal adapts the sprint lanes automatically**: `resolveRunFanOutInner`
  (`laneChainResolution.ts:60-78`) derives the lane-step vocabulary from the run's frozen
  definition, and `cyboflow_update_sprint_task`'s `current_step` validation follows it
  (`mcpQueryHandler.ts:3283`). Removing `write-tests`/`code-review` from the fan-out inner chain
  is therefore a pure spec edit.
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

### D1. A level is a pure transform, applied through the existing spec chokepoint

New module `shared/tuning/workflowTuning.ts` (shared so main + frontend agree byte-for-byte):

```ts
type TuningLevel = 'efficient' | 'standard' | 'thorough';

interface TuningPreset {
  // per-agent-key model/effort pins → merged into definition.agentConfigs
  agentConfigs: Record<string, { model?: AgentModelAlias; effort?: ReasoningEffort }>;
  // step edits keyed by "<phaseId>/<stepId>" or "<phaseId>/<stepId>/inner/<innerId>"
  removeSteps?: string[];                       // efficient: drop write-tests, code-review
  stepPatches?: Record<string, Partial<Pick<WorkflowStep, 'retries' | 'optional' | 'name'>>>;
  mergeAddenda?: Record<string, string>;        // see D5 (implement+tests merge)
  evalDefault?: boolean;                        // efficient: false
}

applyTuningPreset(builtin: WorkflowDefinition, flow: CyboflowWorkflowName, level: TuningLevel): WorkflowDefinition
serializeDefinition(def: WorkflowDefinition): string   // THE canonical serializer (see D3)
```

Applying a level = `updateSpec(workflowId, applyTuningPreset(builtinFor(name), name, level))` plus
stamping `workflows.tuning_level`. It writes ordinary `spec_json`, so:
- `computeSpecHash` versions each preset naturally (each level = a distinct spec revision —
  desired: Insights/revisions history groups per level for free);
- variants, A/B rotation, revisions, and the MCP surface all keep working unchanged;
- no `spec_json` key additions, so nothing gets Zod-stripped.

Preset tables initially calibrated for **sprint** and **planner** (from the design matrices).
Other built-ins (launch, compound, ship, verify-setup) start with agentConfigs-only presets
(model/effort tiers, no structural edits) until individually calibrated. Custom (non-built-in)
flows have no preset baseline → the tuning page is hidden for them; they open straight to Advanced.

### D2. Persistence: two nullable columns (migration 119)

```sql
ALTER TABLE workflows     ADD COLUMN tuning_level TEXT;      -- last APPLIED level; NULL = never applied
ALTER TABLE workflow_runs ADD COLUMN tuning_level TEXT;      -- frozen per-run effective level; NULL = pre-feature/custom
```

`workflow_runs.tuning_level` is stamped once in `createRun` (same immutable-snapshot pattern as
`spec_hash`/`variant_id`): the wizard's per-run override if given, else the workflow's stamped
level **iff the stored spec still matches that level's preset** (i.e. not custom), else NULL.
Variant-pinned/rotation runs stamp NULL (a variant is its own frozen spec — attributing a level
to it would poison the estimate buckets).

### D3. CUSTOM is derived, never persisted

`isCustom(workflow) = tuning_level != null && workflow.spec_json !== serializeDefinition(applyTuningPreset(builtin, name, tuning_level))`.

One shared `serializeDefinition` (stable key order via explicit field-by-field construction, same
function used by the apply path) makes the comparison byte-exact — both sides of the compare are
produced by the same serializer, so `JSON.stringify` ordering is not a hazard. Computed in one
main-process helper, exposed on the tRPC workflow read surface as `{ tuningLevel, isCustom }`
(and on the MCP compact row alongside the existing `has_custom_spec`). No dirty bit to keep in
sync; an edit from ANY writer (editor Advanced page, MCP `cyboflow_update_workflow`, variants
promoting into baseline) flips CUSTOM automatically on next read.

Display state machine:
- `tuning_level` set + spec matches → that level's badge.
- `tuning_level` set + diverged → **CUSTOM** badge; "Reset to <level>" re-applies the stamped
  level's preset (one `updateSpec`).
- `tuning_level` NULL + `spec_json` empty → no badge ("as authored"); the selector highlights
  nothing until the user applies a level. (We do NOT pretend the built-in equals Standard —
  Standard's calibration intentionally differs from today's as-authored defaults.)
- `tuning_level` NULL + `spec_json` non-empty (existing edited flows) → **CUSTOM**, reset offers
  Standard.

### D4. Per-run override: a `tuningSpecJson` sibling of `variantSpecJson`

Extend `runs.start` input with `tuningLevel?: TuningLevel`. `RunLauncher.launch` computes
`tuningSpecJson = serializeDefinition(applyTuningPreset(builtin, name, tuningLevel))` and threads
it to `createRun`, whose freeze line becomes:

```ts
effectiveSpecJson = opts?.variantSpecJson ?? opts?.tuningSpecJson ?? workflow.spec_json ?? '{}';
```

Wizard rule: the level override and an explicit variant pin are **mutually exclusive** — picking
a non-baseline variant disables the level segment (with a note), and vice versa. Rotation
(no explicit pin) with a level override forces baseline for that run (the override IS an explicit
spec choice). Override never writes the workflows row.

`spec_hash` of an override run hashes the materialized preset spec — identical to the hash of the
same level applied persistently, so revision stats bucket coherently.

### D5. The efficient-level "implement + write tests" merge

The lane chain edit is trivial (remove the `write-tests` inner step). The behavioral half —
implement also writes tests — uses the existing `WorkflowAgentConfig.custom` seam: at **apply
time**, compose `custom.systemPrompt = <current built-in implement agent body> + mergeAddendum`
(a short "you also author the tests for your diff; run them targeted" block from the preset
table). This uses only existing run-side machinery (`applyWorkflowAgentConfigs` already handles
`custom`). Known semantics, documented in the preset module: the embedded copy freezes the base
prompt at apply time; base-agent edits don't retroactively flow in until the level is re-applied.
Re-applying the (already selected) level is allowed as a "refresh" and is idempotent otherwise.

Alternative considered and rejected for v1: a per-step `promptAddendum` field on
`FanOutInnerStep` — cleaner long-term but a type + both-planes + Zod ripple; revisit if the
frozen-copy drift bites.

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
self-calibrate as stamped runs accumulate. Label estimates as `~` always.

## 4. UI work

- **`WorkflowEditorModal`** becomes a two-page modal (matches the approved prototype):
  - default page: level selector (3 cards + est. tokens + multiplier), the "what runs at this
    level" phase strip (chips colored by model: haiku green / sonnet amber / opus red / fable
    violet, sub-label `model · effort`, struck = removed/skipped, hatched = human gate) rendered
    from `applyTuningPreset` output — no hand-maintained strip data; CUSTOM card + reset;
    "Open advanced editor →".
  - advanced page: the ENTIRE existing editor body (canvas, inspector, agents, variants) moved
    unchanged behind a `view: 'simple' | 'advanced'` state with a "← Tuning level" back nav.
    Custom flows and flows with no preset open directly here.
- **`SessionStartWizard`**: level segment defaulting to the workflow's stamped level (or "—"),
  "override for this run" affordance, est. tokens per option, mutual-exclusion with the variant
  picker; existing Advanced collapse unchanged.
- Type-parity: `WorkflowRow`/tRPC additions (`tuningLevel`, `isCustom`) follow
  `docs/CODE-PATTERNS.md` IPC rules (mirror shared types, no drift).

## 5. Phasing (each phase = independently committable + green)

| # | Phase | Contents | Size |
|---|-------|----------|------|
| 1 | Preset core | `shared/tuning/workflowTuning.ts`: types, sprint+planner preset tables, `applyTuningPreset`, `serializeDefinition`, `detectTuningState`; exhaustive unit tests incl. "every flow × level output passes `workflowDefinitionSchema`" | M |
| 2 | Persistence | migration 119 (+ test), registry `applyTuningLevel` (spec write + stamp, atomic), `resetToLevel`, tRPC routes, read-surface fields, MCP compact-row exposure | M |
| 3 | Run stamping + override | `runs.start.tuningLevel`, `RunLauncher` → `createRun` `tuningSpecJson` seam, stamping rules (incl. variant-NULL rule), `evalDefault` consumption; lane-chain adaptation test for the efficient sprint preset | M |
| 4 | Editor UI | two-page modal, selector, generated phase strip, CUSTOM/reset | L |
| 5 | Wizard UI | level segment, override plumbing, variant mutual exclusion | S–M |
| 6 | Estimates | `selectTuningLevelUsage` + median helper + tRPC read + both UI surfaces | S–M |
| 7 | Eval juror filter | `EvalWorker` slot filter by run level (D6) | S |
| 8 | Viewport prompt guidance | fan-out instruction line by level (D7) | S |

Suggested checkpoints: after phase 3 the feature is fully functional headless (MCP/tRPC); after
phase 5 it is user-visible end-to-end; 6–8 are polish/depth.

## 6. Testing

- Unit (phase-local, per the lane test policy): transform idempotence + schema-validity sweep;
  detection truth table (all 4 display states); migration 119; `createRun` stamp matrix
  (override/stamped/custom/variant); efficient-sprint `resolveRunFanOutInner` +
  `current_step` validation adaptation; median query fixture.
- `pnpm test:unit` + `typecheck` + `lint` as the settled-tree gate per phase commit.
- No `panels/claude` files change (`agentOverlayWriter` untouched) → itest suite not implicated,
  but run it once at the end anyway since prompts/fan-out-instructions is adjacent.
- Manual smoke (dev app): apply each level on sprint, verify badge/custom/reset; run an
  efficient sprint and confirm the lane rail shows the merged chain; wizard override run stamps
  `workflow_runs.tuning_level`; estimates line appears after ≥1 stamped run.

## 7. Risks / open questions

1. **Standard ≠ as-authored.** The Standard calibration deliberately changes models vs today's
   built-ins (e.g. code-review → opus). Users who never touch the dial keep as-authored behavior
   (NULL stamp); the moment they click Standard they opt into the calibration. Confirm this is
   the intended semantics vs "Standard = exactly today's defaults".
2. **Frozen implement-prompt copy (D5)** drifts from base-agent edits until re-applied. Mitigation
   documented; the `promptAddendum` field is the escape hatch if it bites.
3. **Orchestrated plane is advisory** for retries/optional-skips (prompt guidance, not mechanics) —
   levels are strictly enforced only on the programmatic plane. Acceptable: same asymmetry the
   editor's existing knobs already have.
4. **Estimate bucket pollution**: failed/interrupted runs drag the median down. Filter to
   completed runs; consider trimming later.
5. **Preset upgrades across app versions**: a shipped calibration change makes previously-applied
   levels read as CUSTOM (spec no longer matches the new preset). Options: version presets and
   treat "matches any known version of the stamped level" as non-custom, offering an "update to
   latest calibration" nudge — decide before phase 1 lands (affects `detectTuningState`'s shape).
6. **Launch wizard variant rotation × override** (D4's "force baseline") removes a run from
   rotation stats — acceptable since the user explicitly overrode, but Insights should exclude
   override runs from rotation experiment counts (they already will: no `rotation_experiment_id`).
