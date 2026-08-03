/**
 * Panel-scoped relay/spawn for a PTY-backed chat panel (interactive Claude or
 * Codex PTY).
 *
 * WHY THIS EXISTS — added ("Add chat") PTY panels. A quick session's PRIMARY
 * chat panel is eager-spawned server-side by sessions:create-quick, and the
 * session-scoped sessions:input relay always resolves the session's FIRST claude
 * panel. A SECOND PTY chat panel (TASK-103 Add chat, or a per-panel interactive
 * override on an SDK session) therefore had NO way to spawn a live REPL of its
 * own, and its composer turns misrouted to the first panel. This helper gives
 * every PTY panel a PANEL-SCOPED "relay into the live REPL, or spawn a fresh one"
 * path keyed by the panel's OWN id, so N concurrent PTY panels each drive their
 * own isolated process.
 *
 * Used at two seams:
 *   - panels:create (ipc/panels.ts) — eager spawn (input=null → briefing first
 *     prompt) so the added terminal is alive immediately, exactly like the
 *     primary panel's create-quick eager spawn. Direct xterm keystrokes then
 *     relay panelId-keyed through SubstrateDispatchFacade.relayInput.
 *   - panels:send-input (ipc/session.ts) — the composer's per-panel turn (⌃G),
 *     relayed into THIS panel's REPL (or a dead-REPL respawn) rather than the
 *     session's first panel.
 */
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { ReasoningEffort } from '../../../shared/types/reasoningEffort';
import { isAnyEffortLevel } from '../../../shared/types/reasoningEffort';
import { isPtyLane, resolvePanelLane } from '../services/panelLane';
import { assertAgentProviderAllowed } from '../services/agentProviderGuard';
import { providerForRuntime } from '../../../shared/types/agentRuntime';
import { QUICK_PTY_BRIEFING, QUICK_CODEX_PTY_BRIEFING } from './quickSessionBriefings';

/** Common live-REPL relay surface shared by both PTY managers. */
interface PtyManagerLike {
  isPanelRunning(panelId: string): boolean;
  relayUserTurn(panelId: string, input: string): void;
}

/** InteractiveClaudeManager's positional startPanel (claude interactive PTY). */
interface InteractivePtyManagerLike extends PtyManagerLike {
  startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string,
    effort?: 'ultracode',
    fastMode?: boolean,
    resumeSessionId?: string,
    reasoningEffort?: ReasoningEffort,
  ): Promise<void>;
}

/** CodexPtyManager's positional startPanel (codex PTY). */
interface CodexPtyManagerLike extends PtyManagerLike {
  startPanel(
    panelId: string,
    sessionId: string,
    worktreePath: string,
    prompt: string,
    permissionMode?: 'approve' | 'ignore',
    model?: string,
    runId?: string,
    reasoningEffort?: ReasoningEffort,
  ): Promise<void>;
}

interface DbSessionLike {
  agent_runtime?: string | null;
  substrate?: CliSubstrate | null;
  chat_run_id?: string | null;
}

interface SessionLike {
  worktreePath?: string | null;
  permissionMode?: 'approve' | 'ignore';
}

/**
 * Injected-dependency surface (structurally satisfied by AppServices). Narrow
 * so the routing can be exercised with stub managers in tests without building a
 * full AppServices.
 */
export interface PtyPanelDispatchDeps {
  sessionManager: {
    getDbSession(sessionId: string): DbSessionLike | undefined;
    // getSession is synchronous in SessionManager; the helper `await`s it anyway
    // (await on a non-Promise passes the value through), so a Promise-returning
    // impl would also satisfy this.
    getSession(sessionId: string): SessionLike | null | undefined | Promise<SessionLike | null | undefined>;
    updateSession(sessionId: string, updates: { status?: string }): Promise<unknown> | unknown;
  };
  databaseService: {
    getPanelSettings(
      panelId: string,
    ): { model?: unknown; fastMode?: unknown; reasoningEffort?: unknown } | undefined;
  };
  configManager: { isDemoMode(): boolean };
  interactiveCliManager: InteractivePtyManagerLike;
  codexPtyManager: CodexPtyManagerLike;
  registerLivePanel(runId: string, panelId: string): void;
  registerCodexPtyPanel(runId: string, panelId: string): void;
  /**
   * Chat-gate sentinel resolver. Only the CODEX branch needs it: the interactive
   * manager resolves its own gate inside startPanel (resolveGateRunId), while
   * codexPtyManager takes the runId from THIS caller. Resolving it here revives a
   * `__quick__` sentinel that boot recovery force-failed on app restart —
   * otherwise a resumed Codex terminal spawns bound to a terminal run and loses
   * both its cyboflow_* MCP writes (`run_not_active`) and its approval gate.
   * Optional: the stub-manager tests fall back to the raw `chat_run_id` read.
   */
  chatSentinelProvider?: (sessionId: string) => string;
}

/** Minimal panel shape (a ToolPanel satisfies it). */
export interface PtyPanelLike {
  id: string;
  sessionId: string;
  substrate?: CliSubstrate | null;
}

/**
 * Relay a turn into a PTY panel's live REPL, or spawn a fresh REPL keyed by the
 * panel's OWN id when none is running.
 *
 * @param input The user turn to relay/seed. `null` is an EAGER-SPAWN probe: it
 *   spawns a fresh REPL with the runtime's context briefing as the first prompt,
 *   and is a strict no-op when the panel already has a live REPL (never relays).
 * @returns `true` when this helper handled the panel (a PTY substrate);
 *   `false` when the panel is NOT PTY-backed (SDK, or a demo interactive
 *   session) — the caller keeps its own SDK/demo path.
 */
