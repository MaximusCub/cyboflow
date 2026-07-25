import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useAddClaudePanel } from '../useAddClaudePanel';

const { mockAddPanel, mockSetActivePanelInStore, mockCreatePanel, mockSetActivePanel } = vi.hoisted(() => ({
  mockAddPanel: vi.fn(),
  mockSetActivePanelInStore: vi.fn(),
  mockCreatePanel: vi.fn(),
  mockSetActivePanel: vi.fn(),
}));

vi.mock('../../stores/panelStore', () => ({
  usePanelStore: () => ({
    addPanel: mockAddPanel,
    setActivePanel: mockSetActivePanelInStore,
  }),
}));

vi.mock('../../services/panelApi', () => ({
  panelApi: {
    createPanel: mockCreatePanel,
    setActivePanel: mockSetActivePanel,
  },
}));

const MOCK_PANEL = {
  id: 'panel-1',
  sessionId: 's1',
  type: 'claude' as const,
  title: 'Chat 1',
  state: { isActive: true },
};

const SECOND_PANEL = {
  ...MOCK_PANEL,
  id: 'panel-2',
  title: 'Chat 2',
};

const MOCK_SESSION = {
  id: 's1',
  worktreePath: '/path/to/worktree',
};

describe('useAddClaudePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePanel.mockResolvedValue(MOCK_PANEL);
    mockSetActivePanel.mockResolvedValue(undefined);
  });

  it('always creates a fresh Claude panel without an explicit title', async () => {
    const { result } = renderHook(() => useAddClaudePanel(MOCK_SESSION));

    await act(async () => { await result.current(); });

    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 's1',
      type: 'claude',
      initialState: { cwd: '/path/to/worktree' },
    });
    expect(mockCreatePanel.mock.calls[0][0]).not.toHaveProperty('title');
    // The add-chat affordance creates a neutral panel and lets the backend
    // apply normal session inheritance; it must not copy a provider/substrate
    // override from whichever panel was active.
    expect(mockCreatePanel.mock.calls[0][0]).not.toHaveProperty('substrate');
  });

  it('threads an explicit substrate override into createPanel when the caller picks one', async () => {
    const { result } = renderHook(() => useAddClaudePanel(MOCK_SESSION));

    await act(async () => { await result.current('interactive'); });

    expect(mockCreatePanel).toHaveBeenCalledWith({
      sessionId: 's1',
      type: 'claude',
      initialState: { cwd: '/path/to/worktree' },
      substrate: 'interactive',
    });
  });

  it('creates and explicitly activates every requested panel', async () => {
    mockCreatePanel
      .mockResolvedValueOnce(MOCK_PANEL)
      .mockResolvedValueOnce(SECOND_PANEL);
    const { result } = renderHook(() => useAddClaudePanel(MOCK_SESSION));

    await act(async () => {
      await result.current();
      await result.current();
    });

    expect(mockAddPanel).toHaveBeenNthCalledWith(1, MOCK_PANEL);
    expect(mockAddPanel).toHaveBeenNthCalledWith(2, SECOND_PANEL);
    expect(mockSetActivePanelInStore).toHaveBeenNthCalledWith(1, 's1', 'panel-1');
    expect(mockSetActivePanelInStore).toHaveBeenNthCalledWith(2, 's1', 'panel-2');
    expect(mockSetActivePanel).toHaveBeenNthCalledWith(1, 's1', 'panel-1');
    expect(mockSetActivePanel).toHaveBeenNthCalledWith(2, 's1', 'panel-2');
    expect(mockCreatePanel).toHaveBeenNthCalledWith(1, {
      sessionId: 's1',
      type: 'claude',
      initialState: { cwd: '/path/to/worktree' },
    });
    expect(mockCreatePanel).toHaveBeenNthCalledWith(2, {
      sessionId: 's1',
      type: 'claude',
      initialState: { cwd: '/path/to/worktree' },
    });
  });

  it('runs onAfterActivate after backend activation', async () => {
    const onAfterActivate = vi.fn();
    const { result } = renderHook(() => useAddClaudePanel(MOCK_SESSION, { onAfterActivate }));

    await act(async () => { await result.current(); });

    expect(onAfterActivate).toHaveBeenCalledWith('s1', 'panel-1');
    expect(mockSetActivePanel.mock.invocationCallOrder[0])
      .toBeLessThan(onAfterActivate.mock.invocationCallOrder[0]);
    expect(mockAddPanel.mock.invocationCallOrder[0])
      .toBeLessThan(mockSetActivePanelInStore.mock.invocationCallOrder[0]);
    expect(mockSetActivePanelInStore.mock.invocationCallOrder[0])
      .toBeLessThan(mockSetActivePanel.mock.invocationCallOrder[0]);
  });

  it('does not invoke onAfterActivate when backend activation fails', async () => {
    const onAfterActivate = vi.fn();
    const activationError = new Error('activation failed');
    mockSetActivePanel.mockRejectedValueOnce(activationError);
    const { result } = renderHook(() => useAddClaudePanel(MOCK_SESSION, { onAfterActivate }));

    await expect(act(async () => { await result.current(); })).rejects.toBe(activationError);

    expect(onAfterActivate).not.toHaveBeenCalled();
  });

  it('warns and does not create a panel without a session', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useAddClaudePanel(null));

    await act(async () => { await result.current(); });

    expect(mockCreatePanel).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[useAddClaudePanel]'));
    warnSpy.mockRestore();
  });
});
