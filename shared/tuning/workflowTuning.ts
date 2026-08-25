/**
 * Workflow tuning levels — the preset core.
 *
 * One dial per workflow: Efficient / Standard / Thorough / Custom. `standard`
 * is the IDENTITY (today's as-authored built-in behaviour, byte for byte) and
 * `custom` resolves the workflow's own `spec_json` slot; `efficient` and
 * `thorough` are named presets that bundle the editor's existing knobs
 * (per-agent model + reasoning-effort pins, optional-step toggles, per-step
 * retries, step removal) as a pure transform over the built-in definition.
 *
 * Levels are resolved at READ time, never materialized onto `workflows.spec_json`
 * — see `docs/plans/workflow-tuning-levels.md` D1. That is why this module is
 * SHARED: main and the renderer must agree on the effective definition
 * byte-for-byte, and `serializeDefinition` is the one serializer both hash.
 *
 * Keep this file free of Node built-ins, zod, and any main/ import — it is
 * consumed by both processes. Preset step ids are plain string DATA; the
 * colocated unit test asserts every one of them resolves against the real
 * built-in graph, so a renamed step trips the suite instead of silently
 * becoming a no-op.
 */

import type { AgentModelAlias } from '../types/agents';
import type { ReasoningEffort } from '../types/reasoningEffort';
import {
  WORKFLOW_DEFINITIONS,
  isCyboflowWorkflowName,
  resolveWorkflowDefinition,
  type CyboflowWorkflowName,
  type FanOutInnerStep,
  type WorkflowAgentConfig,
  type WorkflowDefinition,
  type WorkflowPhase,
  type WorkflowStep,
} from '../types/workflows';

// ─── Level vocabulary ────────────────────────────────────────────────────────

/**
 * The four selectable tuning levels, in display order.
 *
 * `standard` = as-authored built-in defaults (the identity transform).
 * `custom`   = the workflow's own Advanced-edited definition (`spec_json`).
 * `efficient` / `thorough` = the calibrated presets in this module.
 */
export const TUNING_LEVELS = ['efficient', 'standard', 'thorough', 'custom'] as const;

export type TuningLevel = (typeof TUNING_LEVELS)[number];

/** The default level for a workflow that has never been tuned. */
export const DEFAULT_TUNING_LEVEL: TuningLevel = 'standard';

/** Runtime guard for an untyped value (DB column, IPC payload) being a TuningLevel. */
export function isTuningLevel(value: unknown): value is TuningLevel {
  return typeof value === 'string' && (TUNING_LEVELS as readonly string[]).includes(value);
}

/**
 * The levels backed by a preset table. `standard` and `custom` are excluded by
 * construction: neither is a transform (one is the identity, the other reads a
 * stored definition), so neither can have a preset entry.
 */
export type TuningPresetLevel = Exclude<TuningLevel, 'standard' | 'custom'>;

// ─── Preset shape ────────────────────────────────────────────────────────────

/**
 * A per-agent model/effort pin. Deliberately narrower than
 * {@link WorkflowAgentConfig}: a preset may only tune WHICH model runs an agent
 * and HOW HARD it thinks. It must never carry `custom` (a full embedded prompt
 * copy REPLACES description/systemPrompt/tools/enabledMcps wholesale and would
 * silently erase a project's own hardened agent override) nor `runtime` /
 * `providerModel` (a preset is not a provider-routing decision).
 */
export interface TuningAgentPin {
  model?: AgentModelAlias;
  effort?: ReasoningEffort;
}

/**
 * One flow × level calibration.
 *
 * Step keys are `"<phaseId>/<stepId>"` for an outer step and
 * `"<phaseId>/<stepId>/inner/<innerId>"` for a fan-out inner step.
 *
 * `retries` is OUTER-step only: `FanOutInnerStep` has no retries field and lane
 * failures run under the global `FAN_OUT_LANE_ATTEMPT_CAP`, so inner patches may
 * set only `optional` / `name`.
 */
