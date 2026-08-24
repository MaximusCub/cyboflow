/**
 * onboardingTelemetry — the pure transition→usage-event mapper. Exercises the
 * full onboarding funnel: the pristine boot entry, per-step views (modal +
 * coachmark), the Settings replay start, Sidebar resume, skip/abandon, realEvent
 * advances out of 'pending', silent parking, and the completion event. All the
 * async firing lives in OnboardingGate and is not exercised here.
 */
import { describe, it, expect } from 'vitest';
import { onboardingTelemetryEvents, type OnboardingTelemetrySlice } from '../onboardingTelemetry';
import {
  ONBOARDING_STEP_COUNT,
  ONBOARDING_STEP_NAMES,
  ONBOARDING_MODAL_STEPS,
  ONBOARDING_COACH_STEPS,
  ONBOARDING_POINTER_STEPS,
} from '../../utils/onboarding';

/** A hydrated 'active' slice at a given step, overridable per field. */
function slice(over: Partial<OnboardingTelemetrySlice> = {}): OnboardingTelemetrySlice {
  return { status: 'active', step: 0, maxVisitedStep: 0, replay: false, hydrated: true, ...over };
}

describe('onboardingTelemetry — step-name table', () => {
  it('has one stable slug per tour step', () => {
    expect(ONBOARDING_STEP_NAMES).toHaveLength(ONBOARDING_STEP_COUNT);
    expect(new Set(ONBOARDING_STEP_NAMES).size).toBe(ONBOARDING_STEP_COUNT);
  });

  it('has exactly 13 entries', () => {
    expect(ONBOARDING_STEP_COUNT).toBe(13);
    expect(ONBOARDING_STEP_NAMES).toHaveLength(13);
  });

  it('carries the default-runtime slug at index 2 (after Connect, before Permission)', () => {
    expect(ONBOARDING_STEP_NAMES[1]).toBe('connect');
    expect(ONBOARDING_STEP_NAMES[2]).toBe('default_runtime');
    expect(ONBOARDING_STEP_NAMES[3]).toBe('permission');
  });

  it('carries the telemetry slug at index 4 (after Permission, before Add project)', () => {
    expect(ONBOARDING_STEP_NAMES[3]).toBe('permission');
    expect(ONBOARDING_STEP_NAMES[4]).toBe('telemetry');
    expect(ONBOARDING_STEP_NAMES[5]).toBe('add_project');
  });

  it('has no duplicate slugs', () => {
    const seen = new Set<string>();
    for (const name of ONBOARDING_STEP_NAMES) {
      expect(seen.has(name)).toBe(false);
      seen.add(name);
    }
  });

  it('matches the full stable 13-step order end to end', () => {
    expect(ONBOARDING_STEP_NAMES).toEqual([
      'welcome',           // 0
      'connect',           // 1
      'default_runtime',   // 2
      'permission',        // 3
      'telemetry',         // 4
      'add_project',       // 5
      'quick_session',     // 6
      'substrate',         // 7
      'session_permission',// 8
      'model',             // 9
      'ship',              // 10
      'human_review',      // 11
      'rail_map',          // 12
    ]);
  });
});

describe('onboardingTelemetry — step-group constants (modal/coach/pointer)', () => {
  it('ONBOARDING_MODAL_STEPS is exactly the modal-card steps, including the Default-agent (2) and Telemetry (4) steps', () => {
    expect(ONBOARDING_MODAL_STEPS).toEqual([0, 1, 2, 3, 4, 5, 12]);
  });

  it('ONBOARDING_COACH_STEPS is exactly the anchored-coachmark steps', () => {
    expect(ONBOARDING_COACH_STEPS).toEqual([6, 7, 8, 9, 10, 11]);
  });

  it('ONBOARDING_POINTER_STEPS is exactly the Configure pointer trio', () => {
    expect(ONBOARDING_POINTER_STEPS).toEqual([7, 8, 9]);
  });

  it('modal, coach, and pointer sets partition the 13 steps with no overlap and no gaps', () => {
    const modalOrCoach = [...ONBOARDING_MODAL_STEPS, ...ONBOARDING_COACH_STEPS].sort((a, b) => a - b);
    expect(modalOrCoach).toEqual(Array.from({ length: ONBOARDING_STEP_COUNT }, (_, i) => i));
    // Pointer steps are a subset of the coach steps, not a disjoint third set.
    for (const step of ONBOARDING_POINTER_STEPS) {
      expect(ONBOARDING_COACH_STEPS).toContain(step);
    }
  });
});

