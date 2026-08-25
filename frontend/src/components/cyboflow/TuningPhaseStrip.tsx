/**
 * TuningPhaseStrip — "what runs at this level", rendered from an EFFECTIVE
 * definition (plan `docs/plans/workflow-tuning-levels.md` §4).
 *
 * The strip is DERIVED, never hand-maintained: the caller resolves the selected
 * level through the shared transform (`resolveEffectiveDefinition`) and passes
 * the result here, so a recalibrated preset or an edited custom slot changes
 * this view with no edit to the component. A step removed by a preset simply
 * isn't in the definition, so it isn't a chip — the strip shows what runs, not
 * a diff against Standard.
 *
 * Fan-out inner steps are chips too (nested under their outer step): on sprint
 * the lane chain IS the thing a level changes most, and a strip that showed only
 * the outer `execute-tasks` step would hide the whole calibration.
 *
 * A chip's sub-label is `model · effort` from the definition's `agentConfigs`
 * entry for that step's canonical agent key — the same key resolution the editor
 * canvas uses, so a legacy step label and its canonical key agree on which pin
 * applies. Steps with no pin show no sub-label (they inherit the run model);
 * human gates carry no model at all and get the outlined gate treatment.
 */
import type {
  FanOutInnerStep,
  WorkflowAgentConfig,
  WorkflowDefinition,
  WorkflowStep,
} from '../../../../shared/types/workflows';
import { HUMAN_GATE_AGENT, resolveStepAgentKey } from '../../../../shared/types/agentIdentity';

export interface TuningPhaseStripProps {
  /**
   * The selected level's effective definition. `null` when it could not be
   * resolved (a custom flow with a missing/unparseable spec) — the strip then
   * renders an honest placeholder rather than an empty frame.
   */
  definition: WorkflowDefinition | null;
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

interface ChipProps {
  label: string;
  agentKey: string;
  isHumanGate: boolean;
  isOptional: boolean;
  pin: string | null;
  testId: string;
  /** Inner (lane) chips are indented and carry the fan-out accent. */
  inner?: boolean;
}

function StepChip({
  label,
  agentKey,
  isHumanGate,
  isOptional,
  pin,
  testId,
  inner = false,
}: ChipProps): React.JSX.Element {
  return (
    <div
      className="flex flex-col gap-0.5 px-2 py-1.5"
      style={{
        minWidth: 108,
        // Human gates read as outlined/dashed (no agent runs them); lane chips
        // borrow the canvas's fan-out accent so the nesting is legible.
        border: isHumanGate
          ? '1.2px dashed var(--color-human)'
          : `1.2px solid ${inner ? 'var(--color-status-error)' : 'var(--color-border-primary)'}`,
        background: isHumanGate ? 'transparent' : 'var(--color-surface-primary)',
        opacity: isOptional ? 0.7 : 1,
      }}
      data-testid={testId}
    >
      <span className="text-[10.5px] font-semibold text-text-primary leading-tight">{label}</span>
      <span className="text-[9px] text-text-tertiary" style={{ letterSpacing: '0.06em' }}>
        {isHumanGate ? 'human gate' : agentKey}
        {isOptional && ' · optional'}
      </span>
      {pin !== null && (
        <span className="text-[9px] text-text-secondary" data-testid={`${testId}-pin`}>
          {pin}
        </span>
      )}
    </div>
  );
}

/** Resolve the canonical agentConfigs key for an outer or inner step. */
function agentKeyOf(step: WorkflowStep | FanOutInnerStep): string {
  return resolveStepAgentKey(step.id, step.agent) ?? step.agent;
}

export function TuningPhaseStrip({ definition }: TuningPhaseStripProps): React.JSX.Element {
  if (definition === null) {
    return (
      <p className="text-xs text-text-secondary" data-testid="tuning-phase-strip-unresolved">
        This flow&apos;s definition could not be resolved — open the advanced editor to repair it.
      </p>
    );
  }

  return (
    <div className="flex flex-row flex-wrap items-start gap-4" data-testid="tuning-phase-strip">
      {definition.phases.map((phase) => (
        <div
          key={phase.id}
          className="flex flex-col gap-1.5 p-2"
          style={{ border: '1px dashed var(--color-border-primary)' }}
          data-testid={`tuning-phase-group-${phase.id}`}
        >
          <span
            className="text-[9px] font-semibold uppercase"
            style={{ letterSpacing: '0.14em', color: phase.color }}
          >
            {phase.label}
          </span>
          <div className="flex flex-row flex-wrap items-start gap-1.5">
            {phase.steps.map((step) => {
              const agentKey = agentKeyOf(step);
              return (
                <div key={step.id} className="flex flex-col gap-1.5">
                  <StepChip
                    label={step.name}
                    agentKey={agentKey}
                    isHumanGate={step.agent === HUMAN_GATE_AGENT}
                    isOptional={step.optional === true}
                    pin={pinLabel(definition.agentConfigs?.[agentKey])}
                    testId={`tuning-step-chip-${step.id}`}
                  />
                  {step.fanOut !== undefined && step.fanOut.inner.length > 0 && (
                    <div
                      className="flex flex-col gap-1 pl-2"
                      style={{ borderLeft: '1.2px solid var(--color-status-error)' }}
                      data-testid={`tuning-lane-chain-${step.id}`}
                    >
                      {step.fanOut.inner.map((inner) => {
                        const innerKey = agentKeyOf(inner);
                        return (
                          <StepChip
                            key={inner.id}
                            label={
                              inner.name !== undefined && inner.name.trim().length > 0
                                ? inner.name
                                : inner.id
                            }
                            agentKey={innerKey}
                            isHumanGate={inner.agent === HUMAN_GATE_AGENT}
                            isOptional={inner.optional === true}
                            pin={pinLabel(definition.agentConfigs?.[innerKey])}
                            testId={`tuning-lane-chip-${inner.id}`}
                            inner
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
