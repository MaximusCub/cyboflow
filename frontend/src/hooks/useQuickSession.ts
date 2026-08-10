/**
 * useQuickSession — shared hook for creating a quick session (no workflow run).
 *
 * Lifecycle:
 *   1. Calls API.sessions.createQuick({ prompt: '', projectId })
 *   2. On success, creates both panels in sequence:
 *      a. Claude panel — SKIPPED when the response carries `claudePanelId`
 *         (interactive sessions: the server eagerly created the panel when it
 *         spawned the persistent PTY REPL)
 *      b. Terminal panel (cwd = worktreePath) — always
 *   3. Calls useCyboflowStore.getState().setActiveQuickSession(sessionId, runId)
 *   4. If `kickoffPrompt` was passed AND a Claude panel was created above (2a),
 *      fires it as that panel's first turn — fire-and-forget, see `start`'s doc.
 *   5. Calls opts.onSuccess?.(sessionId)
 *   6. Clears isStarting (finally)
 *
 * Guards:
 *   - No-ops when projectId is null or a start is already in-flight.
 *
 * This hook replaces the inline handleQuickStart / handlePickQuickMode logic in
 * WorkflowPicker.tsx and CyboflowRoot.tsx, fixing the FIND-SPRINT-037-3 orphan
 * worktree bug where CyboflowRoot skipped panelApi.createPanel and
 * setActiveQuickSession entirely.
 */
import { useState, useCallback } from 'react';
import { API } from '../utils/api';
import { panelApi } from '../services/panelApi';
import { trackEvent } from '../utils/telemetry';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { usePanelStore } from '../stores/panelStore';
import { useConfigStore } from '../stores/configStore';
import { dispatchQuickSessionInput } from './useClaudePanel';
import type { Session } from '../types/session';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { QuickSessionWorktreeMode } from '../../../shared/types/worktreeMode';
import type { AgentProvider, SessionAgentRuntime } from '../../../shared/types/agentRuntime';
import { isSessionAgentRuntime } from '../../../shared/types/agentRuntime';
import type { ReasoningEffort } from '../../../shared/types/reasoningEffort';
import type { RunTypeLaunchGlobals } from '../../../shared/types/sessionDefaults';
import {
  DEFAULT_QUICK_SUBSTRATE,
  DEFAULT_RUN_TYPE_MODEL_FLOORS,
  QUICK_RUN_TYPE_KEY,
  resolveRunTypeLaunchDefaults,
} from '../../../shared/types/sessionDefaults';

interface UseQuickSessionOptions {
  projectId: number | null;
  onSuccess?: (sessionId: string) => void;
}

