/**
 * panelLane — the SINGLE answer to "which agent process owns THIS chat panel".
 *
 * A chat panel sits on two independent axes:
 *
 *   provider  — claude | codex. Session-wide (`sessions.agent_runtime`); a panel
 *               cannot disagree with its session about which vendor runs it.
 *   substrate — sdk | interactive. PER-PANEL: the Add-chat picker and
 *               claude-panels:set-substrate stamp `panels.substrate`, which wins
 *               over the session's.
 *
 * The dispatch seams used to collapse both axes into one test against
 * `agent_runtime` — `=== 'codex-pty'` meant "Codex", `=== 'codex-sdk'` meant
 * "SDK". That reads the SESSION's substrate as if it were the PANEL's, so a
 * per-panel override could not be honored on the Codex side at all:
 *
 *   - in a codex-sdk session an interactive override fell to the CLAUDE PTY
 *     manager (the provider silently flipped mid-session), and
 *   - in a codex-pty session the `=== 'codex-pty'` test ran ahead of any
 *     substrate test, so an sdk override was ignored outright.
 *
 * Resolving the two axes separately and combining them at the END gives all four
 * lanes, so the picker means what it says in every session type. Callers switch
 * on the lane instead of re-deriving it — a new dispatch seam that forgets one
 * axis is the bug this module exists to prevent.
 */
import { providerForRuntimeValue, type AgentProvider } from '../../../shared/types/agentRuntime';
import { type CliSubstrate } from '../../../shared/types/substrate';
import { resolveSubstrate } from '../orchestrator/substrateResolver';

/** The four (provider × substrate) combinations, one live manager each. */
export type PanelLane = 'claude-sdk' | 'claude-interactive' | 'codex-sdk' | 'codex-pty';

/** Session columns the lane depends on (a DB session row satisfies this). */
export interface PanelLaneSession {
  agent_runtime?: string | null;
  substrate?: string | null;
}

/** Panel columns the lane depends on (a ToolPanel satisfies this). */
export interface PanelLanePanel {
  substrate?: CliSubstrate | null;
}

/**
 * Provider is session-wide, derived from the runtime-id prefix registry rather
 * than a local prefix test — a runtime this build does not know must not
 * silently resolve into the Claude lane. An absent column is a row that predates
 * the provider axis and keeps the Claude floor.
 */
export function providerForSession(session: PanelLaneSession | undefined): AgentProvider {
  return providerForRuntimeValue(session?.agent_runtime, 'providerForSession');
}

/**
 * The panel's EFFECTIVE substrate: a per-panel override beats the session's.
 *
 * `env: {}` — panel routing inherits only the session value, never the process
 * environment, so CYBOFLOW_SUBSTRATE cannot retroactively re-point existing
 * panels.
 *
 * A codex-pty session is interactive BY CONSTRUCTION. Quick-session creation
 * stamps `sessions.substrate = 'interactive'` for it, but the resolver floors an
 * absent value to 'sdk' — so an older row that never got the stamp would resolve
 * its own panels into the SDK lane and lose its terminal. Supply 'interactive'
 * as the session-level value in that case; a genuine per-panel override still
 * outranks it.
 */
export function substrateForPanel(
  session: PanelLaneSession | undefined,
  panel: PanelLanePanel | undefined,
): CliSubstrate {
  const sessionSubstrate =
    session?.substrate ?? (session?.agent_runtime === 'codex-pty' ? 'interactive' : undefined);
  return resolveSubstrate({
    panelOverrideSubstrate: panel?.substrate ?? undefined,
    requestedSubstrate: sessionSubstrate,
    env: {},
  });
}

/** Combine the two axes into the lane that owns this panel. */
export function resolvePanelLane(
  session: PanelLaneSession | undefined,
  panel: PanelLanePanel | undefined,
): PanelLane {
  const interactive = substrateForPanel(session, panel) === 'interactive';
  if (providerForSession(session) === 'codex') return interactive ? 'codex-pty' : 'codex-sdk';
  return interactive ? 'claude-interactive' : 'claude-sdk';
}

/** True when the lane is served by one of the two PTY managers. */
export function isPtyLane(lane: PanelLane): boolean {
  return lane === 'claude-interactive' || lane === 'codex-pty';
}
