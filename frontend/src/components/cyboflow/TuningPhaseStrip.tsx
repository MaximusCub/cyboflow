/**
 * TuningPhaseStrip — "what runs at this level", rendered from an EFFECTIVE
 * definition DIFFED against the Standard baseline
 * (plan `docs/plans/workflow-tuning-levels.md` §4).
 *
 * The strip is DERIVED, never hand-maintained: the caller resolves the selected
 * level through the shared transform (`resolveEffectiveDefinition`) and passes
 * the result here, so a recalibrated preset or an edited custom slot changes
 * this view with no edit to the component.
 *
 * It shows a DIFF, not just a listing. A preset's most important effect is what
 * it takes AWAY, and a step a preset removed is simply absent from the effective
 * definition — invisible unless something else remembers it ran at Standard.
 * That something is `baselineDefinition`: the same flow resolved at
 * `'standard'`. Anything in the baseline and missing from the effective
 * definition renders struck-through ("removed"); anything in the effective
 * definition and missing from the baseline renders as an added chip. With a
 * null baseline the strip degrades to a plain listing.
 *
 * Fan-out steps render FLAT: the outer step is not a chip at all, its inner
 * lane steps sit inline in the phase band, and the phase label gains
 * "· per task ⇄". On sprint the lane chain IS the thing a level changes most,
 * and burying it under an `execute-tasks` chip hid the whole calibration.
 *
 * A chip's sub-label is a MODEL tag, resolved in the same precedence the run
 * itself uses: the definition's `agentConfigs` pin for that step's canonical
 * agent key (`model · effort`) wins; else the agent's own catalogue run target
 * (`agentRunTargets` — a per-agent model pin or a non-Claude provider), which
 * is what the advanced canvas's step cards show; else the honest "run model"
 * (the agent inherits whatever model the launch picks, unknowable here). A
 * Claude-model tag also colours the chip's 3px left border, which is what the
 * legend above the strip decodes. Human gates carry no model at all and get the
 * hatched gate treatment.
 */
import type { AgentModelAlias, AgentRunTarget } from '../../../../shared/types/agents';
import {
  providerForRuntime,
  WORKFLOW_AGENT_RUNTIME_LABELS,
} from '../../../../shared/types/agentRuntime';
import type {
  FanOutInnerStep,
  WorkflowAgentConfig,
  WorkflowDefinition,
  WorkflowPhase,
  WorkflowStep,
} from '../../../../shared/types/workflows';
import { HUMAN_GATE_AGENT, resolveStepAgentKey } from '../../../../shared/types/agentIdentity';

/**
 * Per-model chip accent. Mid-tone hues chosen to stay legible on both the paper
 * and dark themes, so they are literal rather than theme tokens — they happen to
 * coincide with the shared phase/status primitives (green-accent, phase-review,
 * warm-red, phase-refine), but they mean "which model", not "which phase".
 */
export const MODEL_COLORS: Readonly<Record<AgentModelAlias, string>> = {
  haiku: '#2d8a5b',
  sonnet: '#a87a2c',
  opus: '#b5482f',
  fable: '#5a4ad6',
};

/** Order the legend reads in — cheapest to strongest. */
const LEGEND_ORDER: readonly AgentModelAlias[] = ['haiku', 'sonnet', 'opus', 'fable'];

/** An added step's accent (and its faint fill), shared with the chip renderer. */
const ADDED_COLOR = '#2d8a5b';
const ADDED_FILL = 'rgba(45,138,91,0.06)';

/** Human-gate hatching — the canvas's checkpoint treatment, chip-sized. */
const HUMAN_BORDER = '#a86b1d';
const HUMAN_HATCH =
  'repeating-linear-gradient(135deg, rgba(217,154,61,0.45) 0px 6px, rgba(201,138,45,0.45) 6px 12px)';

/**
 * The colour legend for chip left-borders. Exported separately from the strip so
 * the page can right-align it on the section's header row while the knowledge of
 * which colour means which model stays in one file.
 */
export function TuningModelLegend(): React.JSX.Element {
  return (
    <span className="flex flex-row items-baseline gap-2" data-testid="tuning-model-legend">
      <span className="text-[8.5px] text-text-tertiary" style={{ letterSpacing: '0.08em' }}>
        agent model:
      </span>
      {LEGEND_ORDER.map((model) => (
        <span
          key={model}
          className="text-[8.5px] font-bold"
          style={{ letterSpacing: '0.08em', color: MODEL_COLORS[model] }}
        >
          ● {model}
        </span>
      ))}
    </span>
  );
}

