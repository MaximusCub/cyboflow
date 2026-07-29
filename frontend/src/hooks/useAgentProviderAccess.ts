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
 */
import { useMemo } from 'react';
import {
  isAgentProviderEnabled,
  isRuntimeProviderEnabled,
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
  return useMemo(() => resolveAgentProviderAccess(raw), [raw]);
}

/** True when `provider` may be used. Convenience over useAgentProviderAccess. */
export function useIsAgentProviderEnabled(provider: AgentProvider): boolean {
  return useConfigStore((s) =>
    isAgentProviderEnabled(resolveAgentProviderAccess(s.config?.agentProviderAccess), provider),
  );
}

/** True when `runtime`'s owning provider may be used. */
export function useIsRuntimeEnabled(runtime: AgentRuntime): boolean {
  return useConfigStore((s) =>
    isRuntimeProviderEnabled(resolveAgentProviderAccess(s.config?.agentProviderAccess), runtime),
  );
}
