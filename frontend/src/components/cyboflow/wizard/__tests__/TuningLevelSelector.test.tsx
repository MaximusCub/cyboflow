/**
 * TuningLevelSelector — isolated component tests (no wizard/tRPC scaffolding).
 *
 * Verifies:
 *   (a) the saved level is tagged;
 *   (b) picking a non-saved segment reports it and shows the override caption;
 *   (c) Custom is disabled with a hint while the slot is empty, selectable once filled;
 *   (d) `disabled` greys out every segment (incl. Custom) and swaps in the
 *       variant-pinned note instead of an override caption.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TuningLevelSelector } from '../TuningLevelSelector';

describe('TuningLevelSelector', () => {
  it('(a) tags the saved level and shows no override caption when value === savedLevel', () => {
    render(
      <TuningLevelSelector
        value="standard"
        savedLevel="standard"
        flowTitle="Sprint"
        customSlotAvailable={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('wizard-tuning-level-standard-saved-tag')).toBeInTheDocument();
    expect(screen.queryByTestId('wizard-tuning-level-efficient-saved-tag')).not.toBeInTheDocument();
    expect(screen.queryByTestId('wizard-tuning-level-override-note')).not.toBeInTheDocument();
  });

  it('(b) clicking a non-saved segment reports it and renders the override caption', () => {
    const onChange = vi.fn();
    render(
      <TuningLevelSelector
        value="standard"
        savedLevel="standard"
        flowTitle="Sprint"
        customSlotAvailable={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('wizard-tuning-level-thorough'));
    expect(onChange).toHaveBeenCalledWith('thorough');

    // Re-render as the parent would after applying the pick.
    render(
      <TuningLevelSelector
        value="thorough"
        savedLevel="standard"
        flowTitle="Sprint"
        customSlotAvailable={false}
        onChange={onChange}
      />,
    );
    const note = screen.getAllByTestId('wizard-tuning-level-override-note')[0];
    expect(note).toHaveTextContent('Override for this run only — the Sprint workflow keeps Standard.');
  });

  it('(c) Custom is disabled with a hint while the slot is empty, and clickable once filled', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <TuningLevelSelector
        value="standard"
        savedLevel="standard"
        flowTitle="Sprint"
        customSlotAvailable={false}
        onChange={onChange}
      />,
    );
    const customBtn = screen.getByTestId('wizard-tuning-level-custom');
    expect(customBtn).toBeDisabled();
    fireEvent.click(customBtn);
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <TuningLevelSelector
        value="standard"
        savedLevel="standard"
        flowTitle="Sprint"
        customSlotAvailable
        onChange={onChange}
      />,
    );
    const enabledCustomBtn = screen.getByTestId('wizard-tuning-level-custom');
    expect(enabledCustomBtn).not.toBeDisabled();
    fireEvent.click(enabledCustomBtn);
    expect(onChange).toHaveBeenCalledWith('custom');
  });

  it('(d) disabled=true greys out every segment, incl. Custom with a slot, and shows the variant note', () => {
    const onChange = vi.fn();
    render(
      <TuningLevelSelector
        value="thorough"
        savedLevel="standard"
        flowTitle="Sprint"
        customSlotAvailable
        disabled
        onChange={onChange}
      />,
    );
    for (const level of ['efficient', 'standard', 'thorough', 'custom'] as const) {
      expect(screen.getByTestId(`wizard-tuning-level-${level}`)).toBeDisabled();
    }
    fireEvent.click(screen.getByTestId('wizard-tuning-level-efficient'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('wizard-tuning-level-variant-note')).toBeInTheDocument();
    // No override caption while disabled, even though value !== savedLevel.
    expect(screen.queryByTestId('wizard-tuning-level-override-note')).not.toBeInTheDocument();
  });
});
