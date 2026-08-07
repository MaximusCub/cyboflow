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
import {
  DEFAULT_SESSION_AGENT_RUNTIME,
  DEFAULT_WORKFLOW_AGENT_RUNTIME,
  SESSION_AGENT_RUNTIMES,
  WORKFLOW_AGENT_RUNTIMES,
  type AgentRuntime,
} from '../../../../shared/types/agentRuntime';
import { CLAUDE_EFFORT_LEVELS, type ReasoningEffort } from '../../../../shared/types/reasoningEffort';
import {
  DEFAULT_QUICK_MODEL,
  DEFAULT_WORKFLOW_MODEL,
  type RunTypeDefaults,
  type RunTypeDefaultsPatch,
} from '../../../../shared/types/sessionDefaults';
import { DEFAULT_SUBSTRATE, type CliSubstrate } from '../../../../shared/types/substrate';
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

/** The synthetic global key every quick session resolves its defaults under. */
export const QUICK_RUN_TYPE_KEY = 'quick';

/** The `runTypeDefaults` key for one workflow row id. */
export function workflowRunTypeKey(workflowId: string): string {
  return `workflow:${workflowId}`;
}

/** True for the synthetic quick-session key (the only key that carries effort). */
export function isQuickRunTypeKey(key: string): boolean {
  return key === QUICK_RUN_TYPE_KEY;
}

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
 * WORKFLOW_AGENT_RUNTIME_LABELS (three of the five runtimes) and the quick-
 * session key can legitimately store `codex-pty`. Kept in the same wording as
 * that map so the two read as one family.
 */
const AGENT_RUNTIME_LABELS: Record<AgentRuntime, string> = {
  'claude-sdk': 'Claude SDK',
  'claude-interactive': 'Claude interactive',
  'codex-sdk': 'Codex SDK',
  'codex-pty': 'Codex terminal',
  'codex-exec': 'Codex exec',
};

/** The runtimes offerable for a key — quick sessions may also use Codex PTY. */
export function agentRuntimeOptions(key: string): readonly AgentRuntime[] {
  return isQuickRunTypeKey(key) ? SESSION_AGENT_RUNTIMES : WORKFLOW_AGENT_RUNTIMES;
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
 * Resolve the global baseline for one key. Mirrors, field for field:
 *   - `model`        — the per-kind floor (`DEFAULT_QUICK_MODEL` /
 *                      `DEFAULT_WORKFLOW_MODEL`, both Opus). There is no global
 *                      launch-model config field; `configManager.getDefaultLaunchModel`
 *                      floors to these same constants and deliberately never
 *                      inherits the legacy `defaultModel`.
 *   - `substrate`    — quick: `quickSessionDefaultSubstrate ?? 'interactive'`
 *                      (useQuickSession.startWithDefaults); flows: DEFAULT_SUBSTRATE
 *                      ('sdk', useLaunchWorkflow).
 *   - `permissionMode` — `defaultAgentPermissionMode ?? 'default'` for both.
 *   - `agentRuntime` — the shared session / workflow runtime defaults.
 */
export function resolveRunTypeBaseline(
  key: string,
  config: AppConfig | null | undefined,
): RunTypeBaseline {
  const quick = isQuickRunTypeKey(key);
  return {
    model: quick ? DEFAULT_QUICK_MODEL : DEFAULT_WORKFLOW_MODEL,
    substrate: quick ? (config?.quickSessionDefaultSubstrate ?? 'interactive') : DEFAULT_SUBSTRATE,
    agentRuntime: quick ? DEFAULT_SESSION_AGENT_RUNTIME : DEFAULT_WORKFLOW_AGENT_RUNTIME,
    permissionMode: config?.defaultAgentPermissionMode ?? 'default',
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
