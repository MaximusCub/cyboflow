/**
 * runTypeOverrides — pure model behind Settings → AI → "Session settings" →
 * per-run-type overrides (the list of session types plus its detail screen).
 *
 * No React, no tRPC, no store access: a set of pure functions over
 * `config.runTypeDefaults` + the live workflow rows, so the two rules that are
 * easy to get wrong are assertable without mounting anything:
 *
 *   1. **The summary is a DIFF, not a restated config.** A chip renders only
 *      when a value is BOTH stored AND different from the global baseline that
 *      the launch surfaces would otherwise resolve. A row that stores a value
 *      equal to the baseline is still "Following defaults" — it changes nothing.
 *   2. **A stale key is inert, never pruned.** A `workflow:<id>` key whose
 *      workflow was renamed, archived, or deleted keeps rendering (labelled with
 *      its raw key). The Settings modal has no `projectId` and `workflows.list`
 *      is per-project + hides archived flows, so a "filter to live rows" step
 *      here would silently destroy a live default the moment a flow is archived.
 *
 * The baselines below are the SAME ones the launch surfaces resolve — see
 * `useQuickSession.startWithDefaults` (quick) and `useLaunchWorkflow.launch`
 * (flows). A baseline that drifts from those produces a chip for a value that is
 * not actually an override, which is exactly the "restated config" failure.
 */
