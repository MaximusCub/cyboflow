/**
 * Preset core for workflow tuning levels (shared/tuning/workflowTuning.ts).
 *
 * Colocated in main because the schema-validity sweep needs the AUTHORITATIVE
 * zod write-path validator (`workflowDefinitionSchema`), which is main-only —
 * and because main's vitest config only collects `main/src/**`.
 *
 * What is pinned here:
 *   1. standard/custom are the identity, and the transform is pure;
 *   2. EVERY built-in flow × EVERY level produces a definition the write-path
 *      schema accepts (the sweep that catches a preset removing a phase's last
 *      step, orphaning a loopback, or writing an empty agentConfigs entry);
 *   3. every step key and agent key in the preset TABLES resolves against the
 *      real built-in graph — a renamed step trips this instead of silently
 *      becoming a no-op;
 *   4. `serializeDefinition` is order-independent and round-trips;
 *   5. the efficient-sprint calibration actually collapses the lane chain.
 */
import { describe, it, expect } from 'vitest';
import {
  TUNING_LEVELS,
  TUNING_PRESETS,
  applyTuningPreset,
  definitionAgentKeys,
  definitionHasStepKey,
  getTuningPreset,
  isTuningLevel,
  materializeForLevel,
  resolveEffectiveDefinition,
  serializeDefinition,
  type TuningPresetLevel,
} from '../../../../shared/tuning/workflowTuning';
import {
  CYBOFLOW_WORKFLOW_NAMES,
  WORKFLOW_DEFINITIONS,
  resolveWorkflowDefinition,
  type CyboflowWorkflowName,
  type WorkflowDefinition,
} from '../../../../shared/types/workflows';
import { workflowDefinitionSchema } from '../workflowDefinitionSchema';

const PRESET_LEVELS: readonly TuningPresetLevel[] = ['efficient', 'thorough'];

/** The sprint fan-out step's inner chain in the output of a level. */
function sprintLaneIds(def: WorkflowDefinition): string[] {
  const phase = def.phases.find((candidate) => candidate.id === 'execute');
  const step = phase?.steps.find((candidate) => candidate.id === 'execute-tasks');
  return (step?.fanOut?.inner ?? []).map((inner) => inner.id);
}

describe('tuning level vocabulary', () => {
  it('isTuningLevel accepts the four levels and rejects anything else', () => {
    for (const level of TUNING_LEVELS) expect(isTuningLevel(level)).toBe(true);
    for (const bogus of ['', 'STANDARD', 'fast', null, undefined, 3]) {
      expect(isTuningLevel(bogus)).toBe(false);
    }
  });

  it('getTuningPreset has no preset for standard/custom or a non-built-in flow', () => {
    expect(getTuningPreset('sprint', 'standard')).toBeUndefined();
    expect(getTuningPreset('sprint', 'custom')).toBeUndefined();
    expect(getTuningPreset('my-custom-flow', 'efficient')).toBeUndefined();
    expect(getTuningPreset('sprint', 'efficient')).toBeDefined();
  });
});

describe('applyTuningPreset — identity levels', () => {
  it.each(CYBOFLOW_WORKFLOW_NAMES)('standard is the identity for %s', (flow) => {
    expect(applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, 'standard')).toEqual(
      WORKFLOW_DEFINITIONS[flow],
    );
  });

  it.each(CYBOFLOW_WORKFLOW_NAMES)('custom is the identity for %s', (flow) => {
    expect(applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, 'custom')).toEqual(
      WORKFLOW_DEFINITIONS[flow],
    );
  });

  it('returns a fresh structure, not the input reference', () => {
    const builtin = WORKFLOW_DEFINITIONS.sprint;
    const out = applyTuningPreset(builtin, 'sprint', 'standard');
    expect(out).not.toBe(builtin);
    expect(out.phases).not.toBe(builtin.phases);
  });
});

