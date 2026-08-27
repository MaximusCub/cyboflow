import { describe, expect, it } from 'vitest';
import {
  PROVIDER_PROMPT_ENVELOPES,
  renderWorkflowPromptForRuntime,
} from '../workflowPromptRenderer';
import type { WorkflowPrompt } from '../workflowPromptReader';

const BASE_PROMPT: WorkflowPrompt = {
  prompt: 'Shared workflow body.',
  systemPromptAppend: 'Report every step.',
};

describe('renderWorkflowPromptForRuntime', () => {
  it('leaves Claude prompts byte-identical', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'claude',
      runtime: 'claude-sdk',
    });

    expect(rendered).toBe(BASE_PROMPT);
  });

  it('wraps Codex prompts with a provider adapter while preserving the shared body', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'launch',
    });

    expect(rendered.prompt).toContain('# Runtime adapter: Codex');
    expect(rendered.prompt).toContain('same Cyboflow workflow semantics');
    expect(rendered.prompt).toContain('never pass a `cyboflow-*` name as `agent_type`');
    expect(rendered.prompt).toContain('built-in `worker`');
    expect(rendered.prompt).toContain('built-in `explorer`');
    expect(rendered.prompt.endsWith(BASE_PROMPT.prompt)).toBe(true);
    expect(rendered.systemPromptAppend).toBe(BASE_PROMPT.systemPromptAppend);
  });

  it('keeps the database, step-reporting, and human-gate contracts explicit for Codex', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'programmatic-step',
    });

    expect(rendered.prompt).toContain('cyboflow_*');
    expect(rendered.prompt).toContain('cyboflow_report_step');
    expect(rendered.prompt).toContain('Human gates remain host-owned gates');
    expect(rendered.prompt).toContain('cyboflow_request_user_input');
    expect(rendered.prompt).toContain('This MCP call blocks until the human answers');
    expect(rendered.prompt).toContain('Cyboflow database remains the single source of truth');
  });

  it('does not wrap Codex nudge or resume turns because the thread already has the launch prompt', () => {
    expect(renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'nudge',
    })).toBe(BASE_PROMPT);
    expect(renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'codex',
      runtime: 'codex-sdk',
      turnKind: 'resume',
    })).toBe(BASE_PROMPT);
  });

  /**
   * OMP DOES get an envelope, because the T1 step prompt is not
   * provider-neutral: it tells the step to delegate to its `cyboflow-<agent>`
   * role and asserts that role is installed in `.claude/agents/`, which is true
   * on Claude only. Without the envelope an OMP step resolves the prefix-stripped
   * name against its own roster and can adopt a same-named THIRD-PARTY agent.
   */
  it('prepends the OMP envelope to a programmatic-step prompt', () => {
    const rendered = renderWorkflowPromptForRuntime(BASE_PROMPT, {
      provider: 'omp',
      runtime: 'omp-sdk',
      executionModel: 'programmatic',
      turnKind: 'programmatic-step',
    });

    expect(rendered.prompt).toContain('# Runtime adapter: OMP');
    expect(rendered.prompt.endsWith(BASE_PROMPT.prompt)).toBe(true);
    expect(rendered.systemPromptAppend).toBe(BASE_PROMPT.systemPromptAppend);
  });

  /**
   * The envelope's whole job is to stop a step adopting a same-named agent from
   * the host environment — the exact failure that killed a real Compound run.
   */
  it('forbids resolving a cyboflow role against the host agent roster', () => {
    const envelope = PROVIDER_PROMPT_ENVELOPES.omp;

    expect(envelope).not.toBeNull();
    expect(envelope).toContain('NEVER pass a `cyboflow-*` name');
    expect(envelope).toContain('with the prefix stripped');
    expect(envelope).toContain('plugin cache');
  });

  /** A nudge / resume turn stays identity for OMP, same rule as Codex. */
  it('leaves an OMP nudge or resume turn unenveloped', () => {
    for (const turnKind of ['nudge', 'resume'] as const) {
      expect(renderWorkflowPromptForRuntime(BASE_PROMPT, {
        provider: 'omp',
        runtime: 'omp-sdk',
        turnKind,
      })).toBe(BASE_PROMPT);
    }
  });
});
