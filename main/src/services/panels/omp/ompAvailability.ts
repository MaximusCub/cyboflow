import { findExecutableInPath, getShellPath } from '../../../utils/shellPath';
import { probeCliVersion } from '../cli/cliVersionProbe';
import { evaluateOmpVersionPolicy, OMP_MIN_SUPPORTED_VERSION, OMP_TESTED_VERSION } from './ompVersions';
import type { ProviderDetectionResult } from '../../../../../shared/types/onboarding';

/**
 * OMP's onboarding/Settings availability probe (proposal §3.3, and the
 * discovery half of §5.2's ladder — minus the spawn machinery, which lives in
 * {@link OmpPtyManager}).
 *
 * Deliberately thinner than {@link CodexPtyManager.testCliAvailability}: there
 * is no bundled OMP binary in v1 (unlike Codex's vendored `@openai/codex`), so
 * the ladder is just explicit custom path → `findExecutableInPath('omp')` →
 * version probe → the floor/tested policy in `ompVersions.ts`. `customPath` is
 * accepted so a future Settings field (there is none today — no
 * `ompExecutablePath` config key exists yet) can wire straight in without
 * touching this function's shape.
 *
 * OMP owns its own provider credentials (proposal §3.3) — there is no login
 * for cyboflow to check, so "available" here means exactly "a usable binary
 * (present, `--version` succeeds, at/above the floor) is on this machine",
 * never anything about which model providers OMP itself can reach.
 *
 * Side-effect free and UNCACHED, per the onboarding probe contract in
 * `providerDetection.ts`: every call re-probes PATH and re-runs `--version` so
 * "Check again" sees a just-completed install.
 */
export async function detectOmpAvailability(
  customPath?: string,
): Promise<ProviderDetectionResult<'omp'>> {
  const configuredPath = customPath?.trim();
  const resolvedPath = configuredPath || findExecutableInPath('omp');
  if (!resolvedPath) {
    return { state: 'unavailable', binaryPath: null, version: null };
  }

  let rawVersion: string;
  try {
    const probe = await probeCliVersion(resolvedPath, { ...process.env, PATH: getShellPath() });
    rawVersion = probe.version;
  } catch {
    // Found on disk but `--version` failed (broken install, wrong binary,
    // timeout) — report unavailable rather than claim a usable binary. No
    // version to report here: the probe never got a string back.
    return { state: 'unavailable', binaryPath: resolvedPath, version: null };
  }

  const verdict = evaluateOmpVersionPolicy(rawVersion);
  if (!verdict.ok) {
    // Still report the raw version so the Integrations card can explain WHY
    // ("found omp 17.2.0, need >= 17.3.0") instead of a bare "not found".
    return { state: 'unavailable', binaryPath: resolvedPath, version: rawVersion };
  }
  if (verdict.aboveTested) {
    console.warn(
      `[OMP] detected version ${rawVersion} is newer than the last version this integration was tested against (${OMP_TESTED_VERSION}, floor ${OMP_MIN_SUPPORTED_VERSION}); proceeding, but behavior beyond the tested version is unverified.`,
    );
  }
  return { state: 'detected', binaryPath: resolvedPath, version: rawVersion };
}
