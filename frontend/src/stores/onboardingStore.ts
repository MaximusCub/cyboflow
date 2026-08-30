import { create } from 'zustand';
import type { AgentProvider } from '../../../shared/types/agentRuntime';
import type { ProviderDetectionResult } from '../../../shared/types/onboarding';
import type { PermissionMode } from '../../../shared/types/workflows';
import {
  ONBOARDING_COACH_STEPS,
  ONBOARDING_DEFAULT_RUNTIME_STEP,
  ONBOARDING_POINTER_STEPS,
  ONBOARDING_STEP_COUNT,
} from '../utils/onboarding';

/**
 * onboardingStore — the 13-step first-run tour's state machine.
 *
 * Steps: 0 welcome · 1 connect an agent provider (the only gated step) · 2 default agent
 * (CONDITIONAL — shown only when step 1 left 2+ providers activated) · 3 permission
 * mode · 4 telemetry consent · 5 add project · 6 quick-session coachmark (wizard Quick
 * Session card) · 7-9 wizard-Configure pointers (runtime / session permission / model) ·
 * 10 /ship coachmark (session canvas chip) · 11 Human-review coachmark ·
 * 12 rail map.
 *
 * The machine is PURE — all persistence (user_preferences JSON snapshot),
 * detection fetches, window-event subscriptions, keyboard handling, and
 * precondition navigation (ensuring the wizard is open when step 6 begins)
 * live in components/onboarding/OnboardingGate. Keep it that way: every
 * transition here must stay synchronously testable.
 *
 * Advancement rules (the tour is completed by DOING, not clicking through):
 * - Modal steps (0,1,2,3,4,5,12) advance via next(); step 1 refuses until the
 *   Claude or Codex probe says 'detected' AND its consent toggle is on; step 5
 *   normally advances via the real 'project-created' event (its primary
 *   button creates the project), falling back to next() when projects
 *   already exist (replay / resumed installs). Step 4 (telemetry) advances
 *   like any other modal step via next() — the actual consent UI is owned by
 *   its own step component, not this store.
 * - Step 2 (default agent) is the one CONDITIONAL step: it only has a question
 *   to ask when step 1 left more than one provider activated, so next()/back()/
 *   forceNext() step OVER it otherwise (see isStepSkipped) and goTo() refuses to
 *   land on it. The decision is recomputed on every departure from step 1, so
 *   flipping a second provider on and pressing Continue brings the step back.
 * - Pointer steps (7-9, the Configure trio) are informational: they advance
 *   via next() (the popover's Next button); interacting with the anchored
 *   control never advances them. Next on the LAST pointer (9) parks 'pending'
 *   — the next tour beat (the /ship chip) only exists once the session
 *   launches, and 'quick-session-created' fires from ANY of steps 6-9 (the
 *   user may hit Start before Next-ing through every pointer), landing 10.
 * - Do-steps advance ONLY via the real action: step 6's card click flips the
 *   wizard to Configure where step 7's anchor mounts, so it advances directly;
 *   step 10's /ship click parks 'pending' while the idea modal runs and
 *   'workflow-run-started' lands 11; step 11 advances directly on its click.
 * - Dots/keyboard may only revisit steps already reached (maxVisitedStep),
 *   so neither can bypass the step-1 gate or the coach preconditions.
 * - forceNext() is the anchor-lost escape (see its interface doc): the only way
 *   to move a do-step forward when its target has unmounted.
 * - skipStep() is the deliberate per-step escape (see its interface doc): it
 *   records a do-step (6/10/11) as skipped and advances past it, without
 *   abandoning the rest of the tour the way skip() does.
 */

export type OnboardingStatus = 'idle' | 'active' | 'pending' | 'skipped' | 'completed';

/** Real-world signals the coach steps wait on (see utils/onboarding.ts events). */
export type OnboardingRealEvent = 'project-created' | 'quick-session-created' | 'workflow-run-started';

