/**
 * DesignPlannerPrompt — the post-approve "start the planner?" modal. Covers:
 * hidden when unarmed; renders the idea title; an eligible design session
 * renders both launch choices enabled; same-session click launches with
 * `{ hostSessionId }`; new-session click launches with `{ forceNewSession }`;
 * an in-place/main-repo session or a busy session disables the same-session
 * button with the matching hint; Not-now dismisses without launching; missing
 * planner row degrades to an inline error with both launch buttons disabled.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useDesignModeStore } from '../../../../stores/designModeStore';
import { useSessionStore } from '../../../../stores/sessionStore';
import { useActiveRunsStore } from '../../../../stores/activeRunsStore';
import type { Session } from '../../../../types/session';
import type { ActiveRunRow } from '../../../../stores/activeRunsStore';

const workflowsListQuery = vi.fn();
vi.mock('../../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: { list: { query: (...args: unknown[]) => workflowsListQuery(...args) } },
    },
  },
}));

const launchMock = vi.fn();
let capturedLaunchOpts: { onLaunched?: (runId: string) => void } | undefined;
vi.mock('../../../../hooks/useLaunchWorkflow', () => ({
  useLaunchWorkflow: (_projectId: number, opts?: { onLaunched?: (runId: string) => void }) => {
    capturedLaunchOpts = opts;
    return { launch: launchMock, isLaunching: false, error: null };
  },
}));

const goToSession = vi.fn();
vi.mock('../../../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ goToSession }) },
}));

import { DesignPlannerPrompt } from '../DesignPlannerPrompt';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'My Design Session',
    status: 'running',
    projectId: 7,
    ...overrides,
  } as unknown as Session;
}

function makeActiveRun(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
  return {
    id: 'run-existing',
    session_id: 'sess-1',
    status: 'running',
    workflowName: 'planner',
    workflow_id: 'wf-3-planner',
    created_at: '2026-07-29T00:00:00Z',
    ...overrides,
  } as unknown as ActiveRunRow;
}

describe('DesignPlannerPrompt', () => {
  beforeEach(() => {
    workflowsListQuery.mockReset();
    launchMock.mockReset();
    goToSession.mockReset();
    capturedLaunchOpts = undefined;
    useDesignModeStore.setState({ activeDesignSessionId: null, plannerPrompt: null });
    useSessionStore.setState({ sessions: [] });
    useActiveRunsStore.setState({ runsByProject: {} });
  });

  it('renders nothing while unarmed', () => {
    const { container } = render(<DesignPlannerPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the idea title and both launch buttons enabled for an eligible session', async () => {
    workflowsListQuery.mockResolvedValue([
      { id: 'wf-2-sprint', name: 'sprint' },
      { id: 'wf-3-planner', name: 'planner' },
    ]);
    useSessionStore.setState({ sessions: [makeSession()] });
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: 'Nice Idea', sessionId: 'sess-1' },
    });
    render(<DesignPlannerPrompt />);

    expect(screen.getByTestId('design-planner-prompt')).toHaveTextContent('Nice Idea');
    const startSame = screen.getByTestId('design-planner-prompt-start-same');
    const startNew = screen.getByTestId('design-planner-prompt-start-new');
    await waitFor(() => expect(startSame).not.toBeDisabled());
    expect(startNew).not.toBeDisabled();
    expect(screen.queryByTestId('design-planner-prompt-same-hint')).not.toBeInTheDocument();
  });

  it('same-session click launches with hostSessionId', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-3-planner', name: 'planner' }]);
    launchMock.mockResolvedValue('run-1');
    useSessionStore.setState({ sessions: [makeSession()] });
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: 'Nice Idea', sessionId: 'sess-1' },
    });
    render(<DesignPlannerPrompt />);

    const startSame = screen.getByTestId('design-planner-prompt-start-same');
    await waitFor(() => expect(startSame).not.toBeDisabled());
    fireEvent.click(startSame);

    expect(launchMock).toHaveBeenCalledWith(
      'wf-3-planner',
      { ideaId: 'idea-1' },
      { hostSessionId: 'sess-1' },
    );

    // The hook's onLaunched navigates to the session view and dismisses.
    capturedLaunchOpts?.onLaunched?.('run-1');
    expect(goToSession).toHaveBeenCalled();
    expect(useDesignModeStore.getState().plannerPrompt).toBeNull();
  });

  it('new-session click launches with forceNewSession', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-3-planner', name: 'planner' }]);
    launchMock.mockResolvedValue('run-1');
    useSessionStore.setState({ sessions: [makeSession()] });
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: 'Nice Idea', sessionId: 'sess-1' },
    });
    render(<DesignPlannerPrompt />);

    const startNew = screen.getByTestId('design-planner-prompt-start-new');
    await waitFor(() => expect(startNew).not.toBeDisabled());
    fireEvent.click(startNew);

    expect(launchMock).toHaveBeenCalledWith(
      'wf-3-planner',
      { ideaId: 'idea-1' },
      { forceNewSession: true },
    );
  });

  it('disables the same-session button and shows the in-place hint for an in-place session', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-3-planner', name: 'planner' }]);
    useSessionStore.setState({ sessions: [makeSession({ inPlace: true })] });
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: 'Nice Idea', sessionId: 'sess-1' },
    });
    render(<DesignPlannerPrompt />);

    await waitFor(() => expect(screen.getByTestId('design-planner-prompt-start-new')).not.toBeDisabled());
    expect(screen.getByTestId('design-planner-prompt-start-same')).toBeDisabled();
    expect(screen.getByTestId('design-planner-prompt-same-hint')).toHaveTextContent(
      "This session works directly in the checkout — starting here isn't possible; a planner run needs its own worktree.",
    );
  });

  it('disables the same-session button and shows the busy hint for a busy session', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-3-planner', name: 'planner' }]);
    useSessionStore.setState({ sessions: [makeSession()] });
    useActiveRunsStore.setState({ runsByProject: { 7: [makeActiveRun()] } });
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: 'Nice Idea', sessionId: 'sess-1' },
    });
    render(<DesignPlannerPrompt />);

    await waitFor(() => expect(screen.getByTestId('design-planner-prompt-start-new')).not.toBeDisabled());
    expect(screen.getByTestId('design-planner-prompt-start-same')).toBeDisabled();
    expect(screen.getByTestId('design-planner-prompt-same-hint')).toHaveTextContent(
      'This session is busy with another run.',
    );
  });

  it('"Not now" dismisses without launching', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-3-planner', name: 'planner' }]);
    useSessionStore.setState({ sessions: [makeSession()] });
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: null, sessionId: 'sess-1' },
    });
    render(<DesignPlannerPrompt />);

    fireEvent.click(screen.getByTestId('design-planner-prompt-later'));
    expect(useDesignModeStore.getState().plannerPrompt).toBeNull();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('degrades to an inline error with both launch buttons disabled when the planner row is missing', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-2-sprint', name: 'sprint' }]);
    useSessionStore.setState({ sessions: [makeSession()] });
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: 'Nice Idea', sessionId: 'sess-1' },
    });
    render(<DesignPlannerPrompt />);

    expect(await screen.findByTestId('design-planner-prompt-error')).toHaveTextContent(
      'Planner workflow not found.',
    );
    expect(screen.getByTestId('design-planner-prompt-start-same')).toBeDisabled();
    expect(screen.getByTestId('design-planner-prompt-start-new')).toBeDisabled();
  });
});