export interface TuningPreset {
  /** Per-agent-key pins merged into `definition.agentConfigs`. */
  agentConfigs: Record<string, TuningAgentPin>;
  /** Step keys to drop from the graph entirely. */
  removeSteps?: string[];
  /**
   * Field patches for outer steps, keyed `"<phaseId>/<stepId>"`. `outputArtifact`
   * is patchable so a preset that removes a step can re-home the artifact that
   * step minted (planner-efficient moves `decomposed-stories` onto `epics`).
   */
  outerStepPatches?: Record<
    string,
    Partial<Pick<WorkflowStep, 'retries' | 'optional' | 'name' | 'outputArtifact'>>
  >;
  /** Field patches for fan-out inner steps, keyed `"<phaseId>/<stepId>/inner/<innerId>"`. */
  innerStepPatches?: Record<string, Partial<Pick<FanOutInnerStep, 'optional' | 'name'>>>;
  /**
   * Per-agent-key prompt addendum written to `agentConfigs[key].promptAddendum`.
   * Consumed at run time by `resolveRunEffectiveAgents` (a later phase) — it is
   * APPENDED to whatever system prompt the builtin → project-override →
   * workflow-config → variant merge resolved, so it composes with a project's
   * own hardening instead of clobbering it.
   */
  promptAddenda?: Record<string, string>;
  /**
   * Default for `workflow_runs.eval_enabled` when the launch wizard did not
   * explicitly override it. The ONLY eval lever levels have — jury composition
   * is untouched at every level.
   */
  evalDefault?: boolean;
}

// ─── Preset tables ───────────────────────────────────────────────────────────

/**
 * Sprint. Agent keys resolved against the built-in graph:
 * `dependency-analyzer` (plan/analyze-dependencies), `implement` /
 * `write-tests` / `code-review` / `task-verify` / `visual-verify` (the
 * execute/execute-tasks fan-out inner chain), `sprint-verify` /
 * `sprint-review` / `address-review` (the verify phase).
 */
const SPRINT_PRESETS: Readonly<Record<TuningPresetLevel, TuningPreset>> = {
  efficient: {
    agentConfigs: {
      'dependency-analyzer': { model: 'haiku', effort: 'low' },
      implement: { model: 'sonnet', effort: 'medium' },
      'task-verify': { model: 'sonnet', effort: 'low' },
      'sprint-verify': { model: 'haiku', effort: 'low' },
      'sprint-review': { model: 'sonnet', effort: 'high' },
      'address-review': { model: 'sonnet', effort: 'high' },
    },
    // Collapse the five-stage lane to implement → task-verify. `task-verify`'s
    // `loopback: 'implement'` survives; the removed stages' work moves into the
    // implement turn via the addendum below.
    removeSteps: [
      'execute/execute-tasks/inner/write-tests',
      'execute/execute-tasks/inner/code-review',
      'execute/execute-tasks/inner/visual-verify',
    ],
    promptAddenda: {
      implement:
        'This tuning level runs a MERGED implementation lane — the separate write-tests and code-review lane steps are disabled. In the same turn as your diff you also author the unit tests covering it and run them TARGETED (only the test files that touch your change, never the full suite), and you self-review the diff for correctness and pattern compliance before you finish.',
    },
    evalDefault: false,
  },
  thorough: {
    agentConfigs: {
      'dependency-analyzer': { model: 'sonnet', effort: 'high' },
      implement: { model: 'opus', effort: 'high' },
      'write-tests': { model: 'sonnet', effort: 'high' },
      'code-review': { model: 'opus', effort: 'high' },
      'task-verify': { model: 'opus', effort: 'high' },
      // `visual-verify` is a firm gate with no subagent (the orchestrator fires
      // the verification request and parks the lane), so this pin is inert
      // today. Kept because the agent key is real and a future scriptable
      // visual-verify would honour it.
      'visual-verify': { model: 'opus', effort: 'high' },
      'sprint-verify': { model: 'opus', effort: 'high' },
      'sprint-review': { model: 'fable', effort: 'medium' },
      'address-review': { model: 'opus', effort: 'high' },
    },
    // DEFERRED: the design matrix also adds an "adversarial verify" lane step at
    // thorough. Not implemented — adding a step needs an agent bundle that does
    // not exist yet, so it is left out rather than pinned to a missing key.
  },
};