describe('applyTuningPreset — purity', () => {
  it.each(CYBOFLOW_WORKFLOW_NAMES)('never mutates the built-in definition for %s', (flow) => {
    const before = serializeDefinition(WORKFLOW_DEFINITIONS[flow]);
    for (const level of TUNING_LEVELS) {
      applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level);
    }
    expect(serializeDefinition(WORKFLOW_DEFINITIONS[flow])).toBe(before);
  });

  it('mutating the output does not reach back into the built-in', () => {
    const out = applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'efficient');
    out.phases[0].steps[0].name = 'clobbered';
    expect(WORKFLOW_DEFINITIONS.sprint.phases[0].steps[0].name).toBe('Analyze dependencies');
  });

  it('is idempotent — re-applying a level to its own output changes nothing', () => {
    for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
      for (const level of PRESET_LEVELS) {
        const once = applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level);
        const twice = applyTuningPreset(once, flow, level);
        expect(serializeDefinition(twice)).toBe(serializeDefinition(once));
      }
    }
  });
});

describe('applyTuningPreset — schema validity sweep', () => {
  // The load-bearing sweep: a preset that empties a phase, orphans a loopback,
  // or writes an `{}` agentConfigs entry would be silently accepted by the
  // lenient read-path parser but REJECTED at persistence / freeze time.
  for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
    for (const level of TUNING_LEVELS) {
      it(`${flow} × ${level} passes workflowDefinitionSchema`, () => {
        const out = applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level);
        expect(() => workflowDefinitionSchema.parse(out)).not.toThrow();
      });
    }
  }
});

describe('preset tables resolve against the real built-in graphs', () => {
  for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
    for (const level of PRESET_LEVELS) {
      const preset = TUNING_PRESETS[flow][level];

      it(`${flow} × ${level}: every removeSteps key is a real step`, () => {
        for (const key of preset.removeSteps ?? []) {
          expect(
            definitionHasStepKey(WORKFLOW_DEFINITIONS[flow], key),
            `${flow}/${level} removeSteps key "${key}" does not resolve`,
          ).toBe(true);
        }
      });

      it(`${flow} × ${level}: every step-patch key is a real step`, () => {
        const keys = [
          ...Object.keys(preset.outerStepPatches ?? {}),
          ...Object.keys(preset.innerStepPatches ?? {}),
        ];
        for (const key of keys) {
          expect(
            definitionHasStepKey(WORKFLOW_DEFINITIONS[flow], key),
            `${flow}/${level} patch key "${key}" does not resolve`,
          ).toBe(true);
        }
      });

      it(`${flow} × ${level}: every agent key is bound by a step`, () => {
        const bound = definitionAgentKeys(WORKFLOW_DEFINITIONS[flow]);
        const keys = [
          ...Object.keys(preset.agentConfigs),
          ...Object.keys(preset.promptAddenda ?? {}),
        ];
        for (const key of keys) {
          expect(bound.has(key), `${flow}/${level} agent key "${key}" is not bound`).toBe(true);
        }
      });

      it(`${flow} × ${level}: no pin targets a step this preset removes`, () => {
        const out = applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level);
        const stillBound = definitionAgentKeys(out);
        for (const key of Object.keys(out.agentConfigs ?? {})) {
          expect(stillBound.has(key), `${flow}/${level} left a dead pin on "${key}"`).toBe(true);
        }
      });
    }
  }

  it('definitionHasStepKey rejects malformed and dangling keys', () => {
    const sprint = WORKFLOW_DEFINITIONS.sprint;
    expect(definitionHasStepKey(sprint, 'execute/execute-tasks')).toBe(true);
    expect(definitionHasStepKey(sprint, 'execute/execute-tasks/inner/implement')).toBe(true);
    expect(definitionHasStepKey(sprint, 'execute/nope')).toBe(false);
    expect(definitionHasStepKey(sprint, 'nope/execute-tasks')).toBe(false);
    expect(definitionHasStepKey(sprint, 'execute/execute-tasks/inner/nope')).toBe(false);
    expect(definitionHasStepKey(sprint, 'execute/execute-tasks/nested/implement')).toBe(false);
    expect(definitionHasStepKey(sprint, 'execute-tasks')).toBe(false);
    expect(definitionHasStepKey(sprint, '')).toBe(false);
    expect(definitionHasStepKey(sprint, 'execute//implement')).toBe(false);
  });
});

