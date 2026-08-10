import { FileText, FolderOpen, ShieldCheck, SlidersHorizontal, Terminal, Zap } from 'lucide-react';
import { Checkbox, Textarea } from '../ui/Input';
import { CollapsibleCard } from '../ui/CollapsibleCard';
import { SettingsSection } from '../ui/SettingsSection';
import { PERMISSION_MODE_OPTIONS } from '../cyboflow/AgentPermissionModeSelector';
import { RunTypeOverridesSection } from './RunTypeOverridesSection';
import { trackEvent } from '../../utils/telemetry';
import type { ExecutionModel } from '../../../../shared/types/executionModel';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { PermissionMode } from '../../../../shared/types/workflows';
import type { QuickSessionWorktreeMode } from '../../../../shared/types/worktreeMode';

/**
 * The AI tab's "Session settings" group — the knobs that answer *what does a new
 * session or run start with*, as opposed to the "Feature controls" group's *is
 * this capability available at all*.
 *
 * Props-in / callback-out only: every value still lives as lifted state in
 * `Settings.tsx` and is persisted by the shared `handleSubmit` there, so this is
 * a presentation container, not a self-fetching panel like `IntegrationsSettings`.
 */
export interface SessionSettingsProps {
  globalSystemPrompt: string;
  onGlobalSystemPromptChange: (prompt: string) => void;
  defaultAgentPermissionMode: PermissionMode;
  onDefaultAgentPermissionModeChange: (mode: PermissionMode) => void;
  defaultExecutionModel: ExecutionModel;
  onDefaultExecutionModelChange: (model: ExecutionModel) => void;
  quickSessionWorktreeMode: QuickSessionWorktreeMode;
  onQuickSessionWorktreeModeChange: (mode: QuickSessionWorktreeMode) => void;
  quickSessionDefaultSubstrate: CliSubstrate;
  onQuickSessionDefaultSubstrateChange: (substrate: CliSubstrate) => void;
  codeReviewEvalEnabled: boolean;
  onCodeReviewEvalEnabledChange: (enabled: boolean) => void;
  autoGradeVariantRuns: boolean;
  onAutoGradeVariantRunsChange: (enabled: boolean) => void;
}