/**
 * Planner. Agent keys resolved against the built-in graph: `context`
 * (plan/context + refine/expand-spec), `ui-prototype` / `architecture` /
 * `adversarial-review` (the optional refine design steps), `epics`, `tasks`.
 *
 * The design matrix also lists a `research` pin — DROPPED: planner has no
 * research STEP (research is a subagent the `context` agent spins up on demand),
 * so there is no agent key to pin.
 */
const PLANNER_PRESETS: Readonly<Record<TuningPresetLevel, TuningPreset>> = {
  efficient: {
    agentConfigs: {
      context: { model: 'sonnet', effort: 'medium' },
      epics: { model: 'sonnet', effort: 'medium' },
      // The matrix also pins `tasks` — DROPPED here because this same preset
      // removes the step that binds it (see removeSteps), leaving the pin dead.
    },
    // Drop the optional design track, and merge task detail into epic creation.
    // `refine/approve-design` is deliberately KEPT: it is already optional and
    // self-skips when neither design step ran, so removing it would change the
    // gate vocabulary for no behavioural gain.
    removeSteps: [
      'refine/ui-prototype',
      'refine/architecture',
      'refine/adversarial-review',
      'refine/tasks',
    ],
    promptAddenda: {
      epics:
        'This tuning level runs a MERGED decomposition step — the separate "fill out task details" step is disabled. Alongside the epic breakdown, return the COMPLETE task list for every epic (title, body, and acceptance criteria per task) so the orchestrator can persist execution-ready tasks straight from your output.',
    },
    // The removed `refine/tasks` step minted the decomposed-stories artifact the
    // approve-plan gate reviews — re-home the mint onto the merged epics step.
    outerStepPatches: {
      'refine/epics': {
        outputArtifact: { atype: 'decomposed-stories', label: 'Decomposed stories' },
      },
    },
    evalDefault: false,
  },
  thorough: {
    agentConfigs: {
      context: { model: 'opus', effort: 'high' },
      epics: { model: 'opus', effort: 'high' },
      tasks: { model: 'opus', effort: 'medium' },
      'ui-prototype': { model: 'sonnet', effort: 'high' },
      architecture: { model: 'opus', effort: 'high' },
      'adversarial-review': { model: 'fable', effort: 'medium' },
    },
    // Make the whole design track always-on. `approve-design` joins them: with
    // both design steps guaranteed to run, its "skipped when neither ran"
    // escape no longer applies.
    outerStepPatches: {
      'refine/ui-prototype': { optional: false },
      'refine/architecture': { optional: false },
      'refine/adversarial-review': { optional: false },
      'refine/approve-design': { optional: false },
    },
  },
};

/**
 * The uncalibrated built-ins (launch, compound, ship, verify-setup): identity
 * plus the eval lever only. Per-flow calibration is future work — each needs its
 * own matrix before pins or structural edits can be justified.
 *
 * `evalDefault: false` is a no-op for compound and verify-setup (both are
 * eval-EXEMPT by name in `snapshotRunForEval`); it is kept uniform so the lever
 * means the same thing on every flow.
 */
const UNCALIBRATED_PRESETS: Readonly<Record<TuningPresetLevel, TuningPreset>> = {
  efficient: { agentConfigs: {}, evalDefault: false },
  thorough: { agentConfigs: {} },
};