describe('serializeDefinition', () => {
  it('is insensitive to object key insertion order', () => {
    const a: WorkflowDefinition = {
      id: 'x',
      phases: [
        {
          id: 'p',
          label: 'P',
          color: '#3b6dd6',
          steps: [{ id: 's', name: 'S', agent: 'a', mcps: [], retries: 0 }],
        },
      ],
    };
    const b: WorkflowDefinition = {
      phases: [
        {
          steps: [{ retries: 0, mcps: [], agent: 'a', name: 'S', id: 's' }],
          color: '#3b6dd6',
          label: 'P',
          id: 'p',
        },
      ],
      id: 'x',
    };
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(serializeDefinition(a)).toBe(serializeDefinition(b));
  });

  it('preserves ARRAY order (step order is semantic, not incidental)', () => {
    const def = applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'standard');
    const reversed: WorkflowDefinition = { ...def, phases: [...def.phases].reverse() };
    expect(serializeDefinition(reversed)).not.toBe(serializeDefinition(def));
  });

  it('round-trips through JSON.parse for every flow × level', () => {
    for (const flow of CYBOFLOW_WORKFLOW_NAMES) {
      for (const level of TUNING_LEVELS) {
        const out = applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level);
        expect(JSON.parse(serializeDefinition(out))).toEqual(out);
      }
    }
  });

  it('is stable across repeated calls', () => {
    const out = applyTuningPreset(WORKFLOW_DEFINITIONS.planner, 'planner', 'efficient');
    expect(serializeDefinition(out)).toBe(serializeDefinition(out));
  });
});

describe('sprint × efficient', () => {
  const out = applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'efficient');

  it('collapses the lane chain to implement -> task-verify', () => {
    expect(sprintLaneIds(WORKFLOW_DEFINITIONS.sprint)).toEqual([
      'implement',
      'write-tests',
      'code-review',
      'task-verify',
      'visual-verify',
    ]);
    expect(sprintLaneIds(out)).toEqual(['implement', 'task-verify']);
  });

  it('keeps task-verify looping back to the implement stage that survived', () => {
    const taskVerify = out.phases
      .find((phase) => phase.id === 'execute')
      ?.steps.find((step) => step.id === 'execute-tasks')
      ?.fanOut?.inner.find((inner) => inner.id === 'task-verify');
    expect(taskVerify?.loopback).toBe('implement');
  });

  it('gives the implement agent the merged-lane prompt addendum', () => {
    const implement = out.agentConfigs?.implement;
    expect(implement?.promptAddendum).toContain('write-tests');
    expect(implement?.promptAddendum).toContain('code-review');
    // The addendum rides ALONGSIDE the pins — it must not replace them.
    expect(implement?.model).toBe('sonnet');
    expect(implement?.effort).toBe('medium');
  });

  it('defaults eval off', () => {
    expect(getTuningPreset('sprint', 'efficient')?.evalDefault).toBe(false);
  });

  it('leaves the outer phases intact', () => {
    expect(out.phases.map((phase) => phase.id)).toEqual(['plan', 'execute', 'verify']);
  });
});

describe('sprint × thorough', () => {
  const out = applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'thorough');

  it('makes no structural edit', () => {
    const structuralOnly = (def: WorkflowDefinition): string =>
      serializeDefinition({ id: def.id, phases: def.phases });
    expect(structuralOnly(out)).toBe(structuralOnly(WORKFLOW_DEFINITIONS.sprint));
  });

  it('pins every lane and review agent', () => {
    expect(out.agentConfigs?.implement).toEqual({ model: 'opus', effort: 'high' });
    expect(out.agentConfigs?.['sprint-review']).toEqual({ model: 'fable', effort: 'medium' });
  });

  it('leaves evalDefault unset (the jury is untouched above efficient)', () => {
    expect(getTuningPreset('sprint', 'thorough')?.evalDefault).toBeUndefined();
  });
});

