import type {
  AgentProvider,
  WorkflowRunStorableRuntime,
} from '../../../shared/types/agentRuntime';
import type { ExecutionModel } from '../../../shared/types/executionModel';
import type { WorkflowPrompt } from './workflowPromptReader';

export type WorkflowPromptTurnKind = 'launch' | 'nudge' | 'resume' | 'programmatic-step';

export interface WorkflowPromptRenderContext {
  provider: AgentProvider;
  // The runtime the run is EXECUTING on (a run row's value), not a launch
  // choice — a runtime that is storable but not workflow-launchable still
  // renders prompts.
  runtime: WorkflowRunStorableRuntime;
  executionModel?: ExecutionModel;
  turnKind?: WorkflowPromptTurnKind;
}

const DEFAULT_RENDER_CONTEXT: WorkflowPromptRenderContext = {
  provider: 'claude',
  runtime: 'claude-sdk',
  executionModel: 'orchestrated',
  turnKind: 'launch',
};

export function defaultWorkflowPromptRenderContext(): WorkflowPromptRenderContext {
  return DEFAULT_RENDER_CONTEXT;
}

const CODEX_WORKFLOW_ENVELOPE = `# Runtime adapter: Codex

You are running the same Cyboflow workflow semantics as the Claude runtime, but through Codex.

Provider adaptation rules:

- Treat the workflow body below as the source of truth for phases, step ids, required outputs, database writes, artifacts, and human gates.
- When the workflow mentions Claude-specific mechanics such as \`.claude/agents/\`, the Agent tool, or a named \`cyboflow-*\` subagent, interpret that as a role/delegation instruction. On Codex, never pass a \`cyboflow-*\` name as \`agent_type\`: use built-in \`worker\` for \`implement\`, \`write-tests\`, and \`ui-prototype\`; use built-in \`explorer\` for \`context\`, \`research\`, \`epics\`, \`tasks\`, \`architecture\`, \`dependency-analyzer\`, \`code-review\`, \`task-verify\`, \`visual-verify\`, \`sprint-verify\`, \`sprint-review\`, and \`compounder\`; use built-in \`worker\` for \`address-review\` (it edits files). For an unlisted role, use \`worker\` when it must modify files and \`explorer\` when it is read-only. If native delegation is unavailable, perform that role's work directly in this turn while preserving the same returned sections and persistence contract.
- Continue to use the \`cyboflow_*\` MCP tools for workflow state. \`cyboflow_report_step\` is still required at the same step boundaries.
- Human gates remain host-owned gates. Whenever the workflow says to use AskUserQuestion or request_user_input, call \`cyboflow_request_user_input\` with the same questions instead. This MCP call blocks until the human answers in Cyboflow; do not continue past the gate before it returns.
- Do not create or read plugin state files. The Cyboflow database remains the single source of truth.

---`;

