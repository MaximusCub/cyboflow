import type { AgentRuntime } from './agentRuntime';
import type { ReasoningEffort } from './reasoningEffort';
import type { CliSubstrate } from './substrate';
import { DEFAULT_SUBSTRATE } from './substrate';
import type { PermissionMode } from './workflows';

/** Sparse defaults for one launch kind. */
export interface RunTypeDefaults {
  model?: string;
  permissionMode?: PermissionMode;
  substrate?: CliSubstrate;
  agentRuntime?: AgentRuntime;
  /** v1 writes this only under the synthetic global `quick` key. */
  reasoningEffort?: ReasoningEffort;
}

export type RunTypeDefaultsPatch = {
  [K in keyof RunTypeDefaults]?: RunTypeDefaults[K] | null;
};

export type RunTypeDefaultsOp =
  | { kind: 'merge'; value: RunTypeDefaultsPatch }
  | { kind: 'replace'; value: RunTypeDefaults | null };

export const DEFAULT_WORKFLOW_MODEL = 'opus';
export const DEFAULT_QUICK_MODEL = 'opus';

/**
 * Shared floors for DEFAULT_WORKFLOW_MODEL and DEFAULT_QUICK_MODEL in
 * frontend/src/components/cyboflow/ModelSelector.tsx. The renderer re-exports
 * these values, so main and frontend cannot drift or fall back to defaultModel.
 */
export const DEFAULT_RUN_TYPE_MODEL_FLOORS = {
  workflow: DEFAULT_WORKFLOW_MODEL,
  quick: DEFAULT_QUICK_MODEL,
} as const;

/**
 * Substrate floors, mirroring DEFAULT_RUN_TYPE_MODEL_FLOORS. A workflow run
 * floors to the SDK substrate; a quick session floors to the interactive REPL
 * (the floor every quick launch surface already applies behind
 * `config.quickSessionDefaultSubstrate`).
 */
export const DEFAULT_QUICK_SUBSTRATE: CliSubstrate = 'interactive';

export const DEFAULT_RUN_TYPE_SUBSTRATE_FLOORS = {
  workflow: DEFAULT_SUBSTRATE,
  quick: DEFAULT_QUICK_SUBSTRATE,
} as const;

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/** The synthetic key every quick-session launch resolves its defaults under. */
export const QUICK_RUN_TYPE_KEY = 'quick';

/** The run-type key for a workflow id. The ONLY sanctioned way to build one. */
export function workflowRunTypeKey(workflowId: string): string {
  return `workflow:${workflowId}`;
}

export function isQuickRunTypeKey(key: string): boolean {
  return key === QUICK_RUN_TYPE_KEY;
}

/** Which floor table a key indexes into. Anything not `'quick'` is a workflow. */
export type RunTypeKind = 'workflow' | 'quick';

export function runTypeKindForKey(key: string): RunTypeKind {
  return isQuickRunTypeKey(key) ? 'quick' : 'workflow';
}

/**
 * The middle rung of the ladder: the caller's GLOBAL config defaults, already
 * read off `AppConfig`. Passed in (rather than imported) so this resolver stays
 * pure — no store, no React, no IPC — and is usable from main as well as the
 * renderer. Every member is optional; an absent member falls through to the
 * hardcoded floor.
 */
export interface RunTypeLaunchGlobals {
  model?: string;
  permissionMode?: PermissionMode;
  substrate?: CliSubstrate;
  agentRuntime?: AgentRuntime;
  reasoningEffort?: ReasoningEffort;
}

/**
 * What a launch seam should actually send. `agentRuntime` and `reasoningEffort`
 * stay possibly-undefined: there is no floor for them, and a launch that
 * resolves them to undefined must OMIT them from its payload rather than send a
 * synthesized value (that is what keeps an unconfigured install byte-identical).
 */
export interface ResolvedRunTypeLaunchDefaults {
  model: string;
  permissionMode: PermissionMode;
  substrate: CliSubstrate;
  agentRuntime: AgentRuntime | undefined;
  reasoningEffort: ReasoningEffort | undefined;
}

/**
 * THE canonical resolution of a run-type key into launch defaults. Every launch
 * seam (quick session, in-session workflow launch, backlog run, sprint batch)
 * goes through this one function so the precedence ladder cannot drift:
 *
 *   per-type stored value → the matching global config default → the floor
 *
 * The model floor is chosen BY KEY KIND (`DEFAULT_QUICK_MODEL` for the quick
 * key, `DEFAULT_WORKFLOW_MODEL` for a `workflow:<id>` key), so a caller cannot
 * express the "quick floor on a workflow key" mismatch that used to be written
 * out by hand at each seam.
 *
 * `reasoningEffort` is QUICK-ONLY: v1 writes it only under the quick key, so a
 * workflow key always resolves it to undefined — even if a stale row carries
 * one.
 *
 * `agentRuntime` is returned VERBATIM (no per-kind validity check). A workflow
 * seam must still run it through `workflowRuntimeForLaunch` and drop it when
 * that returns null; this file cannot import the renderer's UI helper.
 */
export function resolveRunTypeLaunchDefaults(
  key: string,
  runTypeDefaults: Record<string, RunTypeDefaults> | undefined,
  globals?: RunTypeLaunchGlobals,
): ResolvedRunTypeLaunchDefaults {
  const kind = runTypeKindForKey(key);
  const stored = runTypeDefaults?.[key];
  return {
    model: stored?.model ?? globals?.model ?? DEFAULT_RUN_TYPE_MODEL_FLOORS[kind],
    permissionMode: stored?.permissionMode ?? globals?.permissionMode ?? DEFAULT_PERMISSION_MODE,
    substrate: stored?.substrate ?? globals?.substrate ?? DEFAULT_RUN_TYPE_SUBSTRATE_FLOORS[kind],
    agentRuntime: stored?.agentRuntime ?? globals?.agentRuntime,
    reasoningEffort:
      kind === 'quick' ? (stored?.reasoningEffort ?? globals?.reasoningEffort) : undefined,
  };
}
