/**
 * useAgentProviderAccess — the per-provider access toggles (Settings →
 * Integrations / the onboarding Connect step), read reactively from the config
 * store.
 *
 * Mirrors the AUTHORITATIVE backend read (ConfigManager.getAgentProviderAccess,
 * consumed in WorkflowRegistry.createRun and the quick-session IPC handler):
 * an absent member floors to ENABLED, and an all-off map degrades to both-on
 * rather than leaving the app unable to launch anything.
 *
 * Every runtime picker derives from this ONE selector (SubstrateSelector, the
 * agent editor, the workflow step inspector, the variant editor) so no surface
 * can offer a provider the launch seams will reject. The renderer read is a
 * COURTESY, never the enforcement — a payload that names a disabled provider
 * still fails closed on the main side.
 *
 * THE ARIA GATE IS FOLDED IN HERE, once, for that same reason: a provider whose
 * registry entry sets `requiresAriaMode` comes back FALSE on a non-Aria install
 * whatever its access key says, so every picker downstream inherits the gate
 * without a per-surface check somebody can forget to add. It is applied with the
 * SAME shared `applyAriaProviderGate` the backend runs over the map it hands the
 * launch seams, so the two sides cannot drift. Settings → Integrations is the one
 * surface that needs more than this, because it must also decide whether to
 * render the provider's CARD — it reads `useIsAgentProviderSurfaced` for that.
 */
import { useMemo } from 'react';
import {
  AGENT_PROVIDERS,
  applyAriaProviderGate,
  isAgentProviderEnabled,
  isProviderSurfaced,
  isRuntimeProviderEnabled,
  providerForRuntime,
  resolveAgentProviderAccess,
  type AgentProvider,
  type AgentProviderAccess,
  type AgentRuntime,
} from '../../../shared/types/agentRuntime';
import { useConfigStore } from '../stores/configStore';

export function useAgentProviderAccess(): AgentProviderAccess {
  // The raw field is a stable object reference for as long as the config isn't
  // refetched, so the default Object.is store equality is correct; useMemo then
  // keeps the RESOLVED map referentially stable across renders for consumers
  // that use it as an effect dependency.
  const raw = useConfigStore((s) => s.config?.agentProviderAccess);
  const ariaMode = useConfigStore((s) => s.config?.ariaMode === true);
  return useMemo(() => applyAriaProviderGate(resolveAgentProviderAccess(raw), ariaMode), [raw, ariaMode]);
}

/** True when `provider` may be used. Convenience over useAgentProviderAccess. */
export function useIsAgentProviderEnabled(provider: AgentProvider): boolean {
  return useConfigStore(
    (s) =>
      isProviderSurfaced(provider, s.config?.ariaMode === true) &&
      isAgentProviderEnabled(resolveAgentProviderAccess(s.config?.agentProviderAccess), provider),
  );
}

/** True when `runtime`'s owning provider may be used. */
export function useIsRuntimeEnabled(runtime: AgentRuntime): boolean {
  return useConfigStore(
    (s) =>
      isProviderSurfaced(providerForRuntime(runtime), s.config?.ariaMode === true) &&
      isRuntimeProviderEnabled(resolveAgentProviderAccess(s.config?.agentProviderAccess), runtime),
  );
}

/**
 * True when `provider` may be OFFERED on this install — the Aria gate ALONE,
 * ignoring the access toggle. Settings → Integrations renders a provider's card
 * only when this holds: a gated-out provider has no toggle to show, so showing
 * a switched-off card would just raise a question the UI cannot answer.
 */
export function useIsAgentProviderSurfaced(provider: AgentProvider): boolean {
  return useConfigStore((s) => isProviderSurfaced(provider, s.config?.ariaMode === true));
}

/**
 * The install's Aria-mode flag, straight from the config store — the SAME read
 * `useAgentProviderAccess` gates on. `useOmpAvailability` also exposes an
 * `ariaMode`, but it packages it with OMP bridge state; a surface reasoning
 * about the provider gate should read the flag itself rather than borrow
 * another provider's availability object.
 */
export function useAriaMode(): boolean {
  return useConfigStore((s) => s.config?.ariaMode === true);
}

/**
 * The all-toggles-on access map for THIS install — every provider it could
 * surface, with the Aria-gated ones still off. The baseline a picker compares
 * against to decide whether anything is hidden *by the Settings toggles*: a
 * flat all-on baseline would count an Aria-gated provider as "hidden", making
 * the notice permanent and pointing the user at a Settings row that is not
 * rendered.
 */
export function useSurfacedProviderBaseline(): AgentProviderAccess {
  const ariaMode = useAriaMode();
  return useMemo(() => {
    const out: AgentProviderAccess = {};
    for (const provider of AGENT_PROVIDERS) out[provider] = isProviderSurfaced(provider, ariaMode);
    return out;
  }, [ariaMode]);
}