interface UseQuickSessionReturn {
  /**
   * Create the quick session. An optional per-session 4-mode agent-permission
   * override (Session Start Wizard step 3) is threaded into createQuick and
   * persisted on the session; omitted → the session inherits the global default.
   * An optional CLI substrate ('sdk'|'interactive') is likewise threaded and
   * stamped onto sessions.substrate; omitted → SDK (legacy behavior). An optional
   * `effort` ('ultracode') launches the interactive REPL with the ultracode
   * setting (the Ultracode wizard card); omitted → no effort setting.
   *
   * `model` (the Configure model dropdown, e.g. 'opus') and `fastMode` (the
   * fast-mode toggle, default off) are persisted on the claude panel — directly
   * for the frontend-created SDK panel, and via the createQuick request for the
   * interactive eager spawn — so the per-turn respawn (sessions:input) applies them.
   *
   * `worktreeMode` ('worktree' | 'in-place') threads the wizard's Workspace choice
   * into createQuick; omitted → the server floors to the global default. 'in-place'
   * skips worktree creation and works directly in the project checkout (both
   * substrates — the interactive gate needs no checkout writes).
   *
   * `reasoningEffort` (IDEA-029, the wizard's effort select / the in-composer
   * EffortPill) rides claudeConfig alongside model/fastMode for the interactive
   * eager spawn, and is persisted on the frontend-created panel the same way model
   * is — for BOTH Claude SDK and codex-sdk (codex-sdk has no eager server spawn, so
   * its panel is frontend-created here and startCodexSdkTurn reads the persisted
   * effort per turn). Only codex-pty is excluded: it emits no effort flag and its
   * panel is server-eager-created, so it never reaches the persistence branch. The
   * claudeConfig ride stays Claude-only (create-quick reads it for
   * `quickAgentProvider === 'claude'`); codex-sdk relies solely on the setEffort
   * persistence below.
   *
   * `designIdeaId` (Design Mode, design-mode.md): the idea a design session
   * binds to, threaded into createQuick so the server can validate the idea
   * (exists, owned by the project, not decomposed) and stamp
   * sessions.design_idea_id. Only sent by the wizard's Design arm, which also
   * forces `substrate`/`agentProvider`/`agentRuntime` to 'sdk'/'claude'/
   * 'claude-sdk' regardless of the caller's other params (a security boundary
   * — the MCP scope mechanism that limits a design session's toolset exists
   * only on the SDK path). Omitted for every non-design launch.
   *
   * `kickoffPrompt` (Design Mode v0.5, "Auto-start"): an optional canonical
   * first-turn message sent as the session's first panel input immediately
   * after the Claude panel is created and setActiveQuickSession has run —
   * NOT via createQuick's `prompt` field, which the SDK path ignores entirely
   * (createQuickSessionCore hardcodes `prompt: ''`). Uses the same dispatch
   * the chat composer uses (`dispatchQuickSessionInput`), so it renders as a
   * real, visible, restart-safe first user turn — deliberately not a
   * synthetic/hidden one. Only fires when a Claude panel was created on THIS
   * client call (the `claudePanelId === undefined` branch below) — an
   * eagerly server-spawned panel (interactive substrate) has no seam here,
   * and design sessions are SDK-pinned regardless. Dispatched
   * fire-and-forget: a failed kickoff send is logged and must never fail
   * session creation. Omitted for every non-design launch (every existing
   * caller keeps its current behavior unchanged).
   */
  start: (
    agentPermissionMode?: PermissionMode,
    substrate?: CliSubstrate,
    effort?: 'ultracode',
    model?: string,
    fastMode?: boolean,
    disabledMcpServers?: string[],
    enabledPlugins?: string[],
    worktreeMode?: QuickSessionWorktreeMode,
    agentProvider?: AgentProvider,
    agentRuntime?: SessionAgentRuntime,
    reasoningEffort?: ReasoningEffort,
    designIdeaId?: string,
    kickoffPrompt?: string,
  ) => Promise<void>;
  /**
   * Zero-arg-friendly entry point for launches that only know a run-type key
   * (e.g. the synthetic global `'quick'` key used by the ⌘-shortcut / "New
   * quick session" affordance) — NOT a `start` replacement. Delegates the
   * whole ladder (stored per-type default → global config default → floor) to
   * the canonical `resolveRunTypeLaunchDefaults`, then threads every resolved
   * field — model, permissionMode, substrate, agentRuntime, reasoningEffort —
   * into `start`'s existing positional args, so a saved Quick Session default
   * (Settings → "Run type defaults") is honored rather than write-only.
   *
   * `reasoningEffort` resolves off the `'quick'` key even when the caller
   * passes a workflow key: this seam always creates a quick session, and v1
   * never writes effort under any other key (see RunTypeDefaults).
   *
   * Added by TASK-153 as a NEW, additive method — `start`'s 13-positional-
   * param signature is unchanged; do not expand it further.
   */
  startWithDefaults: (key: string) => Promise<void>;
  isStarting: boolean;
  error: string | null;
}

