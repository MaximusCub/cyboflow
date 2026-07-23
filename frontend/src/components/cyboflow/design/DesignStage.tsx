/**
 * DesignStage — the v0.5 fullscreen design surface's center-stage state
 * machine (design-mode.md "Fullscreen design surface (v0.5)").
 *
 * Renders by strict precedence, exactly one state at a time:
 *
 *   1. clarify  — pending AskUserQuestion gates for this session's chat run,
 *                 rendered center-stage as cards.
 *   2. working  — the agent is generating (session status 'running' OR a
 *                 live tail in flight) and there is no pending gate.
 *   3. prototype — a bound `ui-prototype` artifact exists and the agent is
 *                 not currently working.
 *   4. intro    — nothing above applies (idle, pre-kickoff, or idle with no
 *                 artifact yet).
 *
 * NOTE the deliberate precedence subtlety: prototype does NOT win over
 * working just because an (older) prototype already exists — while the agent
 * regenerates, the working animation shows even with a stale prototype
 * sitting behind it. Only when working goes false does the (possibly newer)
 * prototype take over.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useQuestionStore } from '../../../stores/questionStore';
import { usePanelLiveEventsStore } from '../../../stores/panelLiveEventsStore';
import { reduceLiveTail } from '../../../utils/liveTailReducer';
import { AskUserQuestionCard } from '../../AskUserQuestion/AskUserQuestionCard';
import { DesignStageCanvas } from './DesignStageCanvas';
import type { Artifact } from '../../../../../shared/types/artifacts';

interface DesignStageProps {
  sessionId: string;
  chatRunId: string | null;
  panelId: string | null;
  sessionStatus: string | null;
  prototypeArtifact: Artifact | null;
}

/** Cosmetic status lines cycled while the agent works. Purely decorative. */
const WORKING_STATUS_LINES = ['Reading the idea…', 'Grounding in your codebase…', 'Designing…'];

/** Cycle interval for the working status line, in ms (exported for tests). */
export const WORKING_STATUS_CYCLE_MS = 2200;

/**
 * The stage's liveness indicator: a ring with a rotating arc (animate-spin).
 * A plain `animate-pulse` on a hollow ring read as a static blank circle in the
 * live smoke — the arc gives unambiguous motion. Arc color via inline var()
 * because the Tailwind border palette doesn't map the semantic text tokens.
 */
function StageSpinner(): ReactElement {
  return (
    <div
      data-testid="design-stage-spinner"
      className="h-10 w-10 rounded-full border-2 border-border-primary animate-spin"
      style={{ borderTopColor: 'var(--color-text-secondary)' }}
    />
  );
}

function WorkingState(): ReactElement {
  const [statusIndex, setStatusIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setStatusIndex((i) => (i + 1) % WORKING_STATUS_LINES.length);
    }, WORKING_STATUS_CYCLE_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div data-testid="design-stage-working" className="h-full w-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <StageSpinner />
        <span className="text-sm text-text-muted" data-testid="design-stage-working-status">
          {WORKING_STATUS_LINES[statusIndex]}
        </span>
      </div>
    </div>
  );
}

function IntroState(): ReactElement {
  // Carries the same pulse as the working state: a fresh design session sits
  // here for the second or two before its kickoff turn flips the session to
  // 'running', and a static panel in that window reads as "nothing is
  // happening" (live-smoke feedback).
  return (
    <div data-testid="design-stage-intro" className="h-full w-full flex items-center justify-center">
      <div className="max-w-md flex flex-col items-center gap-4 text-center px-8 py-10 border border-border-primary rounded-lg">
        <StageSpinner />
        <p className="text-sm text-text-muted">
          Design session starting — the designer will read the linked idea and check in here.
        </p>
      </div>
    </div>
  );
}

export function DesignStage({
  sessionId: _sessionId,
  chatRunId,
  panelId,
  sessionStatus,
  prototypeArtifact,
}: DesignStageProps): ReactElement {
  // questionStore.init() is idempotent — safe to call unconditionally on mount.
  useEffect(() => {
    useQuestionStore.getState().init();
  }, []);

  const queue = useQuestionStore((s) => s.queue);
  const pending = useMemo(
    () => (chatRunId !== null ? queue.filter((q) => q.runId === chatRunId) : []),
    [queue, chatRunId],
  );

  const panelLiveEvents = usePanelLiveEventsStore((s) => (panelId !== null ? s.byPanel[panelId] : undefined));
  const liveTail = useMemo(() => reduceLiveTail(panelLiveEvents ?? []), [panelLiveEvents]);
  const working = sessionStatus === 'running' || liveTail.isGenerating;

  if (pending.length > 0) {
    return (
      <div data-testid="design-stage-clarify" className="h-full w-full overflow-y-auto">
        <div className="max-w-2xl mx-auto py-8 space-y-4">
          <h2 className="text-xs font-medium text-text-muted uppercase tracking-wide px-1">
            The designer needs your input
          </h2>
          {pending.map((q) => (
            <AskUserQuestionCard key={q.id} item={q} />
          ))}
        </div>
      </div>
    );
  }

  if (working) {
    return <WorkingState />;
  }

  if (prototypeArtifact !== null) {
    return (
      <div data-testid="design-stage-prototype" className="h-full w-full">
        <DesignStageCanvas artifact={prototypeArtifact} />
      </div>
    );
  }

  return <IntroState />;
}
