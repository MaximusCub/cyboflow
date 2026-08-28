/**
 * RuntimeMixDial — the editor simple page's SECOND dial, sitting under
 * {@link TuningLevelDial} (plan `docs/plans/workflow-runtime-mix.md` D4).
 *
 * The level decides WHICH steps run and at what Claude tier·effort; the mix
 * decides WHICH PROVIDER runs each step, split along one line — execution vs.
 * verification. Four cards, Claude-most to Codex-most: CLAUDE ONLY,
 * CLAUDE PRIMARY, CODEX PRIMARY, CODEX ONLY. Selecting one is a single
 * `workflows.setRuntimeMix` write — the host owns the mutation; this component
 * only reports the choice, exactly like its tuning sibling.
 *
 * Cards mirror TuningLevelDial's exactly — title, description, an always-
 * rendered "● ACTIVE" tick so selection never changes the row's height. The
 * two MIXED cards carry the Codex accent on their title (the design canvas's
 * color coding): a cross-provider version is the novel thing this dial sells,
 * and the teal is the same hue the phase strip's Codex chips decode to.
 *
 * `mixedDisabled` greys ONLY those two cross-provider cards, for a flow whose
 * verification class is empty (`VERIFICATION_AGENT_KEYS` — compound,
 * verify-setup): there is nothing to cross between providers there, while
 * `claude`/`codex` stay meaningful as a whole-flow provider choice.
 */
import { RUNTIME_MIXES, isMixedRuntimeMix, type RuntimeMix } from '../../../../shared/tuning/runtimeMix';

/**
 * The Codex-provider accent — the mixed cards' title hue and the section
 * header's. Literal for the same both-themes reason as the strip's
 * MODEL_COLORS; sits between its luna/sol tier hues.
 */
const CODEX_ACCENT = '#0e7c86';

/** Display copy per mix: the card name and its description. */
const MIX_COPY: Readonly<Record<RuntimeMix, { label: string; desc: string }>> = {
  claude: {
    label: 'Claude only',
    desc: 'Everything on Claude, model tailored to the task and effort level.',
  },
  'claude-primary': {
    label: 'Claude primary',
    desc: 'Claude executes, Codex reviews & verifies.',
  },
  'codex-primary': {
    label: 'Codex primary',
    desc: 'Codex executes, Claude reviews & verifies.',
  },
  codex: {
    label: 'Codex only',
    desc: 'Everything on Codex, model tailored to the task and effort level.',
  },
};

/** Tooltip on the two cross-provider cards while the flow has no verification steps. */
const MIXED_DISABLED_HINT = 'This flow has no verification steps to cross between providers.';

export interface RuntimeMixDialProps {
  /** The currently selected mix. */
  mix: RuntimeMix;
  /** Grey ONLY the two cross-provider cards — the flow has no verification class. */
  mixedDisabled: boolean;
  /** Called with the chosen mix for any enabled card. */
  onSelect: (mix: RuntimeMix) => void;
  /** Blocks every card while a mutation is in flight. */
  busy?: boolean;
}

export function RuntimeMixDial({
  mix,
  mixedDisabled,
  onSelect,
  busy = false,
}: RuntimeMixDialProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5" data-testid="runtime-mix-dial">
      <div className="flex flex-row items-baseline gap-2.5">
        <span
          className="text-[10px] font-bold uppercase"
          style={{ letterSpacing: '0.18em', color: CODEX_ACCENT }}
        >
          Runtime mix
        </span>
        <span className="text-[9px] text-text-tertiary">
          which provider runs each step — mixed versions combine both model families in one flow
        </span>
      </div>

      <div className="flex flex-row items-stretch" style={{ gap: 10 }}>
        {RUNTIME_MIXES.map((candidate) => {
          const isCross = isMixedRuntimeMix(candidate);
          const disabled = isCross && mixedDisabled;
          const selected = candidate === mix;
          const copy = MIX_COPY[candidate];
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={selected}
              disabled={disabled}
              title={disabled ? MIXED_DISABLED_HINT : undefined}
              onClick={() => {
                if (busy || disabled) return;
                onSelect(candidate);
              }}
              className="flex-1 text-left"
              style={{
                padding: '12px 14px',
                border: disabled
                  ? '1px dashed var(--color-border-primary)'
                  : selected
                    ? '1.4px solid var(--color-text-primary)'
                    : '1px solid var(--color-border-primary)',
                background: disabled
                  ? 'transparent'
                  : selected
                    ? 'var(--color-surface-primary)'
                    : 'var(--color-surface-tertiary)',
                boxShadow: !disabled && selected ? '0 2px 0 var(--color-text-primary)' : 'none',
                opacity: disabled ? 0.75 : 1,
                cursor: busy || disabled ? 'not-allowed' : 'pointer',
              }}
              data-testid={`runtime-mix-segment-${candidate}`}
            >
              <span
                className="block text-[12px] font-bold uppercase"
                style={{
                  letterSpacing: '0.12em',
                  // The design canvas's color coding: mixed versions carry the
                  // Codex accent, single-provider versions stay neutral.
                  color: disabled
                    ? 'var(--color-text-tertiary)'
                    : isCross
                      ? CODEX_ACCENT
                      : 'var(--color-text-primary)',
                }}
              >
                {copy.label}
              </span>

              <span
                className="mt-1.5 block text-[10px] text-text-secondary"
                style={{ lineHeight: 1.45 }}
                data-testid={`runtime-mix-desc-${candidate}`}
              >
                {copy.desc}
              </span>

              {/* Always rendered — transparent when unselected — so selecting a
                  card never changes the row's height. */}
              <span
                className="mt-2 block text-[8.5px] font-bold"
                style={{
                  letterSpacing: '0.14em',
                  color:
                    selected && !disabled ? 'var(--color-interactive-primary)' : 'transparent',
                }}
                aria-hidden={!selected || disabled}
              >
                ● ACTIVE
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