describe('onboardingTelemetry — boot resolve', () => {
  it('pristine first-run (idle → active) emits started + the step-0 view', () => {
    const events = onboardingTelemetryEvents(
      { status: 'idle', step: 0, maxVisitedStep: 0, replay: false, hydrated: false },
      slice({ step: 0 }),
    );
    expect(events).toEqual([
      { name: 'onboarding_started', props: { trigger: 'first_run' } },
      { name: 'onboarding_step_viewed', props: { step: 0, name: 'welcome' } },
    ]);
  });

  it('existing install (idle → completed) emits nothing', () => {
    const events = onboardingTelemetryEvents(
      { status: 'idle', step: 0, maxVisitedStep: 0, replay: false, hydrated: false },
      { status: 'completed', step: 0, maxVisitedStep: 0, replay: false, hydrated: true },
    );
    expect(events).toEqual([]);
  });

  it('clamped mid-tour resume (idle → skipped) emits nothing', () => {
    const events = onboardingTelemetryEvents(
      { status: 'idle', step: 0, maxVisitedStep: 0, replay: false, hydrated: false },
      { status: 'skipped', step: 5, maxVisitedStep: 5, replay: false, hydrated: true },
    );
    expect(events).toEqual([]);
  });
});

describe('onboardingTelemetry — per-step views', () => {
  it('a forward advance emits the new step view', () => {
    const events = onboardingTelemetryEvents(slice({ step: 0 }), slice({ step: 1, maxVisitedStep: 1 }));
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 1, name: 'connect' } }]);
  });

  it('a backward move re-emits the step view', () => {
    const events = onboardingTelemetryEvents(slice({ step: 2, maxVisitedStep: 2 }), slice({ step: 1, maxVisitedStep: 2 }));
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 1, name: 'connect' } }]);
  });

  it('every step index maps to its named view', () => {
    for (let step = 1; step < ONBOARDING_STEP_COUNT; step++) {
      const events = onboardingTelemetryEvents(slice({ step: step - 1 }), slice({ step, maxVisitedStep: step }));
      expect(events).toEqual([
        { name: 'onboarding_step_viewed', props: { step, name: ONBOARDING_STEP_NAMES[step] } },
      ]);
    }
  });

  it('a realEvent jump that skips pointer steps (6 → 10) emits only the landed view', () => {
    const events = onboardingTelemetryEvents(slice({ step: 6, maxVisitedStep: 6 }), slice({ step: 10, maxVisitedStep: 10 }));
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 10, name: 'ship' } }]);
  });

  it('a Connect advance that steps OVER the skipped Default-agent step (1 → 3) emits only the landed view', () => {
    const events = onboardingTelemetryEvents(slice({ step: 1, maxVisitedStep: 1 }), slice({ step: 3, maxVisitedStep: 3 }));
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 3, name: 'permission' } }]);
  });

  it('a no-op transition (same status, same step) emits nothing', () => {
    expect(onboardingTelemetryEvents(slice({ step: 3 }), slice({ step: 3 }))).toEqual([]);
  });
});