/** JSON shape persisted under ONBOARDING_PREF_KEY — version 1 (pre-Telemetry-step). */
export interface PersistedOnboardingV1 {
  version: 1;
  status: Exclude<OnboardingStatus, 'idle'>;
  step: number;
}

/**
 * JSON shape persisted under ONBOARDING_PREF_KEY — version 2. Same shape as
 * v1; only the step-index semantics changed (the Telemetry step's insertion
 * at index 3 shifted every step from the old index 3 onward forward by one).
 * See migratePersistedOnboarding.
 */
export interface PersistedOnboardingV2 {
  version: 2;
  status: Exclude<OnboardingStatus, 'idle'>;
  step: number;
}

/**
 * JSON shape persisted under ONBOARDING_PREF_KEY — version 3. Same shape again;
 * the Default-agent step's insertion at index 2 (after Connect) shifted every
 * step from the old index 2 onward forward by one. The user's ANSWER is not
 * persisted here — it goes straight to `AppConfig.defaultAgentRuntime`, the
 * field every launch already resolves through.
 *
 * `skippedDoSteps` is an ADDITIVE optional field (no version bump — absent in
 * older snapshots and treated as empty): the do-steps the user explicitly
 * skipped this run, persisted so hydrate never re-offers a declined step.
 */
export interface PersistedOnboardingV3 {
  version: 3;
  status: Exclude<OnboardingStatus, 'idle'>;
  step: number;
  skippedDoSteps?: number[];
}

/** JSON shape persisted under ONBOARDING_PREF_KEY (any schema version). */
export type PersistedOnboarding =
  | PersistedOnboardingV1
  | PersistedOnboardingV2
  | PersistedOnboardingV3;

/**
 * Version-1 → version-2 step-index remap: the Telemetry step was inserted at
 * index 3 (after Permission, before Add project), so every old step at or
 * after index 3 now lives one index higher.
 */
export function migrateV1StepIndex(step: number): number {
  return step >= 3 ? step + 1 : step;
}

/**
 * Version-2 → version-3 step-index remap: the Default-agent step was inserted at
 * index 2 (after Connect), so every v2 step at or after index 2 lives one index
 * higher. Composed AFTER migrateV1StepIndex for a v1 snapshot — a v1 index has
 * to become a v2 index before this remap means anything.
 */
export function migrateV2StepIndex(step: number): number {
  return step >= ONBOARDING_DEFAULT_RUNTIME_STEP ? step + 1 : step;
}

/**
 * Normalizes a persisted snapshot to the current (version 3) shape.
 * - version 3 snapshots pass through unchanged (already-current schema).
 * - snapshots with status 'completed' keep their step as-is — a completed
 *   onboarding's step index carries no further navigational meaning (hydrate
 *   short-circuits on status alone), so remapping it would be a no-op at best
 *   and is skipped entirely to avoid ever "breaking" a completed snapshot.
 * - older snapshots in any other status are walked forward one version at a
 *   time (v1 → v2 → v3) before the store ever sees them.
 */
export function migratePersistedOnboarding(persisted: PersistedOnboarding): PersistedOnboardingV3 {
  if (persisted.version === 3) return persisted;
  if (persisted.status === 'completed') {
    return { version: 3, status: 'completed', step: persisted.step };
  }
  const v2Step = persisted.version === 1 ? migrateV1StepIndex(persisted.step) : persisted.step;
  return { version: 3, status: persisted.status, step: migrateV2StepIndex(v2Step) };
}

/**
 * Boot clamp for a restart mid-tour: coach steps whose real-world context is
 * gone resume at the nearest step that can rebuild it. Steps 7-9 anchor the
 * wizard's Configure page and step 10 the session canvas — neither survives a
 * restart — so they re-run step 6, which rebuilds its own precondition (the
 * gate reopens the wizard). Step 11's rail anchor always exists.
 */
export function clampResumeStep(step: number): number {
  if (step >= 7 && step <= 10) return 6;
  return Math.min(Math.max(step, 0), ONBOARDING_STEP_COUNT - 1);
}

