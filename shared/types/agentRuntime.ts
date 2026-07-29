/**
 * Provider/runtime selection for Cyboflow agent sessions and workflow runs.
 *
 * This is intentionally separate from the legacy Claude-only CliSubstrate
 * (`'sdk' | 'interactive'`). Provider answers "which agent family?" while
 * runtime answers "which transport for that family?".
 */

import type { CliSubstrate } from './substrate';

export type AgentProvider = 'claude' | 'codex';

export type AgentRuntime =
  | 'claude-sdk'
  | 'claude-interactive'
  | 'codex-sdk'
  | 'codex-pty'
  | 'codex-exec';

export type SessionAgentRuntime = Exclude<AgentRuntime, 'codex-exec'>;

export type WorkflowAgentRuntime = Exclude<AgentRuntime, 'codex-pty' | 'codex-exec'>;

export const DEFAULT_AGENT_PROVIDER: AgentProvider = 'claude';
export const DEFAULT_SESSION_AGENT_RUNTIME: SessionAgentRuntime = 'claude-sdk';
export const DEFAULT_WORKFLOW_AGENT_RUNTIME: WorkflowAgentRuntime = 'claude-sdk';

export const AGENT_PROVIDERS = ['claude', 'codex'] as const;

export const SESSION_AGENT_RUNTIMES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
  'codex-pty',
] as const;

export const WORKFLOW_AGENT_RUNTIMES = [
  'claude-sdk',
  'claude-interactive',
  'codex-sdk',
] as const;

/** Human labels for the workflow-scoped runtime picker. Single source shared by
 * the step inspector and the global Agents-pane editor. */
export const WORKFLOW_AGENT_RUNTIME_LABELS: Record<WorkflowAgentRuntime, string> = {
  'claude-sdk': 'Claude SDK',
  'claude-interactive': 'Claude interactive',
  'codex-sdk': 'Codex SDK',
};

export function isWorkflowRuntimeSupported(value: unknown): value is WorkflowAgentRuntime {
  return typeof value === 'string' && (WORKFLOW_AGENT_RUNTIMES as readonly string[]).includes(value);
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export function isSessionAgentRuntime(value: unknown): value is SessionAgentRuntime {
  return typeof value === 'string' && (SESSION_AGENT_RUNTIMES as readonly string[]).includes(value);
}

export function isWorkflowAgentRuntime(value: unknown): value is WorkflowAgentRuntime {
  return typeof value === 'string' && (WORKFLOW_AGENT_RUNTIMES as readonly string[]).includes(value);
}

export function claudeRuntimeFromSubstrate(
  substrate: CliSubstrate,
): Extract<WorkflowAgentRuntime, 'claude-sdk' | 'claude-interactive'> {
  return substrate === 'interactive' ? 'claude-interactive' : 'claude-sdk';
}

/** Derive the owning provider for an agent runtime. */
export function providerForRuntime(runtime: AgentRuntime): AgentProvider {
  return runtime.startsWith('codex-') ? 'codex' : 'claude';
}

/**
 * Per-provider access toggles — the user's answer to "may Cyboflow use this
 * agent account at all?", set in Settings → Integrations and in the onboarding
 * Connect step (both write the SAME `AppConfig.agentProviderAccess` field).
 *
 * An ABSENT member floors to ENABLED, so existing config.json files stay
 * byte-identical and every install that never touched the toggles behaves
 * exactly as before. A disabled provider is removed from every runtime picker
 * (SubstrateSelector / agent + variant editors) and rejected at the launch
 * seams (WorkflowRegistry.createRun, the quick-session IPC handler), so it can
 * never be reached by a stale payload or an MCP-written agent config.
 *
 * At least one provider must stay enabled — the Settings UI refuses to turn off
 * the last one, mirroring onboarding's "enable at least one detected provider"
 * gate. `resolveAgentProviderAccess` re-applies that floor defensively for any
 * value read back off disk.
 */
export type AgentProviderAccess = Partial<Record<AgentProvider, boolean>>;

/** True when `provider` may be used. Absent/unset ⇒ enabled (the floor). */
export function isAgentProviderEnabled(
  access: AgentProviderAccess | undefined,
  provider: AgentProvider,
): boolean {
  return access?.[provider] ?? true;
}

/** True when `runtime`'s owning provider may be used. */
export function isRuntimeProviderEnabled(
  access: AgentProviderAccess | undefined,
  runtime: AgentRuntime,
): boolean {
  return isAgentProviderEnabled(access, providerForRuntime(runtime));
}

/** The providers currently usable, in AGENT_PROVIDERS order. */
export function enabledAgentProviders(
  access: AgentProviderAccess | undefined,
): AgentProvider[] {
  return AGENT_PROVIDERS.filter((p) => isAgentProviderEnabled(access, p));
}

/**
 * Normalize a persisted/IPC value into an access map with the "never disable
 * everything" floor applied. An all-off map would leave the app unable to
 * launch anything, so it degrades to the default (both enabled) rather than
 * bricking every launch seam.
 */
export function resolveAgentProviderAccess(
  access: AgentProviderAccess | undefined,
): AgentProviderAccess {
  const resolved: AgentProviderAccess = {
    claude: isAgentProviderEnabled(access, 'claude'),
    codex: isAgentProviderEnabled(access, 'codex'),
  };
  if (!resolved.claude && !resolved.codex) return { claude: true, codex: true };
  return resolved;
}

/** Structural validator for the untyped IPC config patch. */
export function isAgentProviderAccess(value: unknown): value is AgentProviderAccess {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, member]) =>
      isAgentProvider(key) && (member === undefined || typeof member === 'boolean'),
  );
}

/**
 * The runtime a picker should fall back to when the current selection belongs
 * to a now-disabled provider. Returns null when `candidates` has no runtime on
 * an enabled provider (the caller then has nothing to offer).
 */
export function firstEnabledRuntime<T extends AgentRuntime>(
  access: AgentProviderAccess | undefined,
  candidates: readonly T[],
): T | null {
  return candidates.find((r) => isRuntimeProviderEnabled(access, r)) ?? null;
}

/**
 * Agent keys that always deploy on the Claude runtime, no matter what a
 * workflow's `agentConfigs` overlay / project override / variant delta says.
 * EMPTY today: `visual-verify` was removed from this set once the
 * verification agent gained a Codex runtime implementation
 * (`codexVerificationAgentQuery` — the runner dispatches on the resolved
 * provider). The machinery stays wired for a future key that genuinely can't
 * run on Codex: the workflow editor (`AgentEditorForm.tsx` /
 * `WorkflowStepInspector.tsx`) renders "Always runs on Claude" instead of a
 * runtime select for a key in this set (UI communicates the invariant); the
 * deploy seam (`resolveStepAgent`) enforces it server-side by dropping a
 * `runtime: 'codex-sdk'` pin with a logged warning — because `agentConfigs`
 * can also be written via the MCP workflow-config tools, bypassing the editor
 * entirely.
 */
export const CLAUDE_ONLY_AGENT_KEYS: ReadonlySet<string> = new Set<string>();

/** True when `key` must always resolve in the Claude provider namespace. */
export function isClaudeOnlyAgentKey(key: string): boolean {
  return CLAUDE_ONLY_AGENT_KEYS.has(key);
}
