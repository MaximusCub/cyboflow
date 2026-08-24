/**
 * First-run onboarding — renderer-side shared constants.
 *
 * Neutral module (importable by stores, components, and integration touch
 * points alike) so the onboarding overlay, the Sidebar resume button, and the
 * real-action dispatch sites never drift on key/event/anchor names.
 */

import type { OnboardingStepName } from '../../../shared/types/telemetry';

/**
 * Single user_preferences key holding the persisted tour snapshot as JSON
 * (see PersistedOnboarding in stores/onboardingStore.ts). Read/write via the
 * raw `preferences:get` / `preferences:set` IPC channels — the established
 * pattern for one-shot UI flags (docs/CODE-PATTERNS.md "IPC preference-backed
 * component visibility").
 */
export const ONBOARDING_PREF_KEY = 'cyboflow_onboarding_state_v1';

/**
 * Window CustomEvents that advance the tour's coach steps. `projectCreated`
 * is the app's PRE-EXISTING event (dispatched by CreateProjectDialog and any
 * onboarding-embedded create path); the other two are dispatched at the
 * real-action success sites (quick-session creation, runs.start success).
 */
export const ONBOARDING_EVENTS = {
  projectCreated: 'project-created',
  quickSessionCreated: 'cyboflow:quick-session-created',
  workflowRunStarted: 'cyboflow:workflow-run-started',
} as const;

/**
 * Coachmark anchor ids, rendered as `data-onboarding="<id>"` on the real
 * target elements. The Coachmark component resolves targets exclusively via
 * this attribute — never by class name or test id.
 */
export const ONBOARDING_ANCHOR_ATTR = 'data-onboarding';
export const ONBOARDING_ANCHORS = {
  /** SessionStartWizard step-② Quick Session card (tour step 6). */
  quickSessionCard: 'quick-session-card',
  /** Wizard Configure — Session permission selector (tour step 8). */
  sessionPermission: 'session-permission',
  /** Wizard Configure — Model picker (tour step 9). */
  modelSelect: 'model-select',
  /** Wizard Configure — agent runtime selector (tour step 7). */
  substrateSelect: 'substrate-select',
  /** QuickSessionCanvas "/ship" workflow chip (tour step 10). */
  shipChip: 'ship-chip',
  /** Sidebar "Human review" rail item (tour step 11). */
  humanReview: 'human-review',
} as const;

export const ONBOARDING_STEP_COUNT = 13;

/** Steps rendered as the centered modal card. */
export const ONBOARDING_MODAL_STEPS: ReadonlyArray<number> = [0, 1, 2, 3, 4, 5, 12];
/** Steps rendered as an anchored coachmark over the live UI. */
export const ONBOARDING_COACH_STEPS: ReadonlyArray<number> = [6, 7, 8, 9, 10, 11];
/**
 * The coach steps that are informational POINTERS (the wizard-Configure trio:
 * runtime / permission / model). Unlike the advance-by-doing steps (6, 10, 11)
 * they carry a Next button on the popover and advance via store.next();
 * interacting with the anchored control never advances them.
 */
export const ONBOARDING_POINTER_STEPS: ReadonlyArray<number> = [7, 8, 9];

/**
 * The one CONDITIONAL step: "which agent should be your default?" only has a
 * question to ask when the Connect step left more than one provider activated.
 * The store decides (onboardingStore.isStepSkipped) — this constant just names
 * the index so the numbering helpers below and the store agree on which one it
 * is.
 */
export const ONBOARDING_DEFAULT_RUNTIME_STEP = 2;

/**
 * Progress numbering that EXCLUDES the steps this run skips, so a single-
 * provider install reads "STEP 3 / 12" rather than "STEP 4 / 13" with a dot
 * nobody can reach. Both helpers take the live skipped set (the gate derives it
 * from the store) rather than importing the store, keeping this module neutral.
 */
export function visibleStepTotal(skipped: ReadonlySet<number>): number {
  return ONBOARDING_STEP_COUNT - skipped.size;
}

/** 1-based position of `step` among the steps this run actually shows. */
export function visibleStepNumber(step: number, skipped: ReadonlySet<number>): number {
  let n = 0;
  for (let i = 0; i <= step && i < ONBOARDING_STEP_COUNT; i++) {
    if (!skipped.has(i)) n++;
  }
  // A skipped step is never rendered, but Back/goTo race a toggle change; report
  // the position it would occupy rather than 0.
  return Math.max(n, 1);
}

/**
 * Stable analytics slug per step index (see telemetry `OnboardingStepName`),
 * index-aligned with the tour's step order and ONBOARDING_STEP_COUNT. Used only
 * for the `onboarding_*` usage events — never for control flow.
 *
 * `telemetry` was inserted at index 3 (after Permission, before Add project) and
 * `default_runtime` later at index 2 (after Connect) — each time, every step at
 * or after the insertion point shifted forward by one. Do NOT append new
 * entries at the end without checking whether they belong earlier in the tour's
 * actual order.
 */
export const ONBOARDING_STEP_NAMES: readonly OnboardingStepName[] = [
  'welcome',
  'connect',
  'default_runtime',
  'permission',
  'telemetry',
  'add_project',
  'quick_session',
  'substrate',
  'session_permission',
  'model',
  'ship',
  'human_review',
  'rail_map',
];

/** Step index → analytics slug; out-of-range indices fall back to 'welcome'. */
export function onboardingStepName(step: number): OnboardingStepName {
  return ONBOARDING_STEP_NAMES[step] ?? 'welcome';
}

/**
 * Real-action dispatch helpers — call these at the SUCCESS point of the
 * corresponding launch path (never on error paths). OnboardingGate is the
 * sole listener; these just fire the window CustomEvents it forwards into
 * `useOnboardingStore.realEvent`, so integration call sites never need to
 * import the store directly.
 */
export function notifyQuickSessionCreated(detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENTS.quickSessionCreated, { detail }));
}

export function notifyWorkflowRunStarted(detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENTS.workflowRunStarted, { detail }));
}
