/**
 * DesignPlannerPrompt — the post-approve "start the planner?" modal
 * (design-mode.md "Fullscreen design surface (v0.5)": approving a design exits
 * design mode and prompts the planner handoff).
 *
 * Mounted ONCE at the App level (a sibling of the design-mode swap, so it
 * survives the surface's unmount) and driven entirely by
 * `useDesignModeStore.plannerPrompt`: the surface arms it as Approve succeeds.
 * The user chooses where the planner run lands — "In this session" continues
 * the seamless SDK-pinned design session in place, or "In a new session"
 * always creates a fresh worktree-backed session (the prior, only, behavior).
 * Same-session hosting is gated client-side: the backend `RunLauncher` rejects
 * a run targeting an `inPlace`/`isMainRepo` session (it has no isolated
 * worktree) and enforces one active workflow per session, so the option is
 * only offered when the design session is worktree-backed and free; otherwise
 * it renders disabled with an inline hint. "Not now" just dismisses.
 *
 * The planner workflow row is resolved by name from `workflows.list` when the
 * prompt arms; a missing planner row (should not happen — it is a built-in)
 * degrades to an inline error instead of dead buttons.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../../ui/Modal';
import { trpc } from '../../../trpc/client';
import { useDesignModeStore, type PlannerPromptState } from '../../../stores/designModeStore';
import { useLaunchWorkflow } from '../../../hooks/useLaunchWorkflow';
import { useNavigationStore } from '../../../stores/navigationStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { isTerminalRunStatus, useActiveRunsStore } from '../../../stores/activeRunsStore';

export function DesignPlannerPrompt(): ReactElement | null {
  const prompt = useDesignModeStore((s) => s.plannerPrompt);
  if (prompt === null) return null;
  // Keyed by idea so a re-armed prompt never reuses stale inner state.
  return <DesignPlannerPromptInner key={prompt.ideaId} prompt={prompt} />;
}

function DesignPlannerPromptInner({ prompt }: { prompt: PlannerPromptState }): ReactElement {
  const dismiss = useDesignModeStore((s) => s.dismissPlannerPrompt);
  const [plannerId, setPlannerId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [pendingChoice, setPendingChoice] = useState<'same' | 'new' | null>(null);

  const session = useSessionStore((s) => s.sessions.find((x) => x.id === prompt.sessionId));
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);
  const sessionIsBusy = (runsByProject[prompt.projectId] ?? []).some(
    (run) => run.session_id === prompt.sessionId && !isTerminalRunStatus(run.status),
  );
  const sessionIsRawCheckout = session?.inPlace === true || session?.isMainRepo === true;
  const sameSessionEligible = session !== undefined && !sessionIsRawCheckout && !sessionIsBusy;
  const sameSessionHint =
    session === undefined
      ? "This session can't host the run."
      : sessionIsRawCheckout
        ? "This session works directly in the checkout — starting here isn't possible; a planner run needs its own worktree."
        : sessionIsBusy
          ? 'This session is busy with another run.'
          : null;

  const { launch, isLaunching, error: launchError } = useLaunchWorkflow(prompt.projectId, {
    onLaunched: () => {
      // setActiveRun already selected the new session; make sure the center
      // surface is the session view (idempotent when it already is).
      useNavigationStore.getState().goToSession();
      useDesignModeStore.getState().dismissPlannerPrompt();
    },
  });

  useEffect(() => {
    let cancelled = false;
    trpc.cyboflow.workflows.list
      .query({ projectId: prompt.projectId })
      .then((rows) => {
        if (cancelled) return;
        const planner = rows.find((r) => r.name === 'planner');
        if (planner) setPlannerId(planner.id);
        else setListError('Planner workflow not found.');
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setListError(err instanceof Error ? err.message : 'Failed to load workflows.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [prompt.projectId]);

  const error = launchError ?? listError;

  const handleStartSame = (): void => {
    if (plannerId === null || isLaunching || !sameSessionEligible) return;
    setPendingChoice('same');
    // The design session is already SDK-pinned and free — continue the run
    // there instead of spinning up a new worktree.
    void launch(plannerId, { ideaId: prompt.ideaId }, { hostSessionId: prompt.sessionId });
  };

  const handleStartNew = (): void => {
    if (plannerId === null || isLaunching) return;
    setPendingChoice('new');
    // forceNewSession: land the planner run in its own fresh worktree-backed
    // session, leaving the design session untouched.
    void launch(plannerId, { ideaId: prompt.ideaId }, { forceNewSession: true });
  };

  return (
    <Modal isOpen onClose={dismiss} size="sm" closeOnOverlayClick={false}>
      <ModalHeader>Design approved ✓</ModalHeader>
      <ModalBody>
        <div data-testid="design-planner-prompt" className="space-y-2 text-sm text-text-secondary">
          <p>
            The design spec was folded into{' '}
            <span className="font-medium text-text-primary">
              {prompt.ideaTitle ?? 'the linked idea'}
            </span>
            .
          </p>
          <p>Start the planner on this idea now? It can continue in this session or start in a fresh one.</p>
          {!sameSessionEligible && sameSessionHint && (
            <p data-testid="design-planner-prompt-same-hint" className="text-xs text-text-tertiary">
              {sameSessionHint}
            </p>
          )}
          {error && (
            <p data-testid="design-planner-prompt-error" className="text-xs text-status-error">
              {error}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          data-testid="design-planner-prompt-later"
          onClick={dismiss}
          className="px-3 py-1.5 text-xs rounded border border-border-primary text-text-secondary hover:text-text-primary"
        >
          Not now
        </button>
        <button
          type="button"
          data-testid="design-planner-prompt-start-new"
          onClick={handleStartNew}
          disabled={plannerId === null || isLaunching}
          className="px-3 py-1.5 text-xs rounded border border-border-primary text-text-secondary hover:text-text-primary disabled:opacity-50"
        >
          {isLaunching && pendingChoice === 'new' ? 'Starting…' : 'In a new session'}
        </button>
        <button
          type="button"
          data-testid="design-planner-prompt-start-same"
          onClick={handleStartSame}
          disabled={plannerId === null || isLaunching || !sameSessionEligible}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-interactive text-white hover:bg-interactive-hover disabled:opacity-50"
        >
          {isLaunching && pendingChoice === 'same' ? 'Starting…' : 'In this session'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
