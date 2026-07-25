import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../../shared/types/panels';
import { PanelTabBar } from '../PanelTabBar';

function panel(id: string, title: string): ToolPanel {
  return {
    id,
    sessionId: 'session-1',
    type: 'claude',
    title,
    state: { isActive: id === 'panel-1', customState: {} },
    metadata: {
      createdAt: '2026-07-13T00:00:00.000Z',
      lastActiveAt: '2026-07-13T00:00:00.000Z',
      position: 0,
    },
  };
}

describe('PanelTabBar chat labels', () => {
  it('renders legacy provider-generated titles as provider-neutral Chat tabs', () => {
    const panels = [
      panel('panel-1', 'Claude 1'),
      panel('panel-2', 'Codex'),
    ];

    render(
      <PanelTabBar
        panels={panels}
        activePanel={panels[0]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        context="project"
      />,
    );

    expect(screen.getByText('Chat 1')).toBeInTheDocument();
    expect(screen.getByText('Chat')).toBeInTheDocument();
    expect(screen.queryByText('Claude 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Codex')).not.toBeInTheDocument();
  });

  it('preserves a user-supplied chat panel title', () => {
    const customPanel = panel('panel-1', 'Planning notes');

    render(
      <PanelTabBar
        panels={[customPanel]}
        activePanel={customPanel}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        context="project"
      />,
    );

    expect(screen.getByText('Planning notes')).toBeInTheDocument();
  });
});

describe('PanelTabBar add chat action', () => {
  it('renders Add chat next to Add terminal as a substrate picker and invokes the chat callback with no override for "Inherit session"', () => {
    const onAddTerminal = vi.fn();
    const onAddChat = vi.fn();

    render(
      <PanelTabBar
        panels={[]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        onAddTerminal={onAddTerminal}
        onAddChat={onAddChat}
      />,
    );

    expect(screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['Add terminal panel', 'Add chat panel']);

    // Clicking the trigger opens the picker rather than creating a chat directly.
    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    expect(onAddChat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Inherit session'));

    expect(onAddChat).toHaveBeenCalledTimes(1);
    expect(onAddChat).toHaveBeenCalledWith(undefined);
    expect(onAddTerminal).not.toHaveBeenCalled();
  });

  it('invokes the chat callback with the chosen substrate override', () => {
    const onAddChat = vi.fn();

    render(
      <PanelTabBar
        panels={[]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        onAddChat={onAddChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    fireEvent.click(screen.getByText('PTY (interactive)'));

    expect(onAddChat).toHaveBeenCalledTimes(1);
    expect(onAddChat).toHaveBeenCalledWith('interactive');
  });

  it('logs rejected async add-chat callbacks instead of leaking an unhandled rejection', async () => {
    const error = new Error('create chat failed');
    const onAddChat = vi.fn().mockRejectedValue(error);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <PanelTabBar
        panels={[]}
        onPanelSelect={vi.fn()}
        onPanelClose={vi.fn()}
        onAddChat={onAddChat}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    fireEvent.click(screen.getByText('Inherit session'));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith('[PanelTabBar] Failed to add chat:', error);
    });

    errorSpy.mockRestore();
  });
});
