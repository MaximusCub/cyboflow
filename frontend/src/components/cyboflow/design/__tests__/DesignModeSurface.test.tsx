/**
 * DesignModeSurface tests — the v0.5 fullscreen design takeover shell.
 *
 * ClaudePanel, DesignStage, and DesignApproveControl are stubbed (vi.mock) so
 * the tests exercise the surface's own wiring: exit → store, the missing-session
 * placeholder, the Approve render gate, and the prototype threaded to the stage.
 * The session/panel stores are seeded via setState; useSessionArtifactsList is
 * mocked with a per-test artifact list; useEnsureClaudePanel is a no-op.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Artifact } from '../../../../../../shared/types/artifacts';
import type { Session } from '../../../../types/session';
import type { ToolPanel } from '../../../../../../shared/types/panels';
import { useDesignModeStore } from '../../../../stores/designModeStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { usePanelStore } from '../../../../stores/panelStore';

// --- stubs for the three heavy children -------------------------------------
vi.mock('../../../panels/claude/ClaudePanel', () => ({
  ClaudePanel: ({ panel, isActive }: { panel: ToolPanel; isActive: boolean }) => (
    <div data-testid="claude-panel-stub" data-panel-id={panel.id} data-active={String(isActive)} />
  ),
}));

vi.mock('../DesignStage', () => ({
  DesignStage: (props: { prototypeArtifact: Artifact | null; sessionId: string }) => (
    <div
      data-testid="design-stage-stub"
      data-session-id={props.sessionId}
      data-proto-id={props.prototypeArtifact?.id ?? 'none'}
    />
  ),
}));

vi.mock('../../DesignApproveControl', () => ({
  DesignApproveControl: (props: {
    sessionId: string;
    artifactRevision?: number;
    onApproved?: (info: { ideaId: string | null; ideaTitle: string | null }) => void;
  }) => (
    <div
      data-testid="design-approve-stub"
      data-session-id={props.sessionId}
      data-revision={String(props.artifactRevision)}
      // Surface the callback so tests can simulate an approve success.
      onClick={() => props.onApproved?.({ ideaId: 'idea-1', ideaTitle: 'Nice Idea' })}
    />
  ),
}));

// --- artifacts hook: per-test list ------------------------------------------
let mockArtifacts: Artifact[] = [];
vi.mock('../../../../hooks/useArtifactsList', () => ({
  useSessionArtifactsList: () => ({ artifacts: mockArtifacts, loaded: true }),
}));

// --- ensure-claude-panel: no-op ---------------------------------------------
vi.mock('../../../../hooks/useEnsureClaudePanel', () => ({
  useEnsureClaudePanel: () => vi.fn().mockResolvedValue(undefined),
}));

import { DesignModeSurface } from '../DesignModeSurface';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'My Design Session',
    status: 'running',
    projectId: 1,
    ...overrides,
  } as unknown as Session;
}

function makeClaudePanel(): ToolPanel {
  return {
    id: 'panel-1',
    sessionId: 'sess-1',
    type: 'claude',
    title: 'Chat 1',
  } as unknown as ToolPanel;
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'ui-prototype',
    label: 'Prototype',
    stepOrigin: null,
    mode: 'canvas',
    committed: false,
    sessionOnly: true,
    isNew: false,
    payloadJson: JSON.stringify({ fileName: 'prototype/index.html' }),
    sourceRef: 'IDEA-1',
    createdAt: '2026-07-23T00:00:00Z',
    committedAt: null,
    revision: 5,
    ...overrides,
  } as Artifact;
}

function seed(session: Session | null, panel: ToolPanel | null): void {
  useSessionStore.setState({ sessions: session ? [session] : [] });
  usePanelStore.setState({ panels: panel ? { [panel.sessionId]: [panel] } : {} });
}

describe('DesignModeSurface', () => {
  beforeEach(() => {
    mockArtifacts = [];
    useDesignModeStore.setState({ activeDesignSessionId: 'sess-1', plannerPrompt: null });
    seed(makeSession(), makeClaudePanel());
  });

  it('renders null when no design session is active', () => {
    useDesignModeStore.setState({ activeDesignSessionId: null });
    const { container } = render(<DesignModeSurface />);
    expect(container).toBeEmptyDOMElement();
  });

  it('(a) the exit button clears the active design session in the store', () => {
    render(<DesignModeSurface />);
    fireEvent.click(screen.getByTestId('design-mode-exit'));
    expect(useDesignModeStore.getState().activeDesignSessionId).toBeNull();
  });

  it('(b) shows the "Preparing…" placeholder when the session is not yet in the store', () => {
    seed(null, null);
    render(<DesignModeSurface />);
    expect(screen.getByTestId('design-mode-preparing')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-panel-stub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-stage-stub')).not.toBeInTheDocument();
  });

  it('(b2) shows the placeholder when the session exists but its Claude panel does not', () => {
    seed(makeSession(), null);
    render(<DesignModeSurface />);
    expect(screen.getByTestId('design-mode-preparing')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-panel-stub')).not.toBeInTheDocument();
  });

  it('mounts the Claude panel and stage once session + panel resolve', () => {
    render(<DesignModeSurface />);
    expect(screen.getByTestId('claude-panel-stub')).toHaveAttribute('data-panel-id', 'panel-1');
    expect(screen.getByTestId('design-stage-stub')).toHaveAttribute('data-session-id', 'sess-1');
    expect(screen.queryByTestId('design-mode-preparing')).not.toBeInTheDocument();
  });

  it('(c) mounts the Approve control only when the prototype passes the sourceRef + sessionId gate', () => {
    mockArtifacts = [makeArtifact({ sourceRef: 'IDEA-1', sessionId: 'sess-1', revision: 5 })];
    render(<DesignModeSurface />);
    const approve = screen.getByTestId('design-approve-stub');
    expect(approve).toHaveAttribute('data-session-id', 'sess-1');
    expect(approve).toHaveAttribute('data-revision', '5');
  });

  it('(c2) hides the Approve control when the prototype has no sourceRef', () => {
    mockArtifacts = [makeArtifact({ sourceRef: null })];
    render(<DesignModeSurface />);
    expect(screen.queryByTestId('design-approve-stub')).not.toBeInTheDocument();
  });

  it('(c3) hides the Approve control when the prototype has no sessionId', () => {
    mockArtifacts = [makeArtifact({ sessionId: null })];
    render(<DesignModeSurface />);
    expect(screen.queryByTestId('design-approve-stub')).not.toBeInTheDocument();
  });

  it('(c4) hides the Approve control when there is no ui-prototype artifact', () => {
    mockArtifacts = [];
    render(<DesignModeSurface />);
    expect(screen.queryByTestId('design-approve-stub')).not.toBeInTheDocument();
  });

  it('(d) threads the resolved prototype artifact to the stage', () => {
    mockArtifacts = [makeArtifact({ id: 'art-99' })];
    render(<DesignModeSurface />);
    expect(screen.getByTestId('design-stage-stub')).toHaveAttribute('data-proto-id', 'art-99');
  });

  it('(d2) picks the most recently created ui-prototype across runs', () => {
    mockArtifacts = [
      makeArtifact({ id: 'art-old', createdAt: '2026-07-20T00:00:00Z' }),
      makeArtifact({ id: 'art-new', createdAt: '2026-07-23T00:00:00Z' }),
      makeArtifact({ id: 'not-proto', atype: 'generic', createdAt: '2026-07-24T00:00:00Z' }),
    ];
    render(<DesignModeSurface />);
    expect(screen.getByTestId('design-stage-stub')).toHaveAttribute('data-proto-id', 'art-new');
  });

  it('(d3) a bytes-less creation stub reads as "no prototype yet" for the stage but still opens the Approve gate', () => {
    // The backend mints this row at session creation purely as the re-entry
    // door: sourceRef/sessionId stamped, payloadJson null (no fileName).
    mockArtifacts = [makeArtifact({ id: 'art-stub', payloadJson: null })];
    render(<DesignModeSurface />);
    expect(screen.getByTestId('design-stage-stub')).toHaveAttribute('data-proto-id', 'none');
    expect(screen.getByTestId('design-approve-stub')).toBeInTheDocument();
  });

  it('(d4) a malformed payload also reads as bytes-less rather than crashing', () => {
    mockArtifacts = [makeArtifact({ id: 'art-bad', payloadJson: 'not json' })];
    render(<DesignModeSurface />);
    expect(screen.getByTestId('design-stage-stub')).toHaveAttribute('data-proto-id', 'none');
  });

  it('(e) "Open in browser" shows only for a bytes-backed prototype and calls the IPC bridge', () => {
    const openHtmlExternal = vi.fn().mockResolvedValue({ success: true, data: { opened: true } });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      artifacts: { openHtmlExternal },
    };
    try {
      mockArtifacts = [makeArtifact({ runId: 'run-7' })];
      render(<DesignModeSurface />);
      const btn = screen.getByTestId('design-mode-open-in-browser');
      fireEvent.click(btn);
      expect(openHtmlExternal).toHaveBeenCalledWith({ runId: 'run-7', atype: 'ui-prototype' });
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('(e2) "Open in browser" is hidden for the bytes-less creation stub', () => {
    mockArtifacts = [makeArtifact({ id: 'art-stub', payloadJson: null })];
    render(<DesignModeSurface />);
    expect(screen.queryByTestId('design-mode-open-in-browser')).not.toBeInTheDocument();
  });

  it('(g) unmounting with an interactive-prototype artifact stops its server, keyed on runId', () => {
    const stop = vi.fn().mockResolvedValue({ success: true, data: { stopped: true } });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      designPrototypeServer: { stop, ensure: vi.fn(), onEvent: vi.fn() },
    };
    try {
      mockArtifacts = [makeArtifact({ atype: 'interactive-prototype', runId: 'run-live' })];
      const { unmount } = render(<DesignModeSurface />);
      expect(stop).not.toHaveBeenCalled();
      unmount();
      expect(stop).toHaveBeenCalledWith({ runId: 'run-live' });
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('(g2) unmounting with a static ui-prototype artifact does NOT call stop', () => {
    const stop = vi.fn().mockResolvedValue({ success: true, data: { stopped: true } });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      designPrototypeServer: { stop, ensure: vi.fn(), onEvent: vi.fn() },
    };
    try {
      mockArtifacts = [makeArtifact({ atype: 'ui-prototype', runId: 'run-static' })];
      const { unmount } = render(<DesignModeSurface />);
      unmount();
      expect(stop).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    }
  });

  it('(f) approve success exits design mode and arms the planner prompt', () => {
    mockArtifacts = [makeArtifact({ sourceRef: 'IDEA-1', sessionId: 'sess-1' })];
    render(<DesignModeSurface />);
    // The stub forwards a click as onApproved({ ideaId: 'idea-1', ... }).
    fireEvent.click(screen.getByTestId('design-approve-stub'));
    const state = useDesignModeStore.getState();
    expect(state.activeDesignSessionId).toBeNull();
    expect(state.plannerPrompt).toEqual({
      projectId: 1,
      ideaId: 'idea-1',
      ideaTitle: 'Nice Idea',
    });
  });
});