export function SessionSettings({
  globalSystemPrompt,
  onGlobalSystemPromptChange,
  defaultAgentPermissionMode,
  onDefaultAgentPermissionModeChange,
  defaultExecutionModel,
  onDefaultExecutionModelChange,
  quickSessionWorktreeMode,
  onQuickSessionWorktreeModeChange,
  quickSessionDefaultSubstrate,
  onQuickSessionDefaultSubstrateChange,
  codeReviewEvalEnabled,
  onCodeReviewEvalEnabledChange,
  autoGradeVariantRuns,
  onAutoGradeVariantRunsChange,
}: SessionSettingsProps): React.JSX.Element {
  return (
    <section data-testid="settings-session-settings">
      <CollapsibleCard
        title="Session settings"
        subtitle="What a new session or run starts with"
        icon={<SlidersHorizontal className="w-5 h-5" />}
        defaultExpanded={true}
      >
        {/* Global defaults — the baseline every new session or run inherits.
            Per-run-type overrides belong directly BELOW this sub-block. */}
        <section aria-labelledby="session-settings-global-defaults">
          <h4
            id="session-settings-global-defaults"
            className="text-xs font-semibold uppercase tracking-[.08em] text-text-tertiary mb-4"
          >
            Global defaults
          </h4>

          <SettingsSection
            title="Global Instructions"
            description="Add custom instructions that apply to all your projects"
            icon={<FileText className="w-4 h-4" />}
          >
            <Textarea
              label="Global System Prompt"
              value={globalSystemPrompt}
              onChange={(e) => onGlobalSystemPromptChange(e.target.value)}
              placeholder="Always use TypeScript... Follow our team's coding standards..."
              rows={3}
              fullWidth
              helperText="These instructions will be added to every Claude session across all projects."
            />
          </SettingsSection>

          <SettingsSection
            title="Agent Permission Mode"
            description="How workflow agents handle tool use that touches your files"
            icon={<ShieldCheck className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {PERMISSION_MODE_OPTIONS.map(({ id, label, hint }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    onDefaultAgentPermissionModeChange(id);
                    trackEvent('permission_mode_changed', { mode: id });
                  }}
                  aria-pressed={defaultAgentPermissionMode === id}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    defaultAgentPermissionMode === id
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              Applies to workflow runs on both CLI substrates. "Auto" uses Claude's native permission classifier; "Don't ask" skips all permission prompts.
            </p>
          </SettingsSection>

          <SettingsSection
            title="Workflow Orchestration"
            description="Who walks a flow run's steps — the classic orchestrator or the programmatic host loop"
            icon={<Zap className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {([
                { model: 'programmatic', label: 'Programmatic', hint: 'Default · in-process host walks the DAG' },
                { model: 'orchestrated', label: 'Orchestrated', hint: 'Classic orchestrator-driven steps' },
              ] as const).map(({ model, label, hint }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    onDefaultExecutionModelChange(model);
                    trackEvent('execution_model_default_changed', { executionModel: model });
                  }}
                  aria-pressed={defaultExecutionModel === model}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    defaultExecutionModel === model
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              "Programmatic" hands new SDK flow runs to the in-process host loop, which walks the
              run's steps deterministically instead of the classic orchestrator. Every programmatic
              run always includes a chat supervisor you can query mid-run; escalations always go to
              the human review queue and are also surfaced in chat. Only affects SDK runs started
              after you save — the interactive terminal substrate always runs orchestrated.
            </p>
          </SettingsSection>

          <SettingsSection
            title="Quick Sessions"
            description="Where a new quick session works — an isolated git worktree or your project checkout"
            icon={<FolderOpen className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {([
                { mode: 'worktree', label: 'Own worktree (default)', hint: 'Isolated git worktree' },
                { mode: 'in-place', label: 'Project checkout (in place)', hint: 'Work directly in your checkout' },
              ] as const).map(({ mode, label, hint }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    onQuickSessionWorktreeModeChange(mode);
                    trackEvent('quick_worktree_mode_default_changed', { mode });
                  }}
                  aria-pressed={quickSessionWorktreeMode === mode}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    quickSessionWorktreeMode === mode
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              "Project checkout (in place)" starts new quick sessions directly in your working copy —
              no worktree, no isolation. It works with both the SDK and interactive terminal runtimes,
              commit automation stays off, and a workflow launched from an in-place session opens in a
              separate worktree-backed session. Only affects sessions created after you save; you can
              override this per session in the launch wizard's Advanced options.
            </p>
          </SettingsSection>

          <SettingsSection
            title="Quick Session Runtime"
            description="Which CLI substrate a new quick session starts on — the live terminal or the SDK"
            icon={<Terminal className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {([
                { substrate: 'interactive', label: 'Interactive terminal (default)', hint: 'Live PTY — full REPL' },
                { substrate: 'sdk', label: 'SDK', hint: 'In-process Agent SDK' },
              ] as const).map(({ substrate, label, hint }) => (
                <button
                  key={substrate}
                  type="button"
                  onClick={() => {
                    onQuickSessionDefaultSubstrateChange(substrate);
                    trackEvent('quick_substrate_default_changed', { substrate });
                  }}
                  aria-pressed={quickSessionDefaultSubstrate === substrate}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    quickSessionDefaultSubstrate === substrate
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              Sets which runtime a new quick session starts on. The interactive terminal is the default —
              a full live REPL. This seeds the launch wizard's substrate picker; you can still switch it
              per session. The global "Interactive PTY only" lock and demo mode override this. Workflow
              runs use the separate default above and are unaffected.
            </p>
          </SettingsSection>

          {/* Stays whole in Session settings (sub-toggle included): the launch
              wizard already carries a real per-run "Quality eval" override, the
              same shape as the other session knobs in this group. */}
          <SettingsSection
            title="Code Review Eval"
            description="Automatic LLM-jury quality assessment of a flow's diff at the review step"
            icon={<ShieldCheck className="w-4 h-4" />}
          >
            <div className="flex flex-col gap-1.5">
              {([
                { enabled: true, label: 'On', hint: 'Default · grade every built-in flow run' },
                { enabled: false, label: 'Off', hint: 'Skip the jury pass — no eval cost' },
              ] as const).map(({ enabled, label, hint }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => onCodeReviewEvalEnabledChange(enabled)}
                  aria-pressed={codeReviewEvalEnabled === enabled}
                  className={`flex items-center justify-between gap-3 px-3 py-2 rounded-button border transition-colors text-left ${
                    codeReviewEvalEnabled === enabled
                      ? 'border-interactive bg-interactive-surface'
                      : 'border-border-secondary bg-surface-secondary hover:bg-surface-hover'
                  }`}
                >
                  <span className="text-text-primary font-medium text-sm">{label}</span>
                  <span className="text-xs text-text-tertiary">{hint}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-text-tertiary mt-2">
              When a built-in flow (Sprint / Ship) reaches its human-review step, Cyboflow can run a
              Three-slot jury pass (two Opus + one Codex) over the run's diff and file any findings into the review queue. Each
              eval uses real model calls. Turn it off to skip it globally; a per-run "Quality
              eval" override in the launch wizard's Advanced options can force it on or off for a single
              run. Only affects runs started after you save.
            </p>

            <div className="mt-4 border-t border-border-secondary pt-4">
              <Checkbox
                label="Auto-grade variant & experiment runs"
                checked={autoGradeVariantRuns}
                onChange={(e) => onAutoGradeVariantRunsChange(e.target.checked)}
              />
              <p className="text-xs text-text-tertiary mt-1">
                Extends the jury pass to workflow-variant runs (rotation) and side-by-side A/B
                experiment arms — a per-arm rubric score plus, for experiments, a pairwise judge
                verdict. Default on. Turning it off stops the extra judge cost from activating
                variants or running an A/B test, without touching the global toggle above.
              </p>
            </div>
          </SettingsSection>
        </section>

        {/* Per-run-type overrides land here, directly below Global defaults.
            This one IS self-fetching (workflow rows + config) and writes through
            the dedicated `applyRunTypeDefault` IPC op rather than this group's
            props-in/callback-out contract — see RunTypeOverrideDetail's module
            doc for why Settings.tsx's shared handleSubmit is the wrong channel. */}
        <RunTypeOverridesSection />
      </CollapsibleCard>
    </section>
  );
}