/**
 * The step resume() will actually land on from `step`: steps 7-9 rewind to 6
 * when their anchors are missing, otherwise the step is kept. Shared by
 * resume() and the Sidebar's "Resume setup" label, so the button can never
 * advertise a step a rewind won't land on. A user-skipped step is never
 * re-offered: a rewind whose target (6) is itself skipped walks past the
 * wizard pointers to the first non-skipped step (10/11 or the final modal
 * card, which is never skippable).
 */
export function resumeLandingStep(
  step: number,
  wizardAnchorsMissing: boolean,
  skippedDoSteps: ReadonlySet<number> = new Set<number>(),
): number {
  if (step >= 7 && step <= 9 && wizardAnchorsMissing) {
    if (!skippedDoSteps.has(6)) return 6;
    for (let i = 10; i < ONBOARDING_STEP_COUNT; i++) {
      if (!skippedDoSteps.has(i)) return i;
    }
    return ONBOARDING_STEP_COUNT - 1;
  }
  return step;
}

interface OnboardingState {
  status: OnboardingStatus;
  /** Current step, 0..12 — meaningful whenever status !== 'idle'. */
  step: number;
  /** Highest step ever reached this run; dots/goTo may only jump ≤ this. */
  maxVisitedStep: number;
  /** True when launched from Settings → Replay walkthrough (step 5 shows the existing-project state). */
  replay: boolean;
  /** Latest providers:detect('claude') result; null = probe not yet run (step 1 shows loading). */
  detection: ProviderDetectionResult<'claude'> | null;
  /** Step-1 consent toggle ("use this install for every session"). */
  connected: boolean;
  /** Latest providers:detect('codex') result; null = probe not yet run. */
  codexDetection: ProviderDetectionResult<'codex'> | null;
  /** Step-1 consent toggle for the ChatGPT-authenticated Codex runtime. */
  codexConnected: boolean;
  /**
   * Latest providers:detect('omp') result; null = probe not yet run. OMP is an
   * OPTIONAL row on step 1 — unlike claude/codex it never participates in
   * isNextGateBlocked, since its runtimes are not yet offered by any picker
   * (RUNTIME_CAPABILITIES.selectableInPickers), so "connected" here means only
   * "the provider-access toggle will be turned on", not "ready to launch".
   */
  ompDetection: ProviderDetectionResult<'omp'> | null;
  /**
   * Step-1 consent toggle for OMP. Defaults false and STAYS false unless the
   * user explicitly opts in — mirrors AGENT_PROVIDER_REGISTRY.omp.defaultEnabled
   * (absent access-map key floors to disabled for OMP, unlike claude/codex) so
   * onboarding never turns a provider on that a fresh install would otherwise
   * leave off.
   */
  ompConnected: boolean;
  /** Step-3 selection; 'auto' preselected per design, persisted to config on step-3 next(). */
  permMode: PermissionMode;
  /**
   * Step-2 selection — which ACTIVATED provider new sessions should default to.
   * null = not yet resolved (the gate seeds it from the persisted
   * `defaultAgentRuntime`, else the first activated provider, on entry).
   */
  defaultProvider: AgentProvider | null;
  /**
   * Whether step 2 (default agent) is part of THIS run of the tour. Recomputed
   * every time the user leaves the Connect step: the question only exists when
   * more than one provider came out of it activated. Starts true so the early
   * steps show the full tour and the count only ever shrinks on an explicit
   * action, never mid-probe.
   */
  multiRuntime: boolean;
  /** Boot gate resolved — render nothing until true (no-flash rule, docs/CODE-PATTERNS.md). */
  hydrated: boolean;
  /**
   * Do-steps (6/10/11) the user explicitly skipped this run — folded into
   * isStepSkipped/skippedStepSet so every navigation path steps over them.
   * Cleared by begin(); persisted additively (see
   * PersistedOnboardingV3.skippedDoSteps).
   */
  skippedDoSteps: ReadonlySet<number>;

