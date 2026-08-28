/**
 * RuntimeMixDial — the editor simple page's SECOND dial, sitting under
 * {@link TuningLevelDial} (plan `docs/plans/workflow-runtime-mix.md` D4).
 *
 * The level decides WHICH steps run and at what Claude tier·effort; the mix
 * decides WHICH PROVIDER runs each step, split along one line — execution vs.
 * verification. Four segments, Claude-most to Codex-most: CLAUDE/only,
 * CLAUDE/primary, CODEX/primary, CODEX/only. Selecting one is a single
 * `workflows.setRuntimeMix` write — the host owns the mutation; this component
 * only reports the choice, exactly like its tuning sibling.
 *
 * `mixedDisabled` greys ONLY the two cross-provider segments, for a flow whose
 * verification class is empty (`VERIFICATION_AGENT_KEYS` — compound,
 * verify-setup): there is nothing to cross between providers there, while
 * `claude`/`codex` stay meaningful as a whole-flow provider choice.
 *
 * Styled as an editor-native sibling of `TuningLevelDial` — sharp borders, the
 * same selected-card treatment — NOT the wizard's rounded `RuntimeMixSelector`
 * buttons, which belong to the launch flow, not the editor.
 */
import { RUNTIME_MIXES, type RuntimeMix } from '../../../../shared/tuning/runtimeMix';

/** The two-line segment label per mix — provider on top, aspect below. */
const SEGMENT_LABELS: Readonly<Record<RuntimeMix, { provider: string; aspect: string }>> = {
  claude: { provider: 'CLAUDE', aspect: 'only' },
  'claude-primary': { provider: 'CLAUDE', aspect: 'primary' },
  'codex-primary': { provider: 'CODEX', aspect: 'primary' },
  codex: { provider: 'CODEX', aspect: 'only' },
};

/** One-line description per selected mix, rendered below the row. */
const MIX_DESCRIPTIONS: Readonly<Record<RuntimeMix, string>> = {
  claude: 'Everything on Claude, model tailored to the task and effort level.',
  'claude-primary': 'Claude executes, Codex reviews & verifies.',
  'codex-primary': 'Codex executes, Claude reviews & verifies.',
  codex: 'Everything on Codex, model tailored to the task and effort level.',
};

/** Tooltip on the two cross-provider segments while the flow has no verification steps. */
const MIXED_DISABLED_HINT = 'This flow has no verification steps to cross between providers.';

export interface RuntimeMixDialProps {
  /** The currently selected mix. */
  mix: RuntimeMix;
  /** Grey ONLY the two cross-provider segments — the flow has no verification class. */
  mixedDisabled: boolean;
  /** Called with the chosen mix for any enabled segment. */
  onSelect: (mix: RuntimeMix) => void;
  /** Blocks every segment while a mutation is in flight. */
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
          className="text-[10px] font-bold uppercase text-text-tertiary"
          style={{ letterSpacing: '0.18em' }}
        >
          Runtime mix
        </span>
        <span className="text-[9px] text-text-tertiary">
          which provider runs each step — execution vs. verification
        </span>
      </div>

      <div className="flex flex-row items-stretch" style={{ gap: 10 }}>
        {RUNTIME_MIXES.map((candidate) => {
          const isCross = candidate === 'claude-primary' || candidate === 'codex-primary';
          const disabled = isCross && mixedDisabled;
          const selected = candidate === mix;
          const { provider, aspect } = SEGMENT_LABELS[candidate];
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
                padding: '8px 12px',
                border: selected
                  ? '1.4px solid var(--color-text-primary)'
                  : '1px solid var(--color-border-primary)',
                background: selected
                  ? 'var(--color-surface-primary)'
                  : 'var(--color-surface-tertiary)',
                boxShadow: selected ? '0 2px 0 var(--color-text-primary)' : 'none',
                opacity: disabled ? 0.5 : 1,
                cursor: busy || disabled ? 'not-allowed' : 'pointer',
              }}
              data-testid={`runtime-mix-segment-${candidate}`}
            >
              <span
                className="block text-[11px] font-bold uppercase text-text-primary"
                style={{ letterSpacing: '0.12em' }}
              >
                {provider}
              </span>
              <span className="block text-[9px] text-text-tertiary">{aspect}</span>
            </button>
          );
        })}
      </div>

      <span className="text-[10px] text-text-secondary" data-testid="runtime-mix-desc">
        {MIX_DESCRIPTIONS[mix]}
      </span>
    </div>
  );
}
