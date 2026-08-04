/**
 * verifyHealthModel — pure derivations behind the Verify health panel
 * (docs/proposals/verification-setup-flow.md §6).
 *
 * Mirrors `verifyRequestModel.ts`: no React, no tRPC, no Node built-ins — just
 * the row → display-string/class mappings, so the panel's judgement calls (what
 * counts as healthy, what a suppression actually means, when a number is
 * unknown vs zero) are unit-testable without rendering anything.
 *
 * The recurring rule here: NEVER render "no data" as a zero. A project with no
 * attempts has an unknown pass rate, not a 0% one, and the difference is the
 * whole point of the panel — a fresh project and a totally broken one must not
 * look the same.
 */
import type {
  VerificationCapabilityState,
  VerificationModalityHealth,
  VerificationOutcomeStats,
  VerificationRunbookState,
  VerifyProbeId,
  VerifyProbeRow,
  VerifyProbeState,
} from '../../../../shared/types/visualVerification';

/** Human label for each probe row. */
export const PROBE_LABEL: Readonly<Record<VerifyProbeId, string>> = {
  node: 'node',
  chromium: 'chromium',
  'driver-cli': 'driver CLI',
  'native-capture': 'screen capture',
  'native-drive': 'screen driving',
};

/**
 * Pill classes per probe state.
 *
 * `inconclusive` is deliberately NEUTRAL, not a warning colour: the probe did
 * not fail, it declined to answer, and colouring it red would manufacture
 * alarm about a host that may be perfectly fine (the fail-open rule in
 * `preflight.ts`). `blocked` is likewise neutral — it describes missing
 * machinery on our side, not a defect on the user's.
 */
export const PROBE_STATE_CLASS: Readonly<Record<VerifyProbeState, string>> = {
  ok: 'bg-status-success/15 text-status-success',
  missing: 'bg-status-error/15 text-status-error',
  inconclusive: 'bg-bg-tertiary text-text-tertiary',
  blocked: 'bg-bg-tertiary text-text-tertiary',
};

/** Short state word rendered in the pill. */
export const PROBE_STATE_LABEL: Readonly<Record<VerifyProbeState, string>> = {
  ok: 'ok',
  missing: 'missing',
  inconclusive: 'unknown',
  blocked: 'n/a',
};

/** The CTA label for a probe row's offered fix, or null when it offers none. */
export function probeFixLabel(row: VerifyProbeRow): string | null {
  switch (row.fix) {
    case 'provision-chromium':
      return 'Install';
    case 'grant-screen-recording':
      return 'Open settings';
    case null:
      return null;
  }
}

/**
 * `'—'` when there were no attempts, else a whole-percent string.
 *
 * The em-dash is load-bearing: rendering `0%` for a project that has never run
 * a verification would report a catastrophe where there is merely no history.
 */
export function passRateText(stats: VerificationOutcomeStats): string {
  if (stats.passRate === null) return '—';
  return `${Math.round(stats.passRate * 100)}%`;
}

/** Compact duration ('—' when unknown, '840ms', '12s', '3m 04s'). */
export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * The failure histogram as `env 3 · deliverable 1` — zero-count classes are
 * OMITTED so the line stays scannable, and an all-zero histogram yields `''`
 * (the caller renders nothing rather than an empty label).
 */
export function failureHistogramText(stats: VerificationOutcomeStats): string {
  return Object.entries(stats.failures)
    .filter(([, count]) => count > 0)
    .map(([cls, count]) => `${cls} ${count}`)
    .join(' · ');
}

/** `'12 attempts'` / `'1 attempt'` / `'no attempts yet'`. */
export function attemptsText(stats: VerificationOutcomeStats): string {
  if (stats.attempts === 0) return 'no attempts yet';
  return `${stats.attempts} attempt${stats.attempts === 1 ? '' : 's'}`;
}

/**
 * The single most important line per modality: what its runbook state means for
 * whether verification will actually RUN.
 *
 * Absent or unproven ⇒ the §3.2 degrade gate skips every build/serve check for
 * this modality, which is why a project can show a clean queue while having
 * verified nothing. Said plainly, because the failure is silent by design.
 */
export function runbookLine(runbook: VerificationRunbookState | null): {
  text: string;
  tone: 'ok' | 'warn';
} {
  if (runbook === null) {
    return { text: 'no runbook — verification will skip', tone: 'warn' };
  }
  if (runbook.status === 'unproven-draft') {
    return { text: `runbook v${runbook.version} not proven — verification will skip`, tone: 'warn' };
  }
  return { text: `runbook v${runbook.version} proven`, tone: 'ok' };
}

/**
 * The capability line, or `null` when there is nothing worth saying.
 *
 * Reports only a suppression that is CURRENTLY IN FORCE. A tripped row whose
 * TTL lapsed (or whose host generation moved on) is inert — the next request
 * re-attempts freely — so surfacing it would tell the user a modality is
 * blocked when the engine has already moved past it.
 */
export function capabilityLine(
  capability: VerificationCapabilityState | null,
  now: number = Date.now(),
): string | null {
  if (capability === null) return null;
  if (!capability.suppressionActive) {
    // Not in force. Still worth showing the failure streak if one is building
    // toward the breaker, since that is a leading indicator rather than noise.
    return capability.consecutiveEnvFailures > 0
      ? `${capability.consecutiveEnvFailures} consecutive env failures`
      : null;
  }
  const verb = capability.status === 'unsupported' ? 'unsupported' : 'suppressed';
  const reason = capability.reason.trim();
  const until = capability.suppressedUntil === null ? null : Date.parse(capability.suppressedUntil);
  const retry =
    until !== null && Number.isFinite(until) && until > now
      ? ` · retries in ${durationText(until - now)}`
      : '';
  return `${verb}${reason.length > 0 ? `: ${reason}` : ''}${retry}`;
}

/**
 * Whether the project has ANY modality whose runbook is proven.
 *
 * Drives the setup CTA: with none, every build/serve verification on this
 * project degrades to a skip, so offering "set up verification" is the only
 * useful thing the panel can say.
 */
export function hasProvenRunbook(modalities: readonly VerificationModalityHealth[]): boolean {
  return modalities.some((m) => m.runbook?.status === 'proven');
}
