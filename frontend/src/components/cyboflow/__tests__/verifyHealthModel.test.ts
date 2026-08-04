/**
 * verifyHealthModel — pure derivation tests (verification-setup-flow.md §6).
 *
 * The theme throughout: "no data" must never render as a zero. A fresh project
 * and a completely broken one have to look different, which is most of what the
 * health panel is for.
 */
import { describe, it, expect } from 'vitest';
import type {
  VerificationCapabilityState,
  VerificationModalityHealth,
  VerificationOutcomeStats,
} from '../../../../../shared/types/visualVerification';
import {
  attemptsText,
  capabilityLine,
  durationText,
  failureHistogramText,
  hasProvenRunbook,
  passRateText,
  probeFixLabel,
  runbookLine,
} from '../verifyHealthModel';

function stats(over: Partial<VerificationOutcomeStats> = {}): VerificationOutcomeStats {
  return {
    attempts: 0,
    inFlight: 0,
    passed: 0,
    passRate: null,
    outcomes: {
      queued: 0,
      leased: 0,
      running: 0,
      passed: 0,
      failed: 0,
      low_confidence: 0,
      skipped: 0,
      timeout: 0,
    },
    failures: { env: 0, deliverable: 0, ambiguous: 0, unclassified: 0 },
    medianDurationMs: null,
    lastAt: null,
    ...over,
  };
}

function capability(over: Partial<VerificationCapabilityState> = {}): VerificationCapabilityState {
  return {
    status: 'suppressed',
    reason: 'port taken',
    consecutiveEnvFailures: 5,
    suppressedUntil: null,
    hostGeneration: 1,
    suppressionActive: false,
    ...over,
  };
}

describe('passRateText', () => {
  it('renders an em-dash, NOT 0%, when there are no attempts', () => {
    // A project that has never verified anything has an UNKNOWN pass rate.
    // Rendering 0% would report a catastrophe where there is merely no history.
    expect(passRateText(stats())).toBe('—');
  });

  it('rounds a real rate to whole percent', () => {
    expect(passRateText(stats({ attempts: 3, passed: 1, passRate: 1 / 3 }))).toBe('33%');
    expect(passRateText(stats({ attempts: 4, passed: 2, passRate: 0.5 }))).toBe('50%');
  });

  it('renders a genuine zero rate as 0%', () => {
    // Distinct from the no-data case above: attempts happened and none passed.
    expect(passRateText(stats({ attempts: 5, passed: 0, passRate: 0 }))).toBe('0%');
  });
});

describe('durationText', () => {
  it('renders sub-second, seconds, and minute spans', () => {
    expect(durationText(840)).toBe('840ms');
    expect(durationText(12_000)).toBe('12s');
    expect(durationText(184_000)).toBe('3m 04s');
  });

  it('renders an em-dash when unknown', () => {
    expect(durationText(null)).toBe('—');
  });
});

describe('failureHistogramText', () => {
  it('omits zero-count classes and joins the rest', () => {
    expect(
      failureHistogramText(stats({ failures: { env: 3, deliverable: 1, ambiguous: 0, unclassified: 0 } })),
    ).toBe('env 3 · deliverable 1');
  });

  it('is empty when nothing failed, so the caller renders no line at all', () => {
    expect(failureHistogramText(stats())).toBe('');
  });
});

describe('attemptsText', () => {
  it('singularizes and reports emptiness in words', () => {
    expect(attemptsText(stats())).toBe('no attempts yet');
    expect(attemptsText(stats({ attempts: 1 }))).toBe('1 attempt');
    expect(attemptsText(stats({ attempts: 12 }))).toBe('12 attempts');
  });
});

describe('runbookLine', () => {
  it('warns that verification will SKIP with no runbook', () => {
    // The silent failure: without a proven runbook the degrade gate skips every
    // build/serve check, so the queue looks calm while nothing is verified.
    const line = runbookLine(null);
    expect(line.tone).toBe('warn');
    expect(line.text).toMatch(/will skip/);
  });

  it('warns the same way for a registered but unproven draft', () => {
    const line = runbookLine({ status: 'unproven-draft', version: 3, portableHash: 'h' });
    expect(line.tone).toBe('warn');
    expect(line.text).toMatch(/v3 not proven/);
  });

  it('reports a proven runbook as ok', () => {
    const line = runbookLine({ status: 'proven', version: 7, portableHash: 'h' });
    expect(line.tone).toBe('ok');
    expect(line.text).toBe('runbook v7 proven');
  });
});

describe('capabilityLine', () => {
  it('says nothing when the ledger has no row', () => {
    expect(capabilityLine(null)).toBeNull();
  });

  it('does NOT report a suppression that is no longer in force', () => {
    // A tripped row whose TTL lapsed (or whose host generation moved on) is
    // inert — the next request re-attempts freely. Reporting it would tell the
    // user a modality is blocked that the engine has already moved past.
    expect(capabilityLine(capability({ suppressionActive: false, consecutiveEnvFailures: 0 }))).toBeNull();
  });

  it('still surfaces a building failure streak as a leading indicator', () => {
    expect(capabilityLine(capability({ suppressionActive: false, consecutiveEnvFailures: 3 }))).toBe(
      '3 consecutive env failures',
    );
  });

  it('reports an in-force suppression with its reason and retry window', () => {
    const now = Date.parse('2026-08-04T12:00:00.000Z');
    const line = capabilityLine(
      capability({
        suppressionActive: true,
        reason: 'port 4521 occupied',
        suppressedUntil: '2026-08-04T12:30:00.000Z',
      }),
      now,
    );
    expect(line).toBe('suppressed: port 4521 occupied · retries in 30m 00s');
  });

  it('distinguishes an unsupported capability from a suppressed one', () => {
    const line = capabilityLine(
      capability({ status: 'unsupported', suppressionActive: true, reason: 'no grant', suppressedUntil: null }),
    );
    expect(line).toBe('unsupported: no grant');
  });
});

describe('hasProvenRunbook', () => {
  function modality(over: Partial<VerificationModalityHealth>): VerificationModalityHealth {
    return { modality: 'web', ...stats(), capability: null, runbook: null, ...over };
  }

  it('is false with no modalities, or with only unproven drafts', () => {
    expect(hasProvenRunbook([])).toBe(false);
    expect(
      hasProvenRunbook([modality({ runbook: { status: 'unproven-draft', version: 1, portableHash: 'h' } })]),
    ).toBe(false);
  });

  it('is true as soon as ANY modality is proven', () => {
    expect(
      hasProvenRunbook([
        modality({ modality: 'web', runbook: null }),
        modality({ modality: 'cdp-app', runbook: { status: 'proven', version: 1, portableHash: 'h' } }),
      ]),
    ).toBe(true);
  });
});

describe('probeFixLabel', () => {
  it('labels the offered remediation, or none', () => {
    expect(probeFixLabel({ id: 'chromium', state: 'missing', detail: '', fix: 'provision-chromium' })).toBe(
      'Install',
    );
    expect(
      probeFixLabel({ id: 'native-capture', state: 'missing', detail: '', fix: 'grant-screen-recording' }),
    ).toBe('Open settings');
    expect(probeFixLabel({ id: 'node', state: 'ok', detail: '', fix: null })).toBeNull();
  });
});