/** Every built-in flow's preset table, keyed by flow then level. */
export const TUNING_PRESETS: Readonly<
  Record<CyboflowWorkflowName, Readonly<Record<TuningPresetLevel, TuningPreset>>>
> = {
  planner: PLANNER_PRESETS,
  sprint: SPRINT_PRESETS,
  compound: UNCALIBRATED_PRESETS,
  ship: UNCALIBRATED_PRESETS,
  'verify-setup': UNCALIBRATED_PRESETS,
  launch: UNCALIBRATED_PRESETS,
};

/**
 * The preset for a flow × level, or `undefined` when there is none — a
 * non-built-in flow, or the two levels that are not transforms (`standard` is
 * the identity, `custom` reads the stored slot).
 *
 * Main-side callers read `evalDefault` through this.
 */
export function getTuningPreset(flow: string, level: TuningLevel): TuningPreset | undefined {
  if (level === 'standard' || level === 'custom') return undefined;
  if (!isCyboflowWorkflowName(flow)) return undefined;
  return TUNING_PRESETS[flow][level];
}

// ─── Step-key addressing ─────────────────────────────────────────────────────

/** A parsed preset step key. `innerId` present ⇒ it addresses a fan-out inner step. */
interface ParsedStepKey {
  phaseId: string;
  stepId: string;
  innerId?: string;
}

/**
 * Parse `"<phaseId>/<stepId>"` or `"<phaseId>/<stepId>/inner/<innerId>"`.
 * Returns `null` for any other shape (including empty segments) so a malformed
 * key is inert rather than matching something unintended.
 */
function parseStepKey(key: string): ParsedStepKey | null {
  const parts = key.split('/');
  if (parts.some((part) => part.length === 0)) return null;
  if (parts.length === 2) return { phaseId: parts[0], stepId: parts[1] };
  if (parts.length === 4 && parts[2] === 'inner') {
    return { phaseId: parts[0], stepId: parts[1], innerId: parts[3] };
  }
  return null;
}

/**
 * Does `key` address a step that actually exists in `def`? The preset-table
 * test uses this to prove no calibration entry is a dangling id.
 */
export function definitionHasStepKey(def: WorkflowDefinition, key: string): boolean {
  const parsed = parseStepKey(key);
  if (parsed === null) return false;
  const phase = def.phases.find((candidate) => candidate.id === parsed.phaseId);
  const step = phase?.steps.find((candidate) => candidate.id === parsed.stepId);
  if (step === undefined) return false;
  if (parsed.innerId === undefined) return true;
  return step.fanOut?.inner.some((inner) => inner.id === parsed.innerId) ?? false;
}

/**
 * Every agent key `def` binds — outer steps and fan-out inner steps alike. The
 * same vocabulary `agentConfigs` is keyed by.
 */
export function definitionAgentKeys(def: WorkflowDefinition): Set<string> {
  const keys = new Set<string>();
  for (const phase of def.phases) {
    for (const step of phase.steps) {
      keys.add(step.agent);
      for (const inner of step.fanOut?.inner ?? []) keys.add(inner.agent);
    }
  }
  return keys;
}

// ─── Canonical serialization ─────────────────────────────────────────────────

/** Recursively rebuild `value` with object keys in sorted order; arrays keep their order. */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = withSortedKeys(source[key]);
    return sorted;
  }
  return value;
}

/**
 * THE canonical deterministic serializer for a `WorkflowDefinition`.
 *
 * Object keys are sorted recursively before stringify, so two structurally
 * identical definitions produce the same string regardless of the insertion
 * order their producers happened to use. Every caller that hashes a
 * materialized preset (`computeSpecHash`, revision recording, spec_hash
 * bucketing) MUST go through this — a definition that hashes differently on two
 * paths would split its own revision history.
 */
export function serializeDefinition(def: WorkflowDefinition): string {
  return JSON.stringify(withSortedKeys(def));
}

// ─── The transform ───────────────────────────────────────────────────────────

