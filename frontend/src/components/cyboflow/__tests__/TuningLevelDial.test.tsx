/**
 * TuningLevelDial (editor simple-page dial) — estimate labels, the CUSTOM
 * vacancy, and the card selection language
 * (plan D8 / D3, workflow-tuning-levels.md phase 7).
 *
 * Verifies: no estimate line / no caption when `estimateLabels` is absent;
 * a per-segment estimate line renders for whichever level(s) supply one; the
 * "excl. eval" caption appears whenever any label is present, and only then.
 * Plus: the empty-slot hint lives ON the CUSTOM card (it is that card's
 * description, not a detached paragraph), clicking that card still routes to
 * `onCustomUnavailable`, and every card renders its ACTIVE tick so selection
 * never changes the row's height.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CUSTOM_UNAVAILABLE_HINT, TuningLevelDial } from '../TuningLevelDial';

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

  it('carries the empty-slot hint ON the CUSTOM card, as its description', () => {
    render(
      <TuningLevelDial
        level="standard"
        hasCustomDefinition={false}
        onSelect={vi.fn()}
        onCustomUnavailable={vi.fn()}
      />,
    );

    const custom = screen.getByTestId('tuning-level-segment-custom');
    const hint = within(custom).getByTestId('tuning-custom-hint');
    expect(hint).toHaveTextContent(CUSTOM_UNAVAILABLE_HINT);
    // The vacancy is drawn as a vacancy, not as a fourth selectable preset.
    // (Asserted on the style attribute: jsdom drops a shorthand carrying var().)
    expect(custom.getAttribute('style')).toContain('dashed');
  });

  it('describes a FILLED custom slot instead of hinting, and enables the card', () => {
    render(
      <TuningLevelDial
        level="standard"
        hasCustomDefinition
        onSelect={vi.fn()}
        onCustomUnavailable={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('tuning-custom-hint')).not.toBeInTheDocument();
    const custom = screen.getByTestId('tuning-level-segment-custom');
    expect(custom).toHaveTextContent('Your definition');
    expect(custom).toHaveAttribute('aria-disabled', 'false');
  });

  it('routes a click on the empty CUSTOM card to onCustomUnavailable, never to onSelect', () => {
    const onSelect = vi.fn();
    const onCustomUnavailable = vi.fn();
    render(
      <TuningLevelDial
        level="standard"
        hasCustomDefinition={false}
        onSelect={onSelect}
        onCustomUnavailable={onCustomUnavailable}
      />,
    );

    fireEvent.click(screen.getByTestId('tuning-level-segment-custom'));
    expect(onCustomUnavailable).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('swallows every click while busy', () => {
    const onSelect = vi.fn();
    const onCustomUnavailable = vi.fn();
    render(
      <TuningLevelDial
        level="standard"
        hasCustomDefinition={false}
        onSelect={onSelect}
        onCustomUnavailable={onCustomUnavailable}
        busy
      />,
    );

    fireEvent.click(screen.getByTestId('tuning-level-segment-efficient'));
    fireEvent.click(screen.getByTestId('tuning-level-segment-custom'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCustomUnavailable).not.toHaveBeenCalled();
  });

  it('renders the ACTIVE tick on every card — transparent unless selected — so the row never jumps', () => {
    render(
      <TuningLevelDial
        level="thorough"
        hasCustomDefinition
        onSelect={vi.fn()}
        onCustomUnavailable={vi.fn()}
      />,
    );

    for (const level of ['efficient', 'standard', 'thorough', 'custom'] as const) {
      const card = screen.getByTestId(`tuning-level-segment-${level}`);
      const tick = within(card).getByText('● ACTIVE');
      expect(tick.getAttribute('style')).toContain(
        level === 'thorough' ? 'color: var(--color-interactive-primary)' : 'color: transparent',
      );
    }
    expect(screen.getByTestId('tuning-level-segment-thorough')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
