/**
 * Provider-routing core for workflow runtime mixes (shared/tuning/runtimeMix.ts).
 *
 * Colocated in main for the same two reasons its tuning sibling is: main's
 * vitest config only collects `main/src/**`, and the schema-validity sweep needs
 * the AUTHORITATIVE zod write-path validator (`workflowDefinitionSchema`).
 *
 * What is pinned here:
 *   1. the `'claude'` mix is BYTE-identical to `materializeForLevel` at every
 *      flow × level — including a deliberately NON-CANONICAL custom slot, whose
 *      whitespace/key order a parse -> re-serialize round-trip would silently
 *      canonicalize and fork spec_hash from every pre-mix custom run;
 *   2. every verification-class key resolves against the real built-in graph,
 *      and the transform never mints a config for the `human` gate;
 *   3. the tier map's mirror / step-down / step-up rules incl. both clamps;
 *   4. the execution-vs-verification split per mix, on the flow that has one;
 *   5. an explicit user `runtime` outranks the mix;
 *   6. a claude-ROUTED agent is pinned `claude-sdk` on EVERY non-claude mix, so
 *      the materialized graph never depends on the run's base provider (the mix
 *      and the launch Runtime are orthogonal dials).
 */
import { describe, it, expect } from 'vitest';
import {
  CODEX_TIER_MODELS,
  RUNTIME_MIXES,
  VERIFICATION_AGENT_KEYS,
  applyRuntimeMix,
  codexPinForClaude,
  isMixedRuntimeMix,
  isRuntimeMix,
  materializeForLevelAndMix,
  mixRoutesAgentToCodex,
  primaryProviderForMix,
  resolveEffectiveDefinitionWithMix,
  type RuntimeMix,
} from '../../../../shared/tuning/runtimeMix';
import {
  TUNING_LEVELS,
  applyTuningPreset,
  definitionAgentKeys,
  materializeForLevel,
  serializeDefinition,
  type TuningLevel,
} from '../../../../shared/tuning/workflowTuning';
import {
  CYBOFLOW_WORKFLOW_NAMES,
  WORKFLOW_DEFINITIONS,
  type CyboflowWorkflowName,
  type WorkflowAgentConfig,
  type WorkflowDefinition,
} from '../../../../shared/types/workflows';
import { workflowDefinitionSchema } from '../workflowDefinitionSchema';

const PRESET_LEVELS: readonly TuningLevel[] = ['efficient', 'standard', 'thorough'];
const NON_CLAUDE_MIXES: readonly RuntimeMix[] = ['claude-primary', 'codex-primary', 'codex'];

/**
 * A structurally valid sprint definition serialized NON-canonically: same object
 * graph as the built-in, but pretty-printed rather than through
 * `serializeDefinition`. Any parse -> re-serialize round-trip changes its bytes,
 * which is exactly what the `'claude'` short-circuit must not do.
 */
const NON_CANONICAL_SPEC = JSON.stringify(
  JSON.parse(serializeDefinition(WORKFLOW_DEFINITIONS.sprint)),
  null,
  2,
);

function configFor(def: WorkflowDefinition, agentKey: string): WorkflowAgentConfig | undefined {
  return def.agentConfigs?.[agentKey];
}

function mixed(
  flow: CyboflowWorkflowName,
  level: TuningLevel,
  mix: RuntimeMix,
): WorkflowDefinition {
  return applyRuntimeMix(applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level), flow, mix);
}

describe('runtime mix vocabulary', () => {
  it('isRuntimeMix accepts the four mixes and rejects anything else', () => {
    for (const mix of RUNTIME_MIXES) expect(isRuntimeMix(mix)).toBe(true);
    for (const bogus of ['', 'CLAUDE', 'claude_primary', 'omp', null, undefined, 2]) {
      expect(isRuntimeMix(bogus)).toBe(false);
    }
  });

  it('primaryProviderForMix / isMixedRuntimeMix split the four along the right line', () => {
    expect(primaryProviderForMix('claude')).toBe('claude');
    expect(primaryProviderForMix('claude-primary')).toBe('claude');
    expect(primaryProviderForMix('codex-primary')).toBe('codex');
    expect(primaryProviderForMix('codex')).toBe('codex');

    expect(isMixedRuntimeMix('claude')).toBe(false);
    expect(isMixedRuntimeMix('claude-primary')).toBe(true);
    expect(isMixedRuntimeMix('codex-primary')).toBe(true);
    expect(isMixedRuntimeMix('codex')).toBe(false);
  });
});

