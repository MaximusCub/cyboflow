/**
 * WorkflowPicker — dropdown of the cyboflow workflows (Planner + Sprint + Ship +
 * any custom flows) + Start Run button.
 *
 * Accepts a `projectId` prop; on mount it calls `trpc.cyboflow.workflows.list`
 * and populates a `<select>`.  Clicking "Start Run" calls
 * `trpc.cyboflow.runs.start.mutate` and stores the returned runId in
 * `cyboflowStore`.
 *
 * Also provides a "Quick Session" button that creates a quick session via
 * `sessions:create-quick` IPC, bootstraps both Claude and Terminal panels via
 * `panelApi.createPanel`, and navigates via `setActiveQuickSession`.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { trpc } from '../../trpc/client';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useConfigStore } from '../../stores/configStore';
import { ensureSessionForLaunch } from '../../utils/ensureSessionForLaunch';
import { useQuickSession } from '../../hooks/useQuickSession';
import { useAgentPermissionMode } from '../../hooks/useAgentPermissionMode';
import { useSeededSelection } from '../../hooks/useSeededSelection';
import { WorkflowEditorModal } from './WorkflowEditorModal';
import { IdeaPickerModal } from './IdeaPickerModal';
import { AgentPermissionModeSelector } from './AgentPermissionModeSelector';
import { SubstrateSelector } from './SubstrateSelector';
import { ModelSelector, DEFAULT_CODEX_MODEL, DEFAULT_WORKFLOW_MODEL } from './ModelSelector';
import { TaskBatchPickerModal } from './TaskBatchPickerModal';
import { LaunchPromptModal } from './LaunchPromptModal';
import { VariantSelector } from './VariantSelector';
import { variantSelectionToStartInput, type VariantSelection } from './variantSelectorLogic';
import { type WorkflowRow, CYBOFLOW_WORKFLOW_NAMES } from '../../../../shared/types/workflows';
import { DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';
import { isCodexModelFamily, isCodexModelSelection } from '../../../../shared/types/agentModels';
import { DEFAULT_SESSION_AGENT_RUNTIME } from '../../../../shared/types/agentRuntime';
import type { LaunchAgentRuntime } from './agentRuntimeUi';
import {
  isCodexRuntime,
  providerForRuntime,
  quickSessionRuntimeForLaunch,
  substrateForRuntime,
  workflowRuntimeForLaunch,
} from './agentRuntimeUi';
import { trackEvent } from '../../utils/telemetry';
import type { TelemetryFlow } from '../../../../shared/types/telemetry';
import { notifyWorkflowRunStarted } from '../../utils/onboarding';

interface WorkflowPickerProps {
  projectId: number;
  onWorkflowStarted?: (runId: string) => void;
  /**
   * Force the launch into a brand-new session, never reusing the current
   * selection. Set by the "Add a workflow" flow on an interactive (PTY) session,
   * where a second workflow is descoped from the live-REPL session and must run
   * in its own separate session. Threaded into {@link ensureSessionForLaunch}.
   */
  forceNewSession?: boolean;
}