  /**
   * Resolve the boot gate. `persisted` is the parsed pref snapshot (null on a
   * pristine install); `projectsCount` decides the pristine branch: existing
   * installs (projects > 0) are marked completed without ever seeing the tour.
   */
  hydrate: (persisted: PersistedOnboarding | null, projectsCount: number) => void;
  /** Start (or restart) the tour at step 0. */
  begin: (replay: boolean) => void;
  next: () => void;
  /**
   * Anchor-lost escape: force a plain step+1 advance, bypassing the
   * advance-by-doing guard. Wired ONLY to the Coachmark's anchor-lost fallback —
   * a do-step (6/10/11) whose target has unmounted (e.g. Back into step 6 after the
   * wizard left the Quick Session card) has no other way forward, since next()
   * no-ops on do-steps.
   */
  forceNext: () => void;
  back: () => void;
  /** Dot navigation — only to steps already visited. */
  goTo: (step: number) => void;
  skip: () => void;
  /**
   * Per-step escape for the advance-by-doing steps (6/10/11): records the
   * current step as skipped (same mechanism as the conditional step-2 skip —
   * see isStepSkipped) and advances like forceNext(). Never parks pending —
   * a skip has no wait left in it. No-op on every other step (pointers have
   * Next; modal steps are plain next()-steps) and when not active.
   */
  skipStep: () => void;
  /**
   * Skipped/pending → active at the current (clamped) step.
   *
   * `wizardAnchorsMissing` — the Sidebar "Resume setup" caller reports
   * whether the wizard-Configure anchors (steps 7-9's targets) are still
   * mounted. Absent (the default): steps 7-9 rewind to 6. Alive: the step is
   * kept — rewinding would yank the user off live, on-screen anchors back to
   * a step they already passed. A user-skipped step is never re-offered: a
   * rewind whose target (6) is skipped lands past the pointers instead.
   */
  resume: (options?: { wizardAnchorsMissing?: boolean }) => void;
  /**
   * Permanent dismiss from the Sidebar "Resume setup" card: skipped/pending →
   * completed. Unlike skip() (which leaves the resume affordance standing),
   * dismiss() closes the tour for good — the completed snapshot persists, so it
   * never reappears on future boots. Recoverable only via Settings → Replay
   * walkthrough (restart()).
   */
  dismiss: () => void;
  finish: () => void;
  /** Settings → Replay walkthrough. */
  restart: () => void;
  setDetection: (result: ProviderDetectionResult<'claude'> | null) => void;
  setConnected: (connected: boolean) => void;
  setCodexDetection: (result: ProviderDetectionResult<'codex'> | null) => void;
  setCodexConnected: (connected: boolean) => void;
  setOmpDetection: (result: ProviderDetectionResult<'omp'> | null) => void;
  setOmpConnected: (connected: boolean) => void;
  setPermMode: (mode: PermissionMode) => void;
  setDefaultProvider: (provider: AgentProvider | null) => void;
  /** The user clicked the highlighted coachmark target (capture-phase listener). */
  anchorActioned: () => void;
  /** A real-action window event landed (OnboardingGate forwards them here). */
  realEvent: (kind: OnboardingRealEvent) => void;
}

/** Step 1 refuses to advance until the probe is green and consent is given. */
export function isNextGateBlocked(
  state: Pick<
    OnboardingState,
    'step' | 'detection' | 'connected' | 'codexDetection' | 'codexConnected'
  >,
): boolean {
  if (state.step !== 1) return false;
  const claudeReady = state.detection?.state === 'detected' && state.connected;
  const codexReady = state.codexDetection?.state === 'detected' && state.codexConnected;
  return !claudeReady && !codexReady;
}

/**
 * The providers the Connect step left ACTIVATED — probe green AND consent
 * toggle on. Deliberately stricter than the access map the step persists (which
 * carries the raw toggle): a provider whose binary vanished since the last run
 * seeds its toggle back on from config but is not something we should offer as
 * "your default agent". Returned in AGENT_PROVIDERS order so the step's rows and
 * the fallback selection agree.
 */
