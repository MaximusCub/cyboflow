/**
 * RuntimeMixSelector — the launch wizard's per-run runtime-mix control
 * (docs/plans/workflow-runtime-mix.md D4).
 *
 * The SECOND dial inside the Workflow configuration section, rendered directly
 * under {@link TuningLevelSelector}'s segments and styled to match them. The
 * level decides WHICH steps run and at what tier·effort; the mix decides WHICH
 * PROVIDER runs each step, split execution vs. verification — so the four
 * segments read as a provider (top line) and an aspect (bottom line):
 * CLAUDE/only, CLAUDE/primary, CODEX/primary, CODEX/only.
 *
 * Like its sibling this is a plain controlled radiogroup: `value` is whatever
 * the caller wants shown as selected (its per-run override when one is active,
 * else the workflow's stamped mix) and `onChange` reports the pick. `savedMix`
 * is display-only — it marks the description line with "· saved default" when
 * the shown value IS the stamp, so a divergence is legible without a second
 * caption (the parent's shared "Save as default" CTA is the affordance for
 * persisting it).
 *
 * Two independent disabled axes, deliberately not collapsed into one:
 *   - `mixedDisabled` greys ONLY the two cross-provider segments, for a flow
 *     whose verification class is empty (`VERIFICATION_AGENT_KEYS` — compound,
 *     verify-setup). There is nothing to cross between providers there, while
 *     `claude`/`codex` stay meaningful as a whole-flow provider choice.
 *   - `disabled` greys the WHOLE row, for a launch the mix does not reach at
 *     all: a pinned A/B variant (which runs its own frozen definition) or a
 *     single-provider lane like OMP/Pi. `disabledNote` says which, in place of
 *     the mix description.
 */
import { cn } from '../../../utils/cn';
import {
  RUNTIME_MIXES,
  type RuntimeMix,
} from '../../../../../shared/tuning/runtimeMix';

/** The two-line segment label per mix — provider on top, aspect below. */
const RUNTIME_MIX_SEGMENT_LABELS: Record<RuntimeMix, { provider: string; aspect: string }> = {
  claude: { provider: 'CLAUDE', aspect: 'only' },
  'claude-primary': { provider: 'CLAUDE', aspect: 'primary' },
  'codex-primary': { provider: 'CODEX', aspect: 'primary' },
  codex: { provider: 'CODEX', aspect: 'only' },
};

/** One-line helper under the segments, per selected mix. */
const RUNTIME_MIX_DESCRIPTIONS: Record<RuntimeMix, string> = {
  claude: 'Everything on Claude, model tailored to the task and effort level.',
  'claude-primary': 'Claude executes, Codex reviews & verifies.',
  'codex-primary': 'Codex executes, Claude reviews & verifies.',
  codex: 'Everything on Codex, model tailored to the task and effort level.',
};

/** Tooltip on the two cross-provider segments while the flow has no verification steps. */
const MIXED_DISABLED_HINT = 'This flow has no verification steps to cross between providers.';

export interface RuntimeMixSelectorProps {
  /** The mix currently shown as selected — the active override, else the stamped mix. */
  value: RuntimeMix;
  /** The workflow's STAMPED mix; marks the description line "· saved default" when it equals `value`. */
  savedMix: RuntimeMix;
  /**
   * Grey the two cross-provider segments — the flow's verification class is
   * empty, so `claude-primary`/`codex-primary` would route nothing.
   */
  mixedDisabled: boolean;
  /** Grey the whole row — this launch does not carry a mix at all. */
  disabled?: boolean;
  /** Why the whole row is greyed, shown in place of the mix description. */
  disabledNote?: string;
  onChange: (mix: RuntimeMix) => void;
  id?: string;
}

export function RuntimeMixSelector({
  value,
  savedMix,
  mixedDisabled,
  disabled = false,
  disabledNote,
  onChange,
  id = 'wizard-runtime-mix',
}: RuntimeMixSelectorProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5" data-testid="wizard-runtime-mix">
      <span className="text-xs font-medium text-text-secondary">Runtime mix</span>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Runtime mix" id={id}>
        {RUNTIME_MIXES.map((mix) => {
          const isCross = mix === 'claude-primary' || mix === 'codex-primary';
          const segmentDisabled = disabled || (isCross && mixedDisabled);
          const selected = value === mix;
          const { provider, aspect } = RUNTIME_MIX_SEGMENT_LABELS[mix];
          return (
            <button
              key={mix}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={segmentDisabled}
              onClick={() => onChange(mix)}
              data-testid={`wizard-runtime-mix-${mix}`}
              title={isCross && mixedDisabled ? MIXED_DISABLED_HINT : undefined}
              className={cn(
                // Matched to TuningLevelSelector's segments so the two dials in
                // the Workflow configuration block read as one control family.
                'flex flex-1 flex-col items-center justify-center gap-0.5 rounded-button border px-3 py-2 text-sm font-medium transition-colors',
                segmentDisabled
                  ? 'cursor-not-allowed border-border-secondary bg-surface-secondary text-text-tertiary opacity-50'
                  : selected
                    ? 'border-interactive bg-interactive-surface text-text-primary'
                    : 'border-border-secondary bg-surface-secondary text-text-primary hover:bg-surface-hover',
              )}
            >
              <span>{provider}</span>
              <span className="text-[10px] font-normal text-text-tertiary">{aspect}</span>
            </button>
          );
        })}
      </div>
      {disabled && disabledNote !== undefined ? (
        <p className="text-xs text-text-tertiary" data-testid="wizard-runtime-mix-note">
          {disabledNote}
        </p>
      ) : (
        <p className="text-xs text-text-tertiary" data-testid="wizard-runtime-mix-desc">
          {RUNTIME_MIX_DESCRIPTIONS[value]}
          {value === savedMix ? ' · saved default' : ''}
        </p>
      )}
    </div>
  );
}
