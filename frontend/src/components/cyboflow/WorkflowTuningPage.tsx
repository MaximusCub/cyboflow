/**
 * WorkflowTuningPage — the SIMPLE page of {@link WorkflowEditorModal}, and the
 * default view for a built-in flow (plan `docs/plans/workflow-tuning-levels.md`
 * §4).
 *
 * One dial (Efficient / Standard / Thorough / Custom) over a strip showing what
 * that level actually runs, plus the two doors out: the advanced editor, and
 * deleting the custom definition when one exists.
 *
 * Deliberately presentational — the host modal owns every mutation, the busy
 * latch and the error surface, so this page has no tRPC import and stays
 * testable as a pure render of (level, definition, slot-filled).
 */
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import type { TuningLevel } from '../../../../shared/tuning/workflowTuning';
import { TuningLevelDial } from './TuningLevelDial';
import { TuningPhaseStrip } from './TuningPhaseStrip';

export interface WorkflowTuningPageProps {
  /** The selected level (the workflow's stamped level until the user changes it). */
  level: TuningLevel;
  /** Is the custom slot filled? Gates the CUSTOM segment and the delete action. */
  hasCustomDefinition: boolean;
  /** The SELECTED level's effective definition — what the strip renders. */
  definition: WorkflowDefinition | null;
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
  busy,
  onSelectLevel,
  onOpenAdvanced,
  onDeleteCustom,
  estimateLabels,
}: WorkflowTuningPageProps): React.JSX.Element {
  return (
    <div
      className="flex flex-1 flex-col gap-5 overflow-auto p-5"
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

      <div className="flex flex-col gap-2">
        <span
          className="text-[9px] font-semibold uppercase text-text-tertiary"
          style={{ letterSpacing: '0.14em' }}
        >
          What runs at this level
        </span>
        <TuningPhaseStrip definition={definition} />
      </div>

      <div className="flex flex-row items-center gap-3">
        <button
          type="button"
          onClick={onOpenAdvanced}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover"
          data-testid="tuning-open-advanced"
        >
          Open advanced editor →
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