export interface TuningPhaseStripProps {
  /**
   * The selected level's effective definition. `null` when it could not be
   * resolved (a custom flow with a missing/unparseable spec) — the strip then
   * renders an honest placeholder rather than an empty frame.
   */
  definition: WorkflowDefinition | null;
  /**
   * The SAME flow resolved at `'standard'` — what the diff is taken against.
   * `null` disables the diff (every chip renders plain), which is the honest
   * rendering when the baseline itself could not be resolved.
   */
  baselineDefinition: WorkflowDefinition | null;
  /**
   * Per-agent catalogue run targets (the host modal already computes these for
   * the advanced canvas) — the model-tag fallback for steps the level does not
   * pin. Optional: without it an unpinned chip falls straight to "run model".
   */
  agentRunTargets?: Readonly<Record<string, AgentRunTarget>>;
}

/**
 * The chip-scale model tag for an agent the LEVEL does not pin, from its
 * catalogue run target. Mirrors `agentRunTargetLabel`'s arms at chip scale
 * (lowercase aliases so the tag matches the legend): a non-Claude provider
 * shows its provider-model id (or the runtime label) uncoloured; a Claude
 * model pin shows the alias, coloured; no pin at all is the inherit sentinel
 * "run model" — the launch picks it, so nothing more specific is honest here.
 */
function targetSub(target: AgentRunTarget | undefined): {
  sub: string;
  model: AgentModelAlias | null;
} {
  if (target === undefined) return { sub: 'run model', model: null };
  if (target.runtime !== null && providerForRuntime(target.runtime) !== 'claude') {
    return {
      sub:
        target.providerModel !== null && target.providerModel !== ''
          ? target.providerModel
          : WORKFLOW_AGENT_RUNTIME_LABELS[target.runtime],
      model: null,
    };
  }
  if (target.model !== null) return { sub: target.model, model: target.model };
  return { sub: 'run model', model: null };
}

/**
 * The `model · effort` sub-label for an agent, or null when the level pins
 * neither (the agent inherits the run model, which is not worth a line).
 */
