/**
 * agentProviderGuard — the CALL-LEVEL enforcement of the per-provider access
 * toggles (Settings → Integrations / the onboarding Connect step).
 *
 * Why this exists on top of the launch-seam checks: gating only creation
 * (WorkflowRegistry.createRun, the quick-session IPC handler) leaves every
 * ALREADY-OPEN session able to keep issuing turns — switch Claude off and an
 * existing chat still continues, because a follow-up turn never re-enters a
 * create path. The toggle has to hold at the moment a provider is actually
 * called, not only when a session is born.
 *
 * The guard is installed at the four seams where a turn genuinely reaches a
 * vendor, so no path can bypass it:
 *   1. `utils/lazyAgentSdk.loadSdkQuery()` — EVERY Claude Agent SDK `query()`
 *      in the app resolves the function through it, per call (chat turns, the
 *      eval/pairwise judges, the programmatic monitor, verification agents, the
 *      VLM judge, the model catalogue). One assert covers them all.
 *   2. `AbstractCliManager.spawnCliProcess` + each subclass override — every
 *      cold spawn of a CLI/PTY/app-server process.
 *   3. `relayOrSpawnPtyPanel` — a keystroke relayed into an ALREADY-LIVE PTY
 *      never respawns, so the spawn guard alone would miss it.
 *
 * Resolver injection (rather than importing ConfigManager) keeps this module
 * free of concrete-service imports and leaves it inert in unit/headless
 * contexts: the DEFAULT resolver allows everything, so any test or fixture that
 * never calls `setAgentProviderAccessResolver` behaves byte-identically to
 * before the toggles existed. index.ts wires the real resolver at boot,
 * folding in the demo-mode exemption (demo dispatches to the scripted
 * DemoCliManager, never a real vendor).
 */
import type { AgentProvider } from '../../../shared/types/agentRuntime';

/** Human label used in the thrown message. */
const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * Thrown when a call is attempted against a provider the user switched off.
 * Carries `provider` so a caller can map it back onto a UI affordance without
 * parsing the message.
 */
export class AgentProviderDisabledError extends Error {
  readonly provider: AgentProvider;

  constructor(provider: AgentProvider, context: string) {
    super(
      `${PROVIDER_LABELS[provider]} is turned off in Settings → Integrations, so ${context} cannot run. ` +
        `Enable ${PROVIDER_LABELS[provider]} to continue.`,
    );
    this.name = 'AgentProviderDisabledError';
    this.provider = provider;
  }
}

type AgentProviderAccessResolver = (provider: AgentProvider) => boolean;

/** Allow-all default — keeps unit/headless contexts byte-identical. */
const ALLOW_ALL: AgentProviderAccessResolver = () => true;

let resolver: AgentProviderAccessResolver = ALLOW_ALL;

/**
 * Install the authoritative resolver (index.ts at boot, from ConfigManager).
 * Passing `null` restores the allow-all default — used by tests to undo an
 * install without leaking state across files.
 */
export function setAgentProviderAccessResolver(next: AgentProviderAccessResolver | null): void {
  resolver = next ?? ALLOW_ALL;
}

/** True when `provider` may be called right now. */
export function isAgentProviderAllowed(provider: AgentProvider): boolean {
  try {
    return resolver(provider);
  } catch {
    // A throwing resolver must never harden into an outage: fail OPEN, matching
    // the absent-config floor (a provider is enabled unless explicitly off).
    return true;
  }
}

/**
 * Throw unless `provider` may be called. `context` names the call in the
 * user-facing message, e.g. 'this chat turn' or 'the Codex app server'.
 */
export function assertAgentProviderAllowed(provider: AgentProvider, context: string): void {
  if (!isAgentProviderAllowed(provider)) {
    throw new AgentProviderDisabledError(provider, context);
  }
}