export function useQuickSession(opts: UseQuickSessionOptions): UseQuickSessionReturn {
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (
      agentPermissionMode?: PermissionMode,
      substrate?: CliSubstrate,
      effort?: 'ultracode',
      model?: string,
      fastMode?: boolean,
      disabledMcpServers?: string[],
      enabledPlugins?: string[],
      worktreeMode?: QuickSessionWorktreeMode,
      agentProvider?: AgentProvider,
      agentRuntime?: SessionAgentRuntime,
      reasoningEffort?: ReasoningEffort,
      designIdeaId?: string,
      kickoffPrompt?: string,
    ): Promise<void> => {
      if (opts.projectId === null || isStarting) return;

      setError(null);
      setIsStarting(true);

      try {
        const isCodexRuntime =
          agentProvider === 'codex' || agentRuntime === 'codex-sdk' || agentRuntime === 'codex-pty';
        // model + fastMode + reasoningEffort ride the request as claudeConfig so the
        // INTERACTIVE eager spawn (server-side) receives them; the SDK panel is
        // created on the frontend below and persisted there. Sending both ways is
        // harmless — the SDK create-quick path ignores claudeConfig (no panel to
        // start yet).
        const claudeConfig =
          !isCodexRuntime && (model !== undefined || fastMode === true || reasoningEffort !== undefined)
            ? {
                ...(model !== undefined ? { model } : {}),
                fastMode: fastMode === true,
                ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
              }
            : undefined;

        const result = await API.sessions.createQuick({
          prompt: '',
          projectId: opts.projectId,
          ...(agentPermissionMode ? { agentPermissionMode } : {}),
          ...(substrate ? { substrate } : {}),
          ...(agentProvider ? { agentProvider } : {}),
          ...(agentRuntime ? { agentRuntime } : {}),
          ...(isCodexRuntime && model !== undefined ? { agentModel: model } : {}),
          ...(effort ? { effort } : {}),
          ...(claudeConfig ? { claudeConfig } : {}),
          // Per-session MCP deny / plugin selection chosen in the wizard's Advanced
          // section, persisted before the first spawn. MCP is a DENY list → only
          // sent when non-empty (empty = inherit all servers). Plugins are
          // EXCLUSIVE and reflect the current enabled set → the wizard passes
          // `undefined` when unchanged (inherit) and an explicit array otherwise,
          // INCLUDING `[]` ("disable everything"); forward that distinction as-is.
          ...(disabledMcpServers && disabledMcpServers.length > 0 ? { disabledMcpServers } : {}),
          ...(enabledPlugins !== undefined ? { enabledPlugins } : {}),
          // Workspace choice (wizard Advanced) → sessions.in_place (migration 047).
          // Only sent when explicitly chosen; omitted → the server floors to the
          // global quickSessionWorktreeMode default.
          ...(worktreeMode ? { worktreeMode } : {}),
          // Design Mode (design-mode.md "Idea link"): the idea this design
          // session binds to. Only sent by the wizard's Design arm; every other
          // launch omits it.
          ...(designIdeaId !== undefined ? { designIdeaId } : {}),
        });

        if (!result.success || !result.data) {
          throw new Error(result.error ?? 'Failed to create quick session');
        }

        const { sessionId, worktreePath, runId, claudePanelId } = result.data;

        // Agent panel first (unless the server eagerly created it — interactive
        // PTY sessions spawn during create-quick and return their panel id),
        // then Terminal.
        let createdClaudePanelId: string | undefined;
        if (claudePanelId === undefined) {
          const claudePanel = await panelApi.createPanel({
            sessionId,
            type: 'claude',
            title: 'Chat',
          });
          createdClaudePanelId = claudePanel.id;
          // Register the panel in the frontend store IMMEDIATELY (addPanel dedups
          // by id): nothing else pushes panels created here into panelStore — no
          // panel:created store listener exists — so a consumer mounting right
          // after onSuccess (the v0.5 DesignModeSurface) would otherwise see no
          // Claude panel and mint a DUPLICATE via its ensure fallback.
          usePanelStore.getState().addPanel(claudePanel);
          // Persist the launch model + fast-mode on the SDK panel so the first
          // (and every) sessions:input turn spawns with them — the request's
          // claudeConfig only reaches the interactive eager spawn, never this
          // frontend-created SDK panel.
          if (model !== undefined) await API.claudePanels.setModel(claudePanel.id, model);
          // fastMode is Claude-only (no Codex analogue).
          if (!isCodexRuntime) {
            await API.claudePanels.setFastMode(claudePanel.id, fastMode === true);
          }
          // Reasoning effort persists for every effort-capable runtime that owns a
          // frontend-created panel: Claude SDK AND codex-sdk (startCodexSdkTurn reads
          // it per turn → buildCodexAppServerTurnOptions maps it onto the app-server
          // turn). Only codex-pty is excluded — it is server-eager-created (so it
          // never reaches this frontend branch) and emits no effort flag regardless.
          if (reasoningEffort !== undefined && agentRuntime !== 'codex-pty') {
            await API.claudePanels.setEffort(claudePanel.id, reasoningEffort);
          }
        }
        // NOTE: deliberately NOT store-added — addPanel stamps its panel as the
        // session's active one, and the active tab must stay Chat.
        await panelApi.createPanel({
          sessionId,
          type: 'terminal',
          title: 'Terminal',
          initialState: { cwd: worktreePath },
        });

        useCyboflowStore.getState().setActiveQuickSession(sessionId, runId);
        trackEvent('session_created', { kind: 'quick', substrate });

        // Design Mode auto-start kickoff — see `start`'s doc above. Fired
        // fire-and-forget so a kickoff-send failure never fails session
        // creation; the composer's own dispatch path handles UI reflection of
        // the sent turn once loaded.
        if (kickoffPrompt !== undefined && kickoffPrompt.length > 0 && createdClaudePanelId !== undefined) {
          const kickoffSession: Session = {
            id: sessionId,
            name: sessionId,
            worktreePath,
            prompt: '',
            status: 'ready',
            createdAt: new Date().toISOString(),
            output: [],
            jsonMessages: [],
            agentRuntime: agentRuntime ?? 'claude-sdk',
          };
          // Mode MUST be 'continue', not 'initial': 'initial' routes through
          // panels:send-input, which records the user message FIRST and then
          // reaches continuePanel on the resume path — which throws ("Cannot
          // resume: no Claude session_id stored") on a fresh session.
          // panels:continue has the explicit first-message branch (!isRunning &&
          // !hasClaudeSessionId → startPanel, a clean fresh spawn) — the same
          // path the composer's first typed message takes.
          dispatchQuickSessionInput(kickoffSession, createdClaudePanelId, kickoffPrompt, 'continue').catch(
            (err: unknown) => {
              console.error('[useQuickSession] Failed to send design kickoff turn:', err);
            },
          );
        }

        opts.onSuccess?.(sessionId);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to create quick session');
      } finally {
        setIsStarting(false);
      }
    },
    // opts.projectId and opts.onSuccess are the only external deps; isStarting is
    // read from closure and intentionally excluded to avoid re-creating the callback
    // every time isStarting flips — the guard (`isStarting`) still holds because
    // setIsStarting is synchronous within the render cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.projectId, opts.onSuccess],
  );

  const startWithDefaults = useCallback(
    (key: string): Promise<void> => {
      const config = useConfigStore.getState().config;
      const runTypeDefaults = config?.runTypeDefaults;
      // This seam always creates a QUICK session, so the quick-kind floors
      // apply even when the caller hands over a workflow key — pin them here
      // rather than let the key pick the (workflow) floor table.
      const globals: RunTypeLaunchGlobals = {
        model: DEFAULT_RUN_TYPE_MODEL_FLOORS.quick,
        permissionMode: config?.defaultAgentPermissionMode,
        substrate: config?.quickSessionDefaultSubstrate ?? DEFAULT_QUICK_SUBSTRATE,
      };
      const resolved = resolveRunTypeLaunchDefaults(key, runTypeDefaults, globals);
      // Effort always resolves off the quick key — see the doc above.
      const { reasoningEffort } = resolveRunTypeLaunchDefaults(
        QUICK_RUN_TYPE_KEY,
        runTypeDefaults,
        globals,
      );
      // `start` takes the session-scoped runtime union; a stored 'codex-exec'
      // (never written by the settings UI, but reachable via a hand-edited
      // config) is dropped rather than sent as an unlaunchable runtime.
      const agentRuntime = isSessionAgentRuntime(resolved.agentRuntime)
        ? resolved.agentRuntime
        : undefined;

      return start(
        resolved.permissionMode,
        resolved.substrate,
        undefined,
        resolved.model,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        agentRuntime,
        reasoningEffort,
      );
    },
    [start],
  );

  return { start, startWithDefaults, isStarting, error };
}
