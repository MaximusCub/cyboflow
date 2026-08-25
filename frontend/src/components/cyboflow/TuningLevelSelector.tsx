/**
 * TuningLevelSelector — the four-slot tuning dial on the editor's simple page
 * (plan `docs/plans/workflow-tuning-levels.md` D3).
 *
 * Segments: EFFICIENT / STANDARD / THOROUGH / CUSTOM, in {@link TUNING_LEVELS}
 * order. Selecting one is a single `workflows.setTuningLevel` write — the host
 * owns the mutation; this component only reports the choice.
 *
 * CUSTOM is the workflow's own Advanced-edited definition, so it is UNAVAILABLE
 * while the custom slot is empty. It is rendered `aria-disabled` (not
 * `disabled`) deliberately: a native disabled button swallows the click, and
 * clicking the empty CUSTOM segment is how the user discovers where a custom
 * definition comes from — it opens the Advanced editor via
 * `onCustomUnavailable`.
 *
 * The multiplier tags are STATIC copy calibrated on execution tokens. Real
 * per-level token estimates (`shared/tuning/workflowTuningEstimates`, backed
 * by `run_usage`) land through `estimateLabels` — an optional per-level string
 * rendered under the tag when present. Those numbers are EXECUTION tokens only
 * (eval-jury usage is unmetered — plan D8's "Scope caveat"), so whenever any
 * label is supplied this also renders a one-line "excl. eval" caption below
 * the strip, once per surface rather than once per segment.
 */
import {
  TUNING_LEVELS,
  type TuningLevel,
} from '../../../../shared/tuning/workflowTuning';

/** Display copy per level: the segment label and its static cost tag. */
const LEVEL_COPY: Readonly<Record<TuningLevel, { label: string; tag: string }>> = {
  efficient: { label: 'Efficient', tag: '~0.5×' },
  standard: { label: 'Standard', tag: '1.0× · as authored' },
  thorough: { label: 'Thorough', tag: '~2.6×' },
  custom: { label: 'Custom', tag: 'your definition' },
};

/** Hint shown under the strip while CUSTOM has nothing to select. */
export const CUSTOM_UNAVAILABLE_HINT =
  "No custom definition yet — edit in Advanced and choose 'Overwrite this flow'.";

export interface TuningLevelSelectorProps {
  /** The currently selected level. */
  level: TuningLevel;
  /** Is the workflow's custom slot filled? Gates the CUSTOM segment. */
  hasCustomDefinition: boolean;
  /** Called with the chosen level for any ENABLED segment. */
  onSelect: (level: TuningLevel) => void;
  /** Called when the user clicks CUSTOM while its slot is empty. */
  onCustomUnavailable: () => void;
  /** Blocks every segment while a mutation is in flight. */
  busy?: boolean;
  /**
   * Optional per-level estimate line (a later phase's `run_usage` medians).
   * Rendered under the static tag for whichever levels supply one.
   */
  estimateLabels?: Partial<Record<TuningLevel, string>>;
}

export function TuningLevelSelector({
  level,
  hasCustomDefinition,
  onSelect,
  onCustomUnavailable,
  busy = false,
  estimateLabels,
}: TuningLevelSelectorProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2" data-testid="tuning-level-selector">
      <div className="flex flex-row" style={{ gap: 1 }}>
        {TUNING_LEVELS.map((candidate) => {
          const copy = LEVEL_COPY[candidate];
          const unavailable = candidate === 'custom' && !hasCustomDefinition;
          const selected = candidate === level;
          // CUSTOM carries the info accent so "your own definition" never reads
          // as one more calibrated preset; the presets use the canvas's
          // filled-dark selection language.
          const accent =
            candidate === 'custom' ? 'var(--color-status-info)' : 'var(--color-text-primary)';
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={selected}
              aria-disabled={unavailable || busy}
              onClick={() => {
                if (busy) return;
                if (unavailable) {
                  onCustomUnavailable();
                  return;
                }
                onSelect(candidate);
              }}
              className="flex flex-1 flex-col items-start gap-1 px-3 py-2 text-left"
              style={{
                border: `1.4px solid ${selected ? accent : 'var(--color-border-primary)'}`,
                background: selected ? accent : 'var(--color-surface-primary)',
                color: selected ? 'var(--color-bg-primary)' : 'var(--color-text-primary)',
                opacity: unavailable ? 0.5 : 1,
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
              data-testid={`tuning-level-segment-${candidate}`}
            >
              <span
                className="text-[10px] font-semibold uppercase"
                style={{ letterSpacing: '0.14em' }}
              >
                {copy.label}
              </span>
              <span
                className="text-[9.5px]"
                style={{
                  color: selected ? 'var(--color-bg-primary)' : 'var(--color-text-tertiary)',
                  opacity: selected ? 0.8 : 1,
                }}
              >
                {copy.tag}
              </span>
              {estimateLabels?.[candidate] !== undefined && (
                <span
                  className="text-[9.5px]"
                  style={{
                    color: selected ? 'var(--color-bg-primary)' : 'var(--color-text-secondary)',
                    opacity: selected ? 0.8 : 1,
                  }}
                  data-testid={`tuning-level-estimate-${candidate}`}
                >
                  {estimateLabels[candidate]}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {!hasCustomDefinition && (
        <p className="text-[10px] text-text-tertiary" data-testid="tuning-custom-hint">
          {CUSTOM_UNAVAILABLE_HINT}
        </p>
      )}

      {estimateLabels !== undefined && Object.keys(estimateLabels).length > 0 && (
        <p className="text-[10px] text-text-tertiary" data-testid="tuning-estimate-caption">
          Estimated execution tokens (excl. eval)
        </p>
      )}
    </div>
  );
}