const OMP_WORKFLOW_ENVELOPE = `# Runtime adapter: OMP

You are running the same Cyboflow workflow semantics as the Claude runtime, but through OMP.

Provider adaptation rules:

- Treat the workflow body below as the source of truth for phases, step ids, required outputs, database writes, artifacts, and human gates.
- When the workflow mentions Claude-specific mechanics such as \`.claude/agents/\`, the Agent tool, or a named \`cyboflow-*\` subagent, interpret that as a role/delegation instruction. **Cyboflow installs no agent files on this runtime**, so the workflow's claim that a \`cyboflow-*\` role "is installed in this worktree's \`.claude/agents/\`" does not hold here — OMP's task-agent discovery loads OMP-native \`.omp\` agent roots only.
- NEVER pass a \`cyboflow-*\` name — or the same name with the prefix stripped — as an OMP task agent type, and NEVER go looking for a matching agent definition on disk, in \`~/.claude\`, or in a plugin cache. An agent that happens to share the role's name is NOT Cyboflow's: adopting one runs a stranger's prompt, under a model pin Cyboflow never chose, on your workflow's step.
- Delegate with OMP's own bundled agents instead: \`task\` for a role that must modify files (\`implement\`, \`write-tests\`, \`ui-prototype\`, \`address-review\`), \`reviewer\` for \`code-review\`, and \`scout\` for the read-only roles (\`context\`, \`research\`, \`epics\`, \`tasks\`, \`architecture\`, \`adversarial-review\`, \`dependency-analyzer\`, \`interview\`, \`task-verify\`, \`sprint-verify\`, \`sprint-review\`, \`compounder\`, \`verify-setup\`). For an unlisted role, use \`task\` when it must modify files and \`scout\` when it is read-only. Give the delegate the role's brief in your own words — it has no Cyboflow role prompt of its own.
- If native delegation is unavailable or would not help, perform that role's work directly in this turn while preserving the same returned sections and persistence contract. Doing the step yourself is always preferable to delegating to an agent you did not verify is Cyboflow's.
- Continue to use the \`cyboflow_*\` MCP tools for workflow state. \`cyboflow_report_step\` is still required at the same step boundaries.
- Human gates remain host-owned gates. Whenever the workflow says to use AskUserQuestion or request_user_input, call \`cyboflow_request_user_input\` with the same questions instead. This MCP call blocks until the human answers in Cyboflow; do not continue past the gate before it returns.
- Do not create or read plugin state files. The Cyboflow database remains the single source of truth.

---`;

/**
 * The runtime-adapter block prepended to a launch / programmatic-step prompt,
 * per provider. `null` = the workflow body needs no adaptation, which is what
 * Claude means (the bodies are written for it) and what a provider that has not
 * yet been taught the orchestrator contract must also mean — an envelope is
 * authored deliberately, never inherited from another vendor.
 *
 * The Record is exhaustive over `AgentProvider`, so a new provider cannot ship
 * without someone deciding which of the two it is.
 */
export const PROVIDER_PROMPT_ENVELOPES: Record<AgentProvider, string | null> = {
  claude: null,
  codex: CODEX_WORKFLOW_ENVELOPE,
  // OMP's envelope exists because the T1 step prompt is NOT provider-neutral:
  // `composeStepPrompt` tells every step to delegate to its `cyboflow-<agent>`
  // role and asserts that role "is installed in this worktree's
  // `.claude/agents/`". That assertion is Claude-only — the bundle installer
  // (`installWorkflowBundle`) is wired into the Claude managers alone, and OMP's
  // task-agent discovery loads OMP-native `.omp` agent roots, not
  // `.claude/agents/*.md`. So an OMP step agent looking for `cyboflow-compounder`
  // finds nothing, strips the prefix, and resolves whatever `compounder` its
  // roster does carry — on a real run that was a THIRD-PARTY plugin agent whose
  // own frontmatter pinned a model OMP could not route, which killed the step.
  // The envelope closes that specific hole: the `cyboflow-*` name is a role
  // instruction, a same-named agent from the environment is never ours, and OMP
  // delegates through its own bundled agents or does the work in-turn.
  omp: OMP_WORKFLOW_ENVELOPE,
  // Same rule as OMP: pi has not been taught the T2 orchestrator contract
  // (AskUserQuestion redirection, subagent role mapping), so a pi step prompt
  // renders IDENTITY only. Author an envelope in the phase that teaches it —
  // never inherit Codex's, which would describe a contract pi does not
  // implement.
  pi: null,
};

export function renderWorkflowPromptForRuntime(
  prompt: WorkflowPrompt,
  context: WorkflowPromptRenderContext = DEFAULT_RENDER_CONTEXT,
): WorkflowPrompt {
  const envelope = PROVIDER_PROMPT_ENVELOPES[context.provider];
  if (envelope === null) {
    return prompt;
  }
  if (context.turnKind === 'nudge' || context.turnKind === 'resume') {
    return prompt;
  }

  return {
    prompt: `${envelope}\n\n${prompt.prompt}`,
    systemPromptAppend: prompt.systemPromptAppend,
  };
}
