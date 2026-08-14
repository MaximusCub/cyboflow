import type {
  SessionAgentRuntime,
  WorkflowLaunchableRuntime,
} from '../../../../shared/types/agentRuntime';
import {
  isWorkflowLaunchableRuntime,
  providerForRuntime,
} from '../../../../shared/types/agentRuntime';
import type { CliSubstrate } from '../../../../shared/types/substrate';

export type LaunchAgentRuntime = SessionAgentRuntime | WorkflowLaunchableRuntime;

/**
 * Re-exported so the renderer's launch surfaces resolve a provider through the
 * SAME prefix registry the main-side seams use — this module used to carry its
 * own `startsWith('codex-')` copy, which would map an unregistered runtime into
 * the Claude pickers with no error.
 */
export { providerForRuntime };

export function substrateForRuntime(runtime: LaunchAgentRuntime): CliSubstrate | undefined {
  if (runtime === 'claude-interactive') return 'interactive';
  if (runtime === 'claude-sdk') return 'sdk';
  return undefined;
}

export function workflowRuntimeForLaunch(
  runtime: LaunchAgentRuntime,
): WorkflowLaunchableRuntime | null {
  if (runtime === 'codex-pty') return null;
  return isWorkflowLaunchableRuntime(runtime) ? runtime : null;
}

export function quickSessionRuntimeForLaunch(runtime: LaunchAgentRuntime): SessionAgentRuntime {
  return runtime;
}

export function isCodexRuntime(runtime: LaunchAgentRuntime): boolean {
  return providerForRuntime(runtime) === 'codex';
}