describe("materializeForLevelAndMix — the 'claude' mix is byte-identical", () => {
  for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
    for (const level of TUNING_LEVELS) {
      it(`${flow} × ${level} matches materializeForLevel exactly`, () => {
        expect(materializeForLevelAndMix(flow, NON_CANONICAL_SPEC, level, 'claude')).toBe(
          materializeForLevel(flow, NON_CANONICAL_SPEC, level),
        );
        expect(materializeForLevelAndMix(flow, '{}', level, 'claude')).toBe(
          materializeForLevel(flow, '{}', level),
        );
      });
    }
  }

  it('returns a non-canonical custom slot VERBATIM (no re-serialize)', () => {
    expect(materializeForLevelAndMix('sprint', NON_CANONICAL_SPEC, 'custom', 'claude')).toBe(
      NON_CANONICAL_SPEC,
    );
    // Sanity: the fixture really is non-canonical, so the assertion above has teeth.
    expect(NON_CANONICAL_SPEC).not.toBe(serializeDefinition(WORKFLOW_DEFINITIONS.sprint));
  });

  it('a non-built-in flow short-circuits at every mix', () => {
    for (const mix of RUNTIME_MIXES) {
      for (const level of TUNING_LEVELS) {
        expect(materializeForLevelAndMix('my-custom-flow', NON_CANONICAL_SPEC, level, mix)).toBe(
          NON_CANONICAL_SPEC,
        );
      }
    }
  });

  it('a non-claude mix on a custom slot DOES serialize canonically (an intentional hash fork)', () => {
    const frozen = materializeForLevelAndMix('sprint', NON_CANONICAL_SPEC, 'custom', 'codex');
    expect(frozen).not.toBe(NON_CANONICAL_SPEC);
    expect(frozen).toBe(
      serializeDefinition(applyRuntimeMix(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'codex')),
    );
  });

  it('an unparseable custom slot falls back to the level-only materialization', () => {
    // `resolveWorkflowDefinition` returns null only for a non-built-in flow, so
    // the built-in arm degrades to the built-in graph rather than losing it.
    expect(materializeForLevelAndMix('my-custom-flow', 'not json', 'custom', 'codex')).toBe(
      materializeForLevel('my-custom-flow', 'not json', 'custom'),
    );
  });

  it('a preset level ignores the custom slot under a mix too', () => {
    for (const level of PRESET_LEVELS) {
      expect(materializeForLevelAndMix('sprint', NON_CANONICAL_SPEC, level, 'codex')).toBe(
        materializeForLevelAndMix('sprint', '{}', level, 'codex'),
      );
    }
  });
});

describe('resolveEffectiveDefinitionWithMix', () => {
  it("is the read-path identity at mix 'claude'", () => {
    for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
      for (const level of PRESET_LEVELS) {
        expect(resolveEffectiveDefinitionWithMix(flow, '{}', level, 'claude')).toEqual(
          applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level),
        );
      }
    }
  });

  it('parses back to exactly what the run side freezes', () => {
    for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
      for (const mix of NON_CLAUDE_MIXES) {
        const resolved = resolveEffectiveDefinitionWithMix(flow, '{}', 'standard', mix);
        expect(serializeDefinition(resolved as WorkflowDefinition)).toBe(
          materializeForLevelAndMix(flow, '{}', 'standard', mix),
        );
      }
    }
  });

  it('returns null for an unresolvable non-built-in flow', () => {
    expect(resolveEffectiveDefinitionWithMix('my-custom-flow', '{}', 'standard', 'codex')).toBeNull();
  });
});