export function WorkflowPicker({ projectId, onWorkflowStarted, forceNewSession = false }: WorkflowPickerProps) {
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The per-launch agent runtime choice. Claude runtimes project onto the legacy
   * substrate field. On this mixed launch surface, Codex SDK can launch
   * workflows or quick sessions; Codex PTY is quick-session-only and disables
   * Start Run.
   */
  const [agentRuntime, setAgentRuntime] = useState<LaunchAgentRuntime>(DEFAULT_SESSION_AGENT_RUNTIME);

  /**
   * The user's global quick-session substrate preference (floors to 'interactive',
   * the PTY). This surface's substrate selector defaults to DEFAULT_SUBSTRATE
   * ('sdk') because it primarily governs WORKFLOW launches — but the "Quick
   * Session" escape hatch below is a real quick session and must honor the quick
   * preference, exactly like the Session Start Wizard and keyboard shortcut. When
   * the user hasn't touched the selector we launch the quick session on
   * `quickDefaultSubstrate`; an explicit selector change (tracked by
   * `substrateTouchedRef`) is a real per-launch choice and still wins.
   */
  const quickDefaultSubstrate = useConfigStore(
    (s) => s.config?.quickSessionDefaultSubstrate ?? 'interactive',
  );
  const substrateTouchedRef = useRef(false);

  /**
   * The per-run Claude model choice (Configure model dropdown). Seeded from the
   * user's stored per-run-type default for the SELECTED workflow
   * (`config.runTypeDefaults['workflow:<id>'].model`), floored to Opus
   * (DEFAULT_WORKFLOW_MODEL) when nothing is configured — the same resolution
   * useLaunchWorkflow / useTaskRunLauncher apply on their one-click lanes, so a
   * flow launched from here and from the backlog agree. Threaded into
   * runs.start.mutate as `model` → workflow_runs.model (migration 037) for
   * workflow launches, and into useQuickSession.start for the Quick Session button.
   *
   * Keyed on the selected workflow (`selectedId` is null until the list loads,
   * hence the '' key), so switching flows re-seeds to the NEW flow's default and
   * the prior flow's value never leaks — and each flow keeps its own touched flag.
   */
  const modelKey = `workflow:${selectedId ?? ''}`;
  const modelSeed = useConfigStore((s) => s.config?.runTypeDefaults?.[modelKey]?.model);
  const {
    value: model,
    setByUser: setModelByUser,
    reseed: reseedModel,
    isTouched: isModelTouched,
  } = useSeededSelection<string>({
    key: modelKey,
    seed: modelSeed,
    fallback: DEFAULT_WORKFLOW_MODEL,
  });
  // Runtime-family coercion: a Codex runtime cannot run a Claude model (and vice
  // versa), so flipping the runtime picker rewrites an incompatible selection.
  // This goes through `reseed`, NOT `setByUser`: it is a PROGRAMMATIC coercion,
  // and marking the model touched here would permanently freeze reactive
  // re-seeding for a control the user never actually touched (a mere
  // Claude→Codex→Claude round trip on the runtime picker would kill the stored
  // per-workflow default for the rest of the mount). The Claude branch re-seeds
  // to the stored default rather than the bare floor so it survives that round
  // trip intact — but ONLY when the stored default is itself Claude-compatible:
  // a stale cross-family entry (a Codex id saved under a workflow key) must not
  // be re-applied here, or the coercion would hand a Claude runtime a Codex
  // model and then no-op forever (setValue with the same value bails out).
  useEffect(() => {
    if (isCodexRuntime(agentRuntime)) {
      if (!isCodexModelSelection(model)) reseedModel(DEFAULT_CODEX_MODEL);
      return;
    }
    if (isCodexModelFamily(model)) {
      reseedModel(
        modelSeed !== undefined && !isCodexModelFamily(modelSeed) ? modelSeed : DEFAULT_WORKFLOW_MODEL,
      );
    }
  }, [agentRuntime, model, modelSeed, reseedModel]);

  /**
   * The per-run A/B variant choice (migration 048, VariantSelector). Defaults to
   * 'rotation' — a no-op selection ({@link variantSelectionToStartInput} sends
   * neither `variantId` nor `baseline`) so a workflow with zero (or no eligible)
   * variants launches exactly as before. VariantSelector re-seeds this to the
   * architect-specified default once its list resolves; reset to 'rotation'
   * whenever the selected workflow changes so a stale variant id from a
   * PREVIOUS workflow selection is never sent to a different workflow's launch
   * (variant ids are workflow-scoped — the resolver rejects a foreign pin).
   */
  const [variantSelection, setVariantSelection] = useState<VariantSelection>({ mode: 'rotation' });

  /**
   * The per-run agent permission choice — seeded from the global default and
   * guarded against the config-load race by {@link useAgentPermissionMode}.
   * Threaded into runs.start.mutate as `permissionMode` (the AppRouter-inferred
   * input).
   */
  const { mode: permissionMode, setMode: setPermissionMode } = useAgentPermissionMode();

  // Blueprint editor — opened in 'edit' (selected flow) or 'create' (new flow) mode.
  const [editorMode, setEditorMode] = useState<'edit' | 'create' | null>(null);

  // Planner pre-launch idea-selection gate (migration 017). When the selected
  // workflow is the Planner, "Start Run" opens this picker first; the chosen
  // idea id is threaded into runs.start.mutate({ ideaId }).
  const [ideaPickerOpen, setIdeaPickerOpen] = useState(false);

  // Sprint pre-launch multi-task selector (feat/parallel-sprint). When the
  // selected workflow is the Sprint, "Start Run" opens this picker first; the
  // multi-selected task ids are threaded into runs.start as `taskIds` — ONE
  // session-hosted run whose orchestrator agent fans the tasks out as subagents
  // (per-task progress renders as lanes in the run progress rail).
  const [batchPickerOpen, setBatchPickerOpen] = useState(false);

  // Launch pre-launch seed-prompt gate: the interview-driven super-planner
  // needs a free-text "what are you building?" answer before its first turn,
  // so "Start Run" opens this modal first; the trimmed answer is threaded
  // into runs.start.mutate({ seedPrompt }).
  const [launchPromptOpen, setLaunchPromptOpen] = useState(false);

  /**
   * Synchronous in-flight latch for "Start Run". The `isStarting` STATE guard is
   * insufficient against a double-submit: two clicks fired in the same tick both
   * read isStarting=false and both fire runs.start (each spinning up a worktree),
   * and the `disabled` attribute only applies after the next render. A ref flips
   * synchronously so the second click is rejected. (Prevents the duplicate-run bug.)
   */
  const startInFlightRef = useRef(false);

  const {
    start: startQuickSession,
    isStarting: isQuickStarting,
    error: quickError,
  } = useQuickSession({
    projectId,
    onSuccess: (sessionId) => {
      onWorkflowStarted?.(sessionId);
    },
  });

  /**
   * Fetch the project's workflow list. Refactored out of the mount effect into a
   * callable so it can be re-invoked after the editor saves a new/edited flow.
   * `preferId`, when set, is selected after the refresh (used to focus a flow the
   * user just created/edited); otherwise selection is preserved or defaults to
   * the first row.
   */
  const loadWorkflows = useCallback(
    (preferId?: string): Promise<void> => {
      setIsLoading(true);
      setError(null);
      return trpc.cyboflow.workflows.list
        .query({ projectId })
        .then((rows) => {
          setWorkflows(rows);
          setSelectedId((prev) => {
            if (preferId && rows.some((r) => r.id === preferId)) return preferId;
            if (prev !== null && rows.some((r) => r.id === prev)) return prev;
            return rows.length > 0 ? rows[0].id : null;
          });
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : 'Failed to load workflows');
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [projectId],
  );

  // Load workflows on mount (or when projectId changes).
  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows]);

  // A variant id is workflow-scoped — reset to the no-op 'rotation' selection
  // whenever the selected workflow changes so a PRIOR workflow's variant pin is
  // never sent to a different workflow's launch (VariantSelector re-seeds the
  // real default for the new workflow once its list resolves).
  useEffect(() => {
    setVariantSelection({ mode: 'rotation' });
  }, [selectedId]);

  const handleEditorSaved = useCallback(
    (savedId: string) => {
      setEditorMode(null);
      void loadWorkflows(savedId);
    },
    [loadWorkflows],
  );

  // Map a workflow row id to its telemetry flow key (built-in name, else 'custom').
  const flowOf = (workflowId: string): TelemetryFlow => {
    const name = workflows.find((w) => w.id === workflowId)?.name;
    return name && (CYBOFLOW_WORKFLOW_NAMES as readonly string[]).includes(name)
      ? (name as TelemetryFlow)
      : 'custom';
  };

  /**
   * Fire the actual runs.start mutation. `ideaSeed.ideaId` is the Planner's
   * single-select pre-launch seed idea (migration 017); `ideaSeed.ideaIds` is
   * its multi-select batch (IDEA-009) — mutually exclusive, both undefined for
   * Sprint (and any free Planner launch). `seedPrompt` is the Launch flow's
   * pre-launch free-text answer (LaunchPromptModal) — undefined for every
   * other flow. The synchronous in-flight latch flips HERE (at the real
   * mutate), NOT on modal open, so opening a gate picker/modal is freely
   * cancellable.
   */
  const launchRun = useCallback(
    async (
      workflowId: string,
      ideaSeed?: { ideaId?: string; ideaIds?: string[] },
      seedPrompt?: string,
    ): Promise<void> => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;
      setError(null);
      setIsStarting(true);
      try {
        const workflowRuntime = workflowRuntimeForLaunch(agentRuntime);
        if (workflowRuntime === null) {
          throw new Error('Codex PTY is only available for quick sessions.');
        }
        const launchSubstrate = substrateForRuntime(workflowRuntime);
        // Ensure the run executes INSIDE a session (active one if selected, else
        // a freshly created session). The id is threaded into runs.start so the
        // run runs in that session's worktree, and used to nest the run under
        // the session in the store (setActiveRun's parentSessionId). forceNew
        // bypasses reuse for the PTY add-workflow flow (separate session).
        const sessionId = await ensureSessionForLaunch(projectId, {
          forceNew: forceNewSession,
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          agentModel: model,
        });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          sessionId,
          permissionMode,
          model,
          ...(ideaSeed?.ideaIds !== undefined
            ? { ideaIds: ideaSeed.ideaIds }
            : ideaSeed?.ideaId !== undefined
              ? { ideaId: ideaSeed.ideaId }
              : {}),
          ...(seedPrompt !== undefined ? { seedPrompt } : {}),
          ...variantSelectionToStartInput(variantSelection),
        });
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        trackEvent('workflow_run_started', {
          launch_surface: 'topbar',
          flow: flowOf(workflowId),
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          permission_mode: permissionMode,
        });
        notifyWorkflowRunStarted({ runId: result.runId, launchSurface: 'topbar' });
        onWorkflowStarted?.(result.runId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to start run');
      } finally {
        setIsStarting(false);
        startInFlightRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, agentRuntime, permissionMode, model, variantSelection, onWorkflowStarted, forceNewSession, workflows],
  );

  /**
   * Fire the parallel-sprint launch — ONE session-hosted sprint run seeded with
   * the multi-selected task ids (single-run lane model). Mirrors launchRun
   * exactly (ensureSessionForLaunch → runs.start → setActiveRun →
   * onWorkflowStarted); `taskIds` makes the launcher create the lane batch and
   * stamp workflow_runs.batch_id. The substrate-keyed cap N is enforced both in
   * the picker and server-side in runs.start (defense in depth). The synchronous
   * in-flight latch flips HERE (at the real mutate), so opening the picker stays
   * freely cancellable — mirrors launchRun.
   */
  const launchBatch = useCallback(
    async (workflowId: string, taskIds: string[]): Promise<void> => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;
      setError(null);
      setIsStarting(true);
      try {
        const workflowRuntime = workflowRuntimeForLaunch(agentRuntime);
        if (workflowRuntime === null) {
          throw new Error('Codex PTY is only available for quick sessions.');
        }
        const launchSubstrate = substrateForRuntime(workflowRuntime);
        const sessionId = await ensureSessionForLaunch(projectId, {
          forceNew: forceNewSession,
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          agentModel: model,
        });
        const result = await trpc.cyboflow.runs.start.mutate({
          workflowId,
          projectId,
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          agentProvider: providerForRuntime(workflowRuntime),
          agentRuntime: workflowRuntime,
          sessionId,
          permissionMode,
          model,
          taskIds,
          ...variantSelectionToStartInput(variantSelection),
        });
        useCyboflowStore.getState().setActiveRun(result.runId, sessionId);
        trackEvent('workflow_run_started', {
          launch_surface: 'topbar',
          flow: flowOf(workflowId),
          ...(launchSubstrate ? { substrate: launchSubstrate } : {}),
          permission_mode: permissionMode,
        });
        notifyWorkflowRunStarted({ runId: result.runId, launchSurface: 'topbar' });
        onWorkflowStarted?.(result.runId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to start sprint run');
      } finally {
        setIsStarting(false);
        startInFlightRef.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, agentRuntime, permissionMode, model, variantSelection, onWorkflowStarted, forceNewSession, workflows],
  );

  const handleStartRun = async () => {
    if (selectedId === null || startInFlightRef.current) return;
    // Planner is gated behind the idea picker, Sprint behind the batch picker,
    // Launch behind the seed-prompt modal. Workflow `name` is the lowercase
    // CyboflowWorkflowName seeded by WorkflowRegistry — compare to 'planner' /
    // 'sprint' / 'launch'. Ship (planner ⊕ sprint in one run) is IDEA-seeded
    // like the planner, so it shares the idea gate.
    const selected = workflows.find((wf) => wf.id === selectedId);
    if (selected?.name === 'planner' || selected?.name === 'ship') {
      setError(null);
      setIdeaPickerOpen(true);
      return;
    }
    if (selected?.name === 'sprint') {
      setError(null);
      setBatchPickerOpen(true);
      return;
    }
    if (selected?.name === 'launch') {
      setError(null);
      setLaunchPromptOpen(true);
      return;
    }
    await launchRun(selectedId);
  };

  const handleBatchPicked = useCallback(
    (taskIds: string[]): void => {
      setBatchPickerOpen(false);
      if (taskIds.length === 0) return;
      // The sprint workflow id is the current selection (handleStartRun resolved
      // it before opening the picker; the modal blocks re-selection meanwhile).
      if (selectedId === null) return;
      void launchBatch(selectedId, taskIds);
    },
    [selectedId, launchBatch],
  );

  const handleIdeaPicked = useCallback(
    (ideaIds: string[], opts?: { separateIdeaIds: string[] }): void => {
      setIdeaPickerOpen(false);
      if (selectedId === null) return;
      const workflowId = selectedId;
      void (async () => {
        // A 1-element batch and a single-idea launch are behaviorally identical
        // downstream, but the singular `ideaId` path is the well-trodden one —
        // normalize down to it rather than sending a 1-element `ideaIds` array.
        if (ideaIds.length === 1) {
          await launchRun(workflowId, { ideaId: ideaIds[0] });
        } else if (ideaIds.length > 1) {
          await launchRun(workflowId, { ideaIds });
        }
        // "Plan separately" picks (planner multi-select only, IDEA-009): fire one
        // additional single-idea planner launch per peeled idea, sequentially,
        // after the batch launch. Safe here — launchRun's in-flight latch resets
        // unconditionally in its `finally`, and this surface never navigates away.
        for (const id of opts?.separateIdeaIds ?? []) {
          await launchRun(workflowId, { ideaId: id });
        }
      })();
    },
    [selectedId, launchRun],
  );

  const handleLaunchPromptSubmit = useCallback(
    (seedPrompt: string): void => {
      setLaunchPromptOpen(false);
      if (selectedId === null) return;
      void launchRun(selectedId, undefined, seedPrompt);
    },
    [selectedId, launchRun],
  );

  const handleQuickSession = useCallback(() => {
    // The runtime selector primarily governs WORKFLOW launches and defaults to
    // the SDK runtime. The "Quick Session" escape hatch is a real quick session,
    // so when the user hasn't explicitly touched the selector it must honor the
    // quick-session substrate preference (projected onto a Claude runtime), like
    // the wizard + keyboard shortcut. An explicit runtime pick still wins.
    const effectiveRuntime = substrateTouchedRef.current
      ? agentRuntime
      : quickDefaultSubstrate === 'interactive'
        ? 'claude-interactive'
        : 'claude-sdk';
    const sessionRuntime = quickSessionRuntimeForLaunch(effectiveRuntime);
    // Shared-control ambiguity: this panel has ONE control set driving TWO run
    // types. The controls key to `workflow:<selectedId>` (they primarily govern
    // workflow launches), so an UNTOUCHED model here carries the selected
    // WORKFLOW's default — which is the wrong default for a quick session.
    // Settled resolution: a touched control is a real per-launch choice and is
    // forwarded verbatim; otherwise we resolve the quick default freshly from
    // the synthetic 'quick' key (read imperatively via getState(), consistent
    // with useLaunchWorkflow / useQuickSession.startWithDefaults).
    //
    // The family guard is load-bearing: the 'quick' default is stored without
    // regard to this launch's runtime, so an untouched Codex-runtime quick
    // session could otherwise be handed a Claude model (and vice versa). When
    // the stored value is incompatible we fall back to the live control value,
    // which the coercion effect above already keeps family-correct.
    const storedQuickModel = useConfigStore.getState().config?.runTypeDefaults?.quick?.model;
    const quickModel =
      isModelTouched || storedQuickModel === undefined
        ? model
        : (
            isCodexRuntime(sessionRuntime)
              ? isCodexModelSelection(storedQuickModel)
              : !isCodexModelFamily(storedQuickModel)
          )
          ? storedQuickModel
          : model;
    void startQuickSession(
      permissionMode,
      substrateForRuntime(sessionRuntime),
      undefined,
      quickModel,
      undefined,
      undefined,
      undefined,
      undefined,
      providerForRuntime(sessionRuntime),
      sessionRuntime,
    );
  }, [agentRuntime, model, isModelTouched, permissionMode, startQuickSession, quickDefaultSubstrate]);

  const combinedError = error ?? quickError;
  const workflowRuntimeBlocked = workflowRuntimeForLaunch(agentRuntime) === null;
  const selectedSubstrate = substrateForRuntime(agentRuntime);
  const selectedProvider = providerForRuntime(agentRuntime);

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">Workflow</h2>

      {isLoading && (
        <p className="text-xs text-text-secondary">Loading workflows…</p>
      )}

      {!isLoading && workflows.length > 0 && (
        <select
          value={selectedId ?? ''}
          onChange={(e) => {
            setSelectedId(e.target.value);
            trackEvent('flow_selected', { flow: flowOf(e.target.value) });
          }}
          className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
          aria-label="Select workflow"
        >
          {workflows.map((wf) => (
            <option key={wf.id} value={wf.id}>
              {wf.name}
            </option>
          ))}
        </select>
      )}

      {/* Agent runtime selector + interactive v1 caveats (IDEA-013 / TASK-812). */}
      <SubstrateSelector
        value={agentRuntime}
        onChange={(next) => {
          // A real per-launch choice — after this the Quick Session button uses
          // the explicit runtime's substrate instead of the quick-session default.
          substrateTouchedRef.current = true;
          setAgentRuntime(next);
        }}
        id="workflow-picker-substrate"
        caveatsTestId="workflow-picker-substrate-caveats"
        runtimeScope="mixed"
      />

      {/* Session permission selector — an explicit choice permanently sets the
          host session's mode (the sole execution authority), affecting later chat
          and later flows in that session; the launch still stamps the audit-only
          permission_mode_snapshot. Omitted → the session mode is left untouched. */}
      <AgentPermissionModeSelector
        value={permissionMode}
        onChange={setPermissionMode}
        agentProvider={selectedProvider}
        agentRuntime={agentRuntime}
      />

      {/* Per-run model selector — pins the model a workflow run (or quick session)
          spawns with (default Opus). Workflow: threaded into runs.start as `model`
          → workflow_runs.model (migration 037). Quick: into useQuickSession. */}
      <ModelSelector
        value={model}
        onChange={setModelByUser}
        id="workflow-picker-model"
        agentProvider={selectedProvider}
        agentRuntime={agentRuntime}
      />
      {/* Per-run A/B variant selector (migration 048) — hidden entirely for a
          workflow with zero variants. Threaded into runs.start as variantId /
          baseline (never both); rotation sends neither field. */}
      {selectedId !== null && (
        <VariantSelector
          workflowId={selectedId}
          value={variantSelection}
          onChange={setVariantSelection}
          id="workflow-picker-variant"
        />
      )}

      {combinedError && (
        <p className="text-xs text-status-error" role="alert">
          {combinedError}
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleStartRun}
          disabled={selectedId === null || isLoading || isStarting || isQuickStarting || workflowRuntimeBlocked}
          className="flex-1 rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start Run
        </button>
        <button
          onClick={() => setEditorMode('edit')}
          disabled={selectedId === null || isLoading}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="workflow-picker-edit"
        >
          Edit
        </button>
        <button
          onClick={() => setEditorMode('create')}
          disabled={isLoading}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="workflow-picker-new-flow"
        >
          New flow
        </button>
      </div>

      {editorMode !== null && (
        <WorkflowEditorModal
          isOpen
          mode={editorMode}
          workflowId={selectedId ?? ''}
          projectId={projectId}
          onClose={() => setEditorMode(null)}
          onSaved={handleEditorSaved}
        />
      )}

      {ideaPickerOpen && (
        <IdeaPickerModal
          isOpen
          projectId={projectId}
          onClose={() => setIdeaPickerOpen(false)}
          onPicked={handleIdeaPicked}
          // Multi-select batch (IDEA-009) is a Planner-only affordance — Ship
          // stays single-select (it consumes exactly one idea per run).
          multi={workflows.find((wf) => wf.id === selectedId)?.name === 'planner'}
        />
      )}

      {batchPickerOpen && (
        <TaskBatchPickerModal
          isOpen
          projectId={projectId}
          substrate={selectedSubstrate ?? DEFAULT_SUBSTRATE}
          onClose={() => setBatchPickerOpen(false)}
          onPicked={handleBatchPicked}
        />
      )}

      {launchPromptOpen && (
        <LaunchPromptModal
          open
          onCancel={() => setLaunchPromptOpen(false)}
          onSubmit={handleLaunchPromptSubmit}
        />
      )}

      <div className="mt-2 flex flex-col gap-2 border-t border-border-primary pt-3">
        <p className="text-xs text-text-secondary">Or start without a workflow:</p>
        <button
          onClick={handleQuickSession}
          disabled={isQuickStarting || isStarting}
          className="rounded-button border border-interactive bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="quick-session-button"
        >
          Quick Session
        </button>
      </div>
    </div>
  );
}
