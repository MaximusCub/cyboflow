import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../types/session';
import { ProjectView } from '../ProjectView';

const {
  mockAddChat,
  mockUseAddClaudePanel,
  mockUsePanelSurface,
} = vi.hoisted(() => ({
  mockAddChat: vi.fn(),
  mockUseAddClaudePanel: vi.fn(),
  mockUsePanelSurface: vi.fn(),
}));

vi.mock('../../hooks/usePanelSurface', () => ({
  usePanelSurface: mockUsePanelSurface,
}));

vi.mock('../../hooks/useAddClaudePanel', () => ({
  useAddClaudePanel: mockUseAddClaudePanel,
}));

vi.mock('../../hooks/useAddTerminalPanel', () => ({
  useAddTerminalPanel: vi.fn(() => vi.fn()),
}));

vi.mock('../../hooks/useEnsureClaudePanel', () => ({
  useEnsureClaudePanel: vi.fn(() => vi.fn()),
}));

vi.mock('../../hooks/useAddTerminalShortcut', () => ({
  useAddTerminalShortcut: vi.fn(),
}));

vi.mock('../../hooks/useAddClaudeShortcut', () => ({
  useAddClaudeShortcut: vi.fn(),
}));

const MAIN_REPO_SESSION: Session = {
  id: 'sess-main-1',
  name: 'main-repo',
  projectId: 1,
  status: 'ready',
  isMainRepo: true,
  worktreePath: '/repo/main',
  prompt: '',
  output: [],
  jsonMessages: [],
  createdAt: '',
};

describe('ProjectView Add chat wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddChat.mockResolvedValue(undefined);
    mockUseAddClaudePanel.mockReturnValue(mockAddChat);
    mockUsePanelSurface.mockReturnValue({
      mainRepoSession: MAIN_REPO_SESSION,
      sessionPanels: [],
      currentActivePanel: undefined,
      handlePanelSelect: vi.fn(),
      handlePanelClose: vi.fn(),
    });
  });

  it('passes the fresh-chat hook callback to PanelTabBar and invokes it', () => {
    render(
      <ProjectView
        projectId={1}
        projectName="Cyboflow"
        onGitPull={vi.fn()}
        onGitPush={vi.fn()}
        isMerging={false}
      />,
    );

    expect(mockUseAddClaudePanel).toHaveBeenCalledWith(MAIN_REPO_SESSION, { logTag: 'ProjectView' });

    // The trigger opens a substrate picker rather than invoking the hook
    // directly; "Inherit session" reproduces the pre-picker no-override call.
    fireEvent.click(screen.getByRole('button', { name: 'Add chat panel' }));
    fireEvent.click(screen.getByText('Inherit session'));

    expect(mockAddChat).toHaveBeenCalledTimes(1);
    expect(mockAddChat).toHaveBeenCalledWith(undefined);
  });
});
