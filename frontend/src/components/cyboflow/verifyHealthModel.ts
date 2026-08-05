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
} from '../../../../shared/types/visualVerification';

/**
 * Human label for each probe row.
 *
 * Named for the CAPABILITY, not the mechanism: a user deciding whether their
 * project can be verified cares that a browser can be driven, not that
 * `driver-cli` resolved.
 */
export const PROBE_LABEL: Readonly<Record<VerifyProbeId, string>> = {
  'browser-driving': 'browser driving',
  'screen-recording': 'screen recording',
  accessibility: 'accessibility',
};

/**
 * What a probe row says about the host, in one word.
 *
 * `unknown` is NOT a fourth wheel: a probe that could not answer is not a
 * probe that answered "no" (the fail-open rule in `preflight.ts`), and
 * folding it into `unhealthy` would send someone to fix a host that may be
 * perfectly fine. `n/a` covers machinery missing on OUR side, which is not a
 * verdict on the user's host at all.
 */
export type ProbeStatus = 'healthy' | 'pending action' | 'unhealthy' | 'unknown' | 'n/a';

/**
 * Pill classes per status.
 *
 * `unknown` and `n/a` are deliberately NEUTRAL rather than a warning colour,
 * for the reason above. `pending action` is amber, not red: there is a button
 * right there, so it is a step remaining rather than a fault.
 */
export const PROBE_STATUS_CLASS: Readonly<Record<ProbeStatus, string>> = {
  healthy: 'bg-status-success/15 text-status-success',
  'pending action': 'bg-status-warning/15 text-status-warning',
  unhealthy: 'bg-status-error/15 text-status-error',
  unknown: 'bg-bg-tertiary text-text-tertiary',
  'n/a': 'bg-bg-tertiary text-text-tertiary',
};

/**
 * The row's status word.
 *
 * An unmet capability is `pending action` exactly when the row carries a
 * remedy — the distinction the user acts on is "there is something I can do
 * here" versus "this is broken and the panel cannot help", and the fix button
 * IS that distinction. An unmet capability nobody's runbook needs is softened
 * to `unknown`: it describes a permission the user has no reason to grant, and
 * calling it unhealthy is a false alarm about a host that verifies fine.
 */
export function probeStatus(row: VerifyProbeRow, required: boolean): ProbeStatus {
  switch (row.state) {
    case 'ok':
      return 'healthy';
    case 'inconclusive':
      return 'unknown';
    case 'blocked':
      return 'n/a';
    case 'missing':
      if (!required) return 'unknown';
      return row.fix === null ? 'unhealthy' : 'pending action';
  }
}

/** The CTA label for a probe row's offered fix, or null when it offers none. */
export function probeFixLabel(row: VerifyProbeRow): string | null {
  switch (row.fix) {
    case 'provision-chromium':
      return 'Install';
    case 'request-accessibility':
      return 'Grant access';
    case 'open-screen-recording-settings':
      return 'Open settings';
    case null:
      return null;
  }
}

/** The in-flight label while a fix runs, or null for one that completes instantly. */
export function probeFixPendingLabel(fix: VerifyProbeRow['fix']): string | null {
  return fix === 'provision-chromium' ? 'Installing…' : null;
}

/**
 * Whether a probe row describes a capability THIS host is actually relied upon
 * for.
 *
 * The two TCC grants are always listed — you cannot decide whether to use
 * screen capture without first being told whether it works here, which is
 * exactly what hiding the rows until a runbook declared `native-screen` made
 * impossible. But a grant nobody's runbook needs is not a problem to be
 * alarmed about, so an unmet one is rendered as information rather than as a
 * fault.
 */
export function probeIsRequired(row: VerifyProbeRow, nativeScreenDeclared: boolean): boolean {
  return row.id === 'browser-driving' ? true : nativeScreenDeclared;
}

/** The pill class for a row, via its status. */
export function probeStatusClass(row: VerifyProbeRow, required: boolean): string {
  return PROBE_STATUS_CLASS[probeStatus(row, required)];
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
