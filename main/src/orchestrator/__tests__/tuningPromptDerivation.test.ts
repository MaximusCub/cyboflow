/**
 * Tuning-level prompt derivation (plan D9 + D7).
 *
 * These tests build the COMPLETE effective orchestrated prompt — the real
 * `.md` body from `main/src/orchestrator/workflows/` plus BOTH generated appends
 * (step-reporting + fan-out execution) — the way `RunExecutor.getPrompt` does, and
 * assert two opposing properties:
 *
 *   1. an EFFICIENT sprint / ship run is never instructed to drive a lane step its
 *      frozen definition removed (which `cyboflow_update_sprint_task` would reject
 *      as out-of-vocabulary), and
 *   2. a STANDARD run's GENERATED text is byte-identical to what the generator
 *      emitted before levels existed — the level threading can only ever add the
 *      `thorough` viewport clause.
 *
 * They read the shipped prompt bodies deliberately: a future edit that
 * re-introduces a hard-coded lane id into the prose is exactly the regression D9
 * exists to prevent, and only a test over the real file can catch it.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { readWorkflowPromptForRow } from '../workflowPromptReaderAdapter';
import { buildFanOutAppend } from '../prompts/fan-out-instructions';
import { buildStepReportingAppend } from '../prompts/step-reporting-instructions';
import {
  materializeForLevel,
  type TuningLevel,
} from '../../../../shared/tuning/workflowTuning';
import {
  resolveWorkflowDefinition,
  type WorkflowRow,
} from '../../../../shared/types/workflows';
import { AWAITING_VERIFY_STEP } from '../../../../shared/types/sprintBatch';

const WORKFLOWS_DIR = join(__dirname, '..', 'workflows');

/** The lane steps `sprint-efficient` removes from the fan-out inner chain. */
const REMOVED_AT_EFFICIENT = ['write-tests', 'code-review', 'visual-verify'] as const;

function makeRow(name: string, mdFile: string): WorkflowRow {
  return {
    id: `wf-${name}`,
    project_id: 1,
    name,
    workflow_path: join(WORKFLOWS_DIR, mdFile),
    permission_mode: 'default',
    spec_json: '',
    tuning_level: 'standard',
    created_at: new Date().toISOString(),
    archived_at: null,
  };
}

/**
 * The full text the orchestrating session actually receives: the run prompt plus
 * the system-prompt append. Both halves must be searched — the hard-coded lane
 * vocabulary D9 scrubbed lived in the `.md` half, and the derived chain lives in
 * the append half.
 */
function effectivePromptFor(row: WorkflowRow, level: TuningLevel): string {
  const specJson = materializeForLevel(row.name, row.spec_json, level);
  const { prompt, systemPromptAppend } = readWorkflowPromptForRow(row, {
    specJson,
    tuningLevel: level,
  });
  return `${prompt}\n\n${systemPromptAppend}`;
}

describe('D9 — an efficient run is never instructed to drive a removed lane step', () => {
  for (const [flow, mdFile] of [
    ['sprint', 'sprint.md'],
    ['ship', 'ship.md'],
  ] as const) {
    it(`${flow}: the standard prompt names every lane step and the efficient one names none of the removed ones`, () => {
      const row = makeRow(flow, mdFile);

      // Sanity floor: at STANDARD the ids must be present, otherwise the
      // efficient assertion below would pass vacuously.
      const standard = effectivePromptFor(row, 'standard');
      for (const id of REMOVED_AT_EFFICIENT) {
        expect(standard).toContain(id);
      }

      // Ship's efficient inherits sprint's lane collapse verbatim (its Execute
      // phase IS sprint's), so both flows lose the same lane steps.
      const efficient = effectivePromptFor(row, 'efficient');
      for (const id of REMOVED_AT_EFFICIENT) {
        expect(efficient).not.toContain(id);
      }
    });
  }

  it('sprint: the efficient chain is exactly implement -> task-verify', () => {
    const def = resolveWorkflowDefinition('sprint', materializeForLevel('sprint', '', 'efficient'));
    const chain = def?.phases
      .flatMap((phase) => phase.steps)
      .flatMap((step) => step.fanOut?.inner ?? [])
      .map((inner) => inner.id);
    expect(chain).toEqual(['implement', 'task-verify']);
  });

  it('sprint: an efficient run is never told to park at awaiting-verify', () => {
    // `awaiting-verify` is a runtime PARK state, not a definition step: the MCP
    // write path always widens the allowed ids with it, so a stray write would be
    // accepted rather than rejected — but with no visual merge-gate in the chain
    // there is no verdict to un-park the lane, so the prompt must never send it
    // there. Only the `visual-verify` chain entry introduces the id, and that
    // entry is not rendered when the step is gone.
    const row = makeRow('sprint', 'sprint.md');
    expect(effectivePromptFor(row, 'standard')).toContain(AWAITING_VERIFY_STEP);
    expect(effectivePromptFor(row, 'efficient')).not.toContain(AWAITING_VERIFY_STEP);
  });

  it('sprint/ship prose carries no hard-coded lane vocabulary of its own', () => {
    // The `.md` half alone — the generated append is allowed (indeed required) to
    // name the ids; the PROSE must not, or a removed step is prescribed anyway.
    for (const [flow, mdFile] of [
      ['sprint', 'sprint.md'],
      ['ship', 'ship.md'],
    ] as const) {
      const { prompt } = readWorkflowPromptForRow(makeRow(flow, mdFile));
      for (const id of REMOVED_AT_EFFICIENT) {
        expect(prompt).not.toContain(id);
      }
    }
  });

  it('planner: the generated step list drops the steps planner-efficient removes', () => {
    // Planner's removed ids legitimately survive in NON-OPERATIVE prose (the
    // `ui-prototype` ARTIFACT atype, the component-ledger table), so plain absence
    // is the wrong assertion here. What must adapt is the generated authoritative
    // step list — and planner.md now defers to it rather than prescribing its own.
    const efficientDef = resolveWorkflowDefinition(
      'planner',
      materializeForLevel('planner', '', 'efficient'),
    );
    const stepList = buildStepReportingAppend(efficientDef);
    for (const id of ['ui-prototype', 'architecture', 'adversarial-review', 'tasks']) {
      expect(stepList).not.toContain(`\`${id}\``);
    }
    expect(stepList).toContain('`context`');
    expect(stepList).toContain('`epics`');

    const { prompt } = readWorkflowPromptForRow(makeRow('planner', 'planner.md'));
    expect(prompt).toContain("authoritative step set");
    // The old hand-maintained "these 11 step ids" list is gone — it could only
    // ever contradict a tuned or edited definition.
    expect(prompt).not.toContain('11 step ids');
  });
});

