import type { IpcMain } from 'electron';
import { AGENT_PROVIDERS, isAgentProvider, type AgentProvider } from '../../../shared/types/agentRuntime';
import {
  CLAUDE_DETECT_CHANNEL,
  CODEX_DETECT_CHANNEL,
  PROVIDERS_DETECT_CHANNEL,
  type ProviderDetectionResult,
} from '../../../shared/types/onboarding';
import { probeClaudeDetection } from './claudeDetection';
import { probeCodexDetection } from './codexDetection';
import type { AppServices } from './types';

/**
 * Onboarding / Settings provider detection IPC.
 *
 * One channel (`providers:detect`) takes the provider as its argument and
 * dispatches through {@link PROVIDER_DETECTION_PROBES}. The registry is an
 * exhaustive `Record<AgentProvider, …>`, so a provider added to the union
 * cannot ship without a probe: the alternative — a per-provider channel each
 * consumer has to learn about — is how `claude:detect` and `codex:detect` came
 * to exist, and each new one is a surface the onboarding step and the Settings
 * pane must both be taught by hand.
 *
 * Every probe is idempotent, side-effect free and UNCACHED — "Check again" must
 * see the result of a login the user just performed.
 */

export type ProviderDetectionProbe<P extends AgentProvider> = (
  services: AppServices,
) => Promise<ProviderDetectionResult<P>>;

const PROVIDER_DETECTION_PROBES: { [P in AgentProvider]: ProviderDetectionProbe<P> } = {
  claude: probeClaudeDetection,
  codex: probeCodexDetection,
  // The real probe is the `omp` binary discovery ladder plus a version check —
  // it arrives with `OmpPtyManager`, which owns that ladder (Phase 1, §5.2).
  // Reporting 'unavailable' until then is the truthful answer for a build that
  // cannot run OMP at all, and it keeps the Integrations card honest rather than
  // claiming a provider the app has no manager for.
  omp: async () => ({ state: 'unavailable', binaryPath: null, version: null }),
};

type DetectionResponse =
  | { success: true; data: ProviderDetectionResult }
  | { success: false; error: string };

export function registerProviderDetectionHandlers(ipcMain: IpcMain, services: AppServices): void {
  ipcMain.handle(
    PROVIDERS_DETECT_CHANNEL,
    async (_event, provider: unknown): Promise<DetectionResponse> => {
      if (!isAgentProvider(provider)) {
        return {
          success: false,
          error: `Unknown agent provider "${String(provider)}" (expected one of ${AGENT_PROVIDERS.join(', ')}).`,
        };
      }
      return { success: true, data: await PROVIDER_DETECTION_PROBES[provider](services) };
    },
  );

  // Provider-named delegates, kept so a caller that invokes the old channel
  // directly (rather than through the preload bridge) keeps working. They share
  // the registry above, so they cannot drift from the generic channel.
  ipcMain.handle(
    CLAUDE_DETECT_CHANNEL,
    async (): Promise<{ success: true; data: ProviderDetectionResult<'claude'> }> => ({
      success: true,
      data: await PROVIDER_DETECTION_PROBES.claude(services),
    }),
  );
  ipcMain.handle(
    CODEX_DETECT_CHANNEL,
    async (): Promise<{ success: true; data: ProviderDetectionResult<'codex'> }> => ({
      success: true,
      data: await PROVIDER_DETECTION_PROBES.codex(services),
    }),
  );
}
