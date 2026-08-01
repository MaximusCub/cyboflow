/**
 * laneChainResolution — resolve a run's LANE STEP VOCABULARY from its resolved
 * (frozen) workflow definition, instead of the fixed SPRINT_LANE_STEP_IDS
 * default.
 *
 * Workflow steps now declare a structured `fanOut` spec (shared/types/workflows.ts)
 * whose `inner[].id`s ARE the sprint-lane step vocabulary — user-editable via the
 * workflow editor (spec_json). The programmatic plane already derives its lane
 * driving straight from `step.fanOut.inner` (programmatic/workflowController.ts
 * runFanOut). This module is the ORCHESTRATED-plane mirror: given a runId, walk
 * its resolved definition (resolveRunFrozenSpec + resolveWorkflowDefinition — the
 * SAME frozen-spec contract every other per-run reader uses, e.g.
 * mcpQueryHandler.handleReportStep) and return the id-deduped UNION of every
 * fanOut-bearing step's inner chain (see resolveRunFanOutInner's doc for why the
 * union, not just the first match). Three seams share this single resolution so
 * they can't drift from one another or from the programmatic plane:
 *   - mcpQueryHandler.handleUpdateSprintTask  (allowedStepIds for the MCP write)
 *   - sprintLaneStore.deriveLaneFromTaskDispatch (the PreToolUse auto-derive backstop)
 *   - verify/mergeGateLaneAdvance.ts          (the visual merge-gate's advance/loopback ids)
 *
 * Fail-soft by design: returns null when the run/definition is unresolvable or no
 * step declares `fanOut`. Every caller treats null as "fall back to the canonical
 * SPRINT_LANE_STEP_IDS / SPRINT_SUBAGENT_TO_LANE_STEP defaults", so an unedited
 * sprint/ship run (and any pre-fanOut-generalization DB) is byte-identical to
 * before this module existed.
 *
 * Standalone-typecheck invariant: reads through the narrow DatabaseLike surface
 * only (via resolveRunFrozenSpec) and imports only pure shared types — no
 * 'electron' / 'better-sqlite3' / service import. Safe for the callers above,
 * which carry the same invariant.
 */
import type { DatabaseLike } from './types';
import { resolveRunFrozenSpec } from './runFrozenSpec';
import { resolveWorkflowDefinition } from '../../../shared/types/workflows';
import type { FanOutInnerStep, WorkflowDefinition } from '../../../shared/types/workflows';
import { SPRINT_VISUAL_VERIFY_STEP } from '../../../shared/types/sprintBatch';

/**
 * Resolve the run's fan-out lane vocabulary — the inner chains of EVERY step
 * carrying a `fanOut` spec in the run's resolved definition, concatenated in
 * phases/steps walk order and deduplicated by step id (first occurrence wins).
 *
 * ALL fan-out steps contribute, not just the first, because the orchestrated
 * prompt generator (`buildFanOutAppend`, prompts/fan-out-instructions.ts) emits
 * one instruction section PER fanOut step — an edited workflow with two fan-out
 * steps instructs the orchestrator to write the SECOND chain's step ids too,
 * and a first-chain-only vocabulary here would reject those valid writes as
 * out-of-vocabulary. v1 built-ins declare exactly one fan-out step, for which
 * the union IS that step's inner chain — byte-identical to before.
 *
 * Multi-fan-out caveat (edited workflows only): consumers that pick ONE id out
 * of the chain (mergeGateLaneAdvance's default loopback, the dispatch
 * backstop's agent→step map) resolve against the merged chain, so a canonical
 * id appearing in both chains resolves to its first occurrence.
 *
 * Returns null when the run row is missing, the definition fails to resolve
 * (resolveWorkflowDefinition returns null), or no step contributes any inner
 * id — every caller treats null as the canonical-fallback signal.
 */