describe('planner × efficient', () => {
  const out = applyTuningPreset(WORKFLOW_DEFINITIONS.planner, 'planner', 'efficient');
  const refineStepIds = out.phases.find((phase) => phase.id === 'refine')?.steps.map((s) => s.id);

  it('drops the optional design track and the separate task-detail step', () => {
    expect(refineStepIds).toEqual([
      'expand-spec',
      'approve-design',
      'epics',
      'approve-plan',
      'decompose',
    ]);
  });

  it('folds task detail into epic creation via an addendum', () => {
    expect(out.agentConfigs?.epics?.promptAddendum).toContain('task');
    expect(out.agentConfigs?.epics?.model).toBe('sonnet');
  });

  it('carries no pin for the removed tasks step', () => {
    expect(out.agentConfigs?.tasks).toBeUndefined();
  });

  it('re-homes the decomposed-stories artifact onto the merged epics step', () => {
    const epics = out.phases
      .find((phase) => phase.id === 'refine')
      ?.steps.find((step) => step.id === 'epics');
    expect(epics?.outputArtifact).toEqual({
      atype: 'decomposed-stories',
      label: 'Decomposed stories',
    });
  });
});

describe('planner × thorough', () => {
  const out = applyTuningPreset(WORKFLOW_DEFINITIONS.planner, 'planner', 'thorough');
  const refine = out.phases.find((phase) => phase.id === 'refine');

  it('turns every optional design step always-on', () => {
    for (const id of ['ui-prototype', 'architecture', 'adversarial-review', 'approve-design']) {
      expect(refine?.steps.find((step) => step.id === id)?.optional, id).toBe(false);
    }
  });

  it('leaves non-design optionality untouched', () => {
    const builtinRefine = WORKFLOW_DEFINITIONS.planner.phases.find((p) => p.id === 'refine');
    expect(refine?.steps.map((s) => s.id)).toEqual(builtinRefine?.steps.map((s) => s.id));
  });
});

describe('uncalibrated built-ins', () => {
  const uncalibrated: CyboflowWorkflowName[] = ['launch', 'compound', 'ship', 'verify-setup'];

  it.each(uncalibrated)('%s is structurally identical at every level', (flow) => {
    for (const level of TUNING_LEVELS) {
      expect(applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level)).toEqual(
        WORKFLOW_DEFINITIONS[flow],
      );
    }
  });

  it.each(uncalibrated)('%s only carries the eval lever at efficient', (flow) => {
    expect(getTuningPreset(flow, 'efficient')?.evalDefault).toBe(false);
    expect(getTuningPreset(flow, 'thorough')?.evalDefault).toBeUndefined();
  });
});

describe('mergeAgentConfigs precedence', () => {
  it('a pin overwrites only the fields it sets and preserves the rest of the entry', () => {
    const seeded: WorkflowDefinition = {
      ...WORKFLOW_DEFINITIONS.sprint,
      agentConfigs: {
        implement: { model: 'haiku', runtime: 'codex-sdk', providerModel: 'gpt-5.2-codex' },
      },
    };
    const out = applyTuningPreset(seeded, 'sprint', 'thorough');
    expect(out.agentConfigs?.implement).toEqual({
      model: 'opus',
      effort: 'high',
      runtime: 'codex-sdk',
      providerModel: 'gpt-5.2-codex',
    });
  });

  it('leaves agentConfigs absent when the preset contributes nothing', () => {
    const out = applyTuningPreset(WORKFLOW_DEFINITIONS.ship, 'ship', 'efficient');
    expect(out.agentConfigs).toBeUndefined();
  });
});

