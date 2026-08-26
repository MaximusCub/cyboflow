/**
 * TuningLevelSelector — the launch wizard's per-run tuning-level control
 * (docs/plans/workflow-tuning-levels.md D4 + §4 "SessionStartWizard").
 *
 * Four segments — Efficient / Standard / Thorough / Custom — defaulting to the
 * selected workflow's STAMPED level (`savedLevel`), tagged "saved default".
 * The component is a plain controlled radiogroup: `value` is whatever the
 * caller currently wants shown as selected (the parent's per-run override when
 * one is active, else `savedLevel`), and `onChange` reports the segment the
 * user picked — the caller decides whether that pick IS an override (differs
 * from `savedLevel`) or clears one (matches it back). See
 * SessionStartWizard's `tuningLevelOverride` state for that logic.
 *
 * Custom is disabled-with-hint while the workflow's `spec_json` slot is empty
 * (`customSlotAvailable` — {@link hasCustomSpecSlot}); once selectable it gets
 * a distinct accent (status-info) from the other three preset/identity
 * segments (interactive/terracotta), so a stored definition always reads as a
 * different KIND of choice from a calibrated preset.
 *
 * `disabled` (+ its note) greys out every segment — set by the parent when a
 * non-baseline variant is pinned (D4's mutual-exclusion rule): a pinned
 * variant runs its own frozen definition, so a level choice would be
 * meaningless and the server rejects `tuningLevel` + `variantId` together.
 *
 * `estimateLabels` (plan §5 phase 7, `shared/tuning/workflowTuningEstimates`)
 * renders a small secondary line under whichever segment(s) supply one. Those
 * figures are EXECUTION tokens only (eval-jury usage is unmetered — D8's
 * "Scope caveat"), so whenever any label is supplied this also renders a
 * one-line "excl. eval" caption below the segments, once per surface.
 */
import { cn } from '../../../utils/cn';
import { TUNING_LEVELS, type TuningLevel } from '../../../../../shared/tuning/workflowTuning';

const TUNING_LEVEL_LABELS: Record<TuningLevel, string> = {
  efficient: 'Efficient',
  standard: 'Standard',
  thorough: 'Thorough',
  custom: 'Custom',
};

export interface TuningLevelSelectorProps {
  /** The level currently shown as selected — the active override, else `savedLevel`. */
  value: TuningLevel;
  /** The workflow's stamped (persisted) level — tagged "saved default". */
  savedLevel: TuningLevel;
  /** Display title of the selected flow, threaded into the override caption. */
  flowTitle: string;
  /** Whether the workflow's `spec_json` slot holds a real custom definition. */
  customSlotAvailable: boolean;
  /** Grey out every segment (a non-baseline variant is pinned — D4 mutual exclusion). */
  disabled?: boolean;
  onChange: (level: TuningLevel) => void;
  /** Optional per-level token-estimate seam (plan §5 phase 7) — no query wired yet. */
  estimateLabels?: Partial<Record<TuningLevel, string>>;
  id?: string;
}

export function TuningLevelSelector({
  value,
  savedLevel,
  flowTitle,
  customSlotAvailable,
  disabled = false,
  onChange,
  estimateLabels,
  id = 'wizard-tuning-level',
}: TuningLevelSelectorProps): React.JSX.Element {
  const isOverride = !disabled && value !== savedLevel;

  return (
    <div className="flex flex-col gap-1.5" data-testid="wizard-tuning-level">
      <span className="text-xs font-medium text-text-secondary">Tuning level</span>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Tuning level" id={id}>
        {TUNING_LEVELS.map((level) => {
          const isCustom = level === 'custom';
          const segmentDisabled = disabled || (isCustom && !customSlotAvailable);
          const selected = value === level;
          const estimate = estimateLabels?.[level];
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={segmentDisabled}
              onClick={() => onChange(level)}
              data-testid={`wizard-tuning-level-${level}`}
              title={
                !disabled && isCustom && !customSlotAvailable
                  ? 'No custom definition yet — open Edit blueprint to create one'
                  : undefined
              }
              className={cn(
                'flex flex-1 flex-col items-center gap-0.5 border px-2 py-1.5 text-xs font-medium transition-colors',
                segmentDisabled
                  ? 'cursor-not-allowed border-border-secondary bg-bg-primary text-text-tertiary opacity-50'
                  : selected
                    ? isCustom
                      ? 'border-status-info bg-status-info/10 text-status-info'
                      : 'border-interactive bg-interactive-surface text-text-primary'
                    : 'border-border-secondary bg-bg-primary text-text-secondary hover:bg-surface-hover',
              )}
            >
              <span>{TUNING_LEVEL_LABELS[level]}</span>
              {/* Own line, not inline with the name — inline it overflowed the
                  segment at wizard widths ("SAVED DEFAUL…"). */}
              {level === savedLevel && (
                <span
                  className="eyebrow text-text-muted"
                  data-testid={`wizard-tuning-level-${level}-saved-tag`}
                >
                  saved default
                </span>
              )}
              {estimate !== undefined && (
                <span className="text-[10px] text-text-tertiary">{estimate}</span>
              )}
            </button>
          );
        })}
      </div>
      {disabled ? (
        <p className="text-xs text-text-tertiary" data-testid="wizard-tuning-level-variant-note">
          A pinned variant runs its own definition — tuning level is disabled for this run.
        </p>
      ) : isOverride ? (
        <p className="text-xs text-status-warning" data-testid="wizard-tuning-level-override-note">
          Override for this run only — the {flowTitle} workflow keeps {TUNING_LEVEL_LABELS[savedLevel]}.
        </p>
      ) : null}

      {estimateLabels !== undefined && Object.keys(estimateLabels).length > 0 && (
        <p className="text-xs text-text-tertiary" data-testid="wizard-tuning-estimate-caption">
          Estimated execution tokens (excl. eval)
        </p>
      )}
    </div>
  );
}