export async function relayOrSpawnPtyPanel(
  deps: PtyPanelDispatchDeps,
  panel: PtyPanelLike,
  input: string | null,
): Promise<boolean> {
  const dbSession = deps.sessionManager.getDbSession(panel.sessionId);
  // Provider and substrate resolve INDEPENDENTLY (services/panelLane.ts): the
  // session fixes the vendor, the panel's own override fixes the substrate. This
  // used to be one test against `agent_runtime === 'codex-pty'`, which both
  // ignored an sdk override in a Codex terminal session and handed a Codex
  // session's interactive override to the CLAUDE manager.
  const lane = resolvePanelLane(dbSession, panel);
  if (!isPtyLane(lane)) return false; // SDK lane — caller owns it.
  const isCodexPty = lane === 'codex-pty';
  // Demo interactive sessions never spawn a real REPL (DemoTerminalView paints a
  // canned, client-side session) — leave them to the SDK/demo path.
  if (!isCodexPty && deps.configManager.isDemoMode()) return false;
  // Provider-access gate (Settings → Integrations). The spawn path is already
  // guarded inside the managers, but a turn relayed into an ALREADY-LIVE REPL
  // never respawns — without this, switching a provider off would leave every
  // open PTY chat fully usable. Placed after the demo bail-out so demo stays
  // exempt, and before markRunning so a refused turn never flips the session to
  // "working".
  assertAgentProviderAllowed(providerForRuntime(lane), 'this terminal session');

  const session = await deps.sessionManager.getSession(panel.sessionId);
  if (!session?.worktreePath) return false; // Cannot spawn a REPL without a worktree.
  const worktreePath = session.worktreePath;

  const settings = deps.databaseService.getPanelSettings(panel.id);
  const model = typeof settings?.model === 'string' ? settings.model : undefined;
  const fastMode = settings?.fastMode === true;
  const rawEffort = settings?.reasoningEffort;
  const reasoningEffort = isAnyEffortLevel(rawEffort) ? rawEffort : undefined;

  // Only flip the shared session status to 'running' when the turn-end rest
  // listener (index.ts) will actually flip it BACK: that listener rests only
  // sessions whose substrate is 'interactive' (which includes codex-pty quick
  // sessions — stamped 'interactive'). An interactive-OVERRIDE panel on an
  // otherwise-SDK session (session substrate 'sdk') has no such rester, so
  // flipping 'running' there would strand the session showing "working" forever.
  // The live terminal streams regardless of session status, so skipping the flip
  // for override panels only forgoes the (cross-panel-shared) working indicator.
  const restsViaSessionStatus = dbSession?.substrate === 'interactive';
  const markRunning = async (): Promise<void> => {
    if (restsViaSessionStatus) await deps.sessionManager.updateSession(panel.sessionId, { status: 'running' });
  };

  const manager: PtyManagerLike = isCodexPty ? deps.codexPtyManager : deps.interactiveCliManager;
  if (manager.isPanelRunning(panel.id)) {
    // Live REPL: relay the real user turn. A null (eager-spawn) probe for an
    // already-live panel has nothing to relay.
    if (input !== null) {
      manager.relayUserTurn(panel.id, input);
      await markRunning();
    }
    return true;
  }

  // Fresh spawn. Seed the facade's runId->panelId translation by this panel's OWN
  // id (IDENTITY registration) BEFORE the fire-and-forget spawn, so a relay or
  // close-out racing the first PTY byte resolves to THIS panel's live PTY rather
  // than falling back to the session's shared chat sentinel (which another panel
  // may own). ⚠️ NEVER await startPanel: the persistent REPL's spawn promise
  // resolves only when the process EXITS.
  const firstPrompt = input ?? (isCodexPty ? QUICK_CODEX_PTY_BRIEFING : QUICK_PTY_BRIEFING);
  if (isCodexPty) {
    deps.registerCodexPtyPanel(panel.id, panel.id);
    // runId — align the Codex gate/MCP id with the session's chat sentinel
    // (matches the primary panel); the live channel is keyed by panelId. Resolve
    // it through the provider, NOT a raw `chat_run_id` read, so a sentinel parked
    // by app-restart boot recovery is revived to 'running' before the spawn bakes
    // it into CYBOFLOW_RUN_ID (see PtyPanelDispatchDeps.chatSentinelProvider).
    const codexGateRunId = deps.chatSentinelProvider
      ? deps.chatSentinelProvider(panel.sessionId)
      : (dbSession?.chat_run_id ?? panel.id); // uninjected fallback (tests/boot)
    void deps.codexPtyManager
      .startPanel(
        panel.id,
        panel.sessionId,
        worktreePath,
        firstPrompt,
        session.permissionMode,
        model,
        codexGateRunId,
        reasoningEffort,
      )
      .catch((err: unknown) => {
        console.error(`[ptyPanelDispatch] Codex PTY spawn failed for panel ${panel.id}:`, err);
      });
  } else {
    deps.registerLivePanel(panel.id, panel.id);
    void deps.interactiveCliManager
      .startPanel(
        panel.id,
        panel.sessionId,
        worktreePath,
        firstPrompt,
        session.permissionMode,
        model,
        undefined, // effort ('ultracode') — added chats do not carry the launch card setting
        fastMode,
        undefined, // resumeSessionId — a fresh spawn, not an explicit resume
        reasoningEffort,
      )
      .catch((err: unknown) => {
        console.error(`[ptyPanelDispatch] Interactive REPL spawn failed for panel ${panel.id}:`, err);
      });
  }
  await markRunning();
  return true;
}