function cloneDefinition(def: WorkflowDefinition): WorkflowDefinition {
  return structuredClone(def);
}

/** Drop every step / inner step named in `removeSteps`, then repair what that orphaned. */
function removeSteps(def: WorkflowDefinition, keys: readonly string[]): void {
  const outerToRemove = new Map<string, Set<string>>();
  const innerToRemove = new Map<string, Set<string>>();

  for (const key of keys) {
    const parsed = parseStepKey(key);
    if (parsed === null) continue;
    if (parsed.innerId === undefined) {
      const phaseKey = parsed.phaseId;
      const set = outerToRemove.get(phaseKey) ?? new Set<string>();
      set.add(parsed.stepId);
      outerToRemove.set(phaseKey, set);
    } else {
      const stepKey = `${parsed.phaseId}/${parsed.stepId}`;
      const set = innerToRemove.get(stepKey) ?? new Set<string>();
      set.add(parsed.innerId);
      innerToRemove.set(stepKey, set);
    }
  }

  for (const phase of def.phases) {
    const removedHere = outerToRemove.get(phase.id);
    if (removedHere !== undefined) {
      phase.steps = phase.steps.filter((step) => !removedHere.has(step.id));
    }
    for (const step of phase.steps) {
      const removedInner = innerToRemove.get(`${phase.id}/${step.id}`);
      if (removedInner === undefined || step.fanOut === undefined) continue;
      step.fanOut.inner = step.fanOut.inner.filter((inner) => !removedInner.has(inner.id));
    }
  }

  // A phase emptied by removal is dropped whole — the Zod write-path schema
  // requires at least one step per phase, and an empty phase renders as a
  // meaningless header in the progress rail.
  def.phases = def.phases.filter((phase) => phase.steps.length > 0);

  pruneDanglingLoopbacks(def);
}

/**
 * Clear loopbacks whose target no longer exists. Removal can orphan a loopback,
 * and a dangling one is rejected by the write-path schema (and would send both
 * execution planes to a step that is not there).
 */
function pruneDanglingLoopbacks(def: WorkflowDefinition): void {
  for (const phase of def.phases) {
    const stepIds = new Set(phase.steps.map((step) => step.id));
    for (const step of phase.steps) {
      if (step.loopback !== undefined && !stepIds.has(step.loopback)) delete step.loopback;
      if (step.fanOut === undefined) continue;
      const innerIds = new Set(step.fanOut.inner.map((inner) => inner.id));
      for (const inner of step.fanOut.inner) {
        if (inner.loopback !== undefined && !innerIds.has(inner.loopback)) delete inner.loopback;
      }
    }
  }
}

function findOuterStep(def: WorkflowDefinition, parsed: ParsedStepKey): WorkflowStep | undefined {
  const phase: WorkflowPhase | undefined = def.phases.find(
    (candidate) => candidate.id === parsed.phaseId,
  );
  return phase?.steps.find((candidate) => candidate.id === parsed.stepId);
}

function applyOuterPatches(
  def: WorkflowDefinition,
  patches: Record<
    string,
    Partial<Pick<WorkflowStep, 'retries' | 'optional' | 'name' | 'outputArtifact'>>
  >,
): void {
  for (const [key, patch] of Object.entries(patches)) {
    const parsed = parseStepKey(key);
    if (parsed === null || parsed.innerId !== undefined) continue;
    const step = findOuterStep(def, parsed);
    if (step === undefined) continue;
    if (patch.retries !== undefined) step.retries = patch.retries;
    if (patch.optional !== undefined) step.optional = patch.optional;
    if (patch.name !== undefined) step.name = patch.name;
    if (patch.outputArtifact !== undefined) step.outputArtifact = patch.outputArtifact;
  }
}

