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
 * The levels that MAY be backed by a preset table entry. `custom` is excluded
 * by construction — it reads a stored definition, never a transform. `standard`
 * is included since the aligned-defaults decision (2026-08-26): on the
 * calibrated flows (sprint, planner) Standard pins the matrix's agreed default
 * models per agent — model/effort pins ONLY, no structural edits, and never
 * `evalDefault` (the jury stays exactly as shipped). Uncalibrated flows have no
 * `standard` entry and stay the as-authored identity.
 */
export type TuningPresetLevel = Exclude<TuningLevel, 'custom'>;

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
const SPRINT_PRESETS: Readonly<Partial<Record<TuningPresetLevel, TuningPreset>>> = {
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
  // The ALIGNED DEFAULTS (design matrix, Standard column) — model/effort pins
  // only. No structural edits, and no `evalDefault`: the 3-slot jury runs
  // exactly as shipped at Standard (overriding it is deliberately out of scope).
  standard: {
    agentConfigs: {
      'dependency-analyzer': { model: 'sonnet', effort: 'medium' },
      implement: { model: 'sonnet', effort: 'high' },
      'write-tests': { model: 'sonnet', effort: 'medium' },
      'code-review': { model: 'opus', effort: 'high' },
      'task-verify': { model: 'opus', effort: 'medium' },
      // Inert today (no subagent behind the visual-verify gate) — see the
      // matching note on the thorough pin.
      'visual-verify': { model: 'opus', effort: 'medium' },
      'sprint-verify': { model: 'opus', effort: 'high' },
      'sprint-review': { model: 'opus', effort: 'high' },
      'address-review': { model: 'opus', effort: 'high' },
    },
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
const PLANNER_PRESETS: Readonly<Partial<Record<TuningPresetLevel, TuningPreset>>> = {
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
  // The ALIGNED DEFAULTS (design matrix, Standard column) — pins only, jury
  // untouched. The matrix splits `context` across its two steps (stub at
  // medium, spec expansion at high); pins are per AGENT, so `high` — the
  // spec-expansion value, the step that does the real work — wins for both.
  standard: {
    agentConfigs: {
      context: { model: 'sonnet', effort: 'high' },
      'ui-prototype': { model: 'sonnet', effort: 'medium' },
      architecture: { model: 'opus', effort: 'medium' },
      'adversarial-review': { model: 'opus', effort: 'high' },
      epics: { model: 'sonnet', effort: 'medium' },
      tasks: { model: 'sonnet', effort: 'medium' },
    },
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
 * Ship — planner concatenated with sprint in one run, and its phase/step paths
 * mirror both parents exactly (planner's `refine/*`, sprint's
 * `execute/execute-tasks/inner/*`). Each level is therefore the UNION of the two
 * parent presets: pins, structural edits, and addenda transfer verbatim. The
 * agent-key sets are disjoint, so the union never conflicts. One planner piece
 * does NOT transfer: the efficient `decomposed-stories` re-home
 * (`outerStepPatches` on `refine/epics`) — ship's `tasks` step mints no artifact
 * (the approve-plan surface is orchestrator-templated), so there is nothing to
 * re-home.
 */
const SHIP_PRESETS: Readonly<Partial<Record<TuningPresetLevel, TuningPreset>>> = {
  efficient: {
    agentConfigs: {
      // Sprint side.
      'dependency-analyzer': { model: 'haiku', effort: 'low' },
      implement: { model: 'sonnet', effort: 'medium' },
      'task-verify': { model: 'sonnet', effort: 'low' },
      'sprint-verify': { model: 'haiku', effort: 'low' },
      'sprint-review': { model: 'sonnet', effort: 'high' },
      'address-review': { model: 'sonnet', effort: 'high' },
      // Planner side.
      context: { model: 'sonnet', effort: 'medium' },
      epics: { model: 'sonnet', effort: 'medium' },
    },
    removeSteps: [
      // Planner-efficient: drop the optional design track and merge task detail
      // into epic creation (ship.md carries the same "when `tasks` is absent"
      // merged-decomposition rule as planner.md).
      'refine/ui-prototype',
      'refine/architecture',
      'refine/adversarial-review',
      'refine/tasks',
      // Sprint-efficient: collapse the lane to implement → task-verify.
      'execute/execute-tasks/inner/write-tests',
      'execute/execute-tasks/inner/code-review',
      'execute/execute-tasks/inner/visual-verify',
    ],
    promptAddenda: {
      implement:
        'This tuning level runs a MERGED implementation lane — the separate write-tests and code-review lane steps are disabled. In the same turn as your diff you also author the unit tests covering it and run them TARGETED (only the test files that touch your change, never the full suite), and you self-review the diff for correctness and pattern compliance before you finish.',
      epics:
        'This tuning level runs a MERGED decomposition step — the separate "fill out task details" step is disabled. Alongside the epic breakdown, return the COMPLETE task list for every epic (title, body, and acceptance criteria per task) so the orchestrator can persist execution-ready tasks straight from your output.',
    },
    evalDefault: false,
  },
  // The aligned defaults — the sprint + planner Standard columns unioned. Pins
  // only, jury untouched.
  standard: {
    agentConfigs: {
      // Sprint side.
      'dependency-analyzer': { model: 'sonnet', effort: 'medium' },
      implement: { model: 'sonnet', effort: 'high' },
      'write-tests': { model: 'sonnet', effort: 'medium' },
      'code-review': { model: 'opus', effort: 'high' },
      'task-verify': { model: 'opus', effort: 'medium' },
      'visual-verify': { model: 'opus', effort: 'medium' },
      'sprint-verify': { model: 'opus', effort: 'high' },
      'sprint-review': { model: 'opus', effort: 'high' },
      'address-review': { model: 'opus', effort: 'high' },
      // Planner side.
      context: { model: 'sonnet', effort: 'high' },
      'ui-prototype': { model: 'sonnet', effort: 'medium' },
      architecture: { model: 'opus', effort: 'medium' },
      'adversarial-review': { model: 'opus', effort: 'high' },
      epics: { model: 'sonnet', effort: 'medium' },
      tasks: { model: 'sonnet', effort: 'medium' },
    },
  },
  thorough: {
    agentConfigs: {
      // Sprint side.
      'dependency-analyzer': { model: 'sonnet', effort: 'high' },
      implement: { model: 'opus', effort: 'high' },
      'write-tests': { model: 'sonnet', effort: 'high' },
      'code-review': { model: 'opus', effort: 'high' },
      'task-verify': { model: 'opus', effort: 'high' },
      'visual-verify': { model: 'opus', effort: 'high' },
      'sprint-verify': { model: 'opus', effort: 'high' },
      'sprint-review': { model: 'fable', effort: 'medium' },
      'address-review': { model: 'opus', effort: 'high' },
      // Planner side.
      context: { model: 'opus', effort: 'high' },
      'ui-prototype': { model: 'sonnet', effort: 'high' },
      architecture: { model: 'opus', effort: 'high' },
      'adversarial-review': { model: 'fable', effort: 'medium' },
      epics: { model: 'opus', effort: 'high' },
      tasks: { model: 'opus', effort: 'medium' },
    },
    // Planner-thorough: the whole design track always-on.
    outerStepPatches: {
      'refine/ui-prototype': { optional: false },
      'refine/architecture': { optional: false },
      'refine/adversarial-review': { optional: false },
      'refine/approve-design': { optional: false },
    },
  },
};

/**
 * Compound — three agent steps, three agents, so the tier can follow the work
 * instead of one pin covering the flow. `compound-load` is a read-only survey
 * (the cheapest thing here); `compounder` is the judgment-heavy core that sets
 * the flow's tier; `compound-writeback` applies edits the human already
 * approved, which needs care but no fresh judgment. Pins only: the five-step
 * propose → gate → apply → gate shape has nothing removable.
 *
 * `evalDefault: false` is a no-op here (compound is eval-EXEMPT by name in
 * `snapshotRunForEval`); kept uniform so the lever means the same thing on
 * every flow.
 */
const COMPOUND_PRESETS: Readonly<Partial<Record<TuningPresetLevel, TuningPreset>>> = {
  efficient: {
    agentConfigs: {
      'compound-load': { model: 'haiku', effort: 'low' },
      compounder: { model: 'sonnet', effort: 'medium' },
      'compound-writeback': { model: 'sonnet', effort: 'medium' },
    },
    evalDefault: false,
  },
  standard: {
    agentConfigs: {
      'compound-load': { model: 'sonnet', effort: 'low' },
      compounder: { model: 'opus', effort: 'medium' },
      'compound-writeback': { model: 'sonnet', effort: 'medium' },
    },
  },
  thorough: {
    agentConfigs: {
      'compound-load': { model: 'sonnet', effort: 'medium' },
      compounder: { model: 'opus', effort: 'high' },
      'compound-writeback': { model: 'opus', effort: 'medium' },
    },
  },
};

/**
 * Launch — pins only, no structural edits: launch.md hard-codes its step list in
 * prose and (unlike planner/ship) carries no "absent from the appended list"
 * rule, so a `removeSteps` here would hand the orchestrator contradictory
 * instructions (plan D9). The planner-shared agents mirror the planner matrix;
 * `interview` (the interview / project-brief / ideas steps) tracks `context`'s
 * tier — the same probe-and-synthesize work at project scope.
 */
const LAUNCH_PRESETS: Readonly<Partial<Record<TuningPresetLevel, TuningPreset>>> = {
  efficient: {
    agentConfigs: {
      interview: { model: 'sonnet', effort: 'medium' },
      context: { model: 'sonnet', effort: 'medium' },
      'ui-prototype': { model: 'sonnet', effort: 'medium' },
      architecture: { model: 'sonnet', effort: 'medium' },
      'adversarial-review': { model: 'sonnet', effort: 'medium' },
      epics: { model: 'sonnet', effort: 'medium' },
      tasks: { model: 'sonnet', effort: 'medium' },
    },
    evalDefault: false,
  },
  standard: {
    agentConfigs: {
      interview: { model: 'sonnet', effort: 'high' },
      context: { model: 'sonnet', effort: 'high' },
      'ui-prototype': { model: 'sonnet', effort: 'medium' },
      architecture: { model: 'opus', effort: 'medium' },
      'adversarial-review': { model: 'opus', effort: 'high' },
      epics: { model: 'sonnet', effort: 'medium' },
      tasks: { model: 'sonnet', effort: 'medium' },
    },
  },
  thorough: {
    agentConfigs: {
      interview: { model: 'opus', effort: 'high' },
      context: { model: 'opus', effort: 'high' },
      'ui-prototype': { model: 'sonnet', effort: 'high' },
      architecture: { model: 'opus', effort: 'high' },
      'adversarial-review': { model: 'fable', effort: 'medium' },
      epics: { model: 'opus', effort: 'high' },
      tasks: { model: 'opus', effort: 'medium' },
    },
  },
};

/**
 * Verify-setup — a single `verify-setup` agent drives inspect / derive / prove.
 * The prove step's diagnose-and-retry loop over real build/serve failures is the
 * hard part, which sets the tier. Pins only; eval-exempt like compound (the
 * `evalDefault: false` is the same uniform no-op).
 */
const VERIFY_SETUP_PRESETS: Readonly<Partial<Record<TuningPresetLevel, TuningPreset>>> = {
  efficient: {
    agentConfigs: { 'verify-setup': { model: 'sonnet', effort: 'medium' } },
    evalDefault: false,
  },
  standard: {
    agentConfigs: { 'verify-setup': { model: 'opus', effort: 'medium' } },
  },
  thorough: {
    agentConfigs: { 'verify-setup': { model: 'opus', effort: 'high' } },
  },
};

/** Every built-in flow's preset table, keyed by flow then level. */
export const TUNING_PRESETS: Readonly<
  Record<CyboflowWorkflowName, Readonly<Partial<Record<TuningPresetLevel, TuningPreset>>>>
> = {
  planner: PLANNER_PRESETS,
  sprint: SPRINT_PRESETS,
  compound: COMPOUND_PRESETS,
  ship: SHIP_PRESETS,
  'verify-setup': VERIFY_SETUP_PRESETS,
  launch: LAUNCH_PRESETS,
};

/**
 * The preset for a flow × level, or `undefined` when there is none — a
 * non-built-in flow, `custom` (reads the stored slot, never a transform), or
 * `standard` on a flow with no aligned-defaults entry (the identity; every
 * CURRENT built-in carries one, so today that arm only guards a future flow).
 *
 * Main-side callers read `evalDefault` through this. A `standard` preset never
 * carries `evalDefault` (jury as shipped), so the eval lever still resolves to
 * the enabled default there.
 */
export function getTuningPreset(flow: string, level: TuningLevel): TuningPreset | undefined {
  if (level === 'custom') return undefined;
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
 * contributes nothing, so a pinless preset's output is structurally identical
 * to the built-in.
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
 * `custom` is the identity: the returned definition is a structural clone that
 * deep-equals the input. (`custom` never reaches a preset — its definition comes
 * from the workflow's own slot, see {@link resolveEffectiveDefinition} — but
 * returning the identity here keeps the function total over the level union.)
 * `standard` applies the flow's aligned-defaults pins — every built-in carries
 * a standard preset now — and is the identity only for a flow without one.
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

/**
 * The RUN-side sibling of {@link resolveEffectiveDefinition}: the exact
 * `spec_json` TEXT a run should freeze for a flow at a level (plan D1's
 * "materialization happens once per run, at createRun").
 *
 * Two functions rather than one because the run side freezes a STRING, and which
 * string it freezes is load-bearing beyond the definition it parses to:
 *
 *   `standard` on a flow WITHOUT an aligned-defaults preset -> `'{}'`
 *     LITERALLY, never the workflow's slot. `'{}'` is the built-in-fallback
 *     sentinel every per-run reader already resolves through
 *     `resolveWorkflowDefinition`, so such a run's `spec_hash` is byte-identical
 *     to what an untouched flow has always stamped — no revision fork, no stats
 *     re-bucketing. (A flow whose slot holds a definition while the dial sits on
 *     `standard` deliberately freezes `'{}'` too: `standard` never reads the
 *     slot.) Every CURRENT built-in carries a standard preset, so this arm only
 *     guards a future uncalibrated flow; on a flow WITH one, `standard`
 *     materializes like any preset level — the aligned pins must reach the
 *     frozen spec or the run would not honour them.
 *   `custom`   -> the workflow's own slot — today's exact path.
 *   otherwise  -> the preset applied to the built-in, through the canonical
 *     {@link serializeDefinition}, so the same level on the same flow always
 *     hashes to the same revision whether it was persistent or a per-run override.
 *
 * A non-built-in flow has no baseline to transform; it always freezes its own
 * spec regardless of level (its runs stamp a NULL level — it is outside the
 * level system).
 */
export function materializeForLevel(
  name: string,
  specJson: string | null | undefined,
  level: TuningLevel,
): string {
  if (!isCyboflowWorkflowName(name)) return specJson ?? '{}';
  if (level === 'custom') return specJson ?? '{}';
  if (level === 'standard' && getTuningPreset(name, 'standard') === undefined) return '{}';
  return serializeDefinition(applyTuningPreset(WORKFLOW_DEFINITIONS[name], name, level));
}