export function activatedProviders(
  state: Pick<
    OnboardingState,
    | 'detection'
    | 'connected'
    | 'codexDetection'
    | 'codexConnected'
    | 'ompDetection'
    | 'ompConnected'
  >,
): AgentProvider[] {
  const out: AgentProvider[] = [];
  if (state.detection?.state === 'detected' && state.connected) out.push('claude');
  if (state.codexDetection?.state === 'detected' && state.codexConnected) out.push('codex');
  if (state.ompDetection?.state === 'detected' && state.ompConnected) out.push('omp');
  return out;
}

/**
 * Whether `step` is skipped for this run. Two sources feed the ONE mechanism
 * (no parallel skip state):
 * - the conditional Default-agent step (2): a single activated provider leaves
 *   it with no question to ask, so every navigation path steps over it;
 * - do-steps (6/10/11) the user explicitly skipped with "Skip step"
 *   (`skippedDoSteps`). Both make every navigation path step over the step and
 *   drop it from the progress numbering and dots.
 */
export function isStepSkipped(
  step: number,
  state: Pick<OnboardingState, 'multiRuntime' | 'skippedDoSteps'>,
): boolean {
  if (step === ONBOARDING_DEFAULT_RUNTIME_STEP && !state.multiRuntime) return true;
  return state.skippedDoSteps.has(step);
}

// Stable identities: the gate feeds these straight into React props, so a fresh
// Set per render would re-run every memo downstream.
const EMPTY_SKIPPED: ReadonlySet<number> = new Set<number>();
const DEFAULT_RUNTIME_SKIPPED: ReadonlySet<number> = new Set([ONBOARDING_DEFAULT_RUNTIME_STEP]);

// Identity-stable merge of the derived Default-agent skip with the user-skipped
// do-steps. The inputs only ever change identity on skipStep/hydrate/begin, so
// keying the cache on them keeps the merged output stable between those events
// (same no-fresh-Set-per-render rule as above).
let mergedSkippedCache: {
  base: ReadonlySet<number>;
  user: ReadonlySet<number>;
  merged: ReadonlySet<number>;
} | null = null;

/** The set of skipped indices, for the progress-numbering helpers. */
export function skippedStepSet(
  state: Pick<OnboardingState, 'multiRuntime' | 'skippedDoSteps'>,
): ReadonlySet<number> {
  // multiRuntime TRUE means step 2 is part of this run → nothing derived to skip.
  if (state.skippedDoSteps.size === 0) {
    return state.multiRuntime ? EMPTY_SKIPPED : DEFAULT_RUNTIME_SKIPPED;
  }
  const base = state.multiRuntime ? EMPTY_SKIPPED : DEFAULT_RUNTIME_SKIPPED;
  const cached = mergedSkippedCache;
  if (cached && cached.base === base && cached.user === state.skippedDoSteps) return cached.merged;
  const merged = new Set([...base, ...state.skippedDoSteps]);
  mergedSkippedCache = { base, user: state.skippedDoSteps, merged };
  return merged;
}

/**
 * The next/previous index that is not skipped, or null when the walk runs off
 * the end of the tour. `dir` is +1 or -1.
 */
function stepAfter(
  step: number,
  dir: 1 | -1,
  state: Pick<OnboardingState, 'multiRuntime' | 'skippedDoSteps'>,
): number | null {
  for (let i = step + dir; i >= 0 && i < ONBOARDING_STEP_COUNT; i += dir) {
    if (!isStepSkipped(i, state)) return i;
  }
  return null;
}