describe('the verification class table resolves against the real graphs', () => {
  it.each(CYBOFLOW_WORKFLOW_NAMES)('every %s verification key is bound by a step', (flow) => {
    const bound = definitionAgentKeys(WORKFLOW_DEFINITIONS[flow]);
    for (const key of VERIFICATION_AGENT_KEYS[flow]) {
      expect(bound.has(key), `${flow} verification key "${key}" is not bound`).toBe(true);
    }
  });

  it('ship is exactly the union of its sprint and planner parents', () => {
    expect([...VERIFICATION_AGENT_KEYS.ship].sort()).toEqual(
      [...new Set([...VERIFICATION_AGENT_KEYS.sprint, ...VERIFICATION_AGENT_KEYS.planner])].sort(),
    );
  });

  it('the single-agent flows have an EMPTY verification class', () => {
    expect(VERIFICATION_AGENT_KEYS.compound.size).toBe(0);
    expect(VERIFICATION_AGENT_KEYS['verify-setup'].size).toBe(0);
  });

  it('mixRoutesAgentToCodex splits execution from verification', () => {
    expect(mixRoutesAgentToCodex('sprint', 'claude', 'code-review')).toBe(false);
    expect(mixRoutesAgentToCodex('sprint', 'claude', 'implement')).toBe(false);
    expect(mixRoutesAgentToCodex('sprint', 'claude-primary', 'code-review')).toBe(true);
    expect(mixRoutesAgentToCodex('sprint', 'claude-primary', 'implement')).toBe(false);
    expect(mixRoutesAgentToCodex('sprint', 'codex-primary', 'code-review')).toBe(false);
    expect(mixRoutesAgentToCodex('sprint', 'codex-primary', 'implement')).toBe(true);
    expect(mixRoutesAgentToCodex('sprint', 'codex', 'code-review')).toBe(true);
    expect(mixRoutesAgentToCodex('sprint', 'codex', 'implement')).toBe(true);
  });
});

describe('codexPinForClaude — the tier map', () => {
  const luna = CODEX_TIER_MODELS.luna;
  const sol = CODEX_TIER_MODELS.sol;

  const cases: ReadonlyArray<[string | undefined, string | undefined, string, string]> = [
    // sonnet mirrors, with `max` clamped onto `xhigh`.
    ['sonnet', 'low', luna, 'low'],
    ['sonnet', 'medium', luna, 'medium'],
    ['sonnet', 'high', luna, 'high'],
    ['sonnet', 'xhigh', luna, 'xhigh'],
    ['sonnet', 'max', luna, 'xhigh'],
    ['sonnet', undefined, luna, 'medium'],
    ['sonnet-250k', 'high', luna, 'high'],
    // haiku is always the floor.
    ['haiku', 'low', luna, 'low'],
    ['haiku', 'high', luna, 'low'],
    ['haiku', undefined, luna, 'low'],
    // opus steps one rung DOWN, flooring at low.
    ['opus', 'medium', sol, 'low'],
    ['opus', 'high', sol, 'medium'],
    ['opus', 'xhigh', sol, 'high'],
    ['opus', 'max', sol, 'high'],
    ['opus', 'low', sol, 'low'],
    ['opus', undefined, sol, 'low'],
    ['opus-250k', 'high', sol, 'medium'],
    // fable steps one rung UP, ceilinged at xhigh.
    ['fable', 'low', sol, 'medium'],
    ['fable', 'medium', sol, 'high'],
    ['fable', 'high', sol, 'xhigh'],
    ['fable', 'xhigh', sol, 'xhigh'],
    ['fable', 'max', sol, 'xhigh'],
    ['fable', undefined, sol, 'high'],
    // Unknown / unpinned falls back to sonnet·medium, BOTH halves.
    [undefined, undefined, luna, 'medium'],
    [undefined, 'high', luna, 'medium'],
    ['gpt-9', 'high', luna, 'medium'],
  ];

  it.each(cases)('%s · %s -> %s · %s', (model, effort, providerModel, mapped) => {
    expect(codexPinForClaude(model, effort)).toEqual({ providerModel, effort: mapped });
  });
});