describe('D9 — a standard run is byte-identical to the pre-levels output', () => {
  it('the generated fan-out block is unchanged at every non-thorough level', () => {
    const def = resolveWorkflowDefinition('sprint', '{}');
    // No options at all is EXACTLY the call shape that existed before the
    // tuningLevel option was added, so this is the pre-change golden.
    const preChange = buildFanOutAppend(def);
    for (const level of [undefined, null, 'standard', 'custom', 'efficient'] as const) {
      expect(buildFanOutAppend(def, { tuningLevel: level })).toBe(preChange);
    }
  });

  it('passing a standard run context changes nothing vs. the context-free read', () => {
    // The context-free call is what index.ts did before the frozen-spec threading,
    // so equality here is the regression guard for that seam.
    for (const [flow, mdFile] of [
      ['sprint', 'sprint.md'],
      ['ship', 'ship.md'],
      ['planner', 'planner.md'],
    ] as const) {
      const row = makeRow(flow, mdFile);
      expect(
        readWorkflowPromptForRow(row, { specJson: '{}', tuningLevel: 'standard' }),
      ).toEqual(readWorkflowPromptForRow(row));
      // An unattributed run (variant / pre-feature / non-built-in) is treated the
      // same way — never a level-specific variation.
      expect(readWorkflowPromptForRow(row, { specJson: '', tuningLevel: null })).toEqual(
        readWorkflowPromptForRow(row),
      );
    }
  });
});

describe('D7 — viewport depth guidance by level', () => {
  const def = resolveWorkflowDefinition('sprint', '{}');

  it('thorough adds exactly one viewport clause and nothing else', () => {
    const standard = buildFanOutAppend(def);
    const thorough = buildFanOutAppend(def, { tuningLevel: 'thorough' });
    expect(thorough).not.toBe(standard);
    expect(thorough).toContain('desktop, tablet, and mobile');
    // The ONLY difference is the appended clause: removing it restores the
    // standard text byte for byte.
    const clause = thorough.slice(thorough.indexOf(' This run is tuned **thorough**'));
    const clauseEnd = clause.indexOf('\n');
    const onlyDiff = clauseEnd === -1 ? clause : clause.slice(0, clauseEnd);
    expect(thorough.replace(onlyDiff, '')).toBe(standard);
  });

  it('no other level emits a viewport clause', () => {
    for (const level of [undefined, null, 'standard', 'custom', 'efficient'] as const) {
      expect(buildFanOutAppend(def, { tuningLevel: level })).not.toContain('viewports');
    }
  });

  it('thorough emits nothing when the chain carries no visual merge-gate', () => {
    // An efficient-shaped graph that a custom edit kept at `thorough`: with the
    // gate removed there is no composed verification task to deepen, so the
    // guidance would have no addressee.
    const gateless = resolveWorkflowDefinition(
      'sprint',
      materializeForLevel('sprint', '', 'efficient'),
    );
    expect(buildFanOutAppend(gateless, { tuningLevel: 'thorough' })).toBe(
      buildFanOutAppend(gateless),
    );
  });
});
