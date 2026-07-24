/**
 * DesignPlannerPrompt — the post-approve "start the planner?" modal. Covers:
 * hidden when unarmed; renders the idea title; Start resolves the planner
 * workflow row by name and launches it seeded with the idea in a FRESH
 * session; Not-now dismisses without launching; missing planner row degrades
 * to an inline error with Start disabled.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useDesignModeStore } from '../../../../stores/designModeStore';

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

describe('DesignPlannerPrompt', () => {
  beforeEach(() => {
    workflowsListQuery.mockReset();
    launchMock.mockReset();
    goToSession.mockReset();
    capturedLaunchOpts = undefined;
    useDesignModeStore.setState({ activeDesignSessionId: null, plannerPrompt: null });
  });

  it('renders nothing while unarmed', () => {
    const { container } = render(<DesignPlannerPrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the idea title and launches the planner seeded with the idea in a fresh session', async () => {
    workflowsListQuery.mockResolvedValue([
      { id: 'wf-2-sprint', name: 'sprint' },
      { id: 'wf-3-planner', name: 'planner' },
    ]);
    launchMock.mockResolvedValue('run-1');
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: 'Nice Idea' },
    });
    render(<DesignPlannerPrompt />);

    expect(screen.getByTestId('design-planner-prompt')).toHaveTextContent('Nice Idea');
    const start = screen.getByTestId('design-planner-prompt-start');
    await waitFor(() => expect(start).not.toBeDisabled());

    fireEvent.click(start);
    expect(launchMock).toHaveBeenCalledWith(
      'wf-3-planner',
      { ideaId: 'idea-1' },
      { forceNewSession: true },
    );

    // The hook's onLaunched navigates to the session view and dismisses.
    capturedLaunchOpts?.onLaunched?.('run-1');
    expect(goToSession).toHaveBeenCalled();
    expect(useDesignModeStore.getState().plannerPrompt).toBeNull();
  });

  it('"Not now" dismisses without launching', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-3-planner', name: 'planner' }]);
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: null },
    });
    render(<DesignPlannerPrompt />);

    fireEvent.click(screen.getByTestId('design-planner-prompt-later'));
    expect(useDesignModeStore.getState().plannerPrompt).toBeNull();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it('degrades to an inline error with Start disabled when the planner row is missing', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-2-sprint', name: 'sprint' }]);
    useDesignModeStore.setState({
      plannerPrompt: { projectId: 7, ideaId: 'idea-1', ideaTitle: 'Nice Idea' },
    });
    render(<DesignPlannerPrompt />);

    expect(await screen.findByTestId('design-planner-prompt-error')).toHaveTextContent(
      'Planner workflow not found.',
    );
    expect(screen.getByTestId('design-planner-prompt-start')).toBeDisabled();
  });
});