describe('onboardingTelemetry — lifecycle', () => {
  it('the Settings replay (→ active, step 0, maxVisited 0, replay) emits started:replay + view', () => {
    const events = onboardingTelemetryEvents(
      { status: 'completed', step: 12, maxVisitedStep: 12, replay: false, hydrated: true },
      slice({ status: 'active', step: 0, maxVisitedStep: 0, replay: true }),
    );
    expect(events).toEqual([
      { name: 'onboarding_started', props: { trigger: 'replay' } },
      { name: 'onboarding_step_viewed', props: { step: 0, name: 'welcome' } },
    ]);
  });

  it('a Sidebar resume (skipped → active, same step) emits resumed', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'skipped', step: 3, maxVisitedStep: 3 }),
      slice({ status: 'active', step: 3, maxVisitedStep: 3 }),
    );
    expect(events).toEqual([{ name: 'onboarding_resumed', props: { step: 3 } }]);
  });

  it('a clamping resume (skipped → active, 7 → 6) still emits resumed, not a step view', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'skipped', step: 7, maxVisitedStep: 9 }),
      slice({ status: 'active', step: 6, maxVisitedStep: 6 }),
    );
    expect(events).toEqual([{ name: 'onboarding_resumed', props: { step: 6 } }]);
  });

  it('a realEvent out of pending (pending → active, 9 → 10) reads as a view, not a resume', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'pending', step: 9, maxVisitedStep: 9 }),
      slice({ status: 'active', step: 10, maxVisitedStep: 10 }),
    );
    expect(events).toEqual([{ name: 'onboarding_step_viewed', props: { step: 10, name: 'ship' } }]);
  });

  it('a skip (active → skipped) records the step abandoned at', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 8, maxVisitedStep: 8 }),
      slice({ status: 'skipped', step: 8, maxVisitedStep: 8 }),
    );
    expect(events).toEqual([{ name: 'onboarding_skipped', props: { step: 8, name: 'session_permission' } }]);
  });

  it('a skip on the Telemetry step (active → skipped, step 4) records it too', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 4, maxVisitedStep: 4 }),
      slice({ status: 'skipped', step: 4, maxVisitedStep: 4 }),
    );
    expect(events).toEqual([{ name: 'onboarding_skipped', props: { step: 4, name: 'telemetry' } }]);
  });

  it('a skip on the Default-agent step (active → skipped, step 2) records its own slug', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 2, maxVisitedStep: 2 }),
      slice({ status: 'skipped', step: 2, maxVisitedStep: 2 }),
    );
    expect(events).toEqual([{ name: 'onboarding_skipped', props: { step: 2, name: 'default_runtime' } }]);
  });

  it('parking (active → pending) is silent', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 10, maxVisitedStep: 10 }),
      slice({ status: 'pending', step: 10, maxVisitedStep: 10 }),
    );
    expect(events).toEqual([]);
  });

  it('completion (active → completed) records the furthest step reached', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'active', step: 12, maxVisitedStep: 12 }),
      slice({ status: 'completed', step: 12, maxVisitedStep: 12 }),
    );
    expect(events).toEqual([{ name: 'onboarding_completed', props: { furthest_step: 12 } }]);
  });

  it('a Sidebar dismiss (skipped → completed) is a dismiss, not a completion', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'skipped', step: 8, maxVisitedStep: 8 }),
      slice({ status: 'completed', step: 8, maxVisitedStep: 8 }),
    );
    expect(events).toEqual([{ name: 'onboarding_dismissed', props: { step: 8, name: 'session_permission' } }]);
  });

  it('a dismiss from a parked coach step (pending → completed) reads as a dismiss too', () => {
    const events = onboardingTelemetryEvents(
      slice({ status: 'pending', step: 10, maxVisitedStep: 10 }),
      slice({ status: 'completed', step: 10, maxVisitedStep: 10 }),
    );
    expect(events).toEqual([{ name: 'onboarding_dismissed', props: { step: 10, name: 'ship' } }]);
  });

  it('an idle target (never expected post-boot) emits nothing', () => {
    expect(onboardingTelemetryEvents(slice(), slice({ status: 'idle' }))).toEqual([]);
  });
});