export function resolveRunFanOutInner(db: DatabaseLike, runId: string): readonly FanOutInnerStep[] | null {
  const row = resolveRunFrozenSpec(db, runId);
  if (!row) return null;
  const def = resolveWorkflowDefinition(row.workflowName, row.specJson);
  if (def === null) return null;
  const seen = new Set<string>();
  const union: FanOutInnerStep[] = [];
  for (const phase of def.phases) {
    for (const step of phase.steps) {
      if (step.fanOut === undefined) continue;
      for (const innerStep of step.fanOut.inner) {
        if (seen.has(innerStep.id)) continue;
        seen.add(innerStep.id);
        union.push(innerStep);
      }
    }
  }
  return union.length > 0 ? union : null;
}

/**
 * Does this workflow definition contain a CONTROLLER-OWNED visual-verify step —
 * i.e. a fan-out inner step whose id is {@link SPRINT_VISUAL_VERIFY_STEP}, the
 * one the programmatic controller drives agentlessly (workflowController.runFanOut)
 * by enqueuing the verification itself and parking the lane?
 *
 * WHY THIS PREDICATE EXISTS. Two seams reject `cyboflow_request_verification`
 * whenever a run's execution model is `programmatic` — the per-spawn deny list
 * (programmatic/spawnStepRunner.ts) and the MCP ownership guard
 * (mcpServer/mcpQueryHandler.handleRequestVerification). Both were written for
 * sprint/ship, where the controller IS the only legitimate enqueuer and a step
 * turn firing the tool itself creates an unkeyed request that races the merge
 * gate (observed live 2026-07-22). Both encoded that as "programmatic ⇒ deny",
 * which silently assumed every programmatic run has a controller-owned enqueue.
 *
 * `verify-setup` broke the assumption. It resolves programmatic like everything
 * else (the global default floors SDK runs to programmatic), has NO fan-out and
 * therefore no controller-owned visual-verify step, and its `prove` step's whole
 * deliverable is firing a `setup_proof` verification — which both guards denied,
 * making the one flow that bootstraps verification structurally incapable of
 * doing so (found by the first live dogfood run, 2026-07-31; invisible to unit
 * tests because deny list, flow definition, and gate are each correct alone).
 *
 * So the real question is not "is this run programmatic?" but "does a controller
 * own the enqueue on this run?" — and the answer is exactly whether the chain the
 * controller walks has the step it would enqueue from. A run with no such step
 * has no enqueue to race, so the agent is the only party that can fire one.
 *
 * Deliberately keyed on the STEP ID, not the workflow name: an edited sprint that
 * renames/removes `visual-verify` genuinely loses its controller-owned enqueue
 * (the controller keys on the same literal), and a custom flow that adds one
 * genuinely gains it. Name-matching would get both backwards.
 */
export function definitionHasControllerVisualVerify(def: WorkflowDefinition): boolean {
  return def.phases.some((phase) =>
    phase.steps.some(
      (step) => step.fanOut?.inner.some((innerStep) => innerStep.id === SPRINT_VISUAL_VERIFY_STEP) === true,
    ),
  );
}

/**
 * {@link definitionHasControllerVisualVerify} resolved from a runId, for the
 * seams that hold a DB handle rather than the definition (the MCP socket).
 * Resolves through the SAME frozen-spec contract as
 * {@link resolveRunFanOutInner}, so the guard and the controller can never
 * disagree about which chain a live run is walking.
 *
 * FAIL-CLOSED on an unresolvable definition: `resolveRunFanOutInner` returns null
 * for a missing run row, an unparseable spec, OR a definition with no fan-out at
 * all, and those cases are not distinguishable here. The callers use this to
 * decide whether to DENY a verification enqueue, so an unresolvable run keeps
 * today's deny posture — a wrongly-denied setup proof surfaces as an actionable
 * tool error, while a wrongly-allowed one races a live sprint's merge gate.
 */
export function runHasControllerVisualVerify(db: DatabaseLike, runId: string): boolean {
  const row = resolveRunFrozenSpec(db, runId);
  if (!row) return true;
  const def = resolveWorkflowDefinition(row.workflowName, row.specJson);
  if (def === null) return true;
  return definitionHasControllerVisualVerify(def);
}
