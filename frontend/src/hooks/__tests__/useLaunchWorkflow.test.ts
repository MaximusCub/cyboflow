/**
 * Unit tests for useLaunchWorkflow — the one-click "Add a workflow" launch path
 * used by QuickSessionCanvas. ensureSessionForLaunch, the tRPC client, and the
 * config store are mocked; cyboflowStore is real so we can assert setActiveRun.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockEnsureSession, mockStartMutate, mockSubscribe, mockConfigState } = vi.hoisted(() => ({
  mockEnsureSession: vi.fn(),
  mockStartMutate: vi.fn(),
  mockSubscribe: vi.fn(() => vi.fn()),
  // Mutable so tests can flip runTypeDefaults per-case (and mid-test, between
  // two launch calls on the same mounted hook) without re-mocking the module.
  mockConfigState: {
    config: {
      defaultAgentPermissionMode: 'default' as string,
      runTypeDefaults: undefined as Record<string, { model?: string }> | undefined,
    },
  },
}));

vi.mock('../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: mockEnsureSession,
}));

vi.mock('../../trpc/client', () => ({
  trpc: { cyboflow: { runs: { start: { mutate: mockStartMutate } } } },
}));

vi.mock('../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: mockSubscribe,
}));

vi.mock('../../stores/configStore', () => {
  const useConfigStore = (selector: (s: typeof mockConfigState) => unknown) =>
    selector(mockConfigState);
  useConfigStore.getState = () => mockConfigState;
  return { useConfigStore };
});

import { useLaunchWorkflow } from '../useLaunchWorkflow';
import { useCyboflowStore } from '../../stores/cyboflowStore';

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureSession.mockResolvedValue('session-1');
  mockStartMutate.mockResolvedValue({ runId: 'run-9', worktreePath: '/wt', branchName: 'b' });
  mockConfigState.config.defaultAgentPermissionMode = 'default';
  mockConfigState.config.runTypeDefaults = undefined;
  act(() => {
    useCyboflowStore.getState().clearActiveRun();
    useCyboflowStore.getState().clearActiveQuickSession();
  });
});

describe('useLaunchWorkflow', () => {
  it('launches a run into the resolved session and selects it', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));

    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('wf-sprint');
    });

    expect(runId).toBe('run-9');
    // forceNew defaults to false (reuse the current selection) and is always
    // threaded into ensureSessionForLaunch.
    expect(mockEnsureSession).toHaveBeenCalledWith(7, { forceNew: false });
    expect(mockStartMutate).toHaveBeenCalledWith({
      workflowId: 'wf-sprint',
      projectId: 7,
      substrate: 'sdk',
      sessionId: 'session-1',
      permissionMode: 'default',
      // No runTypeDefaults entry configured for wf-sprint, so this falls back
      // to the DEFAULT_WORKFLOW_MODEL floor (Opus) → workflow_runs.model
      // (migration 037).
      model: 'opus',
    });
    expect(useCyboflowStore.getState().activeRunId).toBe('run-9');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('session-1');
  });

  it('hostSessionId bypasses ensureSessionForLaunch and threads the given id verbatim', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));

    let runId: string | null = null;
    await act(async () => {
      runId = await result.current.launch('wf-planner', { ideaId: 'idea-1' }, { hostSessionId: 'design-sess-1' });
    });

    expect(runId).toBe('run-9');
    expect(mockEnsureSession).not.toHaveBeenCalled();
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'design-sess-1' }),
    );
    expect(useCyboflowStore.getState().activeRunId).toBe('run-9');
    expect(useCyboflowStore.getState().selectedSessionId).toBe('design-sess-1');
  });

  it('launchOpts.permissionMode overrides the global default in the run payload', async () => {
    // Same-session launches carry the host session's live agentPermissionMode
    // so the run keeps behaving like the session it lands in.
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch(
        'wf-planner',
        { ideaId: 'idea-1' },
        { hostSessionId: 'design-sess-1', permissionMode: 'dontAsk' },
      );
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'design-sess-1', permissionMode: 'dontAsk' }),
    );
  });

  it('threads forceNew:true into ensureSessionForLaunch when the hook opts in', async () => {
    // In-place / main-repo host sessions must never absorb the current selection —
    // the canvas passes forceNew so the run lands in a fresh worktree-backed session.
    const { result } = renderHook(() => useLaunchWorkflow(7, { forceNew: true }));
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockEnsureSession).toHaveBeenCalledWith(7, { forceNew: true });
  });

  it('threads seed.ideaId into the mutation when provided (Planner gate)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-planner', { ideaId: 'idea-3' });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-planner', ideaId: 'idea-3' }),
    );
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ taskIds: expect.anything() }),
    );
  });

  it('threads seed.ideaIds into the mutation when provided (Planner multi-select batch)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-planner', { ideaIds: ['idea-1', 'idea-2'] });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-planner', ideaIds: ['idea-1', 'idea-2'] }),
    );
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ ideaId: expect.anything() }),
    );
  });

  it('threads seed.taskIds into the mutation when provided (Sprint batch gate)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-sprint', { taskIds: ['task-a', 'task-b'] });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-sprint', taskIds: ['task-a', 'task-b'] }),
    );
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ ideaId: expect.anything() }),
    );
  });

  it('threads seed.seedPrompt into the mutation when provided (Launch gate)', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));
    await act(async () => {
      await result.current.launch('wf-launch', { seedPrompt: 'A recipe app.' });
    });
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-launch', seedPrompt: 'A recipe app.' }),
    );
    expect(mockStartMutate).toHaveBeenCalledWith(
      expect.not.objectContaining({ ideaId: expect.anything() }),
    );
  });

  it('sets error and returns null when the launch fails', async () => {
    mockStartMutate.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useLaunchWorkflow(7));

    let runId: string | null = 'sentinel';
    await act(async () => {
      runId = await result.current.launch('wf-sprint');
    });

    expect(runId).toBeNull();
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(useCyboflowStore.getState().activeRunId).toBeNull();
  });

  it('ignores a concurrent second launch (in-flight latch)', async () => {
    // ensureSessionForLaunch never resolves on the first call, so the latch stays
    // closed while we fire a second launch — which must early-return null.
    let release: (v: string) => void = () => {};
    mockEnsureSession.mockReturnValueOnce(new Promise<string>((r) => { release = r; }));

    const { result } = renderHook(() => useLaunchWorkflow(7));

    let first: Promise<string | null> = Promise.resolve(null);
    act(() => {
      first = result.current.launch('wf-sprint');
    });
    // Second call while the first is still in flight.
    let second: string | null = 'sentinel';
    await act(async () => {
      second = await result.current.launch('wf-planner');
    });
    expect(second).toBeNull();
    expect(mockStartMutate).not.toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-planner' }),
    );

    // Let the first finish so there are no dangling promises.
    await act(async () => {
      release('session-1');
      await first;
    });
  });

  it('resolves a configured per-workflow model default, keyed per call within the same hook instance', async () => {
    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': { model: 'sonnet' } };
    const { result } = renderHook(() => useLaunchWorkflow(7));

    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'sonnet' }));

    // wf-planner has no runTypeDefaults entry, so — from the SAME hook
    // instance that just resolved wf-sprint to Sonnet — it still floors to
    // Opus, proving the lookup is keyed per-call by workflowId, not cached
    // or shared across workflows once one resolves.
    await act(async () => {
      await result.current.launch('wf-planner');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'opus' }));
  });

  it('picks up a runTypeDefaults change made between two launch calls on the same mounted hook', async () => {
    const { result } = renderHook(() => useLaunchWorkflow(7));

    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(1, expect.objectContaining({ model: 'opus' }));

    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': { model: 'sonnet' } };
    // The config read happens via useConfigStore.getState() INSIDE the launch
    // callback, not a hook-level selector captured at mount, so a config
    // change between two calls on the same hook instance is picked up by the
    // second call.
    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenNthCalledWith(2, expect.objectContaining({ model: 'sonnet' }));
  });

  it('falls back to the Opus floor when the runTypeDefaults entry exists but has no model field', async () => {
    mockConfigState.config.runTypeDefaults = { 'workflow:wf-sprint': {} };
    const { result } = renderHook(() => useLaunchWorkflow(7));

    await act(async () => {
      await result.current.launch('wf-sprint');
    });
    expect(mockStartMutate).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }));
  });
});
