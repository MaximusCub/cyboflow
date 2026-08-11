/**
 * Orchestrator-subtree handler for workflow-run list queries.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Only DatabaseLike (structural interface) is used.
 */
import type { DatabaseLike } from './types';
import type { WorkflowRunListRow } from '../../../shared/types/workflows';

/**
 * Name of the quick-session sentinel workflow (workflowRegistry's
 * QUICK_WORKFLOW_NAME). Re-declared rather than imported, as
 * chatSentinelProvider.ts does, to keep this module's standalone-typecheck
 * invariant — it must not pull in the registry's dependency graph.
 */
const QUICK_WORKFLOW_SENTINEL_NAME = '__quick__';

/**
 * Returns all workflow runs for a given project, ordered newest-first.
 *
 * The heavy snapshot column is excluded intentionally — callers that need
 * the full row should query workflow_runs directly.
 *
 * @param db        - Narrow DatabaseLike surface.
 * @param projectId - The project_id to filter by.
 * @returns Array of WorkflowRunListRow, newest first. Empty array when none exist.
 */
export function listRunsHandler(
  db: DatabaseLike,
  projectId: number,
): WorkflowRunListRow[] {
  return db
    .prepare(
      `SELECT id, workflow_id, project_id, status, worktree_path, branch_name,
              created_at, updated_at, started_at, ended_at, stuck_reason, substrate, session_id,
              batch_id, seed_idea_ids, permission_mode_snapshot, model, error_message, execution_model, variant_label,
              experiment_id, experiment_arm, agent_provider, agent_runtime, rail_dismissed_at
         FROM workflow_runs
        WHERE project_id = ?
        ORDER BY created_at DESC`,
    )
    .all(projectId) as WorkflowRunListRow[];
}

/** The run a session belongs to, resolved for display and for tagging. */
export interface SessionRunRef {
  runId: string;
  flowName: string | null;
}

/**
 * Resolve the newest workflow run belonging to a session, whatever its status.
 *
 * Deliberately NOT status-filtered. The rail's active-runs store only retains
 * runs in a non-terminal state, so resolving a run through it loses exactly the
 * runs a bug report is most likely to be about — the ones that already failed or
 * finished. Anything reporting a run id must therefore query here, not read the
 * rail.
 *
 * `flowName` is null for a quick session, whose run points at the internal
 * `__quick__` sentinel workflow — a real row, so the join finds it, but not a
 * flow anyone would recognize as one. The run id is the half that matters for
 * triage, so a nameless flow never suppresses the link — hence LEFT JOIN, which
 * also keeps the run id resolvable if a workflow row ever goes missing.
 */
export function resolveSessionRunHandler(
  db: DatabaseLike,
  sessionId: string,
): SessionRunRef | null {
  const row = db
    .prepare(
      `SELECT r.id AS runId, w.name AS flowName
         FROM workflow_runs r
         LEFT JOIN workflows w ON w.id = r.workflow_id
        WHERE r.session_id = ?
        ORDER BY r.created_at DESC
        LIMIT 1`,
    )
    .get(sessionId) as { runId: string; flowName: string | null } | undefined;
  if (!row) return null;
  const named = row.flowName && row.flowName !== QUICK_WORKFLOW_SENTINEL_NAME;
  return { runId: row.runId, flowName: named ? row.flowName : null };
}
