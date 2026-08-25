/**
 * TuningLevelDial (editor simple-page dial) — estimate-label rendering
 * (plan D8, workflow-tuning-levels.md phase 7).
 *
 * Verifies: no estimate line / no caption when `estimateLabels` is absent;
 * a per-segment estimate line renders for whichever level(s) supply one; the
 * "excl. eval" caption appears whenever any label is present, and only then.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TuningLevelDial } from '../TuningLevelDial';

describe('TuningLevelDial (editor)', () => {
  it('renders no estimate lines and no caption when estimateLabels is omitted', () => {
    render(
      <TuningLevelDial
        level="standard"
        hasCustomDefinition={false}
        onSelect={vi.fn()}
        onCustomUnavailable={vi.fn()}
      />,
    );
    for (const level of ['efficient', 'standard', 'thorough', 'custom'] as const) {
      expect(screen.queryByTestId(`tuning-level-estimate-${level}`)).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId('tuning-estimate-caption')).not.toBeInTheDocument();
  });

  it('renders an estimate line only for the levels that supply one, plus the excl.-eval caption', () => {
    render(
      <TuningLevelDial
        level="standard"
        hasCustomDefinition={false}
        onSelect={vi.fn()}
        onCustomUnavailable={vi.fn()}
        estimateLabels={{ efficient: '~150k', standard: '~300k' }}
      />,
    );
    expect(screen.getByTestId('tuning-level-estimate-efficient')).toHaveTextContent('~150k');
    expect(screen.getByTestId('tuning-level-estimate-standard')).toHaveTextContent('~300k');
    expect(screen.queryByTestId('tuning-level-estimate-thorough')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tuning-level-estimate-custom')).not.toBeInTheDocument();
    expect(screen.getByTestId('tuning-estimate-caption')).toHaveTextContent(/excl\. eval/i);
  });

  it('renders no caption for an empty estimateLabels object', () => {
    render(
      <TuningLevelDial
        level="standard"
        hasCustomDefinition={false}
        onSelect={vi.fn()}
        onCustomUnavailable={vi.fn()}
        estimateLabels={{}}
      />,
    );
    expect(screen.queryByTestId('tuning-estimate-caption')).not.toBeInTheDocument();
  });
});
