/**
 * ResumeSessionPrompt — the Claude-switched-off variant.
 *
 * Resuming SPAWNS a claude REPL, so the provider toggle governs it. The refusal
 * used to be invisible (the handler's spawn is fire-and-forget, so the prompt
 * closed onto a blank terminal), and the fix is as much copy as plumbing: say
 * Claude is off, offer the Settings shortcut, and still offer to go ahead —
 * because unlike a refused SDK turn, declining here destroys the conversation's
 * history for good.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResumeSessionPrompt } from '../ResumeSessionPrompt';

function renderPrompt(over: Partial<React.ComponentProps<typeof ResumeSessionPrompt>> = {}) {
  const props = {
    isOpen: true,
    onClose: vi.fn(),
    onResume: vi.fn(),
    onStartFresh: vi.fn(),
    ...over,
  };
  render(<ResumeSessionPrompt {...props} />);
  return props;
}

describe('ResumeSessionPrompt — Claude enabled (unchanged)', () => {
  it('shows no warning and keeps the original primary label', () => {
    renderPrompt();
    expect(screen.queryByTestId('resume-prompt-claude-disabled')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume previous session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Settings/ })).not.toBeInTheDocument();
  });
});

describe('ResumeSessionPrompt — Claude switched off', () => {
  it('names the reason concretely instead of failing silently', () => {
    renderPrompt({ claudeDisabled: true, onOpenSettings: vi.fn() });
    const warning = screen.getByTestId('resume-prompt-claude-disabled');
    expect(warning).toHaveTextContent(/Claude is turned off/);
    expect(warning).toHaveTextContent(/Settings → Integrations/);
    // The copy must be honest about what resuming does and does NOT restore:
    // the history comes back, sending stays blocked.
    expect(warning).toHaveTextContent(/recover its history/);
    expect(warning).toHaveTextContent(/won't be able to send/);
  });

  it('still offers to resume — declining is what loses the history', async () => {
    const props = renderPrompt({ claudeDisabled: true, onOpenSettings: vi.fn() });
    const resume = screen.getByRole('button', { name: 'Resume anyway' });
    await userEvent.click(resume);
    expect(props.onResume).toHaveBeenCalledTimes(1);
  });

  it('offers the Settings shortcut as the way to actually fix it', async () => {
    const onOpenSettings = vi.fn();
    renderPrompt({ claudeDisabled: true, onOpenSettings });
    await userEvent.click(screen.getByRole('button', { name: /Open Settings/ }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps "Start fresh" available', async () => {
    const props = renderPrompt({ claudeDisabled: true, onOpenSettings: vi.fn() });
    await userEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(props.onStartFresh).toHaveBeenCalledTimes(1);
  });

  it('omits the Settings button when the host supplies no handler', () => {
    renderPrompt({ claudeDisabled: true });
    expect(screen.getByTestId('resume-prompt-claude-disabled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Settings/ })).not.toBeInTheDocument();
  });
});
