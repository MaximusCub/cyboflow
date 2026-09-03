import { useCallback, useEffect, useRef, useState } from 'react';
import { PROVIDER_DEFAULT_RUNTIME, providerForRuntime } from '../../../../shared/types/agentRuntime';
import type { ProviderDetectionResult } from '../../../../shared/types/onboarding';
import { PROVIDERS_DETECT_CHANNEL } from '../../../../shared/types/onboarding';
import type { Project } from '../../types/project';
import type { IPCResponse } from '../../utils/api';
import { API } from '../../utils/api';
import { useConfigStore } from '../../stores/configStore';
import { useNavigationStore } from '../../stores/navigationStore';
import {
  activatedProviders,
  isNextGateBlocked,
  skippedStepSet,
  useOnboardingStore,
  type OnboardingRealEvent,
  type PersistedOnboarding,
  type PersistedOnboardingV3,
} from '../../stores/onboardingStore';
import { onboardingTelemetryEvents } from '../../stores/onboardingTelemetry';
import { ONBOARDING_EVENTS, ONBOARDING_MODAL_STEPS, ONBOARDING_PREF_KEY } from '../../utils/onboarding';
import { emitTelemetryChangeEvents, trackEvent } from '../../utils/telemetry';
import { OnboardingOverlay } from './OnboardingOverlay';
import { OnboardingModalCard, type PrimaryAction } from './OnboardingModalCard';
import { OnboardingPausedCard } from './OnboardingPausedCard';
import { OnboardingSpiralReveal } from './OnboardingSpiralReveal';
import { revealFraction } from '../../utils/onboardingSpiral';
import { Coachmark } from './Coachmark';
import { WelcomeStep } from './steps/WelcomeStep';
import { ConnectStep } from './steps/ConnectStep';
import { PermissionStep } from './steps/PermissionStep';
import { TelemetryStep, type TelemetryDraft } from './steps/TelemetryStep';
import { AddProjectStep } from './steps/AddProjectStep';
import { DefaultRuntimeStep } from './steps/DefaultRuntimeStep';
import { RailMapStep } from './steps/RailMapStep';

/**
 * OnboardingGate — the single side-effect host around the pure onboardingStore.
 * Owns boot hydration (pref snapshot + project count, gated so nothing renders
 * until resolved — the no-flash rule), snapshot persistence, real-action event
 * forwarding, arrow-key navigation, the step-1 credential probe, the step-6
 * wizard precondition, and the step-2/step-3/step-4/step-5 config/project side
 * effects (default agent runtime, permission mode, telemetry consent,
 * add-project). The store stays synchronously testable; every async lives here.
 *
 * Mounted once, app-wide, from App.tsx. Renders the overlay while the tour is
 * 'active', and the small non-blocking OnboardingPausedCard while 'pending'
 * (waiting on a real-world event). Skipped/completed render nothing — the
 * Sidebar owns the "Resume setup" affordance while skipped.
 */

const MISSING_DETECTION: ProviderDetectionResult<'claude'> = {
  credentials: { found: false, source: null, account: null },
  binary: { found: false, path: null, version: null },
  state: 'missing',
};

const UNAVAILABLE_CODEX_DETECTION: ProviderDetectionResult<'codex'> = {
  runtime: { found: false, path: null, version: null },
  account: { found: false, email: null, planType: null },
  state: 'unavailable',
};

const UNAVAILABLE_OMP_DETECTION: ProviderDetectionResult<'omp'> = {
  binaryPath: null,
  version: null,
  state: 'unavailable',
};

/** Trailing path segment, tolerant of either separator + trailing slashes. */
function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

