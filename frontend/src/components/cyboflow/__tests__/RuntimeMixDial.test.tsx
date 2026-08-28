/**
 * RuntimeMixDial (editor simple-page dial) — segment rendering, selection,
 * `mixedDisabled` gating the two cross-provider segments only, `busy`
 * swallowing clicks, and the per-mix description line
 * (plan `docs/plans/workflow-runtime-mix.md` D4).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RuntimeMixDial } from '../RuntimeMixDial';

describe('RuntimeMixDial (editor)', () => {
  it('renders all four segments with aria-pressed on the selected one', () => {
    render(
      <RuntimeMixDial mix="claude-primary" mixedDisabled={false} onSelect={vi.fn()} />,
    );

    for (const mix of ['claude', 'claude-primary', 'codex-primary', 'codex']) {
      expect(screen.getByTestId(`runtime-mix-segment-${mix}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('runtime-mix-segment-claude-primary')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId('runtime-mix-segment-claude')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('clicking a segment calls onSelect with that mix', () => {
    const onSelect = vi.fn();
    render(<RuntimeMixDial mix="claude" mixedDisabled={false} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId('runtime-mix-segment-codex'));
    expect(onSelect).toHaveBeenCalledWith('codex');
  });

  it('mixedDisabled disables exactly the two cross-provider segments, with a title', () => {
    const onSelect = vi.fn();
    render(<RuntimeMixDial mix="claude" mixedDisabled onSelect={onSelect} />);

    const crossHint = 'This flow has no verification steps to cross between providers.';
    expect(screen.getByTestId('runtime-mix-segment-claude-primary')).toBeDisabled();
    expect(screen.getByTestId('runtime-mix-segment-claude-primary')).toHaveAttribute(
      'title',
      crossHint,
    );
    expect(screen.getByTestId('runtime-mix-segment-codex-primary')).toBeDisabled();
    expect(screen.getByTestId('runtime-mix-segment-codex-primary')).toHaveAttribute(
      'title',
      crossHint,
    );

    expect(screen.getByTestId('runtime-mix-segment-claude')).not.toBeDisabled();
    expect(screen.getByTestId('runtime-mix-segment-codex')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('runtime-mix-segment-claude-primary'));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('runtime-mix-segment-codex'));
    expect(onSelect).toHaveBeenCalledWith('codex');
  });

  it('swallows every click while busy', () => {
    const onSelect = vi.fn();
    render(<RuntimeMixDial mix="claude" mixedDisabled={false} onSelect={onSelect} busy />);

    fireEvent.click(screen.getByTestId('runtime-mix-segment-codex'));
    fireEvent.click(screen.getByTestId('runtime-mix-segment-claude-primary'));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the description matching the selected mix', () => {
    const { rerender } = render(
      <RuntimeMixDial mix="claude" mixedDisabled={false} onSelect={vi.fn()} />,
    );
    expect(screen.getByTestId('runtime-mix-desc')).toHaveTextContent(
      'Everything on Claude, model tailored to the task and effort level.',
    );

    rerender(<RuntimeMixDial mix="claude-primary" mixedDisabled={false} onSelect={vi.fn()} />);
    expect(screen.getByTestId('runtime-mix-desc')).toHaveTextContent(
      'Claude executes, Codex reviews & verifies.',
    );

    rerender(<RuntimeMixDial mix="codex-primary" mixedDisabled={false} onSelect={vi.fn()} />);
    expect(screen.getByTestId('runtime-mix-desc')).toHaveTextContent(
      'Codex executes, Claude reviews & verifies.',
    );

    rerender(<RuntimeMixDial mix="codex" mixedDisabled={false} onSelect={vi.fn()} />);
    expect(screen.getByTestId('runtime-mix-desc')).toHaveTextContent(
      'Everything on Codex, model tailored to the task and effort level.',
    );
  });
});
