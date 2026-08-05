import type { AgentRuntime } from './agentRuntime';
import type { ReasoningEffort } from './reasoningEffort';
import type { CliSubstrate } from './substrate';
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