describe('resolveEffectiveDefinition', () => {
  const customSpec = JSON.stringify({
    id: 'sprint',
    phases: [
      {
        id: 'only',
        label: 'Only',
        color: '#3b6dd6',
        steps: [{ id: 'do-it', name: 'Do it', agent: 'implement', mcps: [], retries: 0 }],
      },
    ],
  });

  it('reads the custom slot at level custom, ignoring the built-in', () => {
    const out = resolveEffectiveDefinition('sprint', customSpec, 'custom');
    expect(out?.phases.map((phase) => phase.id)).toEqual(['only']);
  });

  it('ignores a populated custom slot at every preset level', () => {
    for (const level of ['efficient', 'standard', 'thorough'] as const) {
      const out = resolveEffectiveDefinition('sprint', customSpec, level);
      expect(serializeDefinition(out as WorkflowDefinition)).toBe(
        serializeDefinition(applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', level)),
      );
    }
  });

  it('falls back to the built-in when the custom slot is empty', () => {
    expect(resolveEffectiveDefinition('sprint', '{}', 'custom')).toEqual(
      WORKFLOW_DEFINITIONS.sprint,
    );
  });

  it('a non-built-in flow always resolves its own spec, whatever the level', () => {
    for (const level of TUNING_LEVELS) {
      const out = resolveEffectiveDefinition('my-custom-flow', customSpec, level);
      expect(out?.phases.map((phase) => phase.id)).toEqual(['only']);
    }
    expect(resolveEffectiveDefinition('my-custom-flow', '{}', 'standard')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// materializeForLevel — the RUN-side sibling. What createRun freezes.
// ---------------------------------------------------------------------------

describe('materializeForLevel', () => {
  const slotSpec = JSON.stringify({
    id: 'sprint',
    phases: [
      {
        id: 'only',
        label: 'Only',
        color: '#3b6dd6',
        steps: [{ id: 'do-it', name: 'Do it', agent: 'implement', mcps: [], retries: 0 }],
      },
    ],
  });

  it("standard is LITERALLY '{}' — the invariant the whole zero-change promise rests on", () => {
    // Not "a spec that parses to the built-in": the exact string, because it is
    // hashed into spec_hash and any other text would fork the revision history
    // of every flow nobody ever tuned.
    expect(materializeForLevel('sprint', '{}', 'standard')).toBe('{}');
    expect(materializeForLevel('sprint', slotSpec, 'standard')).toBe('{}');
    expect(materializeForLevel('planner', null, 'standard')).toBe('{}');
  });

  it('custom is the slot verbatim', () => {
    expect(materializeForLevel('sprint', slotSpec, 'custom')).toBe(slotSpec);
    expect(materializeForLevel('sprint', '{}', 'custom')).toBe('{}');
  });

  it('a preset level is the canonically serialized transform', () => {
    for (const level of PRESET_LEVELS) {
      expect(materializeForLevel('sprint', '{}', level)).toBe(
        serializeDefinition(applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', level)),
      );
    }
  });

  it('a preset level ignores whatever sits in the custom slot', () => {
    expect(materializeForLevel('sprint', slotSpec, 'efficient')).toBe(
      materializeForLevel('sprint', '{}', 'efficient'),
    );
  });

  it('every materialization round-trips to the same definition the read path resolves', () => {
    // The two halves of D1 must not drift: what a run FREEZES has to parse back
    // to what the editor/prompt side RESOLVES for the same flow at the same level.
    for (const name of CYBOFLOW_WORKFLOW_NAMES) {
      for (const level of TUNING_LEVELS) {
        const frozen = materializeForLevel(name, '{}', level);
        const fromRun = resolveWorkflowDefinition(name, frozen);
        const fromRead = resolveEffectiveDefinition(name, '{}', level);
        expect(serializeDefinition(fromRun as WorkflowDefinition)).toBe(
          serializeDefinition(fromRead as WorkflowDefinition),
        );
      }
    }
  });

  it('a non-built-in flow always materializes its own spec', () => {
    for (const level of TUNING_LEVELS) {
      expect(materializeForLevel('my-custom-flow', slotSpec, level)).toBe(slotSpec);
    }
  });
});
