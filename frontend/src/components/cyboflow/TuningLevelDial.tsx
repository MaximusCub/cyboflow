/**
 * TuningLevelDial — the four-slot tuning dial on the editor's simple page
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
 * `onCustomUnavailable`. While the slot is empty that card's own description IS
 * the hint, so the discovery text sits on the thing you click rather than in a
 * detached paragraph below the row.
 *
 * The multiplier tags are STATIC copy calibrated on execution tokens. Real
 * per-level token estimates (`shared/tuning/workflowTuningEstimates`, backed
 * by `run_usage`) land through `estimateLabels` — an optional per-level string
 * rendered under the description when present. Those numbers are EXECUTION
 * tokens only (eval-jury usage is unmetered — plan D8's "Scope caveat"), so
 * whenever any label is supplied this also renders a one-line "excl. eval"
 * caption below the strip, once per surface rather than once per segment.
 *
 * Every card renders its "● ACTIVE" tick line whether or not it is selected —
 * transparent when it is not — so selecting a card never changes any card's
 * height and the row does not jump under the cursor.
 */
import {
  TUNING_LEVELS,
  type TuningLevel,
} from '../../../../shared/tuning/workflowTuning';

/** Display copy per level: the card name, its static cost tag, its description. */
const LEVEL_COPY: Readonly<
  Record<TuningLevel, { label: string; tag: string; desc: string }>
> = {
  efficient: {
    label: 'Efficient',
    tag: '~0.5×',
    desc: 'Preset — fewest steps, cheaper models, review once per sprint. Drafts, chores, low-risk changes.',
  },
  standard: {
    label: 'Standard',
    tag: '1.0×',
    desc: 'The aligned defaults — balanced models on every step, every check on.',
  },
  thorough: {
    label: 'Thorough',
    tag: '~2.6×',
    desc: 'Preset — every check on, strongest models. Ship-critical or gnarly work.',
  },
  custom: {
    label: 'Custom',
    tag: '—',
    desc: 'Your definition — edit it in Advanced.',
  },
};

/** Description shown ON the CUSTOM card while its slot is empty. */
export const CUSTOM_UNAVAILABLE_HINT =
  "No custom definition yet — edit in Advanced and choose 'Overwrite this flow'.";

export interface TuningLevelDialProps {
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
   * Rendered under the description for whichever levels supply one.
   */
  estimateLabels?: Partial<Record<TuningLevel, string>>;
}

export function TuningLevelDial({
  level,
  hasCustomDefinition,
  onSelect,
  onCustomUnavailable,
  busy = false,
  estimateLabels,
}: TuningLevelDialProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5" data-testid="tuning-level-selector">
      <div className="flex flex-row items-baseline gap-2.5">
        <span
          className="text-[10px] font-bold uppercase text-text-tertiary"
          style={{ letterSpacing: '0.18em' }}
        >
          Tuning level
        </span>
        <span className="text-[9px] text-text-tertiary">
          one dial — sets models, steps and checks across the whole flow
        </span>
      </div>

      <div className="flex flex-row items-stretch" style={{ gap: 10 }}>
        {TUNING_LEVELS.map((candidate) => {
          const copy = LEVEL_COPY[candidate];
          const isCustom = candidate === 'custom';
          const unavailable = isCustom && !hasCustomDefinition;
          const selected = candidate === level;
          // CUSTOM carries the info accent so "your own definition" never reads
          // as one more calibrated preset; the presets carry the canvas accent.
          const accent = isCustom
            ? 'var(--color-status-info)'
            : 'var(--color-interactive-primary)';
          const emphasis = isCustom
            ? 'var(--color-status-info)'
            : 'var(--color-text-primary)';
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
              className="flex-1 text-left"
              style={{
                padding: '12px 14px',
                // An empty CUSTOM slot is drawn as a vacancy — dashed and
                // unfilled — rather than as one more selectable preset.
                border: unavailable
                  ? '1px dashed var(--color-border-primary)'
                  : selected
                    ? `1.4px solid ${emphasis}`
                    : '1px solid var(--color-border-primary)',
                background: unavailable
                  ? 'transparent'
                  : selected
                    ? isCustom
                      ? 'color-mix(in srgb, var(--color-status-info) 6%, transparent)'
                      : 'var(--color-surface-primary)'
                    : 'var(--color-surface-tertiary)',
                boxShadow: !unavailable && selected ? `0 2px 0 ${emphasis}` : 'none',
                opacity: unavailable ? 0.75 : 1,
                cursor: busy ? 'not-allowed' : 'pointer',
              }}
              data-testid={`tuning-level-segment-${candidate}`}
            >
              <span className="flex flex-row items-center justify-between gap-2">
                <span
                  className="text-[12px] font-bold uppercase"
                  style={{
                    letterSpacing: '0.12em',
                    color: isCustom
                      ? unavailable
                        ? 'var(--color-text-tertiary)'
                        : 'var(--color-status-info)'
                      : 'var(--color-text-primary)',
                  }}
                >
                  {copy.label}
                </span>
                <span
                  className="text-[9px] font-bold text-text-secondary"
                  style={{
                    padding: '2px 6px',
                    border: '1px solid var(--color-border-primary)',
                    background: 'var(--color-surface-tertiary)',
                  }}
                >
                  {copy.tag}
                </span>
              </span>

              <span
                className="mt-1.5 block text-[10px] text-text-secondary"
                style={{ lineHeight: 1.45 }}
                data-testid={unavailable ? 'tuning-custom-hint' : undefined}
              >
                {unavailable ? CUSTOM_UNAVAILABLE_HINT : copy.desc}
              </span>

              {estimateLabels?.[candidate] !== undefined && (
                <span
                  className="mt-1 block text-[9.5px] text-text-secondary"
                  data-testid={`tuning-level-estimate-${candidate}`}
                >
                  {estimateLabels[candidate]}
                </span>
              )}

              {/* Always rendered — transparent when unselected — so selecting a
                  card never changes the row's height. */}
              <span
                className="mt-2 block text-[8.5px] font-bold"
                style={{
                  letterSpacing: '0.14em',
                  color: selected && !unavailable ? accent : 'transparent',
                }}
                aria-hidden={!selected || unavailable}
              >
                ● ACTIVE
              </span>
            </button>
          );
        })}
      </div>

      {estimateLabels !== undefined && Object.keys(estimateLabels).length > 0 && (
        <p className="text-[10px] text-text-tertiary" data-testid="tuning-estimate-caption">
          Estimated execution tokens (excl. eval)
        </p>
      )}
    </div>
  );
}