import { MODEL_OPTIONS, modelDisplayLabel } from '../cyboflow/unified/ModelPill';
import { PERMISSION_MODE_OPTIONS } from '../cyboflow/AgentPermissionModeSelector';
import { DEFAULT_CODEX_MODEL } from '../cyboflow/ModelSelector';
import { isCodexModelFamily, isCodexModelSelection } from '../../../../shared/types/agentModels';
import {
  DEFAULT_SESSION_AGENT_RUNTIME,
  SESSION_AGENT_RUNTIMES,
  WORKFLOW_LAUNCHABLE_RUNTIMES,
  claudeRuntimeFromSubstrate,
  providerForRuntime,
  substrateForRuntime,
  type AgentRuntime,
} from '../../../../shared/types/agentRuntime';
import { isRuntimeSelectableInPickers } from '../../../../shared/types/agentCapabilities';
import { CLAUDE_EFFORT_LEVELS, type ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import {
  DEFAULT_RUN_TYPE_SUBSTRATE_FLOORS,
  isQuickRunTypeKey,
  QUICK_RUN_TYPE_KEY,
  resolveRunTypeLaunchDefaults,
  runTypeKindForKey,
  workflowRunTypeKey,
  type RunTypeDefaults,
  type RunTypeDefaultsPatch,
} from '../../../../shared/types/sessionDefaults';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import {
  CYBOFLOW_WORKFLOW_NAMES,
  isCyboflowWorkflowName,
  type PermissionMode,
} from '../../../../shared/types/workflows';
import {
  buildWorkflowMeta,
  type WorkflowListRow,
} from '../cyboflow/wizard/workflowMeta';
import type { AppConfig } from '../../types/config';

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Re-exported from `shared/types/sessionDefaults` — THE canonical key helpers
 * (also used by `resolveRunTypeLaunchDefaults`, the launch-time resolver).
 * This file used to define its own copies; keeping two definitions of "what a
 * quick key looks like" is exactly the drift `resolveRunTypeBaseline` below
 * guards against for the floors.
 */
export { QUICK_RUN_TYPE_KEY, workflowRunTypeKey, isQuickRunTypeKey };

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** Every `RunTypeDefaults` member this UI can edit, in display order. */
export type RunTypeFieldId = keyof RunTypeDefaults;

/**
 * Display order for chips and detail rows. `reasoningEffort` sits next to
 * `model` because they are one knob card ("Model & reasoning effort").
 */
export const RUN_TYPE_FIELD_ORDER: readonly RunTypeFieldId[] = [
  'model',
  'reasoningEffort',
  'substrate',
  'agentRuntime',
  'permissionMode',
];

export const RUN_TYPE_FIELD_LABELS: Record<RunTypeFieldId, string> = {
  model: 'Model',
  reasoningEffort: 'Reasoning effort',
  substrate: 'Substrate',
  agentRuntime: 'Agent runtime',
  permissionMode: 'Permission',
};

const SUBSTRATE_LABELS: Record<CliSubstrate, string> = {
  sdk: 'SDK',
  interactive: 'Interactive terminal',
};

/**
 * Local label map because `shared/types/agentRuntime` only exports
 * WORKFLOW_AGENT_RUNTIME_LABELS (the LAUNCHABLE subset) and the quick-session
 * key can legitimately store a PTY runtime. Kept in the same wording as that map
 * so the two read as one family.
 */
const AGENT_RUNTIME_LABELS: Record<AgentRuntime, string> = {
  'claude-sdk': 'Claude SDK',
  'claude-interactive': 'Claude interactive',
  'codex-sdk': 'Codex SDK',
  'codex-pty': 'Codex terminal',
  'codex-exec': 'Codex exec',
  // `omp-sdk` is offerable on BOTH key kinds now that it is launchable;
  // `omp-pty` stays quick-session-only, exactly as `codex-pty` does. The
  // fallback for a missing key is the raw runtime id, so every member is named.
  'omp-sdk': 'OMP',
  'omp-pty': 'OMP terminal',
};

/**
 * The runtimes offerable for a key — quick sessions may also use Codex PTY.
 *
 * Narrowed by `selectableInPickers` on top of the launch-kind set: a runtime can
 * be a legal SESSION runtime and still not be offerable, which is how a provider
 * declared ahead of its managers stays out of this picker without a second list
 * to keep in sync.
 */
export function agentRuntimeOptions(key: string): readonly AgentRuntime[] {
  const forKind = isQuickRunTypeKey(key) ? SESSION_AGENT_RUNTIMES : WORKFLOW_LAUNCHABLE_RUNTIMES;
  return forKind.filter((runtime) => isRuntimeSelectableInPickers(runtime));
}

/** The model aliases the picker offers (single-sourced with the composer pill). */
export const RUN_TYPE_MODEL_OPTIONS = MODEL_OPTIONS;

/**
 * Effort levels offered on the quick detail screen. Claude's scale: the quick
 * key's effort rides `claudeConfig.reasoningEffort` on the quick-session launch
 * (useQuickSession), which is the Claude spawn path.
 */
export const RUN_TYPE_EFFORT_OPTIONS = CLAUDE_EFFORT_LEVELS;

/** Human label for one stored field value. Falls back to the raw value. */
export function runTypeValueLabel(field: RunTypeFieldId, value: string): string {
  switch (field) {
    case 'model':
      return modelDisplayLabel(value);
    case 'substrate':
      return SUBSTRATE_LABELS[value as CliSubstrate] ?? value;
    case 'agentRuntime':
      return AGENT_RUNTIME_LABELS[value as AgentRuntime] ?? value;
    case 'permissionMode':
      return PERMISSION_MODE_OPTIONS.find((o) => o.id === value)?.label ?? value;
    case 'reasoningEffort':
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

/**
 * What a launch resolves for a key when NOTHING is stored for it. `reasoningEffort`
 * is deliberately absent: there is no global effort setting anywhere in config,
 * so "unset" is its own baseline and any stored value is an override.
 */
export interface RunTypeBaseline {
  model: string;
  substrate: CliSubstrate;
  agentRuntime: AgentRuntime;
  permissionMode: PermissionMode;
}

/**
 * Resolve the global baseline for one key by DELEGATING to
 * `resolveRunTypeLaunchDefaults` (shared/types/sessionDefaults.ts) — the same
 * function every launch seam calls. It used to restate that ladder field by
 * field, which is exactly how it drifted: it resolved `substrate` and
 * `agentRuntime` INDEPENDENTLY and returned `{ substrate: 'interactive',
 * agentRuntime: 'claude-sdk' }` for the quick key on a default install — a pair
 * no launch can honour, seeded straight into the detail screen's draft by
 * `toggleCard`. There is now exactly ONE implementation of "what does this key
 * resolve to".
 *
 * Two deliberate choices:
 *
 * 1. **`runTypeDefaults` is NOT passed.** A baseline is "what a launch resolves
 *    for this key when NOTHING is stored for it" — only the GLOBAL rungs. Feeding
 *    the stored entry back in would make every stored value equal its own
 *    baseline and every diff chip would vanish (rule 1 in the module doc).
 *    The globals passed here are the same ones the launch seams pass:
 *    `quickSessionDefaultSubstrate` for the quick key
 *    (useQuickSession.startWithDefaults), `defaultAgentPermissionMode`, and the
 *    two shared launch globals `defaultLaunchModel` / `defaultAgentRuntime`.
 *    The runtime is coerced to the key's own launch kind first
 *    (`agentRuntimeOptions`), because that is what the launch does: a global
 *    `codex-pty` is quick-session-only, so a FLOW key's launch drops it and
 *    lands on the workflow floor — and the baseline has to say so, or every
 *    flow row would show a phantom runtime chip.
 *
 * 2. **`agentRuntime` is projected from the resolved SUBSTRATE.** The resolver
 *    returns `undefined` for an unconfigured runtime on purpose — that omission
 *    is what keeps an unconfigured install's launch payload byte-identical — but
 *    a diff chip needs a concrete value to display as "the default". So the
 *    baseline fills the gap with `claudeRuntimeFromSubstrate(resolved.substrate)`:
 *    the runtime that OWNS the transport the launch actually resolved. That is
 *    the one direction that cannot contradict itself, and it keeps
 *    `RunTypeBaseline.agentRuntime` non-optional for its consumers
 *    (`effectiveRuntimeForDraft`, `coerceDraftForRuntime`, `toggleCard`).
 *
 *    This DOES change what an unconfigured quick key shows: `claude-interactive`
 *    (matching its `interactive` substrate baseline) rather than the old
 *    `DEFAULT_SESSION_AGENT_RUNTIME`. That is the fix, not a side effect — the
 *    old value was the contradictory half. A workflow key is unchanged
 *    (`sdk` ⇒ `claude-sdk` == `DEFAULT_WORKFLOW_AGENT_RUNTIME`).
 *
 *    When `defaultAgentRuntime` IS set the resolver returns it, so the gap
 *    never opens and the projection does not run. A Codex global therefore
 *    surfaces as the baseline runtime verbatim — exactly what the launch sends
 *    — while `substrate` stays on its floor, since a Codex runtime implies no
 *    Claude transport to move it to.
 */
export function resolveRunTypeBaseline(
  key: string,
  config: AppConfig | null | undefined,
): RunTypeBaseline {
  const quick = runTypeKindForKey(key) === 'quick';
  // Trimmed, blank ⇒ unset — the same normalization main's
  // configManager.getGlobalLaunchModel applies, so the chips describe the model
  // a launch would really resolve.
  const globalModel = config?.defaultLaunchModel?.trim() || undefined;
  // Coerced to this key's launch kind — `agentRuntimeOptions` is the same
  // per-kind set the detail screen offers, so a global the key cannot launch on
  // is dropped here exactly as the launch seam drops it.
  const globalRuntime = config?.defaultAgentRuntime;
  const usableRuntime =
    globalRuntime !== undefined && agentRuntimeOptions(key).includes(globalRuntime)
      ? globalRuntime
      : undefined;
  const resolved = resolveRunTypeLaunchDefaults(key, undefined, {
    model: globalModel,
    permissionMode: config?.defaultAgentPermissionMode,
    agentRuntime: usableRuntime,
    substrate: quick
      ? (config?.quickSessionDefaultSubstrate ?? DEFAULT_RUN_TYPE_SUBSTRATE_FLOORS.quick)
      : DEFAULT_RUN_TYPE_SUBSTRATE_FLOORS.workflow,
  });
  return {
    model: resolved.model,
    substrate: resolved.substrate,
    agentRuntime: resolved.agentRuntime ?? claudeRuntimeFromSubstrate(resolved.substrate),
    permissionMode: resolved.permissionMode,
  };
}

/** The baseline value for one field, or null when the field has no baseline. */
export function baselineValueFor(
  field: RunTypeFieldId,
  baseline: RunTypeBaseline,
): string | null {
  return field === 'reasoningEffort' ? null : baseline[field];
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** One "this differs from the global default" chip. */
export interface RunTypeOverrideChip {
  field: RunTypeFieldId;
  /** Field name, e.g. "Model". */
  label: string;
  /** Display value of the stored override. */
  value: string;
  /** Display value of the baseline it differs from; null when there is none. */
  baseline: string | null;
}

/**
 * The chips for one row: stored fields that actually DIFFER from the baseline.
 * A stored value equal to the baseline yields no chip — the summary must read as
 * a diff, not a restated config.
 */
export function runTypeOverrideChips(
  stored: RunTypeDefaults | undefined,
  baseline: RunTypeBaseline,
): RunTypeOverrideChip[] {
  if (stored === undefined) return [];
  const chips: RunTypeOverrideChip[] = [];
  for (const field of RUN_TYPE_FIELD_ORDER) {
    const value = stored[field];
    if (value === undefined) continue;
    const base = baselineValueFor(field, baseline);
    if (base !== null && base === value) continue;
    chips.push({
      field,
      label: RUN_TYPE_FIELD_LABELS[field],
      value: runTypeValueLabel(field, value),
      baseline: base === null ? null : runTypeValueLabel(field, base),
    });
  }
  return chips;
}

/** `Following defaults` / `N override(s)` — driven by the DIFF, not the key size. */
export function runTypeStatusLabel(chipCount: number): string {
  if (chipCount === 0) return 'Following defaults';
  return chipCount === 1 ? '1 override' : `${chipCount} overrides`;
}

// ---------------------------------------------------------------------------
// Rows + groups
// ---------------------------------------------------------------------------

/** A live workflow row plus the owning project name (workflowsStore's shape). */
export interface RunTypeWorkflowSource {
  row: WorkflowListRow;
  /** `''` for a GLOBAL flow (project_id null) — those group ungrouped. */
  projectName: string;
}

export interface RunTypeRow {
  /** `runTypeDefaults` key: `quick` or `workflow:<id>`. */
  key: string;
  /** Display name; the RAW key for a stale entry whose workflow no longer resolves. */
  label: string;
  /** One-line description; `''` when unknown. */
  sublabel: string;
  /** True when the key has no matching live workflow row (kept, never pruned). */
  stale: boolean;
}

export interface RunTypeGroup {
  id: string;
  title: string;
  rows: RunTypeRow[];
}

/** Canonical ordering for the built-ins (planner → sprint → compound → ship → verify-setup). */
function builtInOrder(name: string): number {
  const index = (CYBOFLOW_WORKFLOW_NAMES as readonly string[]).indexOf(name);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Build the grouped session-type list.
 *
 * Groups, in order: **Built-in flows** · **Quick sessions** (one synthetic row)
 * · **Custom flows** (global) · one group per project for project-scoped custom
 * flows · **Unmatched saved defaults** (stale keys).
 *
 * `verify-setup` is listed under Built-in flows even though the launch wizard
 * hides it (`SETUP_WORKFLOW_NAMES`): its runs read `runTypeDefaults` exactly
 * like any other flow, so omitting it here would leave a stored default with no
 * way to see or clear it. `hiddenFromLauncher` governs the LAUNCHER, not this
 * settings inventory.
 *
 * Stale keys are appended, never dropped — see the module doc.
 */
export function buildRunTypeGroups(
  workflows: readonly RunTypeWorkflowSource[],
  storedKeys: readonly string[],
): RunTypeGroup[] {
  const metas = buildWorkflowMeta(workflows.map((w) => w.row), []);
  const projectNameById = new Map<string, string>();
  for (const w of workflows) projectNameById.set(w.row.id, w.projectName);

  const builtIn: RunTypeRow[] = [];
  const globalCustom: RunTypeRow[] = [];
  const byProject = new Map<string, RunTypeRow[]>();
  const liveKeys = new Set<string>();

  const ordered = [...metas].sort((a, b) => builtInOrder(a.name) - builtInOrder(b.name));
  for (const meta of ordered) {
    const key = workflowRunTypeKey(meta.id);
    liveKeys.add(key);
    const row: RunTypeRow = {
      key,
      label: meta.title,
      sublabel: meta.subtitle,
      stale: false,
    };
    if (isCyboflowWorkflowName(meta.name)) {
      builtIn.push(row);
      continue;
    }
    const projectName = projectNameById.get(meta.id) ?? '';
    if (projectName === '') {
      globalCustom.push(row);
      continue;
    }
    const bucket = byProject.get(projectName);
    if (bucket === undefined) byProject.set(projectName, [row]);
    else bucket.push(row);
  }

  const stale: RunTypeRow[] = storedKeys
    .filter((key) => !isQuickRunTypeKey(key) && !liveKeys.has(key))
    .sort()
    .map((key) => ({
      key,
      // The id no longer resolves to a live row, so the raw key IS the label.
      label: key,
      sublabel: 'No matching flow in the current project list',
      stale: true,
    }));

  const groups: RunTypeGroup[] = [];
  if (builtIn.length > 0) groups.push({ id: 'built-in', title: 'Built-in flows', rows: builtIn });
  groups.push({
    id: 'quick',
    title: 'Quick sessions',
    rows: [
      {
        key: QUICK_RUN_TYPE_KEY,
        label: 'Quick session',
        sublabel: 'Ad-hoc session started outside a flow',
        stale: false,
      },
    ],
  });
  if (globalCustom.length > 0) {
    groups.push({ id: 'custom', title: 'Custom flows', rows: globalCustom });
  }
  for (const projectName of [...byProject.keys()].sort()) {
    groups.push({
      id: `custom-${projectName}`,
      title: `Custom flows · ${projectName}`,
      rows: byProject.get(projectName) ?? [],
    });
  }
  if (stale.length > 0) {
    groups.push({ id: 'stale', title: 'Unmatched saved defaults', rows: stale });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Draft ⇄ patch
// ---------------------------------------------------------------------------

/**
 * The detail screen's editable draft: `null` means "follow the global default"
 * (i.e. delete this member on save), a value means "override with this".
 */
export interface RunTypeDraft {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  substrate: CliSubstrate | null;
  agentRuntime: AgentRuntime | null;
  permissionMode: PermissionMode | null;
}

export function draftFromStored(stored: RunTypeDefaults | undefined): RunTypeDraft {
  return {
    model: stored?.model ?? null,
    reasoningEffort: stored?.reasoningEffort ?? null,
    substrate: stored?.substrate ?? null,
    agentRuntime: stored?.agentRuntime ?? null,
    permissionMode: stored?.permissionMode ?? null,
  };
}

/**
 * The `merge` patch for a draft. EVERY member is sent — a cleared field goes as
 * an explicit `null` so ConfigManager deletes it, and a draft with all five
 * nulls merges the key to empty, which deletes the key outright (pinned by
 * `configManagerRunTypeDefaults.test.ts`). `reasoningEffort` is sent as `null`
 * for a non-quick key too, so a stale effort left under a flow key is pruned
 * rather than silently kept alive by an omitted member.
 */
export function patchFromDraft(draft: RunTypeDraft): RunTypeDefaultsPatch {
  return {
    model: draft.model,
    reasoningEffort: draft.reasoningEffort,
    substrate: draft.substrate,
    agentRuntime: draft.agentRuntime,
    permissionMode: draft.permissionMode,
  };
}

// ---------------------------------------------------------------------------
// Runtime-family coercion
// ---------------------------------------------------------------------------

/**
 * The runtime a draft would actually launch on: its own `agentRuntime`
 * override, or — when the runtime card is off — the baseline it falls through
 * to. EVERY family decision below (which models are offerable, which substrate
 * a pick may imply) is taken against THIS, not against `draft.agentRuntime`,
 * because an absent member still resolves to a concrete runtime at launch.
 */
export function effectiveRuntimeForDraft(
  draft: RunTypeDraft,
  baseline: RunTypeBaseline,
): AgentRuntime {
  return draft.agentRuntime ?? baseline.agentRuntime;
}

/** True when the draft would launch on the Codex provider. */
export function draftUsesCodexRuntime(
  draft: RunTypeDraft,
  baseline: RunTypeBaseline,
): boolean {
  return providerForRuntime(effectiveRuntimeForDraft(draft, baseline)) === 'codex';
}

/**
 * The same-family projection of one model value for `runtime`.
 *
 * `null` means "follow defaults", which is only expressible on the CLAUDE side:
 * an omitted `model` member resolves to the (always-Claude) floor at launch, so
 * under a Codex runtime "follow defaults" IS the cross-family combination — it
 * is replaced with the explicit Codex sentinel instead. This mirrors
 * `ModelSelector`, whose `allowDefaultOption` is likewise Claude-path only.
 *
 * `fallbackModel` is what a Codex value degrades to on a Claude runtime (and
 * what a `null` degrades FROM on a Codex one). It is deliberately the bare model
 * string rather than a `RunTypeBaseline`: this function only ever read
 * `baseline.model`, and the GLOBAL rung (Settings → "Default Launch Model") has
 * no baseline above it — only the hardcoded floor — yet must enforce exactly
 * this invariant. Taking the fallback directly is what lets both rungs share ONE
 * coercion instead of growing a second near-identical copy.
 */
export function coerceModelForRuntime(
  model: string | null,
  runtime: AgentRuntime,
  fallbackModel: string,
): string | null {
  if (providerForRuntime(runtime) === 'codex') {
    const effective = model ?? fallbackModel;
    return isCodexModelSelection(effective) ? effective : DEFAULT_CODEX_MODEL;
  }
  if (model === null) return null;
  return isCodexModelFamily(model) ? fallbackModel : model;
}

/**
 * Apply the SAME runtime-family coercion the launch surfaces already apply on
 * a runtime flip (`WorkflowPicker.tsx` / `wizard/SessionStartWizard.tsx`'s
 * reseed-on-runtime-change effects): picking a concrete `agentRuntime` must
 * never leave the draft able to SAVE a cross-family combination — a Claude
 * model paired with a Codex runtime (or vice versa) cannot launch, and
 * neither can a `substrate` value that no longer matches the new runtime's
 * transport.
 *
 * This is ONE of three entry points, and the invariant only holds because all
 * three coerce: {@link coerceDraftForModel} (model edited last) and
 * {@link coerceDraftForSubstrate} (substrate edited last) close the reverse
 * edit orders. Coercing here alone left `{ agentRuntime: 'codex-sdk', model:
 * 'opus' }` reachable by picking the runtime first and the model second.
 *
 *   - `model` is COERCED, not just cleared: the EFFECTIVE model (the draft's
 *     own override, or — if the model card is off — the baseline it would
 *     otherwise fall through to) is replaced with a same-family value once it
 *     is not one already. This closes the hole even when the model card was
 *     never switched on: an omitted model member still resolves to the
 *     (always-Claude) baseline floor at launch, so leaving it alone would
 *     reproduce the exact bug for a runtime-only override.
 *   - `substrate` is CLEARED (not re-synced to match) once it no longer
 *     agrees with the new runtime's implied transport — a Codex runtime has
 *     no substrate of its own to clear TO, and for a Claude runtime the
 *     cleared member re-derives from the runtime at launch
 *     (`resolveRunTypeLaunchDefaults` treats a resolved runtime as OWNING its
 *     implied substrate).
 */
export function coerceDraftForRuntime(
  draft: RunTypeDraft,
  runtime: AgentRuntime,
  baseline: RunTypeBaseline,
): RunTypeDraft {
  const next: RunTypeDraft = { ...draft, agentRuntime: runtime };

  next.model = coerceModelForRuntime(draft.model, runtime, baseline.model);

  const impliedSubstrate = substrateForRuntime(runtime);
  if (next.substrate !== null && next.substrate !== impliedSubstrate) {
    next.substrate = null;
  }

  return next;
}

/**
 * The model edit path — the reverse of {@link coerceDraftForRuntime}. A value
 * from another family (a stale draft, a restored row, a picker that has not
 * caught up with the runtime yet) never survives into the draft, so it can
 * never reach the saved patch either.
 */
export function coerceDraftForModel(
  draft: RunTypeDraft,
  model: string | null,
  baseline: RunTypeBaseline,
): RunTypeDraft {
  return {
    ...draft,
    model: coerceModelForRuntime(model, effectiveRuntimeForDraft(draft, baseline), baseline.model),
  };
}

/**
 * The substrate edit path. A stored substrate BEATS the runtime's implied one
 * at launch (`resolveRunTypeLaunchDefaults`: `stored?.substrate ??
 * impliedSubstrate ?? …`), so a substrate that disagrees with an explicitly
 * chosen runtime is a savable contradiction, not merely odd:
 *
 *   - No runtime override in the draft ⇒ the substrate is a free-standing
 *     override (it contradicts nothing this key chose) and is taken as picked.
 *   - A CLAUDE runtime override ⇒ the pair must agree, so the RUNTIME moves to
 *     the one that owns the picked transport (`claudeRuntimeFromSubstrate`)
 *     rather than the pick being silently dropped.
 *   - A CODEX runtime override ⇒ there is no substrate to agree with
 *     (`substrateForRuntime` → null), so the member is cleared.
 */
export function coerceDraftForSubstrate(
  draft: RunTypeDraft,
  substrate: CliSubstrate | null,
): RunTypeDraft {
  if (substrate === null) return { ...draft, substrate: null };

  const runtime = draft.agentRuntime;
  if (runtime === null) return { ...draft, substrate };

  const implied = substrateForRuntime(runtime);
  if (implied === null) return { ...draft, substrate: null };
  if (implied === substrate) return { ...draft, substrate };
  return { ...draft, substrate, agentRuntime: claudeRuntimeFromSubstrate(substrate) };
}

// ---------------------------------------------------------------------------
// The GLOBAL rung — Settings → "Default Launch Model" / "Default Agent Runtime"
// ---------------------------------------------------------------------------

/**
 * The global model field's "absent" marker. `SessionSettings` holds the field as
 * a plain string with `''` meaning "Built-in default", and `Settings.tsx`'s save
 * maps that back to `undefined` so config.json stays free of the key.
 */
const GLOBAL_MODEL_UNSET = '';

/**
 * The runtime the GLOBAL rung would actually launch on. A global left on
 * "Built-in default" is NOT family-neutral: each launch kind then falls through
 * to its own floor, and every floor is a Claude runtime — so an unset global
 * scopes the model controls to Claude exactly as a Claude global does. Only the
 * FAMILY of the returned runtime is ever read.
 */
function effectiveGlobalRuntime(runtime: AgentRuntime | undefined): AgentRuntime {
  return runtime ?? DEFAULT_SESSION_AGENT_RUNTIME;
}

/** True when the global rung would launch on the Codex provider. */
export function globalRuntimeUsesCodex(runtime: AgentRuntime | undefined): boolean {
  return providerForRuntime(effectiveGlobalRuntime(runtime)) === 'codex';
}

/**
 * The global rung's model coercion — the SAME invariant the per-type editor
 * enforces ({@link coerceDraftForRuntime} / {@link coerceDraftForModel}),
 * through the SAME {@link coerceModelForRuntime}, expressed in the global
 * field's `''`-means-absent vocabulary. The global rung feeds every launch that
 * has no per-type override, so a cross-family pair stored here is the widest
 * version of the combination the detail screen already refuses.
 *
 * There is no baseline above a global — only the hardcoded floor — so the
 * fallback IS "absent": a Codex model under a Claude runtime clears back to
 * "Built-in default" rather than inventing a Claude alias the user never picked.
 *
 * ABSENT IS NEVER COERCED. `''` stays `''` under a Codex runtime too, even
 * though an unset model resolves to the (Claude) floor at launch: turning a
 * cleared field into a concrete value would make "Built-in default" impossible
 * to select, and clearing a setting must stay a clear. Only a CONCRETE
 * cross-family value is rewritten. (That is the one place this rung diverges
 * from `coerceModelForRuntime`'s `null` branch, whose null means "this KEY
 * stores no model" — a key that still has a global above it to fall through to.)
 */
export function coerceGlobalLaunchModel(
  model: string,
  runtime: AgentRuntime | undefined,
): string {
  if (model === GLOBAL_MODEL_UNSET) return model;
  return (
    coerceModelForRuntime(model, effectiveGlobalRuntime(runtime), GLOBAL_MODEL_UNSET) ??
    GLOBAL_MODEL_UNSET
  );
}