function applyInnerPatches(
  def: WorkflowDefinition,
  patches: Record<string, Partial<Pick<FanOutInnerStep, 'optional' | 'name'>>>,
): void {
  for (const [key, patch] of Object.entries(patches)) {
    const parsed = parseStepKey(key);
    if (parsed === null || parsed.innerId === undefined) continue;
    const step = findOuterStep(def, parsed);
    const inner = step?.fanOut?.inner.find((candidate) => candidate.id === parsed.innerId);
    if (inner === undefined) continue;
    if (patch.optional !== undefined) inner.optional = patch.optional;
    if (patch.name !== undefined) inner.name = patch.name;
  }
}

/**
 * Merge the preset's pins and addenda into `def.agentConfigs`.
 *
 * A preset pin wins over an existing entry for the FIELDS IT SETS ONLY —
 * everything else on that entry (a `custom` copy, a `runtime` / `providerModel`
 * routing decision) is preserved. `agentConfigs` stays absent when the preset
 * contributes nothing, so an uncalibrated flow's output is structurally
 * identical to the built-in.
 */
function mergeAgentConfigs(def: WorkflowDefinition, preset: TuningPreset): void {
  const pins = Object.entries(preset.agentConfigs).filter(
    ([, pin]) => pin.model !== undefined || pin.effort !== undefined,
  );
  const addenda = Object.entries(preset.promptAddenda ?? {});
  if (pins.length === 0 && addenda.length === 0) return;

  const configs: Record<string, WorkflowAgentConfig> = { ...(def.agentConfigs ?? {}) };

  for (const [agentKey, pin] of pins) {
    const next: WorkflowAgentConfig = { ...(configs[agentKey] ?? {}) };
    if (pin.model !== undefined) next.model = pin.model;
    if (pin.effort !== undefined) next.effort = pin.effort;
    configs[agentKey] = next;
  }

  for (const [agentKey, addendum] of addenda) {
    configs[agentKey] = { ...(configs[agentKey] ?? {}), promptAddendum: addendum };
  }

  def.agentConfigs = configs;
}

/**
 * Apply a tuning level to a built-in definition. PURE — `builtin` is never
 * mutated; the result is always a fresh structure.
 *
 * `standard` and `custom` are the identity: the returned definition is a
 * structural clone that deep-equals the input. (`custom` never reaches a preset
 * — its definition comes from the workflow's own slot, see
 * {@link resolveEffectiveDefinition} — but returning the identity here keeps the
 * function total over the level union.)
 */
export function applyTuningPreset(
  builtin: WorkflowDefinition,
  flow: CyboflowWorkflowName,
  level: TuningLevel,
): WorkflowDefinition {
  const next = cloneDefinition(builtin);
  const preset = getTuningPreset(flow, level);
  if (preset === undefined) return next;

  if (preset.removeSteps !== undefined) removeSteps(next, preset.removeSteps);
  if (preset.outerStepPatches !== undefined) applyOuterPatches(next, preset.outerStepPatches);
  if (preset.innerStepPatches !== undefined) applyInnerPatches(next, preset.innerStepPatches);
  mergeAgentConfigs(next, preset);

  return next;
}

/**
 * The effective definition for a workflow at a level — the read-path entry
 * point every definition consumer routes through (D1).
 *
 *   custom          -> the workflow's own `spec_json` slot (today's exact path)
 *   any other level -> the preset applied to the built-in
 *
 * A non-built-in ("save as new") flow has no built-in baseline, so it always
 * resolves its own spec regardless of level — the tuning selector is hidden for
 * those flows. Returns `null` on the same condition `resolveWorkflowDefinition`
 * does: a custom flow whose spec is missing or unparseable.
 */
export function resolveEffectiveDefinition(
  name: string,
  specJson: string | null | undefined,
  level: TuningLevel,
): WorkflowDefinition | null {
  if (level !== 'custom' && isCyboflowWorkflowName(name)) {
    return applyTuningPreset(WORKFLOW_DEFINITIONS[name], name, level);
  }
  return resolveWorkflowDefinition(name, specJson);
}