function pinLabel(config: WorkflowAgentConfig | undefined): string | null {
  if (config === undefined) return null;
  const parts: string[] = [];
  if (config.model !== undefined) parts.push(config.model);
  if (config.effort !== undefined) parts.push(config.effort);
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

/** Resolve the canonical agentConfigs key for an outer or inner step. */
function agentKeyOf(step: WorkflowStep | FanOutInnerStep): string {
  return resolveStepAgentKey(step.id, step.agent) ?? step.agent;
}

/** How a chip stands relative to the Standard baseline. */
type ChipKind = 'normal' | 'skip' | 'added';

interface OrderEntry {
  id: string;
  kind: ChipKind;
}

/**
 * Merge a baseline id order with an effective one, preserving baseline
 * POSITION for ids the effective definition dropped (they become 'skip') and
 * threading ids the effective definition gained (they become 'added') in
 * their own order. A null baseline means "no diff": everything is 'normal'.
 *
 * Each id is emitted at most once, so a reordered step degrades to its baseline
 * position rather than duplicating.
 */
function mergeOrder(baselineIds: readonly string[] | null, effectiveIds: readonly string[]): OrderEntry[] {
  if (baselineIds === null) return effectiveIds.map((id) => ({ id, kind: 'normal' }));
  const baselineSet = new Set(baselineIds);
  const effectiveSet = new Set(effectiveIds);
  const merged: OrderEntry[] = [];
  let cursor = 0;
  for (const id of baselineIds) {
    while (cursor < effectiveIds.length && !baselineSet.has(effectiveIds[cursor])) {
      merged.push({ id: effectiveIds[cursor], kind: 'added' });
      cursor += 1;
    }
    if (effectiveSet.has(id)) {
      merged.push({ id, kind: 'normal' });
      if (effectiveIds[cursor] === id) cursor += 1;
    } else {
      merged.push({ id, kind: 'skip' });
    }
  }
  for (; cursor < effectiveIds.length; cursor += 1) {
    if (!baselineSet.has(effectiveIds[cursor])) {
      merged.push({ id: effectiveIds[cursor], kind: 'added' });
    }
  }
  return merged;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/** A fan-out step's inner chain, or the empty chain for an ordinary step. */
function innerChainOf(step: WorkflowStep | undefined): readonly FanOutInnerStep[] {
  return step?.fanOut?.inner ?? [];
}

interface ChipProps {
  label: string;
  /** Sub-label: `model · effort`, the agent key, `human`, or `removed`. */
  sub: string;
  kind: ChipKind;
  isHumanGate: boolean;
  /** Colours the sub-label and the 3px left border when the step pins a model. */
  model: AgentModelAlias | null;
  testId: string;
  /** Set on the sub-label only when it IS a pin, so tests can address it. */
  pinTestId?: string;
}

function StepChip({
  label,
  sub,
  kind,
  isHumanGate,
  model,
  testId,
  pinTestId,
}: ChipProps): React.JSX.Element {
  const modelColor = model === null ? null : MODEL_COLORS[model];
  const border =
    kind === 'skip'
      ? '1px dashed var(--color-border-primary)'
      : kind === 'added'
        ? `1px solid ${ADDED_COLOR}`
        : isHumanGate
          ? `1px solid ${HUMAN_BORDER}`
          : '1px solid var(--color-border-primary)';
  const background =
    kind === 'skip'
      ? 'transparent'
      : kind === 'added'
        ? ADDED_FILL
        : isHumanGate
          ? HUMAN_HATCH
          : 'var(--color-surface-primary)';
  return (
    <span
      className="inline-flex flex-col"
      style={{
        gap: 2,
        padding: '4px 8px 5px',
        border,
        background,
        // The pinned model reads as a spine on the chip's leading edge, which is
        // what the legend decodes. Skips and additions keep their own language.
        ...(kind === 'normal' && modelColor !== null
          ? { borderLeft: `3px solid ${modelColor}` }
          : {}),
      }}
      data-testid={testId}
    >
      <span
        className="text-[9.5px] uppercase"
        style={{
          letterSpacing: '0.08em',
          whiteSpace: 'nowrap',
          color:
            kind === 'skip'
              ? 'var(--color-text-tertiary)'
              : kind === 'added'
                ? ADDED_COLOR
                : 'var(--color-text-primary)',
          textDecoration: kind === 'skip' ? 'line-through' : undefined,
          fontWeight: kind === 'added' ? 700 : 400,
        }}
      >
        {kind === 'added' ? `+ ${label}` : label}
      </span>
      <span
        className="text-[8px]"
        style={{
          letterSpacing: '0.06em',
          whiteSpace: 'nowrap',
          fontWeight: kind === 'skip' ? 400 : 700,
          fontStyle: kind === 'skip' ? 'italic' : undefined,
          color:
            kind === 'skip'
              ? 'var(--color-text-tertiary)'
              : isHumanGate
                ? HUMAN_BORDER
                : modelColor !== null
                  ? modelColor
                  : 'var(--color-text-tertiary)',
        }}
        data-testid={pinTestId}
      >
        {sub}
      </span>
    </span>
  );
}

/** Everything one chip needs, resolved from the effective + baseline steps. */
function chipPropsFor(
  step: WorkflowStep | FanOutInnerStep | undefined,
  baselineStep: WorkflowStep | FanOutInnerStep | undefined,
  kind: ChipKind,
  definition: WorkflowDefinition,
  targets: Readonly<Record<string, AgentRunTarget>> | undefined,
  testId: string,
): ChipProps {
  const source = step ?? baselineStep;
  const label =
    source === undefined
      ? testId
      : 'name' in source && source.name !== undefined && source.name.trim().length > 0
        ? source.name
        : source.id;
  if (kind === 'skip' || source === undefined) {
    return { label, sub: 'removed', kind: 'skip', isHumanGate: false, model: null, testId };
  }
  const agentKey = agentKeyOf(source);
  const isHumanGate = source.agent === HUMAN_GATE_AGENT;
  const config = definition.agentConfigs?.[agentKey];
  const pin = isHumanGate ? null : pinLabel(config);
  // The model tag: the level's pin wins, else the agent's catalogue target.
  const fallback = targetSub(targets?.[agentKey]);
  const optional = source.optional === true ? ' · optional' : '';
  return {
    label,
    sub: isHumanGate ? 'human' : `${pin ?? fallback.sub}${optional}`,
    kind,
    isHumanGate,
    model: isHumanGate ? null : (config?.model ?? fallback.model),
    testId,
    pinTestId: pin === null ? undefined : `${testId}-pin`,
  };
}

/** The chips of one phase, in baseline order with skips and additions threaded in. */
function phaseChips(
  effectivePhase: WorkflowPhase | undefined,
  baselinePhase: WorkflowPhase | undefined,
  definition: WorkflowDefinition,
  targets: Readonly<Record<string, AgentRunTarget>> | undefined,
  diffing: boolean,
): { chips: ChipProps[]; hasFanOut: boolean } {
  const effectiveSteps = effectivePhase?.steps ?? [];
  const baselineSteps = baselinePhase?.steps ?? [];
  const effectiveById = byId(effectiveSteps);
  const baselineById = byId(baselineSteps);
  const order = mergeOrder(
    diffing ? baselineSteps.map((step) => step.id) : null,
    effectiveSteps.map((step) => step.id),
  );

  const chips: ChipProps[] = [];
  let hasFanOut = false;
  for (const entry of order) {
    const step = effectiveById.get(entry.id);
    const baselineStep = baselineById.get(entry.id);
    const innerEffective = innerChainOf(step);
    const innerBaseline = innerChainOf(baselineStep);
    if (innerEffective.length === 0 && innerBaseline.length === 0) {
      chips.push(
        chipPropsFor(
          step,
          baselineStep,
          entry.kind,
          definition,
          targets,
          `tuning-step-chip-${entry.id}`,
        ),
      );
      continue;
    }
    // Fan-out: the outer step is scaffolding, the lane chain is the content.
    hasFanOut = true;
    const innerEffectiveById = byId(innerEffective);
    const innerBaselineById = byId(innerBaseline);
    const innerOrder = mergeOrder(
      diffing ? innerBaseline.map((inner) => inner.id) : null,
      innerEffective.map((inner) => inner.id),
    );
    for (const innerEntry of innerOrder) {
      chips.push(
        chipPropsFor(
          innerEffectiveById.get(innerEntry.id),
          innerBaselineById.get(innerEntry.id),
          // A removed OUTER step takes its whole lane with it.
          entry.kind === 'skip' ? 'skip' : innerEntry.kind,
          definition,
          targets,
          `tuning-lane-chip-${innerEntry.id}`,
        ),
      );
    }
  }
  return { chips, hasFanOut };
}

export function TuningPhaseStrip({
  definition,
  baselineDefinition,
  agentRunTargets,
}: TuningPhaseStripProps): React.JSX.Element {
  if (definition === null) {
    return (
      <p className="text-xs text-text-secondary" data-testid="tuning-phase-strip-unresolved">
        This flow&apos;s definition could not be resolved — open the advanced editor to repair it.
      </p>
    );
  }

  const diffing = baselineDefinition !== null;
  const effectivePhases = byId(definition.phases);
  const baselinePhases = baselineDefinition === null ? null : byId(baselineDefinition.phases);
  const phaseOrder = mergeOrder(
    baselineDefinition === null ? null : baselineDefinition.phases.map((phase) => phase.id),
    definition.phases.map((phase) => phase.id),
  );

  return (
    <div className="flex flex-col gap-4" data-testid="tuning-phase-strip">
      {phaseOrder.map((entry) => {
        const effectivePhase = effectivePhases.get(entry.id);
        const baselinePhase = baselinePhases?.get(entry.id);
        const phase = effectivePhase ?? baselinePhase;
        if (phase === undefined) return null;
        const { chips, hasFanOut } = phaseChips(
          effectivePhase,
          baselinePhase,
          definition,
          agentRunTargets,
          diffing,
        );
        return (
          <div
            key={entry.id}
            className="relative"
            style={{
              border: '1px dashed var(--color-text-tertiary)',
              padding: '16px 14px 12px',
            }}
            data-testid={`tuning-phase-group-${entry.id}`}
          >
            {/* The label floats ON the band's top rule, masked by the page's own
                surface — the canvas's phase-band language, chip-sized. */}
            <span
              className="absolute text-[9px] uppercase"
              style={{
                top: -7,
                left: 8,
                padding: '0 6px',
                background: 'var(--color-bg-primary)',
                letterSpacing: '0.18em',
                whiteSpace: 'nowrap',
                color: phase.color,
              }}
            >
              {hasFanOut ? `${phase.label} · per task ⇄` : phase.label}
            </span>
            <div className="flex flex-row flex-wrap items-stretch" style={{ gap: 6 }}>
              {chips.map((chip) => (
                <StepChip key={chip.testId} {...chip} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