describe('applyRuntimeMix — purity and the human gate', () => {
  it('never mutates its input and returns a fresh structure', () => {
    const before = serializeDefinition(WORKFLOW_DEFINITIONS.sprint);
    for (const mix of RUNTIME_MIXES) {
      const out = applyRuntimeMix(WORKFLOW_DEFINITIONS.sprint, 'sprint', mix);
      expect(out).not.toBe(WORKFLOW_DEFINITIONS.sprint);
    }
    expect(serializeDefinition(WORKFLOW_DEFINITIONS.sprint)).toBe(before);
  });

  it("mix 'claude' leaves the definition untouched", () => {
    for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
      for (const level of PRESET_LEVELS) {
        const base = applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level);
        expect(applyRuntimeMix(base, flow, 'claude')).toEqual(base);
      }
    }
  });

  it('is idempotent — re-applying a mix to its own output changes nothing', () => {
    for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
      for (const mix of NON_CLAUDE_MIXES) {
        const once = mixed(flow, 'standard', mix);
        expect(serializeDefinition(applyRuntimeMix(once, flow, mix))).toBe(
          serializeDefinition(once),
        );
      }
    }
  });

  it('never writes a config for the human gate or an unbound key', () => {
    for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
      for (const mix of NON_CLAUDE_MIXES) {
        for (const level of PRESET_LEVELS) {
          const out = mixed(flow, level, mix);
          const bound = definitionAgentKeys(out);
          for (const key of Object.keys(out.agentConfigs ?? {})) {
            expect(key, `${flow}/${level}/${mix}`).not.toBe('human');
            expect(bound.has(key), `${flow}/${level}/${mix} wrote unbound key "${key}"`).toBe(true);
          }
        }
      }
    }
  });

  it('every flow × level × mix still passes the write-path schema', () => {
    for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
      for (const level of PRESET_LEVELS) {
        for (const mix of RUNTIME_MIXES) {
          expect(
            () => workflowDefinitionSchema.parse(mixed(flow, level, mix)),
            `${flow}/${level}/${mix}`,
          ).not.toThrow();
        }
      }
    }
  });
});

describe('sprint × claude-primary (standard)', () => {
  const out = mixed('sprint', 'standard', 'claude-primary');

  it('pins every execution agent to claude-sdk, tier pins intact', () => {
    // Pinned EXPLICITLY even though the mix's primary is Claude: the mix is
    // orthogonal to the run's base provider, so a `claude-primary` graph
    // launched under a CODEX orchestrator must still state its Claude routing
    // rather than inherit the run's provider in spawnStepRunner.
    for (const key of ['implement', 'write-tests', 'dependency-analyzer', 'address-review']) {
      expect(configFor(out, key)?.runtime, key).toBe('claude-sdk');
      expect(configFor(out, key)?.providerModel, key).toBeUndefined();
    }
    expect(configFor(out, 'implement')).toEqual({
      model: 'sonnet',
      effort: 'high',
      runtime: 'claude-sdk',
    });
  });

  it('routes every verification agent to codex through the tier map', () => {
    // Standard sprint pins: code-review/sprint-verify/sprint-review opus·high
    // -> sol·medium; task-verify/visual-verify opus·medium -> sol·low.
    expect(configFor(out, 'code-review')).toEqual({
      model: 'opus',
      effort: 'medium',
      runtime: 'codex-sdk',
      providerModel: CODEX_TIER_MODELS.sol,
    });
    expect(configFor(out, 'sprint-verify')?.effort).toBe('medium');
    expect(configFor(out, 'sprint-review')?.effort).toBe('medium');
    expect(configFor(out, 'task-verify')).toEqual({
      model: 'opus',
      effort: 'low',
      runtime: 'codex-sdk',
      providerModel: CODEX_TIER_MODELS.sol,
    });
    expect(configFor(out, 'visual-verify')?.effort).toBe('low');
  });

  it('keeps the Claude model field on every codex-routed agent (the flip-back)', () => {
    for (const key of VERIFICATION_AGENT_KEYS.sprint) {
      expect(configFor(out, key)?.runtime, key).toBe('codex-sdk');
      expect(configFor(out, key)?.model, key).toBe('opus');
    }
  });
});

