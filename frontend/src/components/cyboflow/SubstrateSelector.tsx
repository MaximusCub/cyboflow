/**
 * SubstrateSelector — per-launch agent runtime choice. Claude runtimes still
 * project onto the legacy CLI substrate choice (SDK | Interactive PTY); Codex
 * runtimes are provider/runtime choices and do not carry a substrate value.
 * Controlled (value/onChange), but self-locks to the global PTY-only setting
 * (see below).
 *
 * Substrate is honored on BOTH launch paths:
 *   - Workflow runs: threaded into runs.start as the `substrate` param, stamped
 *     onto workflow_runs.substrate and honored by RunExecutor /
 *     SubstrateDispatchFacade.
 *   - Quick sessions: threaded via useQuickSession.start →
 *     CreateSessionRequest.substrate → sessions.substrate (migration 027);
 *     'interactive' spawns a PTY-backed quick session (persistent claude REPL).
 *
 * Global PTY-only lock: when Settings → AI Integration → CLI runtime is set to
 * "Interactive PTY only" (config.interactivePtyOnly), the SDK is disabled and
 * every run is forced onto the interactive substrate. The authoritative pin is
 * the backend ConfigManager.getForcedSubstrate (consumed in
 * WorkflowRegistry.createRun, above the whole resolver ladder); this component
 * reads the same flag from the config store so the picker stays honest — it
 * renders a read-only locked state and syncs the controlled value to
 * 'interactive' so the launch payload matches what will be stamped. Reading the
 * flag HERE (the single shared picker) locks every consumer at once.
 *
 * Shared by WorkflowPicker (legacy modal) and SessionStartWizard step 3 so the
 * caveats text + lock behavior are single-sourced (no drift). `runtimeScope`
 * narrows by LAUNCH KIND, not by vendor: every structured runtime is launchable
 * for workflows and quick sessions alike, while the terminal runtimes
 * (`codex-pty`, `omp-pty`) stay session-only — the scope test reads
 * `workflowRuntimeForLaunch`, so a runtime joining the launchable set is offered
 * here with no edit.
 */
import { useEffect } from 'react';
import {
  firstEnabledRuntime,
  isRuntimeProviderEnabled,
  isSessionAgentRuntime,
  isWorkflowLaunchableRuntime,
  type AgentProviderAccess,
} from '../../../../shared/types/agentRuntime';
import { isRuntimeSelectableInPickers } from '../../../../shared/types/agentCapabilities';
import { useAgentProviderAccess } from '../../hooks/useAgentProviderAccess';
import { useForcedSubstrate } from '../../hooks/useForcedSubstrate';
import {
  workflowRuntimeForLaunch,
  type LaunchAgentRuntime,
} from './agentRuntimeUi';

/**
 * The v1 limits of the interactive PTY substrate, surfaced when 'interactive' is
 * picked. These are the UNCONDITIONAL caveats — the interactive PreToolUse
 * approval gating DID ship (TASK-810), so the "approval routing unavailable"
 * caveat is intentionally NOT listed.
 */
export const INTERACTIVE_CAVEATS: readonly string[] = [
  'AskUserQuestion is native-TUI-only — multiple-choice questions surface in the terminal, not the structured panel.',
  'Subagent gating is limited — only the main session reports step transitions; subagent tool calls are gated but not separately surfaced.',
  'Streaming is coarser — output arrives at turn-level granularity, not token-level deltas.',
];

/** The v1 limits of the OMP structured (omp-sdk) lane, mirroring INTERACTIVE_CAVEATS' style. */
export const OMP_SDK_CAVEATS: readonly string[] = [
  'Slow approvals (over 25s) are blocked and can be retried.',
];

/** The v1 limits of the OMP terminal (omp-pty) lane. */
export const OMP_PTY_CAVEATS: readonly string[] = [
  'Approvals stay in the OMP terminal — no Cyboflow review-queue integration.',
];

interface SubstrateSelectorProps {
  value: LaunchAgentRuntime;
  onChange: (runtime: LaunchAgentRuntime) => void;
  /** DOM id for the <select> (label association). */
  id?: string;
  /** Heading text above the select. */
  label?: string;
  /** data-testid for the caveats panel (per-surface to keep existing selectors stable). */
  caveatsTestId?: string;
  /** Which launch surface owns the runtime choice. Codex PTY is session-only. */
  runtimeScope?: 'workflow' | 'session' | 'mixed';
}

