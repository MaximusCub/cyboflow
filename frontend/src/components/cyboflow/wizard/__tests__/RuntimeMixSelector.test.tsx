/**
 * RuntimeMixSelector — isolated component tests (no wizard/tRPC scaffolding),
 * mirroring its TuningLevelSelector sibling.
 *
 * Verifies:
 *   (a) all four segments render, with the shown value selected;
 *   (b) picking a segment reports it via onChange;
 *   (c) the description line tracks the selection and carries "· saved default"
 *       only while the shown value IS the workflow's stamp;
 *   (d) `mixedDisabled` greys ONLY the two cross-provider segments (a flow with
 *       an empty verification class), leaving claude/codex pickable;
 *   (e) `disabled` greys the whole row and swaps the description for the note.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { RuntimeMixSelector } from '../RuntimeMixSelector';

describe('RuntimeMixSelector', () => {
  it('(a) renders the four mixes and marks the shown value selected', () => {
    render(
      <RuntimeMixSelector
        value="claude"
        savedMix="claude"
        mixedDisabled={false}
        onChange={vi.fn()}
      />,
    );
    for (const mix of ['claude', 'claude-primary', 'codex-primary', 'codex']) {
      expect(screen.getByTestId(`wizard-runtime-mix-${mix}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('wizard-runtime-mix-claude')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('wizard-runtime-mix-codex')).toHaveAttribute('aria-checked', 'false');
    // Two-line labels: the version's name on top, the secondary provider below.
    expect(screen.getByTestId('wizard-runtime-mix-codex-primary')).toHaveTextContent('CODEX PRIMARY');
    expect(screen.getByTestId('wizard-runtime-mix-codex-primary')).toHaveTextContent('claude secondary');
    expect(screen.getByTestId('wizard-runtime-mix-claude-primary')).toHaveTextContent('codex secondary');
    expect(screen.getByTestId('wizard-runtime-mix-codex')).toHaveTextContent('only');
  });

  it('(b) clicking a segment reports it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RuntimeMixSelector
        value="claude"
        savedMix="claude"
        mixedDisabled={false}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByTestId('wizard-runtime-mix-codex-primary'));
    expect(onChange).toHaveBeenCalledWith('codex-primary');
  });

  it('(c) the description tracks the selection and marks the saved default', () => {
    const { rerender } = render(
      <RuntimeMixSelector
        value="claude"
        savedMix="claude"
        mixedDisabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('wizard-runtime-mix-desc')).toHaveTextContent(
      'Everything on Claude, model tailored to the task and effort level. · saved default',
    );

    // Diverged from the stamp: the copy changes AND the marker drops.
    rerender(
      <RuntimeMixSelector
        value="codex-primary"
        savedMix="claude"
        mixedDisabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('wizard-runtime-mix-desc')).toHaveTextContent(
      'Codex executes, Claude reviews & verifies.',
    );
    expect(screen.getByTestId('wizard-runtime-mix-desc')).not.toHaveTextContent('saved default');

    // …and back on the stamp again, at a different mix.
    rerender(
      <RuntimeMixSelector
        value="codex-primary"
        savedMix="codex-primary"
        mixedDisabled={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('wizard-runtime-mix-desc')).toHaveTextContent('saved default');
  });

  it('(d) mixedDisabled disables ONLY the two cross-provider segments', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RuntimeMixSelector
        value="claude"
        savedMix="claude"
        mixedDisabled
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('wizard-runtime-mix-claude-primary')).toBeDisabled();
    expect(screen.getByTestId('wizard-runtime-mix-codex-primary')).toBeDisabled();
    expect(screen.getByTestId('wizard-runtime-mix-claude-primary')).toHaveAttribute(
      'title',
      'This flow has no verification steps to cross between providers.',
    );
    // The two whole-flow segments stay pickable — a single-agent flow still has
    // a meaningful provider choice.
    expect(screen.getByTestId('wizard-runtime-mix-claude')).not.toBeDisabled();
    const codex = screen.getByTestId('wizard-runtime-mix-codex');
    expect(codex).not.toBeDisabled();
    await user.click(codex);
    expect(onChange).toHaveBeenCalledWith('codex');
  });

  it('(e) disabled greys every segment and shows the note instead of the description', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RuntimeMixSelector
        value="claude"
        savedMix="claude"
        mixedDisabled={false}
        disabled
        disabledNote="Single-provider lane — the runtime mix does not apply."
        onChange={onChange}
      />,
    );
    for (const mix of ['claude', 'claude-primary', 'codex-primary', 'codex']) {
      expect(screen.getByTestId(`wizard-runtime-mix-${mix}`)).toBeDisabled();
    }
    await user.click(screen.getByTestId('wizard-runtime-mix-codex'));
    expect(onChange).not.toHaveBeenCalled();

    expect(screen.getByTestId('wizard-runtime-mix-note')).toHaveTextContent(
      'Single-provider lane — the runtime mix does not apply.',
    );
    expect(screen.queryByTestId('wizard-runtime-mix-desc')).not.toBeInTheDocument();
  });
});
