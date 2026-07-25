import React, { useMemo, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { AIPanelProps } from '../ai/AbstractAIPanel';
import { useClaudePanel } from '../../../hooks/useClaudePanel';
import { useConfigStore } from '../../../stores/configStore';
import type { ClaudePanelState } from '../../../../../shared/types/panels';
import { PendingApprovalsForRun } from '../../ReviewQueue/PendingApprovalsForRun';
import { useSession } from '../../../contexts/SessionContext';
import { useSessionStore } from '../../../stores/sessionStore';
import { InteractiveTerminalView } from '../../cyboflow/InteractiveTerminalView';
import { ResumeSessionPrompt } from '../../cyboflow/ResumeSessionPrompt';
import { DemoTerminalView } from '../../cyboflow/DemoTerminalView';
import { API } from '../../../utils/api';
import { QuickSessionComposer } from '../../cyboflow/unified/QuickSessionComposer';
import { UnifiedChatView } from '../../cyboflow/unified/UnifiedChatView';
import { useUnifiedPanelMessages } from '../../cyboflow/unified/useUnifiedPanelMessages';
import { SessionActionToast } from '../../cyboflow/SessionActionToast';
import { usePendingSendStore } from '../../../stores/pendingSendStore';
import { useQuestionStore } from '../../../stores/questionStore';
import { AskUserQuestionCard } from '../../AskUserQuestion/AskUserQuestionCard';
import { usePanelLiveEventsStore } from '../../../stores/panelLiveEventsStore';
import { LiveTail } from '../../chat/LiveTail';
import { reduceLiveTail, hasVisibleTailContent } from '../../../utils/liveTailReducer';

// Sessions whose open-time resume prompt the user explicitly declined ("Start
// fresh") this app run. Module-level so the decision survives ClaudePanel
// remounts (e.g. switching sessions and back) — without it the probe would
// re-offer resume every remount until the user finally sends a message.
const declinedResumeSessions = new Set<string>();

/** Test-only: clear the module-level declined-resume memory between cases. */
export function __resetDeclinedResumeForTests(): void {
  declinedResumeSessions.clear();
}

/**
 * ClaudePanel — quick-session host for the shared <UnifiedChatView>.
 *
 * Renders the SAME chat surface a workflow run renders (RunChatView): the SDK
 * substrate feeds the structured transcript from `useUnifiedPanelMessages`
 * (panel-scoped `getJsonMessages` + live `session-output-available`), and the
 * interactive (PTY) substrate swaps in the live xterm as the `interactiveBody`.
 * This file owns only the quick-session-specific wiring: the substrate render
 * gate, the open-time REPL resume recovery, the ⌃G composer reveal, and the
 * bottom region (approvals + the unified composer + permission toast).
 */
export const ClaudePanel: React.FC<AIPanelProps> = React.memo(({ panel, isActive }) => {
  const hook = useClaudePanel(panel.id, isActive);
  const activeSession = hook.activeSession;
  // Reliable run id for inline approvals (Role-G — permission-mode redesign §6):
  // chat turns gate on the persistent __quick__ chat_run_id sentinel, DECOUPLED
  // from runId (the latest flow run). The surrounding SessionProvider holds the
  // freshly-fetched session, whose chatRunId reflects the minted/backfilled
  // sentinel; the session-store copy (activeSession) can lag with a null chatRunId
  // for freshly-created quick sessions, so prefer context.
  const sessionCtx = useSession();
  const approvalRunId = sessionCtx?.session.chatRunId ?? activeSession?.chatRunId ?? null;
  // Interactive-PTY render swap (PTY-backed quick sessions): when this panel's
  // session runs on the 'interactive' substrate, the live xterm
  // (InteractiveTerminalView, keyed by the chat __quick__ sentinel run id) replaces
  // the SDK structured transcript below. Session resolution mirrors
  // approvalRunId — prefer the SessionProvider's freshly-fetched session, fall
  // back to the store copy keyed by the panel's sessionId. Null-safe: an
  // interactive session whose chatRunId has not landed yet keeps the SDK surface.
  // Check activeMainRepoSession FIRST: sessionStore.updateSession early-returns
  // for the active main-repo session, writing the update ONLY there and leaving
  // any `sessions` copy stale. Reading just `sessions` would therefore freeze this
  // panel's status (and with it `composerWorking` → the Stop button) for a
  // main-repo quick session. Claude masks that via the live-tail isGenerating
  // flag; codex-sdk emits no stream deltas, so it would never show Stop at all.
  const panelStoreSession = useSessionStore((state) =>
    state.activeMainRepoSession?.id === panel.sessionId
      ? state.activeMainRepoSession
      : state.sessions.find((s) => s.id === panel.sessionId),
  );
  const substrateSession = sessionCtx?.session ?? panelStoreSession;
  const isCodexPtySession = substrateSession?.agentRuntime === 'codex-pty';
  // Effective substrate for THIS panel: a per-panel override (TASK-104 —
  // panel.substrate, set at "Add chat" creation time via the picker, or later
  // via claude-panels:set-substrate) wins over the session's substrate,
  // mirroring the backend's resolveSubstrate precedence (ClaudePanelManager.
  // getCliManager). Reading only substrateSession.substrate here (as before)
  // meant an added chat with a PTY override on an otherwise-SDK session still
  // rendered the SDK transcript/composer — which then waits forever for SDK
  // stream events that never arrive, since the backend actually spawned a PTY
  // for that panel. isCodexPtySession stays session-only: per-panel
  // agentRuntime override is explicitly out of scope for TASK-104.
  const effectiveSubstrate = panel.substrate ?? substrateSession?.substrate;
  const isPtyBackedSession = isCodexPtySession || effectiveSubstrate === 'interactive';
  // PTY-backed panels (interactive Claude AND Codex PTY) key their live terminal
  // by their OWN panelId, NOT the session's shared chatSentinelProvider
  // chat_run_id sentinel (every panel of a session resolves the SAME chat_run_id
  // — it is a session-level approval-gate vehicle, not a per-panel identity).
  // Using the shared sentinel would collapse two concurrent PTY chat panels
  // (Add-chat) onto the same `cyboflow:pty:<runId>` channel / xterm cache / relay
  // target, merging their output and misrouting keystrokes — the "second codex
  // chat shares a stream" bug. SubstrateDispatchFacade resolves relayInput/
  // relayResize/getPtyBacklog by panelId for exactly this reason (registerPtyPanel
  // / recordInteractivePanelMapping's panelId-identity registration), the backend
  // eager-spawns each added panel its own REPL keyed by panelId (ipc/panels.ts →
  // relayOrSpawnPtyPanel), and index.ts broadcasts pty bytes on BOTH the legacy
  // chat_run_id channel and the panelId channel — panelId is simply the more
  // specific, always-unique key that both the primary and added panels resolve.
  const interactiveRunId = isPtyBackedSession ? panel.id : null;
  // Demo mode: an interactive quick session is stamped 'interactive' so this
  // panel swaps in a terminal surface, but the real PTY is never spawned
  // (ipc/session.ts). Render the canned DemoTerminalView instead of the live
  // InteractiveTerminalView (which would subscribe to an empty pty channel).
  const demoModeEnabled = useConfigStore((state) => state.config?.demoMode ?? false);
  const showDemoTerminal = !isCodexPtySession && demoModeEnabled && interactiveRunId !== null;

  // Interactive quick sessions are driven by typing DIRECTLY into the live PTY
  // terminal above, so the separate "Message the live session" composer is
  // redundant and is hidden by default. Ctrl+G summons it for rich multi-line
  // text entry. Captured at the window level (capture phase) so the keystroke
  // toggles the composer instead of reaching xterm as a BEL (\x07).
  const [composerOpen, setComposerOpen] = useState(false);
  // Substrate-aware confirmation for a permission-mode change from the composer
  // pill, co-located with the composer that triggers it.
  const [permissionToast, setPermissionToast] = useState<string | null>(null);

  // Open-time resume recovery for a lost interactive (PTY) quick session. After
  // an app restart the persistent REPL is gone but the prior conversation can be
  // resumed (sessions.claude_session_id + claude's on-disk transcript survive).
  const [resumePromptDismissed, setResumePromptDismissed] = useState(false);
  const [resumeArmed, setResumeArmed] = useState(false);
  const [canOfferResume, setCanOfferResume] = useState(false);

  useEffect(() => {
    if (interactiveRunId === null) {
      setComposerOpen(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        e.stopPropagation();
        setComposerOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [interactiveRunId]);

  // On ⌃G reveal, move focus into the composer so the user's next keystrokes
  // land in the rich text box instead of the live PTY terminal.
  useEffect(() => {
    if (!composerOpen) return;
    const id = requestAnimationFrame(() => hook.textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [composerOpen, hook.textareaRef]);

  // Probe resume eligibility once per interactive quick session (skip demo, whose
  // REPL is never real). Resumable = REPL not live + a stored claude_session_id +
  // the worktree still on disk. Resets cleanly when the panel's session changes.
  useEffect(() => {
    const sessionId = panel.sessionId;
    setResumePromptDismissed(false);
    setResumeArmed(false);
    setCanOfferResume(false);
    if (interactiveRunId === null || showDemoTerminal || isCodexPtySession || !sessionId) return;
    // The user already chose "Start fresh" for this session this app run — don't
    // re-offer until the REPL is live again (a new loss episode).
    if (declinedResumeSessions.has(sessionId)) return;
    let cancelled = false;
    void API.sessions
      .getInteractiveResumeState(sessionId)
      .then((res) => {
        if (cancelled) return;
        const data = res?.data;
        if (res?.success && data && !data.replRunning && data.claudeSessionId && data.worktreeExists) {
          setCanOfferResume(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [panel.sessionId, interactiveRunId, showDemoTerminal, isCodexPtySession]);

  // The "Resuming…" hint is a transient cue shown while claude reopens the prior
  // conversation. Auto-clear it so it never sticks forever.
  useEffect(() => {
    if (!resumeArmed) return;
    const id = setTimeout(() => setResumeArmed(false), 12_000);
    return () => clearTimeout(id);
  }, [resumeArmed]);

  // "Resume previous session" → EAGERLY re-spawn the REPL (`--resume <uuid>`,
  // server-side) so the prior conversation reopens live immediately. Also DISMISS
  // the prompt for this mount: the probe never re-runs for a quick session (its
  // sentinel runId is constant), so canOfferResume stays stale-true and the
  // prompt would re-pop once the "Resuming…" hint clears.
  const handleResumeSession = (): void => {
    setResumeArmed(true);
    setResumePromptDismissed(true);
    void API.sessions.resumeInteractive(panel.sessionId).catch(() => undefined);
  };

  // "Start fresh" (or Escape) → decline: remember the choice and hide the prompt.
  const handleDeclineResume = (): void => {
    setResumePromptDismissed(true);
    declinedResumeSessions.add(panel.sessionId);
  };

  const claudePanelState = (panel.state.customState as ClaudePanelState | undefined) ?? {};
  // SDK substrate emits a "54k/200k tokens (27%)" string; null for PTY/empty.
  const contextUsage = claudePanelState.contextUsage ?? null;

  // Extract and store slash commands when we get JSON messages with init.
  useEffect(() => {
    if (!activeSession) return;
    const jsonMessages = activeSession.jsonMessages || [];
    const initMessage = jsonMessages.find(
      (msg: { type?: string; subtype?: string; slash_commands?: string[] }) =>
        msg.type === 'system' && msg.subtype === 'init' && msg.slash_commands,
    );
    if (initMessage && Array.isArray(initMessage.slash_commands)) {
      try {
        const slashCommandsKey = `slashCommands_${activeSession.id}`;
        localStorage.setItem(slashCommandsKey, JSON.stringify(initMessage.slash_commands));
      } catch (e) {
        console.warn('[slash-debug] Failed to store slash commands for Cyboflow session:', e);
      }
    }
  }, [activeSession?.jsonMessages, activeSession?.id]);

  // Unified-chat chrome derivations for this quick session. Use the PANE's own
  // session (substrateSession), falling back to the global activeSession only
  // when neither context nor store copy is present — the global store
  // activeSession can point at a different / lagging session than this panel.
  // Prefer the LIVE store copy here — deliberately the opposite preference from
  // `substrateSession` above. The SessionContext session (CyboflowRoot's
  // `effectiveSession`) is resolved ONCE and its `status` never updates: it was
  // observed frozen at 'initializing' while the session was actually running,
  // which froze `sessionRunning` → `composerWorking` → the Stop / Queue /
  // Interrupt affordances. Claude hid that behind the live-tail isGenerating
  // flag; codex-sdk emits no stream deltas, so its Stop button never appeared at
  // all. substrateSession keeps its context-first preference because it is read
  // for chatRunId / substrate, which the store copy can still be lagging on
  // right after a quick-session create.
  const paneSession = panelStoreSession ?? sessionCtx?.session ?? activeSession;
  const isInteractive = interactiveRunId !== null;
  const agentName =
    isCodexPtySession || paneSession?.agentRuntime === 'codex-sdk'
      ? 'Codex'
      : isInteractive
        ? 'Terminal'
        : 'Claude';

  // SDK structured transcript source (panel-scoped). Disabled on the interactive
  // substrate, whose live xterm owns the conversation surface.
  const { messages, loadError } = useUnifiedPanelMessages(panel.id, !isInteractive);

  // Pending-send (optimistic echo) — keyed by panel.id (the same id passed as
  // railId + the QuickSessionComposer hostKey). Reconcile against the transcript
  // so a 'sending'/'queued' row is dropped once its real user turn appears.
  const pendingSends = usePendingSendStore((s) => s.byHost[panel.id]);
  const reconcilePending = usePendingSendStore((s) => s.reconcile);
  const requestReopenPending = usePendingSendStore((s) => s.requestReopen);
  useEffect(() => {
    reconcilePending(panel.id, messages);
  }, [messages, panel.id, reconcilePending]);

  // Progressive-render live tail (Option A — see render-map.md): quick panels
  // have no cyboflowStore.streamEvents equivalent, so their `stream_event`/
  // `result` envelopes are captured separately by panelLiveEventsStore (fed
  // from useIPCEvents.ts's onSessionOutput). Skipped on the interactive
  // substrate, whose live xterm owns the conversation surface and never
  // renders ChatTranscript.
  const panelLiveEvents = usePanelLiveEventsStore((s) => s.byPanel[panel.id]);
  const liveTailState = useMemo(
    () => (isInteractive ? { activeBlocks: [], isGenerating: false } : reduceLiveTail(panelLiveEvents ?? [])),
    [isInteractive, panelLiveEvents],
  );
  // Gate on VISIBLE content, not block existence: a block opens empty at
  // content_block_start and an all-empty tail would render a bare "Claude"
  // header while suppressing the animated fallback (blank-bubble bug).
  const liveTail = hasVisibleTailContent(liveTailState.activeBlocks) ? (
    <LiveTail blocks={liveTailState.activeBlocks} agentName={agentName} />
  ) : undefined;

  // -------------------------------------------------------------------------
  // Pending AskUserQuestion gates for this quick session. Chat turns gate on
  // the persistent __quick__ chat_run_id sentinel (the same key the approvals
  // strip uses), so filter the global question queue by approvalRunId. Mirrors
  // RunChatView's wiring: an inline card at the AskUserQuestion tool_use
  // position when the transcript carries the anchor, plus a bottom fallback for
  // questions with no transcript tool row to anchor against (the tool_use stays
  // in-progress until the human answers, so the anchor can be absent — and the
  // interactive substrate never renders ChatTranscript at all).
  // -------------------------------------------------------------------------
  const questionQueue = useQuestionStore((s) => s.queue);
  const pendingQuestions = useMemo(
    () => (approvalRunId === null ? [] : questionQueue.filter((q) => q.runId === approvalRunId)),
    [questionQueue, approvalRunId],
  );
  const renderToolCallExtra = useCallback(
    (toolCallId: string): ReactNode => {
      const question = pendingQuestions.find((q) => q.toolUseId === toolCallId);
      return question != null ? <AskUserQuestionCard item={question} /> : null;
    },
    [pendingQuestions],
  );
  const transcriptToolCallIds = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) {
      for (const segment of message.segments) {
        if (segment.type === 'tool_call') ids.add(segment.tool.id);
      }
    }
    return ids;
  }, [messages]);
  const unanchoredQuestions = useMemo(
    () => pendingQuestions.filter((q) => !transcriptToolCallIds.has(q.toolUseId)),
    [pendingQuestions, transcriptToolCallIds],
  );

  if (!activeSession || !paneSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-secondary">
        <div className="text-center p-8">
          <div className="text-4xl mb-4">🤖</div>
          <h2 className="text-xl font-semibold mb-2">Claude Panel</h2>
          <p className="text-sm">No active session</p>
        </div>
      </div>
    );
  }

  const sessionRunning = paneSession.status === 'running';
  const hasSendingPending = pendingSends?.some((entry) => entry.status === 'sending') ?? false;
  const sessionWorking = sessionRunning || liveTailState.isGenerating || hasSendingPending;
  // The composer's authoritative turn-in-flight signal for its Stop / Queue /
  // Interrupt affordances. Same as `sessionWorking` MINUS the optimistic
  // 'sending' pending row: that row can linger after the backend turn ends (it
  // reconciles only when the settled message lands), which would freeze the Stop
  // button ON with no turn to abort. `isGenerating` self-clears at the turn's
  // `result` (and on a user cancel via the useIPCEvents buffer reset), so it is
  // safe to fold in here where the sticky pending row is not.
  const composerWorking = sessionRunning || liveTailState.isGenerating;
  // Working indicator parity with the prior RichOutputView: show it while the
  // agent is producing, as soon as an SDK send is dispatched, OR when the
  // session is waiting and the last turn was the user's. The optimistic-send
  // edge matters for Codex because app-server startup can precede the durable
  // session status update and first projected event.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  const isWaitingForResponse =
    sessionWorking || (paneSession.status === 'waiting' && lastMessage?.role === 'user');
  const worktreePath = paneSession.worktreePath ?? null;
  const folderLabel =
    worktreePath !== null ? worktreePath.split('/').filter(Boolean).pop() ?? null : null;
  const branchName = hook.gitCommands?.currentBranch ?? null;

  // Interactive (PTY) substrate body — the live xterm (+ open-time resume
  // recovery overlay). guardFirstInteraction={false}: quick sessions are
  // user-driven, so direct typing into the terminal is the expected interaction.
  const interactiveBody =
    interactiveRunId !== null ? (
      <div className="overflow-hidden relative h-full" data-testid="claude-panel-interactive-terminal">
        {showDemoTerminal ? (
          <DemoTerminalView showComposer />
        ) : (
          <InteractiveTerminalView runId={interactiveRunId} guardFirstInteraction={false} />
        )}
        {/* Open-time recovery: offer to resume the lost REPL's conversation. */}
        {!showDemoTerminal && (
          <ResumeSessionPrompt
            isOpen={canOfferResume && !resumePromptDismissed && !resumeArmed}
            onClose={handleDeclineResume}
            onResume={handleResumeSession}
            onStartFresh={handleDeclineResume}
          />
        )}
        {/* Transient cue while claude reopens the prior conversation. */}
        {resumeArmed && (
          <div
            className="pointer-events-none absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded border border-interactive/40 bg-surface-secondary px-3 py-1.5 text-[11px] text-text-secondary shadow-sm"
            data-testid="resume-restored-hint"
          >
            Resuming previous session — your conversation will reappear below.
          </div>
        )}
      </div>
    ) : undefined;

  // Bottom region — approvals + the unified composer + permission toast +
  // archived banner. The composer's substrate-specific send is owned by
  // QuickSessionComposer; demo interactive sessions render their own cosmetic
  // composer inside DemoTerminalView, so suppress the relay composer there.
  const bottomSlot = (
    <>
      {/* Pending AskUserQuestion gates with no transcript anchor to render under
          (in-progress tool_use not yet in the structured transcript, or the
          interactive substrate whose xterm replaces ChatTranscript). Anchored
          questions render inline via renderToolCallExtra instead. */}
      {unanchoredQuestions.length > 0 && (
        <div
          className="shrink-0 mx-4 mb-2 overflow-hidden rounded border border-border-primary bg-bg-secondary"
          data-testid="quick-session-unanchored-questions"
        >
          {unanchoredQuestions.map((question) => (
            <AskUserQuestionCard key={question.id} item={question} />
          ))}
        </div>
      )}

      {/* Inline permission prompts — surfaces ApprovalRouter approvals directly
          above the input. Returns null when there is no pending approval. */}
      <PendingApprovalsForRun runId={approvalRunId} className="shrink-0 mx-4 mb-2" />

      {/* Permission-change confirmation — substrate-aware copy supplied by the
          composer. Centered on the chat column (the relative wrapper makes the
          toast track the composer, not the panel root + prompt rail) and pinned
          just above the composer; auto-dismisses. Mirrors RunChatView's toast. */}
      {permissionToast !== null && (
        <div className="pointer-events-none relative">
          <div className="pointer-events-auto absolute bottom-2 left-1/2 z-20 -translate-x-1/2">
            <SessionActionToast
              message={permissionToast}
              isVisible={permissionToast !== null}
              onDismiss={() => setPermissionToast(null)}
            />
          </div>
        </div>
      )}

      {!paneSession.archived &&
        (showDemoTerminal ? null : (
          <QuickSessionComposer
            activeSession={paneSession}
            input={hook.input}
            setInput={hook.setInput}
            textareaRef={hook.textareaRef}
            handleSendInput={hook.handleSendInput}
            handleContinueConversation={hook.handleContinueConversation}
            handleStopSession={hook.handleStopSession}
            handleCompactContext={hook.handleCompactContext}
            hasConversationHistory={hook.hasConversationHistory}
            panelId={panel.id}
            interactive={isInteractive}
            ptyOpen={composerOpen}
            onTogglePtyOpen={() => setComposerOpen((v) => !v)}
            onPermissionApplied={setPermissionToast}
            onModelFallback={setPermissionToast}
            onFastModeDeclined={setPermissionToast}
            activeQuestion={pendingQuestions[0] ?? null}
            working={composerWorking}
          />
        ))}

      {paneSession.archived && (
        <div className="bg-surface-secondary border-t border-border-primary px-4 py-3 text-center text-text-muted text-sm">
          This session is archived. Unarchive it to continue the conversation.
        </div>
      )}
    </>
  );

  return (
    <div className="relative flex-1 flex flex-col h-full bg-background">
      <UnifiedChatView
        name={agentName}
        transport={isInteractive ? 'interactive' : 'sdk'}
        mode="quick"
        running={sessionWorking}
        messages={messages}
        loadError={loadError}
        isWaitingForResponse={isWaitingForResponse}
        liveTail={liveTail}
        folderLabel={folderLabel}
        folderTitle={worktreePath}
        branchName={branchName}
        contextUsage={contextUsage}
        railId={panel.id}
        renderToolCallExtra={renderToolCallExtra}
        interactiveBody={interactiveBody}
        bottomSlot={bottomSlot}
        pendingSends={isInteractive ? undefined : pendingSends}
        onReopenPending={(entry) => {
          // A server-buffered 'queued' entry must also be dequeued so the reopened
          // message is not ALSO delivered at the turn's rest boundary (behavior 3:
          // reopen removes it from the queue — no double delivery).
          if (entry.status === 'queued') void API.panels.dequeueInput(panel.id, entry.id);
          requestReopenPending(panel.id, entry.id);
        }}
      />
    </div>
  );
});

ClaudePanel.displayName = 'ClaudePanel';

// Default export for lazy loading
export default ClaudePanel;