/** Every runtime this picker knows a row for, in display order. */
const RUNTIME_OPTIONS: readonly { runtime: LaunchAgentRuntime; label: string }[] = [
  { runtime: 'claude-sdk', label: 'Claude SDK (default)' },
  { runtime: 'claude-interactive', label: 'Claude interactive (PTY)' },
  { runtime: 'codex-sdk', label: 'Codex SDK' },
  { runtime: 'codex-pty', label: 'Codex PTY — quick sessions only' },
  { runtime: 'omp-sdk', label: 'OMP' },
  { runtime: 'omp-pty', label: 'OMP terminal' },
];

/**
 * The rows the picker may render at all, before the provider toggles narrow them
 * further. Gated on `RUNTIME_CAPABILITIES.selectableInPickers` rather than on
 * membership of the list above, so a runtime declared ahead of its managers can
 * carry its row and label here from the start and stay invisible until that one
 * flag flips — the alternative is a second list to remember, and a row added to
 * only one of them.
 *
 * Everything downstream (the option list, the disabled-provider fallback, the
 * "some are hidden" note) counts against THIS, never against RUNTIME_OPTIONS.
 */
const SELECTABLE_RUNTIME_OPTIONS = RUNTIME_OPTIONS.filter((o) =>
  isRuntimeSelectableInPickers(o.runtime),
);

/**
 * Scope-level unavailability — rendered as a DISABLED option so the user can
 * see the runtime exists but not here (e.g. Codex PTY on a workflow launch).
 * Provider access is a separate axis: a switched-off provider's runtimes are
 * hidden outright (see enabledRuntimeOptions), because they aren't available
 * anywhere until the toggle goes back on.
 */
function isRuntimeDisabled(runtime: LaunchAgentRuntime, scope: NonNullable<SubstrateSelectorProps['runtimeScope']>): boolean {
  if (scope === 'workflow') return workflowRuntimeForLaunch(runtime) === null;
  if (scope === 'session') return false;
  return false;
}

/** The options a picker may show, given the provider toggles. */
function enabledRuntimeOptions(
  access: AgentProviderAccess,
): readonly { runtime: LaunchAgentRuntime; label: string }[] {
  return SELECTABLE_RUNTIME_OPTIONS.filter((o) => isRuntimeProviderEnabled(access, o.runtime));
}

function scopeHelp(scope: NonNullable<SubstrateSelectorProps['runtimeScope']>): string {
  if (scope === 'workflow') {
    return 'Workflows run on any structured runtime — Claude, Codex SDK, or OMP. The terminal runtimes remain quick-session-only.';
  }
  if (scope === 'session') {
    return 'The structured runtimes run quick-session chat; the terminal runtimes open an interactive terminal-style session instead.';
  }
  return 'A structured runtime can run workflows or quick sessions. The terminal runtimes start quick sessions only.';
}

/** Shared caveats-block rendering — the interactive PTY and both OMP rows use
 *  the same "v1 limits" panel, differing only in title + item list. */
function CaveatsPanel({
  testId,
  title,
  items,
}: {
  testId: string;
  title: string;
  items: readonly string[];
}): React.JSX.Element {
  return (
    <div
      data-testid={testId}
      role="note"
      className="mt-1 rounded-input border border-status-warning bg-bg-secondary px-3 py-2 text-xs text-text-secondary"
    >
      <p className="mb-1 font-semibold text-text-primary">{title}</p>
      <ul className="list-disc space-y-1 pl-4">
        {items.map((caveat) => (
          <li key={caveat}>{caveat}</li>
        ))}
      </ul>
    </div>
  );
}

