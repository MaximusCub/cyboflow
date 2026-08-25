/**
 * Unit tests for applyPromptAddenda — the tuning-level `promptAddendum` append
 * (plan D5).
 *
 * The field exists because the alternative (an embedded `custom` prompt copy)
 * total-replaces description/systemPrompt/tools/enabledMcps and would silently
 * erase a project's own hardened agent policy. So the load-bearing property under
 * test is what the append does NOT touch: tools, MCP grants, model, runtime,
 * provider model, effort, description and role must all survive verbatim, on top
 * of a project override AND on top of a variant's wholesale prompt replacement.
 *
 * The second load-bearing property is the rawContent drop: `installAgentOverlay`
 * prefers `rawContent` over the rendered body, so an addendum applied without
 * dropping it would never reach the spawned subagent.
 */
import { describe, it, expect } from 'vitest';
import { applyPromptAddenda, type EffectiveAgent } from '../effectiveAgents';
import type { CliTool } from '../../../../../shared/types/cliTools';

const ADDENDUM = 'You also author the tests for your diff; run them targeted.';

function builtin(agentKey: string): EffectiveAgent {
  return {
    agentKey,
    name: `cyboflow-${agentKey}`,
    role: 'role',
    description: 'BUILTIN DESC',
    systemPrompt: 'BUILTIN PROMPT',
    tools: ['Read', 'Edit'] as CliTool[],
    model: null,
    enabledMcps: [],
    source: 'builtin',
    rawContent: 'RAW MD BODY',
  };
}

/** A project-hardened override: narrowed tools, a single MCP grant, a pinned model. */
function hardened(agentKey: string): EffectiveAgent {
  return {
    agentKey,
    name: `cyboflow-${agentKey}`,
    role: 'hardened',
    description: 'PROJECT DESC',
    systemPrompt: 'PROJECT PROMPT',
    tools: ['Read'] as CliTool[],
    model: 'opus',
    enabledMcps: ['ctx'],
    source: 'builtin-override',
    runtime: 'codex-sdk',
    providerModel: 'gpt-5.2-codex',
    codexModel: 'gpt-5.2-codex',
    effort: 'high',
  };
}

describe('applyPromptAddenda', () => {
  it('appends to the resolved prompt as a clearly separated trailing section', () => {
    const [result] = applyPromptAddenda([builtin('implement')], {
      implement: { promptAddendum: ADDENDUM },
    });
    expect(result.systemPrompt).toBe(
      `BUILTIN PROMPT\n\n## Tuning-level addendum\n\n${ADDENDUM}`,
    );
  });

  it('preserves every other field of a project-hardened override', () => {
    const base = hardened('implement');
    const [result] = applyPromptAddenda([base], { implement: { promptAddendum: ADDENDUM } });

    expect(result.systemPrompt.startsWith('PROJECT PROMPT')).toBe(true);
    expect(result.systemPrompt).toContain(ADDENDUM);
    // The whole point of the field: the project's policy survives intact.
    expect(result.tools).toEqual(['Read']);
    expect(result.enabledMcps).toEqual(['ctx']);
    expect(result.model).toBe('opus');
    expect(result.runtime).toBe('codex-sdk');
    expect(result.providerModel).toBe('gpt-5.2-codex');
    expect(result.codexModel).toBe('gpt-5.2-codex');
    expect(result.effort).toBe('high');
    expect(result.description).toBe('PROJECT DESC');
    expect(result.role).toBe('hardened');
    expect(result.name).toBe('cyboflow-implement');
  });

  it('drops rawContent and flips source so the overlay renders the appended body', () => {
    const [result] = applyPromptAddenda([builtin('implement')], {
      implement: { promptAddendum: ADDENDUM },
    });
    // Without this the overlay would write the verbatim builtin `.md` and the
    // addendum would never reach the subagent.
    expect(result.rawContent).toBeUndefined();
    expect(result.source).toBe('builtin-override');
  });

  it('applies on top of a variant prompt that already replaced the body wholesale', () => {
    // Plan D5's consistent reading: a variant delta wins the PROMPT, and the
    // addendum then lands on the prompt that won.
    const variantReplaced: EffectiveAgent = {
      ...builtin('implement'),
      systemPrompt: 'VARIANT PROMPT',
      source: 'builtin-override',
      rawContent: undefined,
    };
    const [result] = applyPromptAddenda([variantReplaced], {
      implement: { promptAddendum: ADDENDUM },
    });
    expect(result.systemPrompt).toBe(
      `VARIANT PROMPT\n\n## Tuning-level addendum\n\n${ADDENDUM}`,
    );
  });

  it('leaves agents with no addendum, an empty one, or a non-string one untouched', () => {
    const agents = [builtin('implement'), builtin('code-review')];
    const [withEmpty, untouched] = applyPromptAddenda(agents, {
      implement: { promptAddendum: '   ' },
      // `code-review` has a config, but no addendum key.
      'code-review': { model: 'haiku' },
    });
    // Identity by reference: no spurious source flip / rawContent drop.
    expect(withEmpty).toBe(agents[0]);
    expect(untouched).toBe(agents[1]);
  });

  it('ignores an addendum keyed to an agent that is not in the effective set', () => {
    const agents = [builtin('implement')];
    expect(applyPromptAddenda(agents, { 'not-an-agent': { promptAddendum: ADDENDUM } })).toEqual(
      agents,
    );
  });
});
