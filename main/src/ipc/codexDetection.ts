import type { ProviderDetectionResult } from '../../../shared/types/onboarding';
import type { AppServices } from './types';

/**
 * The CODEX half of the onboarding provider probe — a short-lived app-server
 * account check against the bundled runtime. Registration lives in
 * `providerDetection.ts` (the provider→probe registry behind the generic
 * `providers:detect` channel); this module supplies Codex's probe only.
 */
export function probeCodexDetection(
  services: AppServices,
): Promise<ProviderDetectionResult<'codex'>> {
  return services.codexSdkManager.detectChatGptAccount();
}