describe('sprint × codex-primary (standard)', () => {
  const out = mixed('sprint', 'standard', 'codex-primary');

  it('routes execution to codex through the tier map', () => {
    // implement sonnet·high -> luna·high; dependency-analyzer sonnet·medium ->
    // luna·medium; write-tests sonnet·medium -> luna·medium.
    expect(configFor(out, 'implement')).toEqual({
      model: 'sonnet',
      effort: 'high',
      runtime: 'codex-sdk',
      providerModel: CODEX_TIER_MODELS.luna,
    });
    expect(configFor(out, 'dependency-analyzer')?.providerModel).toBe(CODEX_TIER_MODELS.luna);
    expect(configFor(out, 'dependency-analyzer')?.effort).toBe('medium');
    expect(configFor(out, 'write-tests')?.runtime).toBe('codex-sdk');
    // address-review is opus·high on the sprint standard preset -> sol·medium.
    expect(configFor(out, 'address-review')).toEqual({
      model: 'opus',
      effort: 'medium',
      runtime: 'codex-sdk',
      providerModel: CODEX_TIER_MODELS.sol,
    });
  });

  it('pins verification back to claude-sdk with the level pins intact', () => {
    for (const key of VERIFICATION_AGENT_KEYS.sprint) {
      expect(configFor(out, key), key).toEqual({
        model: 'opus',
        effort: key === 'code-review' || key.startsWith('sprint-') ? 'high' : 'medium',
        runtime: 'claude-sdk',
      });
    }
  });
});

describe('sprint × codex (thorough)', () => {
  const out = mixed('sprint', 'thorough', 'codex');

  it('routes EVERY bound agent to codex', () => {
    for (const key of definitionAgentKeys(out)) {
      if (key === 'human') continue;
      expect(configFor(out, key)?.runtime, key).toBe('codex-sdk');
      expect(configFor(out, key)?.providerModel, key).toBeDefined();
    }
  });

  it('maps the thorough fable sprint-review one rung up onto sol', () => {
    expect(configFor(out, 'sprint-review')).toEqual({
      model: 'fable',
      effort: 'high',
      runtime: 'codex-sdk',
      providerModel: CODEX_TIER_MODELS.sol,
    });
  });
});

describe('custom precedence — an explicit runtime outranks the mix', () => {
  const seeded: WorkflowDefinition = {
    ...WORKFLOW_DEFINITIONS.sprint,
    agentConfigs: { implement: { runtime: 'claude-sdk', model: 'opus' } },
  };

  it.each(NON_CLAUDE_MIXES)('%s leaves the pinned agent untouched but flips the rest', (mix) => {
    const out = applyRuntimeMix(seeded, 'sprint', mix);
    expect(configFor(out, 'implement')).toEqual({ runtime: 'claude-sdk', model: 'opus' });
    // Something else on the flow still moved, so the skip is targeted, not total.
    const others = [...definitionAgentKeys(out)].filter(
      (key) => key !== 'implement' && key !== 'human',
    );
    expect(others.some((key) => configFor(out, key)?.runtime === 'codex-sdk')).toBe(true);
  });
});

describe('the single-agent flows (compound, verify-setup)', () => {
  const singles: readonly CyboflowWorkflowName[] = ['compound', 'verify-setup'];

  it.each(singles)('%s: claude-primary pins every agent to claude-sdk, nothing to codex', (flow) => {
    // The verification class is empty, so `claude-primary` routes EVERY agent to
    // Claude. It still writes a `claude-sdk` pin apiece rather than nothing: the
    // mix no longer decides the run's provider, so "Claude executes" has to be
    // stated for the graph to mean that under a Codex orchestrator.
    for (const level of PRESET_LEVELS) {
      const base = applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level);
      const out = applyRuntimeMix(base, flow, 'claude-primary');
      for (const key of definitionAgentKeys(out)) {
        if (key === 'human') continue;
        expect(configFor(out, key)?.runtime, `${flow}/${level}/${key}`).toBe('claude-sdk');
      }
    }
  });

  it.each(singles)('%s: codex-primary and codex route every agent to codex', (flow) => {
    for (const mix of ['codex-primary', 'codex'] as const) {
      const out = mixed(flow, 'standard', mix);
      for (const key of definitionAgentKeys(out)) {
        if (key === 'human') continue;
        expect(configFor(out, key)?.runtime, `${flow}/${mix}/${key}`).toBe('codex-sdk');
      }
    }
  });
});
