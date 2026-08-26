/**
 * TuningPhaseStrip (editor simple-page "what runs at this level") — the diff
 * rendering (plan `docs/plans/workflow-tuning-levels.md` §4).
 *
 * Verifies against the REAL sprint built-in resolved through the shared
 * transform, not a hand-built fixture: the strip's whole job is to be derived,
 * so a fixture would prove only that the fixture renders. Covered here: a step
 * the preset removes stays on screen struck through, a pinned agent's chip
 * carries a colour-coded `model · effort` sub-label, a human gate reads
 * "human", and a fan-out lane renders FLAT with "per task" on the phase label.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { resolveEffectiveDefinition } from '../../../../../shared/tuning/workflowTuning';
import { MODEL_COLORS, TuningPhaseStrip } from '../TuningPhaseStrip';

/** The sprint built-in at a level — the flow whose lane chain a level changes most. */
function sprintAt(level: 'standard' | 'efficient') {
  const definition = resolveEffectiveDefinition('sprint', null, level);
  if (definition === null) throw new Error(`sprint did not resolve at ${level}`);
  return definition;
}

/** The ship built-in — UNCALIBRATED, so its standard carries no pins at all. */
function shipAt(level: 'standard') {
  const definition = resolveEffectiveDefinition('ship', null, level);
  if (definition === null) throw new Error(`ship did not resolve at ${level}`);
  return definition;
}

/** The chip's name span (first child) — where the strike-through lives. */
function nameOf(chip: HTMLElement): Element {
  const name = chip.firstElementChild;
  if (name === null) throw new Error('chip has no name span');
  return name;
}

/** The chip's sub-label span (second child) — model · effort, agent key, or "removed". */
function subOf(chip: HTMLElement): Element {
  const sub = chip.children[1];
  if (sub === undefined) throw new Error('chip has no sub-label span');
  return sub;
}

describe('TuningPhaseStrip', () => {
  it('renders an honest placeholder for an unresolved definition', () => {
    render(<TuningPhaseStrip definition={null} baselineDefinition={null} />);
    expect(screen.getByTestId('tuning-phase-strip-unresolved')).toBeInTheDocument();
    expect(screen.queryByTestId('tuning-phase-strip')).toBeNull();
  });

  it('renders fan-out lane steps FLAT and marks the phase "per task"', () => {
    const standard = sprintAt('standard');
    render(<TuningPhaseStrip definition={standard} baselineDefinition={standard} />);

    // The whole lane chain is chips in the phase band…
    for (const inner of ['implement', 'write-tests', 'code-review', 'task-verify', 'visual-verify']) {
      expect(screen.getByTestId(`tuning-lane-chip-${inner}`)).toBeInTheDocument();
    }
    // …and the outer fan-out step is scaffolding, not a chip of its own.
    expect(screen.queryByTestId('tuning-step-chip-execute-tasks')).toBeNull();
    expect(screen.queryByTestId('tuning-lane-chain-execute-tasks')).toBeNull();

    expect(screen.getByTestId('tuning-phase-group-execute')).toHaveTextContent('per task');
    // A phase with no fan-out does not claim one.
    expect(screen.getByTestId('tuning-phase-group-plan')).not.toHaveTextContent('per task');
  });

  it('keeps a step the preset removed on screen, struck through and labelled "removed"', () => {
    render(
      <TuningPhaseStrip definition={sprintAt('efficient')} baselineDefinition={sprintAt('standard')} />,
    );

    const removed = screen.getByTestId('tuning-lane-chip-code-review');
    expect(nameOf(removed)).toHaveStyle({ textDecoration: 'line-through' });
    expect(subOf(removed)).toHaveTextContent('removed');

    // A step the preset KEEPS is not marked removed.
    expect(subOf(screen.getByTestId('tuning-lane-chip-implement'))).not.toHaveTextContent('removed');
  });

  it('drops the diff entirely when there is no baseline to compare against', () => {
    render(<TuningPhaseStrip definition={sprintAt('efficient')} baselineDefinition={null} />);
    // Nothing to diff against ⇒ the strip is a plain listing of what runs.
    expect(screen.queryByTestId('tuning-lane-chip-code-review')).toBeNull();
    expect(screen.getByTestId('tuning-lane-chip-implement')).toBeInTheDocument();
  });

  it('colours a pinned chip by its model and reads "model · effort"', () => {
    render(
      <TuningPhaseStrip definition={sprintAt('efficient')} baselineDefinition={sprintAt('standard')} />,
    );

    const chip = screen.getByTestId('tuning-lane-chip-implement');
    expect(screen.getByTestId('tuning-lane-chip-implement-pin')).toHaveTextContent('sonnet · medium');
    expect(subOf(chip)).toHaveStyle({ color: MODEL_COLORS.sonnet });
    expect(chip).toHaveStyle({ borderLeft: `3px solid ${MODEL_COLORS.sonnet}` });
  });

  it('falls back to the honest "run model" tag for a step nothing pins', () => {
    // Ship is UNCALIBRATED: its standard is the as-authored identity, so its
    // steps carry no level pin — and with no catalogue targets either, the
    // model is only decided at launch.
    const standard = shipAt('standard');
    render(<TuningPhaseStrip definition={standard} baselineDefinition={standard} />);

    expect(screen.queryByTestId('tuning-step-chip-context-pin')).toBeNull();
    expect(subOf(screen.getByTestId('tuning-step-chip-context'))).toHaveTextContent('run model');
  });

  it('falls back to the agent catalogue run target when the level pins nothing', () => {
    const standard = shipAt('standard');
    render(
      <TuningPhaseStrip
        definition={standard}
        baselineDefinition={standard}
        agentRunTargets={{
          // A Claude-model catalogue pin: alias tag, coloured like a level pin.
          context: { runtime: null, model: 'opus', providerModel: null },
          // A non-Claude provider: the provider-model id, uncoloured.
          'ui-prototype': { runtime: 'codex-sdk', model: null, providerModel: 'gpt-5.4-codex' },
        }}
      />,
    );

    const claude = screen.getByTestId('tuning-step-chip-context');
    expect(subOf(claude)).toHaveTextContent('opus');
    expect(subOf(claude)).toHaveStyle({ color: MODEL_COLORS.opus });
    expect(claude).toHaveStyle({ borderLeft: `3px solid ${MODEL_COLORS.opus}` });
    // Catalogue fallback is not a LEVEL pin — no pin testid.
    expect(screen.queryByTestId('tuning-step-chip-context-pin')).toBeNull();

    expect(subOf(screen.getByTestId('tuning-step-chip-ui-prototype'))).toHaveTextContent(
      'gpt-5.4-codex',
    );
  });

  it('standard on the calibrated sprint shows the aligned-defaults pins', () => {
    const standard = sprintAt('standard');
    render(<TuningPhaseStrip definition={standard} baselineDefinition={standard} />);
    expect(screen.getByTestId('tuning-lane-chip-implement-pin')).toHaveTextContent('sonnet · high');
    expect(screen.getByTestId('tuning-lane-chip-code-review-pin')).toHaveTextContent('opus · high');
  });

  it('reads a human gate as "human" rather than as an agent', () => {
    const standard = sprintAt('standard');
    render(<TuningPhaseStrip definition={standard} baselineDefinition={standard} />);

    const gate = screen.getByTestId('tuning-step-chip-human-review');
    expect(subOf(gate)).toHaveTextContent('human');
  });
});
