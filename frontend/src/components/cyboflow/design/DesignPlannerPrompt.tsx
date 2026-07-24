/**
 * DesignPlannerPrompt — the post-approve "start the planner?" modal
 * (design-mode.md "Fullscreen design surface (v0.5)": approving a design exits
 * design mode and prompts the planner handoff).
 *
 * Mounted ONCE at the App level (a sibling of the design-mode swap, so it
 * survives the surface's unmount) and driven entirely by
 * `useDesignModeStore.plannerPrompt`: the surface arms it as Approve succeeds;
 * "Start planner" launches a planner run seeded with the approved idea via the
 * shared `useLaunchWorkflow` one-click lane (fresh worktree-backed session —
 * the design session must never host the run); "Not now" just dismisses.
 *
 * The planner workflow row is resolved by name from `workflows.list` when the
 * prompt arms; a missing planner row (should not happen — it is a built-in)
 * degrades to an inline error instead of a dead button.
 */
import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../../ui/Modal';
import { trpc } from '../../../trpc/client';
import { useDesignModeStore, type PlannerPromptState } from '../../../stores/designModeStore';
import { useLaunchWorkflow } from '../../../hooks/useLaunchWorkflow';
import { useNavigationStore } from '../../../stores/navigationStore';

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

  const handleStart = (): void => {
    if (plannerId === null || isLaunching) return;
    // forceNewSession: the design session is still the active selection — the
    // planner run must land in its own fresh worktree-backed session.
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
          <p>Start the planner on this idea now?</p>
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
          data-testid="design-planner-prompt-start"
          onClick={handleStart}
          disabled={plannerId === null || isLaunching}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-interactive text-white hover:bg-interactive-hover disabled:opacity-50"
        >
          {isLaunching ? 'Starting…' : 'Start planner'}
        </button>
      </ModalFooter>
    </Modal>
  );
}
