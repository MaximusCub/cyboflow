/**
 * WorkflowTuningPage — the SIMPLE page of {@link WorkflowEditorModal}, and the
 * default view for a built-in flow (plan `docs/plans/workflow-tuning-levels.md`
 * §4).
 *
 * One dial (Efficient / Standard / Thorough / Custom) over a strip showing what
 * that level actually runs — diffed against Standard, so what a preset TAKES
 * AWAY is as visible as what it keeps — plus the two doors out: the advanced
 * editor, and deleting the custom definition when one exists.
 *
 * Deliberately presentational — the host modal owns every mutation, the busy
 * latch and the error surface, so this page has no tRPC import and stays
 * testable as a pure render of (level, definition, baseline, slot-filled).
 */
import type { AgentRunTarget } from '../../../../shared/types/agents';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import type { TuningLevel } from '../../../../shared/tuning/workflowTuning';
import { TuningLevelDial } from './TuningLevelDial';
import { TuningModelLegend, TuningPhaseStrip } from './TuningPhaseStrip';

export interface WorkflowTuningPageProps {
  /** The selected level (the workflow's stamped level until the user changes it). */
  level: TuningLevel;
  /** Is the custom slot filled? Gates the CUSTOM segment and the delete action. */
  hasCustomDefinition: boolean;
  /** The SELECTED level's effective definition — what the strip renders. */
  definition: WorkflowDefinition | null;
  /** The SAME flow at `'standard'` — what the strip diffs against. */
  baselineDefinition: WorkflowDefinition | null;
  /** Per-agent catalogue run targets — the strip's model-tag fallback. */
  agentRunTargets?: Readonly<Record<string, AgentRunTarget>>;
  /** True while a level write / reset is in flight. */
  busy: boolean;
  onSelectLevel: (level: TuningLevel) => void;
  onOpenAdvanced: () => void;
  onDeleteCustom: () => void;
  /** Optional per-level estimate lines (a later phase's `run_usage` medians). */
  estimateLabels?: Partial<Record<TuningLevel, string>>;
}

export function WorkflowTuningPage({
  level,
  hasCustomDefinition,
  definition,
  baselineDefinition,
  agentRunTargets,
  busy,
  onSelectLevel,
  onOpenAdvanced,
  onDeleteCustom,
  estimateLabels,
}: WorkflowTuningPageProps): React.JSX.Element {
  return (
    <div
      className="flex flex-1 flex-col overflow-auto"
      style={{ gap: 20, padding: '22px 22px 26px' }}
      data-testid="workflow-tuning-page"
    >
      <TuningLevelDial
        level={level}
        hasCustomDefinition={hasCustomDefinition}
        onSelect={onSelectLevel}
        // Clicking the unavailable CUSTOM segment is the discovery path to the
        // only place a custom definition can come from.
        onCustomUnavailable={onOpenAdvanced}
        busy={busy}
        estimateLabels={estimateLabels}
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-row items-baseline gap-3.5">
          <span
            className="text-[10px] font-bold uppercase text-text-tertiary"
            style={{ letterSpacing: '0.18em' }}
          >
            What runs at this level
          </span>
          <span className="flex-1" />
          <TuningModelLegend />
        </div>
        <TuningPhaseStrip
          definition={definition}
          baselineDefinition={baselineDefinition}
          agentRunTargets={agentRunTargets}
        />
      </div>

      <div className="flex flex-col items-start gap-2">
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="flex w-full flex-row items-center gap-2.5 border border-border-primary bg-surface-primary text-left hover:bg-bg-hover"
          style={{ padding: '10px 14px' }}
          data-testid="tuning-open-advanced"
        >
          <span
            className="text-[10px] font-bold uppercase text-text-primary"
            style={{ letterSpacing: '0.16em' }}
          >
            Open advanced editor
          </span>
          <span className="text-[9.5px] text-text-tertiary">
            step graph · agents · MCPs · variants — the full editor, unchanged
          </span>
          <span className="flex-1" />
          <span className="text-[11px] text-text-primary">→</span>
        </button>

        {hasCustomDefinition && (
          <button
            type="button"
            onClick={onDeleteCustom}
            disabled={busy}
            className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-status-error hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="tuning-delete-custom"
          >
            Delete custom definition
          </button>
        )}
      </div>
    </div>
  );
}