/** Advance-by-doing coach steps (6, 10, 11) — coach steps that are NOT pointers. */
const isDoStep = (step: number): boolean =>
  ONBOARDING_COACH_STEPS.includes(step) && !ONBOARDING_POINTER_STEPS.includes(step);

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
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
  skippedDoSteps: EMPTY_SKIPPED,

  hydrate: (persisted, projectsCount) => {
    if (persisted === null) {
      if (projectsCount > 0) {
        // Existing install upgrading into the feature — never show the tour.
        set({ status: 'completed', hydrated: true });
      } else {
        set({
          status: 'active',
          step: 0,
          maxVisitedStep: 0,
          replay: false,
          hydrated: true,
          skippedDoSteps: EMPTY_SKIPPED,
        });
      }
      return;
    }
    const migrated = migratePersistedOnboarding(persisted);
    if (migrated.status === 'completed') {
      set({ status: 'completed', hydrated: true });
      return;
    }
    // Any mid-tour state (active/pending/skipped) resumes as skipped — the
    // rail's Resume button re-enters at the clamped step, letting the gate
    // rebuild coach preconditions instead of dropping a coachmark on a stale
    // anchor. Explicit "Skip step" decisions ride along additively (absent in
    // older snapshots → empty): a step the user already declined must not
    // reappear after a restart.
    const step = clampResumeStep(migrated.step);
    set({
      status: 'skipped',
      step,
      maxVisitedStep: step,
      replay: false,
      hydrated: true,
      skippedDoSteps: new Set(migrated.skippedDoSteps ?? []),
    });
  },

  begin: (replay) => set({
    status: 'active',
    step: 0,
    maxVisitedStep: 0,
    replay,
    connected: false,
    detection: null,
    codexConnected: false,
    codexDetection: null,
    ompConnected: false,
    ompDetection: null,
    permMode: 'auto',
    defaultProvider: null,
    multiRuntime: true,
    hydrated: true,
    skippedDoSteps: EMPTY_SKIPPED,
  }),

  next: () => {
    const s = get();
    if (s.status !== 'active') return;
    if (isDoStep(s.step)) return; // do-steps advance by doing, never by next()
    if (isNextGateBlocked(s)) return;
    // Next on the last Configure pointer parks quiet: step 10's anchor (the
    // /ship chip) only exists once the session launches, so the tour waits for
    // 'quick-session-created' — unless the session already exists (revisiting
    // via dots/Back), where a plain advance is safe.
    if (s.step === 9 && s.maxVisitedStep < 10) {
      set({ status: 'pending' });
      return;
    }
    // Leaving Connect re-decides whether the conditional Default-agent step is
    // part of this run — it must be settled BEFORE the walk below picks a
    // target, or a user who just enabled a second provider would be stepped
    // straight over the question they now qualify for.
    const multiRuntime =
      s.step === 1 ? activatedProviders(s).length >= 2 : s.multiRuntime;
    const step = stepAfter(s.step, 1, { multiRuntime, skippedDoSteps: s.skippedDoSteps });
    if (step === null) {
      set({ multiRuntime, status: 'completed' });
      return;
    }
    set({ multiRuntime, step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
  },

  forceNext: () => {
    const s = get();
    if (s.status !== 'active') return;
    if (isNextGateBlocked(s)) return; // defensive — coach steps are never the step-1 gate
    const step = stepAfter(s.step, 1, s);
    if (step === null) {
      set({ status: 'completed' });
      return;
    }
    set({ step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
  },

  back: () => {
    const s = get();
    if (s.status !== 'active') return;
    set({ step: stepAfter(s.step, -1, s) ?? 0 });
  },

  goTo: (step) => {
    const s = get();
    if (s.status !== 'active') return;
    if (step < 0 || step > s.maxVisitedStep || step === s.step) return;
    if (isStepSkipped(step, s)) return; // a dot the tour never renders
    set({ step });
  },

  skip: () => {
    const s = get();
    if (s.status !== 'active' && s.status !== 'pending') return;
    set({ status: 'skipped' });
  },

  skipStep: () => {
    const s = get();
    if (s.status !== 'active' || !isDoStep(s.step)) return;
    const skippedDoSteps = new Set(s.skippedDoSteps);
    skippedDoSteps.add(s.step);
    // A skip means "move on" — advance like forceNext with the step recorded as
    // skipped, so every later navigation path (next/back/goTo/dots/numbering)
    // steps over it for the rest of this run. Never parks pending: step 10's
    // NORMAL advance waits for 'workflow-run-started', but a skipped step has no
    // wait left in it.
    const step = stepAfter(s.step, 1, { multiRuntime: s.multiRuntime, skippedDoSteps });
    if (step === null) {
      set({ skippedDoSteps, status: 'completed' });
      return;
    }
    set({ skippedDoSteps, step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
  },

  resume: (options) => {
    const s = get();
    if (s.status !== 'skipped' && s.status !== 'pending') return;
    // The Sidebar "Resume setup" button is the only caller. With the anchors
    // MISSING (the cold re-entry after the wizard closed), rebuild like the
    // boot path: fall back to step 6 (its precondition reopens the wizard) and
    // reset maxVisited so dots can't jump straight back onto the still-missing
    // anchors. With them ALIVE, keep the step: rewinding would yank the user
    // off live, on-screen targets they already passed. Steps outside 7-9 always
    // keep their step (10-11 have the /ship Continue escape and the
    // always-present rail anchor; modal steps never disconnect).
    const landing = resumeLandingStep(s.step, options?.wizardAnchorsMissing ?? true, s.skippedDoSteps);
    if (landing !== s.step) {
      // Landing 6 resets maxVisited so dots can't offer the still-missing
      // anchors; a skipped-6 landing (10-12) keeps maxVisited current instead —
      // the same exposure the 10-11 keep-branch already accepts.
      set({
        status: 'active',
        step: landing,
        maxVisitedStep: landing === 6 ? 6 : Math.max(s.maxVisitedStep, landing),
      });
      return;
    }
    set({ status: 'active', step: s.step });
  },

  dismiss: () => {
    const s = get();
    if (s.status !== 'skipped' && s.status !== 'pending') return;
    // Keep the step so the persisted snapshot + telemetry record where the user
    // walked away; completed short-circuits hydrate regardless of step.
    set({ status: 'completed' });
  },

  finish: () => set({ status: 'completed' }),

  restart: () => get().begin(true),

  setDetection: (detection) => set({ detection }),
  setConnected: (connected) => set({ connected }),
  setCodexDetection: (codexDetection) => set({ codexDetection }),
  setCodexConnected: (codexConnected) => set({ codexConnected }),
  setOmpDetection: (ompDetection) => set({ ompDetection }),
  setOmpConnected: (ompConnected) => set({ ompConnected }),
  setPermMode: (permMode) => set({ permMode }),
  setDefaultProvider: (defaultProvider) => set({ defaultProvider }),

  anchorActioned: () => {
    const s = get();
    if (s.status !== 'active' || !isDoStep(s.step)) return;
    if (s.step === 6) {
      // The card click flips the wizard to Configure, where step 7's anchor
      // (the runtime selector) mounts — advance directly.
      set({ step: 7, maxVisitedStep: Math.max(s.maxVisitedStep, 7) });
      return;
    }
    if (s.step === 11) {
      // Human review opens immediately on the click — straight to the rail map.
      set({ step: 12, maxVisitedStep: Math.max(s.maxVisitedStep, 12) });
      return;
    }
    // Step 10: the /ship click hands control to the idea modal; the overlay
    // goes quiet until 'workflow-run-started' lands.
    set({ status: 'pending' });
  },

  realEvent: (kind) => {
    const s = get();
    if (s.status !== 'active' && s.status !== 'pending') return;
    const advanceTo = (step: number): void =>
      set({ status: 'active', step, maxVisitedStep: Math.max(s.maxVisitedStep, step) });
    if (kind === 'project-created' && s.step === 5) advanceTo(6);
    // The launch may fire from ANY Configure-page step — the user can hit
    // Start quick session before Next-ing through every pointer.
    else if (kind === 'quick-session-created' && s.step >= 6 && s.step <= 9) advanceTo(10);
    else if (kind === 'workflow-run-started' && s.step === 10) advanceTo(11);
  },
}));
