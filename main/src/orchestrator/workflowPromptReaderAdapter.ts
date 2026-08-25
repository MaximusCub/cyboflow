/**
 * workflowPromptReaderAdapter — the concrete `WorkflowPromptReaderLike.read`
 * logic that `RunExecutor.getPrompt` drives, extracted from `main/src/index.ts`
 * so it is unit-testable without bootstrapping Electron.
 *
 * It branches on the run's workflow row:
 *   - Built-in / edited built-in flow (non-null `workflow_path`): read the `.md`
 *     body + its `system_prompt_append` frontmatter via `readWorkflowPrompt`,
 *     then concatenate the per-run cyboflow prompt appends derived from the
 *     EFFECTIVE definition: the step-reporting instructions (TASK-803) followed
 *     by the fan-out execution instructions derived from each step's `fanOut`
 *     spec. Fail-soft: a non-SoloFlow / broken-spec workflow yields '' for both
 *     so nothing extra is injected.
 *   - Custom flow (null `workflow_path`, graph in `spec_json`): there is no `.md`
 *     prose, so render the orchestrator prompt from the resolved step graph via
 *     `renderCustomFlowPrompt`. The step-reporting + fan-out appends still ride on
 *     `systemPromptAppend`. An unresolvable definition is a hard error
 *     (`WorkflowPromptReadError`) — the run cannot proceed without a graph.
 *
 * ── Which definition the appends derive from (tuning levels, plan D9) ─────────
 * A LIVE RUN passes a {@link RunPromptContext} carrying its FROZEN spec — the
 * same `(workflow_id, spec_hash)` -> `workflow_revisions` text every other
 * per-run reader resolves through (`resolveRunFanOutInner`,
 * `readWorkflowAgentConfigs`, the merge gate). Deriving the prompt from the live
 * `workflows.spec_json` instead would put the prompt and the machinery on two
 * different graphs, and a tuning level makes them genuinely differ: an
 * `efficient` sprint freezes a preset spec with lane steps removed while the
 * workflow row's slot still reads `'{}'`. The orchestrator would then be told to
 * drive `write-tests` / `code-review` / `visual-verify` while
 * `cyboflow_update_sprint_task` REJECTS those ids as out-of-vocabulary.
 *
 * Omitting the context (the workflow-preview read at the tRPC seam, and older
 * callers) falls back to the live `workflows.spec_json` — byte-identical to this
 * module's behaviour before the context existed.
 *
 * Depends only on `fs` (transitively, via `readWorkflowPrompt`) + pure helpers —
 * no Electron / concrete-DB imports — so it is trivially testable in plain vitest.
 */
import type { WorkflowRow } from '../../../shared/types/workflows';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import { isTuningLevel, type TuningLevel } from '../../../shared/tuning/workflowTuning';
import type { DatabaseLike } from './types';
import { resolveRunFrozenSpec } from './runFrozenSpec';
import {
  readWorkflowPrompt,
  WorkflowPromptReadError,
  type WorkflowPrompt,
} from './workflowPromptReader';
import { buildStepReportingAppend } from './prompts/step-reporting-instructions';
import { buildFanOutAppend } from './prompts/fan-out-instructions';
import { renderCustomFlowPrompt } from './customFlowPrompt';

/**
 * The per-RUN facts the prompt build needs beyond the workflow row: the exact
 * definition the run froze, and the tuning level it froze at.
 */
export interface RunPromptContext {
  /**
   * The run's frozen spec text (`null` when the run resolved none — the reader
   * then falls back to the workflow row's live slot).
   */
  specJson: string | null;
  /**
   * The run's stamped `workflow_runs.tuning_level`. `null` is UNATTRIBUTED — a
   * pre-feature run, a variant run, or a non-built-in flow — and must render the
   * same prompt text as `'standard'`, never a level-specific variation.
   */
  tuningLevel: TuningLevel | null;
}

/**
 * Resolve a live run's {@link RunPromptContext} from the DB: its frozen spec via
 * the shared `resolveRunFrozenSpec` contract plus its `tuning_level` stamp.
 *
 * Fail-soft throughout, mirroring `resolveRunFrozenSpec`'s own posture: a missing
 * run row returns `null` (the caller falls back to the live workflow row) and a
 * DB without the migration-122 column degrades to an unattributed level rather
 * than breaking the spawn.
 */
export function resolveRunPromptContext(db: DatabaseLike, runId: string): RunPromptContext | null {
  const frozen = resolveRunFrozenSpec(db, runId);
  if (frozen === null) return null;

  let tuningLevel: TuningLevel | null = null;
  try {
    const row = db
      .prepare('SELECT tuning_level AS tuningLevel FROM workflow_runs WHERE id = ?')
      .get(runId) as { tuningLevel?: unknown } | undefined;
    if (isTuningLevel(row?.tuningLevel)) tuningLevel = row.tuningLevel;
  } catch {
    // Pre-122 DB (no such column) → unattributed, which renders today's text.
    tuningLevel = null;
  }

  return { specJson: frozen.specJson, tuningLevel };
}

/** Join the non-empty prompt-append fragments with a blank-line separator. */
function joinAppends(parts: string[]): string {
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * Resolve the run-prompt (+ systemPromptAppend) for a workflow row. See the
 * module doc for the built-in vs custom-flow branch contract and for why a live
 * run passes `run`.
 *
 * @throws {WorkflowPromptReadError} when a built-in `.md` is missing/empty
 *   (bubbled from `readWorkflowPrompt`) or when a custom flow has no resolvable
 *   definition.
 */
export function readWorkflowPromptForRow(
  workflow: WorkflowRow,
  run?: RunPromptContext | null,
): WorkflowPrompt {
  const specJson = run != null ? run.specJson : workflow.spec_json;
  const resolvedDef = resolveWorkflowDefinition(workflow.name, specJson);
  // Per-run cyboflow appends, both derived from the SAME resolved definition:
  // step-reporting first, then the fan-out execution instructions. Either is ''
  // (fail-soft) when the def is null / carries no matching steps.
  const workflowAppends = [
    buildStepReportingAppend(resolvedDef),
    buildFanOutAppend(resolvedDef, { tuningLevel: run?.tuningLevel ?? null }),
  ];

  if (workflow.workflow_path) {
    const base = readWorkflowPrompt(workflow.workflow_path);
    const systemPromptAppend = joinAppends([base.systemPromptAppend, ...workflowAppends]);
    return { prompt: base.prompt, systemPromptAppend };
  }

  if (resolvedDef === null) {
    throw new WorkflowPromptReadError(
      `promptReader.read: custom flow ${workflow.id} has no resolvable definition`,
    );
  }
  return {
    prompt: renderCustomFlowPrompt(resolvedDef),
    systemPromptAppend: joinAppends(workflowAppends),
  };
}