export function SubstrateSelector({
  value,
  onChange,
  id = 'substrate-select',
  label = 'Agent runtime',
  caveatsTestId = 'substrate-caveats',
  runtimeScope = 'workflow',
}: SubstrateSelectorProps): React.JSX.Element {
  // Global forced-substrate pin (see file header), mirroring the backend
  // precedence: demo → 'sdk', else interactivePtyOnly → 'interactive', else null.
  // Reactive read so a config fetch resolving AFTER mount still locks the picker.
  const forced = useForcedSubstrate();
  // Provider toggles (Settings → Integrations / onboarding). A switched-off
  // provider's runtimes leave the picker entirely and can never be submitted.
  const providerAccess = useAgentProviderAccess();
  const options = enabledRuntimeOptions(providerAccess);
  const claudeEnabled = isRuntimeProviderEnabled(providerAccess, 'claude-sdk');

  // Under the interactive lock, keep the controlled value consistent so the
  // launch payload matches the backend pin. Scoped to 'interactive' only: demo's
  // 'sdk' pin is left alone so demo's picker behaves as before (cosmetic — the
  // backend forces 'sdk' regardless). After value reaches 'interactive' the
  // guard stops re-firing (safe with an unstable onChange identity).
  // Skipped when Claude is switched off — the lock names a Claude runtime, so
  // forcing the value there would hand the launch seam a provider it rejects;
  // the conflict is surfaced in the locked branch below instead.
  useEffect(() => {
    if (forced === 'interactive' && claudeEnabled && value !== 'claude-interactive') {
      onChange('claude-interactive');
    }
  }, [forced, claudeEnabled, value, onChange]);

  // Snap a selection whose provider was switched off (e.g. the user disabled
  // Codex in Settings while a Codex runtime sat in this picker) back to the
  // first still-available runtime, so the rendered value and the launch payload
  // always name a provider the backend will accept.
  const fallbackRuntime = firstEnabledRuntime(
    providerAccess,
    SELECTABLE_RUNTIME_OPTIONS.filter((o) => !isRuntimeDisabled(o.runtime, runtimeScope)).map(
      (o) => o.runtime,
    ),
  );
  useEffect(() => {
    if (isRuntimeProviderEnabled(providerAccess, value)) return;
    if (fallbackRuntime !== null && fallbackRuntime !== value) onChange(fallbackRuntime);
  }, [providerAccess, value, fallbackRuntime, onChange]);

  // Only the user-facing interactive lock gets the read-only locked UI. Demo
  // mode also pins ('sdk'), but it is a throwaway showcase profile — leave the
  // normal select so demo never falsely renders "Interactive (PTY) — locked".
  if (forced === 'interactive' && !claudeEnabled) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        <div
          data-testid="substrate-provider-conflict"
          role="alert"
          className="w-full rounded-input border border-status-error bg-bg-secondary px-2 py-1 text-sm text-text-secondary"
        >
          No runtime available
        </div>
        <p className="text-xs text-text-tertiary">
          This app is locked to interactive-PTY-only mode, which runs on Claude — but Claude is
          turned off in Settings → Integrations. Enable Claude, or lift the PTY-only lock, to launch.
        </p>
      </div>
    );
  }

  if (forced === 'interactive') {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        <div
          data-testid="substrate-locked"
          aria-label="Agent runtime locked to Claude interactive PTY"
          className="w-full rounded-input border border-border-primary bg-bg-secondary px-2 py-1 text-sm text-text-secondary"
        >
          Claude interactive (PTY) — locked
        </div>
        <p className="text-xs text-text-tertiary">
          Claude SDK is disabled globally (Settings → AI Integration → CLI runtime). Every run uses
          the interactive PTY runtime.
        </p>
        <CaveatsPanel testId={caveatsTestId} title="Interactive substrate — v1 limits" items={INTERACTIVE_CAVEATS} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (
            (isSessionAgentRuntime(next) || isWorkflowLaunchableRuntime(next)) &&
            !isRuntimeDisabled(next, runtimeScope) &&
            isRuntimeProviderEnabled(providerAccess, next)
          ) {
            onChange(next);
          }
        }}
        className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
        aria-label="Select agent runtime"
      >
        {options.map(({ runtime, label: optionLabel }) => (
          <option
            key={runtime}
            value={runtime}
            disabled={isRuntimeDisabled(runtime, runtimeScope)}
          >
            {optionLabel}
          </option>
        ))}
      </select>
      <p className="text-xs text-text-tertiary">
        {options.length === SELECTABLE_RUNTIME_OPTIONS.length
          ? scopeHelp(runtimeScope)
          : `${scopeHelp(runtimeScope)} Runtimes for providers turned off in Settings → Integrations are hidden.`}
      </p>

      {value === 'claude-interactive' && (
        <CaveatsPanel testId={caveatsTestId} title="Interactive substrate — v1 limits" items={INTERACTIVE_CAVEATS} />
      )}
      {value === 'omp-sdk' && (
        <CaveatsPanel testId={caveatsTestId} title="OMP — v1 limits" items={OMP_SDK_CAVEATS} />
      )}
      {value === 'omp-pty' && (
        <CaveatsPanel testId={caveatsTestId} title="OMP terminal — v1 limits" items={OMP_PTY_CAVEATS} />
      )}
    </div>
  );
}