export function OnboardingGate(): React.JSX.Element | null {
  const hydrated = useOnboardingStore((s) => s.hydrated);
  const status = useOnboardingStore((s) => s.status);
  const step = useOnboardingStore((s) => s.step);
  const maxVisitedStep = useOnboardingStore((s) => s.maxVisitedStep);
  const detection = useOnboardingStore((s) => s.detection);
  const connected = useOnboardingStore((s) => s.connected);
  const codexDetection = useOnboardingStore((s) => s.codexDetection);
  const codexConnected = useOnboardingStore((s) => s.codexConnected);
  const ompDetection = useOnboardingStore((s) => s.ompDetection);
  const ompConnected = useOnboardingStore((s) => s.ompConnected);
  const permMode = useOnboardingStore((s) => s.permMode);
  const defaultProvider = useOnboardingStore((s) => s.defaultProvider);
  const multiRuntime = useOnboardingStore((s) => s.multiRuntime);
  const skippedDoSteps = useOnboardingStore((s) => s.skippedDoSteps);

  const hydrate = useOnboardingStore((s) => s.hydrate);
  const next = useOnboardingStore((s) => s.next);
  const forceNext = useOnboardingStore((s) => s.forceNext);
  const back = useOnboardingStore((s) => s.back);
  const goTo = useOnboardingStore((s) => s.goTo);
  const skip = useOnboardingStore((s) => s.skip);
  const skipStep = useOnboardingStore((s) => s.skipStep);
  const setDetection = useOnboardingStore((s) => s.setDetection);
  const setConnected = useOnboardingStore((s) => s.setConnected);
  const setCodexDetection = useOnboardingStore((s) => s.setCodexDetection);
  const setCodexConnected = useOnboardingStore((s) => s.setCodexConnected);
  const setOmpDetection = useOnboardingStore((s) => s.setOmpDetection);
  const setOmpConnected = useOnboardingStore((s) => s.setOmpConnected);
  const setPermMode = useOnboardingStore((s) => s.setPermMode);
  const setDefaultProvider = useOnboardingStore((s) => s.setDefaultProvider);
  const anchorActioned = useOnboardingStore((s) => s.anchorActioned);
  const realEvent = useOnboardingStore((s) => s.realEvent);

  const [projects, setProjects] = useState<Project[]>([]);
  const [checking, setChecking] = useState(false);
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [busyCreate, setBusyCreate] = useState(false);
  // Step-4 (telemetry) draft, resolved fresh from AppConfig.telemetry every
  // time step 4 is (re-)entered — see the resolve effect below. null = not yet
  // resolved (config not loaded, or step just entered before config's around).
  const [telemetryDraft, setTelemetryDraft] = useState<TelemetryDraft | null>(null);
  const [telemetrySubmitting, setTelemetrySubmitting] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  // Snapshot of the resolved config at step-4 entry — the diff base for which
  // channel(s) actually changed (telemetry_opt_out_changed fires per-changed-
  // channel only, never for an unchanged one).
  const telemetryBaselineRef = useRef<TelemetryDraft | null>(null);

  // Persist the snapshot on any (status, step) change once hydrated. Registered
  // before hydration resolves so the initial idle→active/completed write lands.
  // skippedDoSteps rides along additively (absent when empty, so untouched
  // installs keep writing the exact pre-skipStep shape).
  useEffect(() => {
    return useOnboardingStore.subscribe((state, prev) => {
      if (!state.hydrated || state.status === 'idle') return;
      if (
        state.status === prev.status
        && state.step === prev.step
        && state.skippedDoSteps === prev.skippedDoSteps
      ) return;
      const snapshot: PersistedOnboardingV3 = { version: 3, status: state.status, step: state.step };
      if (state.skippedDoSteps.size > 0) {
        snapshot.skippedDoSteps = [...state.skippedDoSteps].sort((a, b) => a - b);
      }
      void window.electron?.invoke('preferences:set', ONBOARDING_PREF_KEY, JSON.stringify(snapshot));
    });
  }, []);

  // Emit onboarding usage telemetry off the same store transitions. Registered
  // before hydration resolves so the pristine first-run 'started' is caught. The
  // transition→event decision is a pure function (onboardingTelemetry); this shell
  // just fires each result. Every step the user sees emits onboarding_step_viewed.
  useEffect(() => {
    return useOnboardingStore.subscribe((state, prev) => {
      for (const ev of onboardingTelemetryEvents(prev, state)) {
        switch (ev.name) {
          case 'onboarding_started':
            trackEvent('onboarding_started', ev.props);
            break;
          case 'onboarding_step_viewed':
            trackEvent('onboarding_step_viewed', ev.props);
            break;
          case 'onboarding_skipped':
            trackEvent('onboarding_skipped', ev.props);
            break;
          case 'onboarding_resumed':
            trackEvent('onboarding_resumed', ev.props);
            break;
          case 'onboarding_dismissed':
            trackEvent('onboarding_dismissed', ev.props);
            break;
          case 'onboarding_completed':
            trackEvent('onboarding_completed', ev.props);
            break;
        }
      }
    });
  }, []);

  // Boot hydration: parse the pref snapshot + count projects, then resolve the
  // gate. Existing installs (projects > 0, no snapshot) are marked completed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let parsed: PersistedOnboarding | null = null;
      try {
        const raw = (await window.electron?.invoke('preferences:get', ONBOARDING_PREF_KEY)) as
          | IPCResponse<string>
          | undefined;
        if (raw?.success && typeof raw.data === 'string' && raw.data.length > 0) {
          parsed = JSON.parse(raw.data) as PersistedOnboarding;
        }
      } catch {
        parsed = null;
      }
      let list: Project[] = [];
      try {
        const res = await API.projects.getAll();
        if (res.success && Array.isArray(res.data)) list = res.data;
      } catch {
        /* projects unavailable — treat as pristine */
      }
      if (cancelled) return;
      setProjects(list);
      hydrate(parsed, list.length);
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  // E2E boot marker: the tour scrim hydrates asynchronously, so a fixed-timeout
  // probe in the test helpers races it under machine load. 'active' = the scrim
  // is (or is about to be) up; 'resolved' = this boot will not show it.
  useEffect(() => {
    if (!hydrated) return;
    document.body.dataset.onboarding = status === 'active' ? 'active' : 'resolved';
  }, [hydrated, status]);

  // Forward the three real-action window events into the store's coach machine.
  useEffect(() => {
    const forward = (kind: OnboardingRealEvent) => () => realEvent(kind);
    // project-created also keeps the local projects list fresh (step-4 display,
    // step-5 wizard lockProjectId) when the project was created via the normal
    // CreateProjectDialog rather than the tour's own card.
    const onProject = (e: Event): void => {
      const detail = (e as CustomEvent<Project | undefined>).detail;
      if (detail && typeof detail === 'object' && typeof detail.id === 'number') {
        setProjects((prev) => (prev.some((p) => p.id === detail.id) ? prev : [...prev, detail]));
      }
      realEvent('project-created');
    };
    const onQuick = forward('quick-session-created');
    const onRun = forward('workflow-run-started');
    window.addEventListener(ONBOARDING_EVENTS.projectCreated, onProject);
    window.addEventListener(ONBOARDING_EVENTS.quickSessionCreated, onQuick);
    window.addEventListener(ONBOARDING_EVENTS.workflowRunStarted, onRun);
    return () => {
      window.removeEventListener(ONBOARDING_EVENTS.projectCreated, onProject);
      window.removeEventListener(ONBOARDING_EVENTS.quickSessionCreated, onQuick);
      window.removeEventListener(ONBOARDING_EVENTS.workflowRunStarted, onRun);
    };
  }, [realEvent]);

  // The step-1 provider probes. Re-run together on Check again; each failure
  // degrades independently so one provider never hides a usable sibling.
  const runDetect = useCallback(async () => {
    setChecking(true);
    const [claudeResponse, codexResponse, ompResponse] = await Promise.all([
      window.electron?.invoke(PROVIDERS_DETECT_CHANNEL, 'claude').catch(() => undefined) as
        | Promise<IPCResponse<ProviderDetectionResult<'claude'>> | undefined>
        | undefined,
      window.electron?.invoke(PROVIDERS_DETECT_CHANNEL, 'codex').catch(() => undefined) as
        | Promise<IPCResponse<ProviderDetectionResult<'codex'>> | undefined>
        | undefined,
      window.electron?.invoke(PROVIDERS_DETECT_CHANNEL, 'omp').catch(() => undefined) as
        | Promise<IPCResponse<ProviderDetectionResult<'omp'>> | undefined>
        | undefined,
    ]);
    setDetection(
      claudeResponse?.success && claudeResponse.data
        ? claudeResponse.data
        : MISSING_DETECTION,
    );
    setCodexDetection(
      codexResponse?.success && codexResponse.data
        ? codexResponse.data
        : UNAVAILABLE_CODEX_DETECTION,
    );
    setOmpDetection(
      ompResponse?.success && ompResponse.data
        ? ompResponse.data
        : UNAVAILABLE_OMP_DETECTION,
    );
    setChecking(false);
  }, [setCodexDetection, setDetection, setOmpDetection]);

  useEffect(() => {
    if (
      status === 'active'
      && step === 1
      && (detection === null || codexDetection === null || ompDetection === null)
      && !checking
    ) {
      void runDetect();
    }
  }, [status, step, detection, codexDetection, ompDetection, checking, runDetect]);

  // Step-1 toggles reflect the SAVED provider access, so replaying the
  // walkthrough on a configured install opens on the user's current setting
  // rather than a blank slate (and Continue then re-persists it unchanged).
  // A pristine install has no saved value — the toggles stay off and the step
  // gate keeps demanding an explicit opt-in, exactly as before. OMP's floor is
  // the ONE difference: claude/codex default to `true` here (their absent⇒
  // enabled legacy floor), but OMP defaults to `false` — a pristine install
  // must never seed the toggle on for a provider AGENT_PROVIDER_REGISTRY.omp
  // itself floors to disabled.
  const persistedProviderAccess = useConfigStore((s) => s.config?.agentProviderAccess);
  useEffect(() => {
    if (status !== 'active' || step !== 1 || persistedProviderAccess === undefined) return;
    setConnected(persistedProviderAccess.claude ?? true);
    setCodexConnected(persistedProviderAccess.codex ?? true);
    setOmpConnected(persistedProviderAccess.omp ?? false);
  }, [status, step, persistedProviderAccess, setConnected, setCodexConnected, setOmpConnected]);

  // Step-6 precondition: the Quick Session card lives in the wizard, so ensure it
  // is the center surface before the coachmark tries to anchor.
  useEffect(() => {
    if (status !== 'active' || step !== 6) return;
    const nav = useNavigationStore.getState();
    if (nav.view !== 'wizard') {
      nav.goToWizard({ lockProjectId: projects[0]?.id, allowQuick: true });
    }
  }, [status, step, projects]);

  // Step-4 (telemetry) draft resolution. Resolved ONLY from the live
  // AppConfig.telemetry (never a hardcoded true/true guess) every time step 4
  // is (re-)entered — including replay (Settings → Replay walkthrough calls
  // restart(), which re-enters at step 0 and walks back through step 4 fresh).
  // If config hasn't loaded yet, the step stays in its loading state and a
  // config-store subscription resolves the draft the moment it arrives.
  useEffect(() => {
    if (status !== 'active' || step !== 4) return;
    setTelemetryError(null);
    const resolveFromConfig = (): boolean => {
      const cfgTelemetry = useConfigStore.getState().config?.telemetry;
      if (!cfgTelemetry) return false;
      const resolved: TelemetryDraft = {
        errorReportingEnabled: cfgTelemetry.errorReportingEnabled,
        usageMetricsEnabled: cfgTelemetry.usageMetricsEnabled,
      };
      setTelemetryDraft(resolved);
      telemetryBaselineRef.current = resolved;
      return true;
    };
    if (resolveFromConfig()) return;
    setTelemetryDraft(null);
    telemetryBaselineRef.current = null;
    return useConfigStore.subscribe((state, prev) => {
      if (state.config?.telemetry && state.config.telemetry !== prev.config?.telemetry) {
        resolveFromConfig();
      }
    });
  }, [status, step]);

  // Which providers the Connect step left ACTIVATED — the rows step 2 offers and
  // the set its selection must stay inside.
  const activated = activatedProviders({
    detection,
    connected,
    codexDetection,
    codexConnected,
    ompDetection,
    ompConnected,
  });
  // Recomputed each render, so the JSON key (not the array identity) is what the
  // seed effect below depends on.
  const activatedKey = activated.join(',');

  // Step-2 seed: open on the user's SAVED default where there is one (so replay
  // on a configured install shows their current answer rather than a blank
  // slate), else the first activated provider — the step's Next always has
  // something valid to persist, and no row is silently preselected that the
  // Connect step did not activate.
  const persistedDefaultRuntime = useConfigStore((s) => s.config?.defaultAgentRuntime);
  useEffect(() => {
    if (status !== 'active' || step !== 2) return;
    const saved =
      persistedDefaultRuntime === undefined ? null : providerForRuntime(persistedDefaultRuntime);
    const seed = saved !== null && activated.includes(saved) ? saved : (activated[0] ?? null);
    setDefaultProvider(seed);
    // `activated` is rebuilt every render; `activatedKey` is its stable summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on activatedKey, see above
  }, [status, step, activatedKey, persistedDefaultRuntime, setDefaultProvider]);

  const handleInstall = useCallback(() => {
    if (window.electronAPI) void window.electronAPI.openExternal('https://claude.ai/code');
  }, []);

  const handleLocate = useCallback(async () => {
    const res = await API.dialog.openFile();
    if (res.success && typeof res.data === 'string' && res.data) {
      // Via the config STORE (not raw API.config.update) so the renderer's
      // cached config refreshes too — consumers seed from the store.
      await useConfigStore.getState().updateConfig({ claudeExecutablePath: res.data });
      setDetection(null); // re-arms runDetect
    }
  }, [setDetection]);

  const handleBrowse = useCallback(async () => {
    const res = await API.dialog.openDirectory();
    if (res.success && typeof res.data === 'string' && res.data) setPickedPath(res.data);
  }, []);

  const handleAddProject = useCallback(async () => {
    if (!pickedPath || busyCreate) return;
    setBusyCreate(true);
    try {
      const res = await API.projects.create({ name: basename(pickedPath), path: pickedPath, active: false });
      if (res.success && res.data) {
        const created = res.data;
        setProjects((prev) => [...prev, created]);
        // Mirror CreateProjectDialog's broadcast (we bypass that dialog); the
        // gate's own listener advances the tour to step 5. goToWizard matches the
        // app's real post-create flow so the step-5 anchor exists.
        window.dispatchEvent(new CustomEvent(ONBOARDING_EVENTS.projectCreated, { detail: created }));
        useNavigationStore.getState().goToWizard({ lockProjectId: created.id, allowQuick: true });
      }
    } finally {
      setBusyCreate(false);
    }
  }, [pickedPath, busyCreate]);

  // Step-1 provider consent IS the global provider-access setting: Continue
  // persists the two toggles to AppConfig.agentProviderAccess — the exact field
  // Settings → Integrations edits — so a provider the user leaves off here is
  // hidden from every runtime picker and rejected at the launch seams. Same
  // re-entry guard and non-fatal posture as handlePermNext below.
  const connectNextInFlight = useRef(false);
  const handleConnectNext = useCallback(async () => {
    if (connectNextInFlight.current) return;
    connectNextInFlight.current = true;
    try {
      // Full access object, never a partial patch — the step gate guarantees at
      // least one of claude/codex is true, so this can never write an all-off
      // map. `omp` rides along at whatever the (optional, non-gating) toggle is
      // currently set to — false unless the user explicitly opted in.
      //
      // Providers this step has NO toggle for are carried over from what is
      // stored rather than omitted: an absent key floors to that provider's
      // default, which is DISABLED for every post-toggle provider, so listing
      // only the ones with a switch would silently clear an opt-in the user
      // made elsewhere. Onboarding can be re-entered from Settings, so this is
      // not a first-run-only path.
      await useConfigStore.getState().updateConfig({
        agentProviderAccess: {
          ...persistedProviderAccess,
          claude: connected,
          codex: codexConnected,
          omp: ompConnected,
        },
      });
    } catch {
      /* non-fatal — advance regardless; the toggles live on in Settings → Integrations */
    } finally {
      connectNextInFlight.current = false;
    }
    next();
  }, [connected, codexConnected, ompConnected, persistedProviderAccess, next]);

  // Step-2 (default agent) Next: persists the chosen PROVIDER's structured
  // runtime into `AppConfig.defaultAgentRuntime` — the middle rung of
  // resolveRunTypeLaunchDefaults, so it seeds quick sessions and flow runs
  // alike. Via the config STORE so the renderer's cached config refreshes and
  // the wizard's seeded pickers inherit the choice without a restart. Same
  // re-entry guard and non-fatal posture as the handlers around it.
  const defaultRuntimeNextInFlight = useRef(false);
  const handleDefaultRuntimeNext = useCallback(async () => {
    if (defaultRuntimeNextInFlight.current || defaultProvider === null) return;
    defaultRuntimeNextInFlight.current = true;
    try {
      await useConfigStore.getState().updateConfig({
        defaultAgentRuntime: PROVIDER_DEFAULT_RUNTIME[defaultProvider],
      });
    } catch {
      /* non-fatal — advance regardless; the default lives on in Settings → Session settings */
    } finally {
      defaultRuntimeNextInFlight.current = false;
    }
    next();
  }, [defaultProvider, next]);

  // Re-entry guard: the config write is async, so a second activation (held
  // ArrowRight auto-repeat, double-click) while the await is in flight would
  // otherwise call next() twice and blow past step 3's UI-only project gate.
  const permNextInFlight = useRef(false);
  const handlePermNext = useCallback(async () => {
    if (permNextInFlight.current) return;
    permNextInFlight.current = true;
    try {
      // MUST go through the config store: updateConfig persists AND refetches
      // the renderer's cached config, so downstream seeds (the wizard's
      // permission-mode useSeededSelection) inherit the choice without an app
      // restart.
      await useConfigStore.getState().updateConfig({ defaultAgentPermissionMode: permMode });
    } catch {
      /* non-fatal — advance regardless; the pill can be changed in Settings */
    } finally {
      permNextInFlight.current = false;
    }
    next();
  }, [permMode, next]);

  // Re-entry guard mirrors handlePermNext: the config write is async, so a
  // second activation while the first is in flight must not double-persist or
  // double-advance.
  const telemetryNextInFlight = useRef(false);
  const handleTelemetryNext = useCallback(async () => {
    if (telemetryNextInFlight.current || telemetryDraft === null) return;
    telemetryNextInFlight.current = true;
    setTelemetrySubmitting(true);
    setTelemetryError(null);
    try {
      // Full telemetry object, never a partial patch — installId (and the
      // sibling channel) must never be dropped by an update that only meant
      // to change one flag.
      const installId = useConfigStore.getState().config?.telemetry?.installId ?? '';
      const ok = await useConfigStore.getState().updateConfig({
        telemetry: {
          installId,
          errorReportingEnabled: telemetryDraft.errorReportingEnabled,
          usageMetricsEnabled: telemetryDraft.usageMetricsEnabled,
        },
      });
      if (!ok) {
        setTelemetryError(
          useConfigStore.getState().error || 'Could not save your telemetry preferences.',
        );
        return;
      }
      const baseline = telemetryBaselineRef.current;
      if (baseline) emitTelemetryChangeEvents(baseline, telemetryDraft);
      next();
    } finally {
      telemetryNextInFlight.current = false;
      setTelemetrySubmitting(false);
    }
  }, [telemetryDraft, next]);

  const hasProject = projects.length > 0;
  const gateBlocked = isNextGateBlocked({
    step,
    detection,
    connected,
    codexDetection,
    codexConnected,
  });

  let primary: PrimaryAction;
  switch (step) {
    case 1:
      primary = {
        label: 'Continue →',
        disabled: gateBlocked,
        title: 'Connect Claude or Codex to continue',
        onClick: () => void handleConnectNext(),
      };
      break;
    case 2:
      primary = {
        label: 'Next →',
        disabled: defaultProvider === null,
        title: 'Pick the agent new sessions should use',
        onClick: () => void handleDefaultRuntimeNext(),
      };
      break;
    case 3:
      primary = { label: 'Next →', disabled: false, onClick: () => void handlePermNext() };
      break;
    case 4:
      primary = {
        label: 'Next →',
        disabled: telemetryDraft === null || telemetrySubmitting,
        onClick: () => void handleTelemetryNext(),
      };
      break;
    case 5:
      primary = hasProject
        ? { label: 'Next →', disabled: false, onClick: next }
        : { label: 'Add project →', disabled: !pickedPath || busyCreate, onClick: () => void handleAddProject() };
      break;
    case 12:
      primary = { label: 'Finish →', disabled: false, onClick: next };
      break;
    default:
      primary = { label: "Let's go →", disabled: false, onClick: next };
  }

  // Arrow-key nav reads the live primary so ArrowRight honours step gates /
  // config persistence; do-steps have no rendered primary and next() no-ops on
  // them, while pointer steps advance (mirroring their popover Next button).
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  useEffect(() => {
    if (status !== 'active') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return; // held-key auto-repeat must not machine-gun steps
      if (e.key === 'ArrowRight') {
        const p = primaryRef.current;
        if (!p.disabled) p.onClick();
      } else if (e.key === 'ArrowLeft') {
        back();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status, back]);

  if (!hydrated) return null;

  // Parked (status 'pending'): the tour waits on a real-world event —
  // 'quick-session-created' after step 9's Next, 'workflow-run-started' after
  // step 10's /ship click — and realEvent below advances the moment it lands.
  // Render a small non-blocking notice instead of vanishing: an overlay that
  // disappears with no feedback reads as the tour having ended.
  if (status === 'pending') {
    return (
      <OnboardingOverlay>
        <OnboardingPausedCard step={step} onSkip={skip} />
      </OnboardingOverlay>
    );
  }

  if (status !== 'active') return null;

  const isModal = ONBOARDING_MODAL_STEPS.includes(step);
  // The steps this run does NOT show, so the dots and "STEP n / N" counters
  // describe the tour the user actually walks (the conditional step-2 skip plus
  // any do-steps the user explicitly skipped).
  const skippedSteps = skippedStepSet({ multiRuntime, skippedDoSteps });

  const body = ((): React.ReactNode => {
    switch (step) {
      case 0:
        return <WelcomeStep />;
      case 1:
        return (
          <ConnectStep
            claudeDetection={detection}
            claudeConnected={connected}
            codexDetection={codexDetection}
            codexConnected={codexConnected}
            ompDetection={ompDetection}
            ompConnected={ompConnected}
            checking={checking}
            onToggleClaude={() => setConnected(!connected)}
            onToggleCodex={() => setCodexConnected(!codexConnected)}
            onToggleOmp={() => setOmpConnected(!ompConnected)}
            onRecheck={() => void runDetect()}
            onLocate={() => void handleLocate()}
            onInstall={handleInstall}
          />
        );
      case 2:
        return (
          <DefaultRuntimeStep
            providers={activated}
            value={defaultProvider}
            onChange={setDefaultProvider}
          />
        );
      case 3:
        return <PermissionStep value={permMode} onChange={setPermMode} />;
      case 4:
        return (
          <TelemetryStep
            value={telemetryDraft}
            onChange={setTelemetryDraft}
            submitting={telemetrySubmitting}
            error={telemetryError}
          />
        );
      case 5:
        return (
          <AddProjectStep
            hasExistingProject={hasProject}
            firstProjectName={projects[0]?.name ?? null}
            firstProjectPath={projects[0]?.path ?? null}
            pickedPath={pickedPath}
            onBrowse={() => void handleBrowse()}
          />
        );
      case 12:
        return <RailMapStep />;
      default:
        return null;
    }
  })();

  return (
    <OnboardingOverlay>
      {/* Behind the card: the terracotta wrapper the app unwinds out of. Renders
          null once the reveal completes, so coach steps see an untouched app. */}
      <OnboardingSpiralReveal step={step} />
      {isModal ? (
        <OnboardingModalCard
          step={step}
          maxVisitedStep={maxVisitedStep}
          skippedSteps={skippedSteps}
          hero={step === 0}
          primary={primary}
          onBack={back}
          onSkip={skip}
          onGoTo={goTo}
          scrimOpacity={revealFraction(step)}
        >
          {body}
        </OnboardingModalCard>
      ) : (
        <Coachmark
          step={step}
          maxVisitedStep={maxVisitedStep}
          skippedSteps={skippedSteps}
          onBack={back}
          onSkip={skip}
          onSkipStep={skipStep}
          onGoTo={goTo}
          onAnchorActioned={anchorActioned}
          onNext={next}
          onForward={forceNext}
        />
      )}
    </OnboardingOverlay>
  );
}
