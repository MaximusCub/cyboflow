/**
 * DesignStage — the v0.5 fullscreen design surface's center-stage state
 * machine. Covers render precedence: clarify gate wins over everything;
 * a live prototype stays visible with the working indicator as an OVERLAY
 * while the agent regenerates; full-stage working only pre-first-prototype;
 * prototype wins over intro; a gate for a DIFFERENT chat run is ignored.
 *
 * Mocks questionStore and panelLiveEventsStore the way
 * RunPendingInputStrip.test.tsx does (module-level mutable state driving the
 * selector, getState().init as a spy) — real-store reducer logic
 * (reduceLiveTail) is exercised for real since it's a pure function import.
 * AskUserQuestionCard and DesignStageCanvas are stubbed to keep this test
 * scoped to DesignStage's own precedence logic.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Question } from '../../../../../../shared/types/questions';
import type { Artifact } from '../../../../../../shared/types/artifacts';
import type { StreamEvent } from '../../../../utils/cyboflowApi';

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

let mockQuestionQueue: Question[] = [];
const mockQuestionInit = vi.fn();

vi.mock('../../../../stores/questionStore', () => ({
  useQuestionStore: Object.assign(
    (selector: (s: { queue: Question[] }) => unknown) => selector({ queue: mockQuestionQueue }),
    { getState: () => ({ init: mockQuestionInit }) },
  ),
}));

let mockPanelEvents: Record<string, StreamEvent[]> = {};

vi.mock('../../../../stores/panelLiveEventsStore', () => ({
  usePanelLiveEventsStore: (selector: (s: { byPanel: Record<string, StreamEvent[]> }) => unknown) =>
    selector({ byPanel: mockPanelEvents }),
}));

vi.mock('../../../AskUserQuestion/AskUserQuestionCard', () => ({
  AskUserQuestionCard: ({ item }: { item: Question }) => (
    <div data-testid="ask-question-card" data-question-id={item.id} data-run-id={item.runId} />
  ),
}));

vi.mock('../DesignStageCanvas', () => ({
  DesignStageCanvas: ({ artifact }: { artifact: Artifact }) => (
    <div data-testid="design-stage-canvas-stub" data-artifact-id={artifact.id} />
  ),
}));

import { DesignStage } from '../DesignStage';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQuestion(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    runId: 'run-1',
    workflowName: 'design',
    toolUseId: 'tool-1',
    questions: [],
    status: 'pending',
    createdAt: new Date().toISOString(),
    answeredAt: null,
    answerJson: null,
    ...overrides,
  };
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
    payloadJson: null,
    sourceRef: null,
    createdAt: new Date().toISOString(),
    committedAt: null,
    ...overrides,
  };
}

const BASE_PROPS = {
  sessionId: 'sess-1',
  chatRunId: 'run-1',
  panelId: 'panel-1',
  sessionStatus: 'waiting' as string | null,
  prototypeArtifact: null as Artifact | null,
};

describe('DesignStage', () => {
  beforeEach(() => {
    mockQuestionQueue = [];
    mockPanelEvents = {};
    mockQuestionInit.mockReset();
  });

  it('(a) pending gate for the chat run wins over everything (clarify state)', () => {
    mockQuestionQueue = [makeQuestion({ id: 'q-1', runId: 'run-1' })];
    render(<DesignStage {...BASE_PROPS} sessionStatus="running" prototypeArtifact={makeArtifact()} />);

    expect(screen.getByTestId('design-stage-clarify')).toBeInTheDocument();
    expect(screen.getByTestId('ask-question-card')).toHaveAttribute('data-question-id', 'q-1');
    expect(screen.queryByTestId('design-stage-working')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-stage-prototype')).not.toBeInTheDocument();
    expect(mockQuestionInit).toHaveBeenCalled();
  });

  it('(b) no gates + sessionStatus running -> working', () => {
    render(<DesignStage {...BASE_PROPS} sessionStatus="running" />);

    expect(screen.getByTestId('design-stage-working')).toBeInTheDocument();
    expect(screen.queryByTestId('design-stage-clarify')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-stage-prototype')).not.toBeInTheDocument();
  });

  it('working also derives from the live tail (isGenerating) independent of sessionStatus', () => {
    mockPanelEvents = {
      'panel-1': [
        { type: 'stream_event', payload: { event: { type: 'message_start' } } } as unknown as StreamEvent,
      ],
    };
    render(<DesignStage {...BASE_PROPS} sessionStatus="waiting" />);

    expect(screen.getByTestId('design-stage-working')).toBeInTheDocument();
  });

  it('(c) no gates + idle + artifact -> prototype (DesignStageCanvas rendered with the artifact)', () => {
    const artifact = makeArtifact({ id: 'art-42' });
    render(<DesignStage {...BASE_PROPS} sessionStatus="waiting" prototypeArtifact={artifact} />);

    expect(screen.getByTestId('design-stage-prototype')).toBeInTheDocument();
    expect(screen.getByTestId('design-stage-canvas-stub')).toHaveAttribute('data-artifact-id', 'art-42');
    expect(screen.queryByTestId('design-stage-working')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-stage-working-overlay')).not.toBeInTheDocument();
  });

  it('regenerating with a live prototype keeps it visible and overlays the working indicator', () => {
    render(<DesignStage {...BASE_PROPS} sessionStatus="running" prototypeArtifact={makeArtifact()} />);

    expect(screen.getByTestId('design-stage-prototype')).toBeInTheDocument();
    expect(screen.getByTestId('design-stage-canvas-stub')).toBeInTheDocument();
    expect(screen.getByTestId('design-stage-working-overlay')).toBeInTheDocument();
    // NOT the full-stage working state — the prototype must not disappear.
    expect(screen.queryByTestId('design-stage-working')).not.toBeInTheDocument();
  });

  it('(d) nothing -> intro', () => {
    render(<DesignStage {...BASE_PROPS} sessionStatus="waiting" prototypeArtifact={null} />);

    expect(screen.getByTestId('design-stage-intro')).toBeInTheDocument();
    expect(screen.queryByTestId('design-stage-working')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-stage-clarify')).not.toBeInTheDocument();
    expect(screen.queryByTestId('design-stage-prototype')).not.toBeInTheDocument();
  });

  it('(e) a gate for a DIFFERENT runId is ignored (falls through to intro)', () => {
    mockQuestionQueue = [makeQuestion({ id: 'q-2', runId: 'some-other-run' })];
    render(<DesignStage {...BASE_PROPS} sessionStatus="waiting" prototypeArtifact={null} />);

    expect(screen.queryByTestId('design-stage-clarify')).not.toBeInTheDocument();
    expect(screen.getByTestId('design-stage-intro')).toBeInTheDocument();
  });

  it('a null chatRunId never matches any queued gate', () => {
    mockQuestionQueue = [makeQuestion({ id: 'q-3', runId: 'run-1' })];
    render(<DesignStage {...BASE_PROPS} chatRunId={null} sessionStatus="waiting" prototypeArtifact={null} />);

    expect(screen.queryByTestId('design-stage-clarify')).not.toBeInTheDocument();
    expect(screen.getByTestId('design-stage-intro')).toBeInTheDocument();
  });
});
