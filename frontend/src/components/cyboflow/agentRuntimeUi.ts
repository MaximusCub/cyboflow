import type {
  AgentProvider,
  SessionAgentRuntime,
  WorkflowAgentRuntime,
} from '../../../../shared/types/agentRuntime';
import { isWorkflowRuntimeSupported, providerForRuntime as sharedProviderForRuntime } from '../../../../shared/types/agentRuntime';
import type { CliSubstrate } from '../../../../shared/types/substrate';

export type LaunchAgentRuntime = SessionAgentRuntime | WorkflowAgentRuntime;

/**
 * The owning provider for a runtime. Delegates to the shared `providerForRuntime`
 * (which owns the OMP branch) so this UI helper can never drift from the provider
 * map. Workflow runtimes provably exclude `omp-fleet` (see `WorkflowAgentRuntime`),
 * so the workflow overload narrows the result to the 2-wide `claude|codex` union
 * that the workflow/variant/A-B wire schemas accept; the general overload keeps the
 * full 3-wide `AgentProvider` for session-scope sites (quick sessions may name OMP).
 */
export function providerForRuntime(runtime: WorkflowAgentRuntime): 'claude' | 'codex';
export function providerForRuntime(runtime: LaunchAgentRuntime): AgentProvider;
export function providerForRuntime(runtime: LaunchAgentRuntime): AgentProvider {
  return sharedProviderForRuntime(runtime);
}

export function substrateForRuntime(runtime: LaunchAgentRuntime): CliSubstrate | undefined {
  if (runtime === 'claude-interactive') return 'interactive';
  if (runtime === 'claude-sdk') return 'sdk';
  return undefined;
}

export function workflowRuntimeForLaunch(runtime: LaunchAgentRuntime): WorkflowAgentRuntime | null {
  if (runtime === 'codex-pty') return null;
  return isWorkflowRuntimeSupported(runtime) ? runtime : null;
}

export function quickSessionRuntimeForLaunch(runtime: LaunchAgentRuntime): SessionAgentRuntime {
  return runtime;
}

export function isCodexRuntime(runtime: LaunchAgentRuntime): boolean {
  return providerForRuntime(runtime) === 'codex';
}
