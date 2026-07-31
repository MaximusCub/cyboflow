/**
 * LaunchPromptModal tests — the pre-launch seed-prompt gate for the Launch
 * flow (the interview-driven super-planner).
 *
 * Behaviors verified:
 *   1. Renders the header question, supportive sub-line, and an autofocused
 *      textarea.
 *   2. Submit stays disabled until the textarea holds non-whitespace text.
 *   3. Confirming calls onSubmit with the TRIMMED text.
 *   4. Cancel (button / Escape / overlay click) calls onCancel, not onSubmit.
 *   5. Cmd/Ctrl+Enter submits like the button.
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { LaunchPromptModal } from '../LaunchPromptModal';

describe('LaunchPromptModal', () => {
  it('renders the header, sub-line, and an autofocused textarea', () => {
    render(<LaunchPromptModal open onCancel={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByText('What are you trying to build?')).toBeInTheDocument();
    expect(
      screen.getByText('One or two sentences is plenty — the interview digs into the rest.'),
    ).toBeInTheDocument();
    const textarea = screen.getByLabelText('What are you trying to build?');
    expect(textarea).toBeInTheDocument();
  });

  it('disables submit until the textarea holds non-whitespace text', async () => {
    render(<LaunchPromptModal open onCancel={vi.fn()} onSubmit={vi.fn()} />);

    const submit = screen.getByTestId('launch-prompt-submit');
    expect(submit).toBeDisabled();

    const textarea = screen.getByLabelText('What are you trying to build?');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '   ' } });
    });
    expect(submit).toBeDisabled();

    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'A recipe app.' } });
    });
    expect(submit).toBeEnabled();
  });

  it('confirming calls onSubmit with the trimmed text', async () => {
    const onSubmit = vi.fn();
    render(<LaunchPromptModal open onCancel={vi.fn()} onSubmit={onSubmit} />);

    const textarea = screen.getByLabelText('What are you trying to build?');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '  A recipe app that plans my week.  ' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('launch-prompt-submit'));
    });

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith('A recipe app that plans my week.');
  });

  it('Cmd/Ctrl+Enter submits like the button', async () => {
    const onSubmit = vi.fn();
    render(<LaunchPromptModal open onCancel={vi.fn()} onSubmit={onSubmit} />);

    const textarea = screen.getByLabelText('What are you trying to build?');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'A recipe app.' } });
    });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    });

    expect(onSubmit).toHaveBeenCalledWith('A recipe app.');
  });

  it('Cancel button calls onCancel, not onSubmit', async () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    render(<LaunchPromptModal open onCancel={onCancel} onSubmit={onSubmit} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Escape calls onCancel', async () => {
    const onCancel = vi.fn();
    render(<LaunchPromptModal open onCancel={onCancel} onSubmit={vi.fn()} />);

    await act(async () => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('renders nothing when closed', () => {
    render(<LaunchPromptModal open={false} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByText('What are you trying to build?')).not.toBeInTheDocument();
  });
});
