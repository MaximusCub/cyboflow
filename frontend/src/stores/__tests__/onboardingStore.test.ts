/**
 * onboardingStore — the pure 13-step tour machine. Covers boot hydration (all
 * four branches) including the version-1 → version-2 → version-3 snapshot
 * migrations (the Telemetry step's insertion at index 3, then the Default-agent
 * step's at index 2), the step-1 credential gate, the CONDITIONAL Default-agent
 * step (shown only when step 1 left 2+ providers activated), coach-step
 * advance-by-doing rules (anchorActioned / realEvent), the Configure pointer
 * steps (7-9: next() advances, the last pointer parks pending), dot/goTo
 * maxVisited clamping, and the skip↔resume round trip. All transitions are
 * synchronous — the async side effects live in OnboardingGate and are not
 * exercised here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ClaudeDetectionResult,
  CodexDetectionResult,
  ProviderDetectionResult,
} from '../../../../shared/types/onboarding';
import {
  useOnboardingStore,
  activatedProviders,
  isNextGateBlocked,
  isStepSkipped,
  migratePersistedOnboarding,
  migrateV1StepIndex,
  migrateV2StepIndex,
  skippedStepSet,
  clampResumeStep,
} from '../onboardingStore';

const DETECTED: ClaudeDetectionResult = {
  credentials: { found: true, source: 'keychain', account: 'a@b.co' },
  binary: { found: true, path: '/usr/bin/claude', version: 'v1.4.2' },
  state: 'detected',
};

const CODEX_DETECTED: CodexDetectionResult = {
  runtime: { found: true, path: '/app/codex', version: '0.144.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
  state: 'detected',
};

const OMP_DETECTED: ProviderDetectionResult<'omp'> = {
  binaryPath: '/usr/local/bin/omp',
  version: '0.9.1',
  state: 'detected',
};

function reset(): void {
  useOnboardingStore.setState({
    status: 'idle',
    step: 0,
    maxVisitedStep: 0,
    replay: false,
    detection: null,
    connected: false,
    codexDetection: null,
    codexConnected: false,
    ompDetection: null,
    ompConnected: false,
    permMode: 'auto',
    defaultProvider: null,
    multiRuntime: true,
    hydrated: false,
  });
}

const s = () => useOnboardingStore.getState();

describe('onboardingStore — hydrate', () => {
  beforeEach(reset);

  it('pristine install (no snapshot, no projects) starts the tour active at step 0', () => {
    s().hydrate(null, 0);
    expect(s().status).toBe('active');
    expect(s().step).toBe(0);
    expect(s().maxVisitedStep).toBe(0);
    expect(s().hydrated).toBe(true);
  });

  it('existing install (no snapshot, projects present) is marked completed without showing the tour', () => {
    s().hydrate(null, 3);
    expect(s().status).toBe('completed');
    expect(s().hydrated).toBe(true);
  });

  it('a completed snapshot stays completed', () => {
    s().hydrate({ version: 1, status: 'completed', step: 10 }, 0);
    expect(s().status).toBe('completed');
  });

  it('v1 snapshots on the old context-bound coach steps (5-8, migrating to new 7-10) resume clamped to 6', () => {
    for (const step of [5, 6, 7, 8]) {
      reset();
      s().hydrate({ version: 1, status: 'active', step }, 1);
      expect(s().status).toBe('skipped');
      expect(s().step).toBe(6);
      expect(s().maxVisitedStep).toBe(6);
    }
  });

  it('a mid-tour v1 snapshot on old step 9 (rail anchor always exists) keeps that step', () => {
    s().hydrate({ version: 1, status: 'active', step: 9 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(11);
  });

  it('a mid-tour snapshot on a modal step keeps that step', () => {
    s().hydrate({ version: 1, status: 'pending', step: 3 }, 0);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(5);
  });
});

describe('onboardingStore — snapshot migration', () => {
  beforeEach(reset);

  it('migrateV1StepIndex leaves the unmoved prefix (0-2) unchanged', () => {
    expect(migrateV1StepIndex(0)).toBe(0);
    expect(migrateV1StepIndex(1)).toBe(1);
    expect(migrateV1StepIndex(2)).toBe(2);
  });

  it('migrateV1StepIndex shifts old index 3 onward forward by one', () => {
    expect(migrateV1StepIndex(3)).toBe(4); // old Add project → v2 Add project
    expect(migrateV1StepIndex(10)).toBe(11); // old Rail map → v2 Rail map
  });

  it('migrateV1StepIndex shifts a value past the valid v1 domain (10) the same way', () => {
    // v1 only ever persisted 0-10; this documents that the shift rule has no
    // special-cased upper bound of its own — anything ≥ 3 shifts by one, and
    // out-of-range values are left for clampResumeStep to clamp downstream.
    expect(migrateV1StepIndex(11)).toBe(12);
  });

  it('migrateV2StepIndex leaves the unmoved prefix (0-1) unchanged and shifts index 2 onward', () => {
    expect(migrateV2StepIndex(0)).toBe(0);
    expect(migrateV2StepIndex(1)).toBe(1);
    expect(migrateV2StepIndex(2)).toBe(3); // v2 Permission → v3 Permission
    expect(migrateV2StepIndex(11)).toBe(12); // v2 Rail map → v3 Rail map
  });

  it('migratePersistedOnboarding is a no-op for an already-v3 snapshot', () => {
    const v3 = { version: 3 as const, status: 'active' as const, step: 4 };
    expect(migratePersistedOnboarding(v3)).toEqual(v3);
  });

  it('migratePersistedOnboarding leaves a completed snapshot completed, step untouched', () => {
    expect(migratePersistedOnboarding({ version: 1, status: 'completed', step: 10 })).toEqual({
      version: 3,
      status: 'completed',
      step: 10,
    });
    expect(migratePersistedOnboarding({ version: 2, status: 'completed', step: 4 })).toEqual({
      version: 3,
      status: 'completed',
      step: 4,
    });
  });

  it('migratePersistedOnboarding leaves a v1 completed snapshot untouched right at the shift boundary (step 3)', () => {
    // A completed snapshot skips the step remaps entirely — confirm that holds
    // even when the raw step sits exactly on the old shift boundary, where a
    // regression to "always remap" would be most likely to surface.
    const migrated = migratePersistedOnboarding({ version: 1, status: 'completed', step: 3 });
    expect(migrated).toEqual({ version: 3, status: 'completed', step: 3 });
  });

  it('migratePersistedOnboarding leaves a v1 completed snapshot untouched just below the shift boundary (step 2)', () => {
    const migrated = migratePersistedOnboarding({ version: 1, status: 'completed', step: 2 });
    expect(migrated).toEqual({ version: 3, status: 'completed', step: 2 });
  });

  it('migratePersistedOnboarding composes BOTH remaps for a v1 active/pending/skipped snapshot', () => {
    // 0 and 1 predate both insertions; 2 is untouched by v1→v2 but shifted by
    // v2→v3; 3 is shifted by both.
    expect(migratePersistedOnboarding({ version: 1, status: 'active', step: 0 })).toEqual({
      version: 3,
      status: 'active',
      step: 0,
    });
    expect(migratePersistedOnboarding({ version: 1, status: 'active', step: 1 })).toEqual({
      version: 3,
      status: 'active',
      step: 1,
    });
    expect(migratePersistedOnboarding({ version: 1, status: 'active', step: 2 })).toEqual({
      version: 3,
      status: 'active',
      step: 3,
    });
    expect(migratePersistedOnboarding({ version: 1, status: 'pending', step: 3 })).toEqual({
      version: 3,
      status: 'pending',
      step: 5,
    });
  });

  it('migratePersistedOnboarding remaps a v1 snapshot at index 10 (old Rail map → new index 12)', () => {
    const migrated = migratePersistedOnboarding({ version: 1, status: 'skipped', step: 10 });
    expect(migrated).toEqual({ version: 3, status: 'skipped', step: 12 });
  });

  it('migratePersistedOnboarding applies ONLY the v2→v3 remap to a v2 snapshot', () => {
    expect(migratePersistedOnboarding({ version: 2, status: 'active', step: 4 })).toEqual({
      version: 3,
      status: 'active',
      step: 5,
    });
    expect(migratePersistedOnboarding({ version: 2, status: 'active', step: 1 })).toEqual({
      version: 3,
      status: 'active',
      step: 1,
    });
  });

  it('hydrate migrates a v1 snapshot end-to-end before clamping (old step 3 → new 5, kept)', () => {
    s().hydrate({ version: 1, status: 'active', step: 3 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(5);
    expect(s().maxVisitedStep).toBe(5);
  });

  it('hydrate migrates a v1 snapshot on an old context-bound coach step (old 7 → new 9, clamped to 6)', () => {
    // old step 7 (last Configure pointer) → new step 9, which falls inside the
    // 7-10 context-bound clamp range and resumes at 6.
    s().hydrate({ version: 1, status: 'active', step: 7 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(6);
    expect(s().maxVisitedStep).toBe(6);
  });

  it('hydrate migrates a v1 snapshot on old step 10 (rail map, unaffected by the clamp) to new 12', () => {
    s().hydrate({ version: 1, status: 'active', step: 10 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(12);
  });

  it('clampResumeStep still clamps out-of-range values to the valid 0-12 window', () => {
    expect(clampResumeStep(-1)).toBe(0);
    expect(clampResumeStep(99)).toBe(12);
  });

  it('clampResumeStep passes through the valid-window edges (0 and 12) unchanged', () => {
    expect(clampResumeStep(0)).toBe(0);
    expect(clampResumeStep(12)).toBe(12);
  });

  it('clampResumeStep maps exactly the context-bound band (7-10) to 6, leaving its neighbors (6, 11) untouched', () => {
    expect(clampResumeStep(6)).toBe(6); // just below the band
    expect(clampResumeStep(7)).toBe(6); // band start
    expect(clampResumeStep(10)).toBe(6); // band end
    expect(clampResumeStep(11)).toBe(11); // just above the band
  });

  it('hydrate accepts a v3 snapshot directly, applying only the clamp (no step shift)', () => {
    s().hydrate({ version: 3, status: 'active', step: 4 }, 1);
    expect(s().status).toBe('skipped');
    expect(s().step).toBe(4); // NOT shifted again — already the new-schema index
  });
});

describe('onboardingStore — step-1 gate', () => {
  beforeEach(reset);

  it('isNextGateBlocked accepts either detected and enabled provider', () => {
    expect(isNextGateBlocked({
      step: 1,
      detection: null,
      connected: false,
      codexDetection: null,
      codexConnected: false,
    })).toBe(true);
    expect(isNextGateBlocked({
      step: 1,
      detection: DETECTED,
      connected: false,
      codexDetection: CODEX_DETECTED,
      codexConnected: false,
    })).toBe(true);
    expect(isNextGateBlocked({
      step: 1,
      detection: DETECTED,
      connected: true,
      codexDetection: null,
      codexConnected: false,
    })).toBe(false);
    expect(isNextGateBlocked({
      step: 1,
      detection: null,
      connected: false,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
    })).toBe(false);
    // Non-step-1 is never gated.
    expect(isNextGateBlocked({
      step: 0,
      detection: null,
      connected: false,
      codexDetection: null,
      codexConnected: false,
    })).toBe(false);
  });

  it('next() is a no-op on step 1 while the gate is closed, and advances once open', () => {
    useOnboardingStore.setState({ status: 'active', step: 1, maxVisitedStep: 1, detection: DETECTED, connected: false });
    s().next();
    expect(s().step).toBe(1);
    s().setConnected(true);
    s().next();
    // One activated provider ⇒ the Default-agent step (2) is skipped entirely.
    expect(s().step).toBe(3);
    expect(s().maxVisitedStep).toBe(3);
  });

  it('next() advances with Codex enabled even when Claude is unavailable', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: null,
      connected: false,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
    });
    s().next();
    expect(s().step).toBe(3);
  });
});

describe('onboardingStore — the conditional Default-agent step (2)', () => {
  beforeEach(reset);

  it('activatedProviders counts only providers that are BOTH detected and toggled on', () => {
    expect(
      activatedProviders({
        detection: DETECTED,
        connected: true,
        codexDetection: CODEX_DETECTED,
        codexConnected: true,
        ompDetection: OMP_DETECTED,
        ompConnected: true,
      }),
    ).toEqual(['claude', 'codex', 'omp']);

    // Toggled on but never detected — a stale access map seeding a vanished
    // binary must not offer itself as "your default agent".
    expect(
      activatedProviders({
        detection: DETECTED,
        connected: true,
        codexDetection: { state: 'unavailable', runtime: { found: false, path: null, version: null }, account: { found: false, email: null, planType: null } },
        codexConnected: true,
        ompDetection: null,
        ompConnected: false,
      }),
    ).toEqual(['claude']);

    // Detected but toggled off.
    expect(
      activatedProviders({
        detection: DETECTED,
        connected: false,
        codexDetection: CODEX_DETECTED,
        codexConnected: true,
        ompDetection: null,
        ompConnected: false,
      }),
    ).toEqual(['codex']);
  });

  it('next() from Connect lands on step 2 when two providers are activated', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
    });
    s().next();
    expect(s().step).toBe(2);
    expect(s().multiRuntime).toBe(true);
    s().next();
    expect(s().step).toBe(3);
  });

  it('next() from Connect steps OVER step 2 with a single activated provider', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: false,
    });
    s().next();
    expect(s().step).toBe(3);
    expect(s().multiRuntime).toBe(false);
    expect(isStepSkipped(2, s())).toBe(true);
  });

  it('back() from Permission steps over a skipped step 2 and lands on Connect', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3, multiRuntime: false });
    s().back();
    expect(s().step).toBe(1);
  });

  it('back() from Permission lands on step 2 when it IS part of this run', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3, multiRuntime: true });
    s().back();
    expect(s().step).toBe(2);
  });

  it('goTo refuses a skipped step even inside maxVisited', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4, multiRuntime: false });
    s().goTo(2);
    expect(s().step).toBe(4);
    s().goTo(1);
    expect(s().step).toBe(1);
  });

  it('forceNext also steps over a skipped step 2', () => {
    useOnboardingStore.setState({ status: 'active', step: 1, maxVisitedStep: 1, multiRuntime: false, detection: DETECTED, connected: true });
    s().forceNext();
    expect(s().step).toBe(3);
  });

  it('the decision is re-made every time Connect is left, so enabling a second provider brings the step back', () => {
    useOnboardingStore.setState({
      status: 'active',
      step: 1,
      maxVisitedStep: 1,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: false,
    });
    s().next();
    expect(s().step).toBe(3);
    expect(s().multiRuntime).toBe(false);

    s().goTo(1);
    s().setCodexConnected(true);
    s().next();
    expect(s().step).toBe(2);
    expect(s().multiRuntime).toBe(true);
  });

  it('skippedStepSet returns a stable identity per mode (no fresh Set per read)', () => {
    useOnboardingStore.setState({ multiRuntime: false });
    expect(skippedStepSet(s())).toBe(skippedStepSet(s()));
    expect([...skippedStepSet(s())]).toEqual([2]);
    useOnboardingStore.setState({ multiRuntime: true });
    expect(skippedStepSet(s()).size).toBe(0);
  });

  it('setDefaultProvider records the step-2 selection', () => {
    s().setDefaultProvider('codex');
    expect(s().defaultProvider).toBe('codex');
    s().setDefaultProvider(null);
    expect(s().defaultProvider).toBeNull();
  });

  it('is included in ONBOARDING_MODAL_STEPS, not the coach/pointer sets', async () => {
    const { ONBOARDING_MODAL_STEPS, ONBOARDING_COACH_STEPS, ONBOARDING_POINTER_STEPS } = await import('../../utils/onboarding');
    expect(ONBOARDING_MODAL_STEPS).toContain(2);
    expect(ONBOARDING_COACH_STEPS).not.toContain(2);
    expect(ONBOARDING_POINTER_STEPS).not.toContain(2);
  });
});

describe('onboardingStore — coach steps advance by doing', () => {
  beforeEach(reset);

  it('next() never advances a do-step (6, 10, 11)', () => {
    for (const step of [6, 10, 11]) {
      useOnboardingStore.setState({ status: 'active', step, maxVisitedStep: step });
      s().next();
      expect(s().step).toBe(step);
      expect(s().status).toBe('active');
    }
  });

  it('anchorActioned on step 6 advances straight to the first Configure pointer (7)', () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(7);
    expect(s().maxVisitedStep).toBe(7);
  });

  it('anchorActioned on step 10 parks pending', () => {
    useOnboardingStore.setState({ status: 'active', step: 10, maxVisitedStep: 10 });
    s().anchorActioned();
    expect(s().status).toBe('pending');
    expect(s().step).toBe(10);
  });

  it('anchorActioned on step 11 jumps straight to the rail map (step 12)', () => {
    useOnboardingStore.setState({ status: 'active', step: 11, maxVisitedStep: 11 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(12);
    expect(s().maxVisitedStep).toBe(12);
  });

  it('anchorActioned is a no-op on pointer steps', () => {
    useOnboardingStore.setState({ status: 'active', step: 7, maxVisitedStep: 7 });
    s().anchorActioned();
    expect(s().status).toBe('active');
    expect(s().step).toBe(7);
  });

  it('realEvent lands the matching next step from pending', () => {
    useOnboardingStore.setState({ status: 'pending', step: 9, maxVisitedStep: 9 });
    s().realEvent('quick-session-created');
    expect(s().status).toBe('active');
    expect(s().step).toBe(10);

    useOnboardingStore.setState({ status: 'pending', step: 10, maxVisitedStep: 10 });
    s().realEvent('workflow-run-started');
    expect(s().step).toBe(11);

    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().realEvent('project-created');
    expect(s().step).toBe(6);
  });

  it('quick-session-created advances from ANY Configure-page step (6-9)', () => {
    for (const step of [6, 7, 8, 9]) {
      useOnboardingStore.setState({ status: 'active', step, maxVisitedStep: step });
      s().realEvent('quick-session-created');
      expect(s().status).toBe('active');
      expect(s().step).toBe(10);
    }
  });

  it('realEvent ignores wrong-step / wrong-kind signals', () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6 });
    s().realEvent('workflow-run-started'); // wrong kind for step 6
    expect(s().step).toBe(6);

    useOnboardingStore.setState({ status: 'skipped', step: 6, maxVisitedStep: 6 });
    s().realEvent('quick-session-created'); // not active/pending
    expect(s().step).toBe(6);
    expect(s().status).toBe('skipped');
  });
});

describe('onboardingStore — Configure pointer steps (7-9)', () => {
  beforeEach(reset);

  it('next() advances pointer steps 7 → 8 → 9', () => {
    useOnboardingStore.setState({ status: 'active', step: 7, maxVisitedStep: 7 });
    s().next();
    expect(s().step).toBe(8);
    s().next();
    expect(s().step).toBe(9);
    expect(s().maxVisitedStep).toBe(9);
  });

  it('next() on the last pointer (9) parks pending until the session launches', () => {
    useOnboardingStore.setState({ status: 'active', step: 9, maxVisitedStep: 9 });
    s().next();
    expect(s().status).toBe('pending');
    expect(s().step).toBe(9);
    s().realEvent('quick-session-created');
    expect(s().status).toBe('active');
    expect(s().step).toBe(10);
  });

  it('next() on step 9 advances normally when step 10 was already reached (revisit)', () => {
    useOnboardingStore.setState({ status: 'active', step: 9, maxVisitedStep: 11 });
    s().next();
    expect(s().status).toBe('active');
    expect(s().step).toBe(10);
  });
});

describe('onboardingStore — forceNext (anchor-lost escape)', () => {
  beforeEach(reset);

  it('force-advances a do-step that next() refuses (6 → 7)', () => {
    useOnboardingStore.setState({ status: 'active', step: 6, maxVisitedStep: 6 });
    s().next();
    expect(s().step).toBe(6); // next() is a no-op on the do-step
    s().forceNext();
    expect(s().step).toBe(7);
    expect(s().maxVisitedStep).toBe(7);
  });

  it('force-advances the later do-steps (10 → 11, 11 → 12)', () => {
    useOnboardingStore.setState({ status: 'active', step: 10, maxVisitedStep: 10 });
    s().forceNext();
    expect(s().step).toBe(11);
    useOnboardingStore.setState({ status: 'active', step: 11, maxVisitedStep: 11 });
    s().forceNext();
    expect(s().step).toBe(12);
    expect(s().maxVisitedStep).toBe(12);
  });

  it('is a no-op unless active', () => {
    useOnboardingStore.setState({ status: 'pending', step: 10, maxVisitedStep: 10 });
    s().forceNext();
    expect(s().step).toBe(10);
    expect(s().status).toBe('pending');
  });

  it('completes from the last step', () => {
    useOnboardingStore.setState({ status: 'active', step: 12, maxVisitedStep: 12 });
    s().forceNext();
    expect(s().status).toBe('completed');
  });
});

describe('onboardingStore — goTo / skip / resume', () => {
  beforeEach(reset);

  it('goTo only revisits steps within maxVisited and ignores the current step', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().goTo(6); // beyond maxVisited
    expect(s().step).toBe(4);
    s().goTo(4); // same step
    expect(s().step).toBe(4);
    s().goTo(1); // reachable
    expect(s().step).toBe(1);
  });

  it('skip then resume round-trips to the same step', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3 });
    s().skip();
    expect(s().status).toBe('skipped');
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(3);
  });

  it('skip then resume round-trips on the Telemetry step (4)', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().skip();
    expect(s().status).toBe('skipped');
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(4); // modal step, never disconnects — no clamp
  });

  it('resume from a live coach pending step returns to the SAME step (steps 10-11 keep place)', () => {
    useOnboardingStore.setState({ status: 'pending', step: 10, maxVisitedStep: 10 });
    s().resume();
    expect(s().status).toBe('active');
    expect(s().step).toBe(10);
  });

  it('resume from a Configure pointer (7-9) clamps to step 6 to rebuild the wizard', () => {
    for (const step of [7, 8, 9]) {
      reset();
      useOnboardingStore.setState({ status: 'skipped', step, maxVisitedStep: 9 });
      s().resume();
      expect(s().status).toBe('active');
      expect(s().step).toBe(6);
      expect(s().maxVisitedStep).toBe(6); // reset so dots can't jump back onto missing anchors
    }
  });

  it('resume clamps a Configure pointer from pending too', () => {
    useOnboardingStore.setState({ status: 'pending', step: 8, maxVisitedStep: 8 });
    s().resume();
    expect(s().step).toBe(6);
  });

  it('dismiss permanently completes the tour from skipped or pending', () => {
    for (const status of ['skipped', 'pending'] as const) {
      reset();
      useOnboardingStore.setState({ status, step: 8, maxVisitedStep: 8 });
      s().dismiss();
      expect(s().status).toBe('completed');
      expect(s().step).toBe(8); // step kept for the persisted snapshot + telemetry
    }
  });

  it('dismiss is a no-op unless skipped/pending (never from an active tour)', () => {
    for (const status of ['active', 'idle', 'completed'] as const) {
      reset();
      useOnboardingStore.setState({ status, step: 6, maxVisitedStep: 6 });
      s().dismiss();
      expect(s().status).toBe(status);
    }
  });

  it('begin resets provider detection + consent for a clean replay', () => {
    useOnboardingStore.setState({
      status: 'skipped',
      step: 11,
      detection: DETECTED,
      connected: true,
      codexDetection: CODEX_DETECTED,
      codexConnected: true,
      ompDetection: OMP_DETECTED,
      ompConnected: true,
      permMode: 'dontAsk',
      defaultProvider: 'codex',
      multiRuntime: false,
    });
    s().begin(true);
    expect(s().status).toBe('active');
    expect(s().step).toBe(0);
    expect(s().replay).toBe(true);
    expect(s().detection).toBeNull();
    expect(s().connected).toBe(false);
    expect(s().codexDetection).toBeNull();
    expect(s().codexConnected).toBe(false);
    expect(s().ompDetection).toBeNull();
    expect(s().ompConnected).toBe(false);
    expect(s().permMode).toBe('auto');
    expect(s().defaultProvider).toBeNull();
    expect(s().multiRuntime).toBe(true);
  });
});

describe('onboardingStore — Telemetry step (4)', () => {
  beforeEach(reset);

  it('next() advances Permission → Telemetry → Add project like any other modal step', () => {
    useOnboardingStore.setState({ status: 'active', step: 3, maxVisitedStep: 3 });
    s().next();
    expect(s().step).toBe(4);
    s().next();
    expect(s().step).toBe(5);
    expect(s().maxVisitedStep).toBe(5);
  });

  it('back() from Telemetry (4) returns to Permission (3)', () => {
    useOnboardingStore.setState({ status: 'active', step: 4, maxVisitedStep: 4 });
    s().back();
    expect(s().step).toBe(3);
  });

  it('goTo reaches the Telemetry step once visited', () => {
    useOnboardingStore.setState({ status: 'active', step: 5, maxVisitedStep: 5 });
    s().goTo(4);
    expect(s().step).toBe(4);
  });

  it('is included in ONBOARDING_MODAL_STEPS, not the coach/pointer sets', async () => {
    const { ONBOARDING_MODAL_STEPS, ONBOARDING_COACH_STEPS, ONBOARDING_POINTER_STEPS } = await import('../../utils/onboarding');
    expect(ONBOARDING_MODAL_STEPS).toContain(4);
    expect(ONBOARDING_COACH_STEPS).not.toContain(4);
    expect(ONBOARDING_POINTER_STEPS).not.toContain(4);
  });
});
