/**
 * sessionRunScope — resolve one run id into every run its SESSION owns.
 *
 * WHY THIS EXISTS. A chat turn's `CYBOFLOW_RUN_ID` is never the flow run whose
 * work the human is talking about. `chatSentinelProvider` binds every chat turn
 * — in a quick session AND in a flow session the human opens a chat panel on —
 * to the session's persistent `__quick__` sentinel (`sessions.chat_run_id`), so
 * a run-bound read like `cyboflow_list_run_findings` queries the sentinel, finds
 * nothing, and replies `{ findings: [] }`. That empty is indistinguishable from
 * "the run filed nothing", which is exactly how a session agent asked to act on
 * its own run's findings concludes the findings are unreadable and stops.
 *
 * The forward link that fixes it already exists: `workflow_runs.session_id`
 * (migration 019, backfilled by 041), stamped by `workflowRegistry.createRun`
 * for the sentinel and for every flow run a session hosts. One session owns many
 * runs over its lifetime — the flow run, its handovers and reopens, and the chat
 * sentinel — and they all share one worktree and one branch, so "the findings
 * this session's work produced" is the honest unit for a human-facing triage
 * read, not "the findings this one run id filed".
 *
 * FAIL-SOFT BY CONSTRUCTION. Every failure mode collapses to `[runId]`, the
 * pre-existing single-run behavior: a schema with no `session_id` column (the
 * migration-subset test fixtures), a run with `session_id IS NULL` (a legacy
 * parentless flow run), a missing run row, or any SQL error. Widening is a
 * strict improvement when it works and a no-op when it cannot, so no caller
 * needs a capability check of its own.
 *
 * Standalone-typecheck invariant: no electron, no better-sqlite3, no
 * main/src/services — just the narrow DatabaseLike.
 */
import type { DatabaseLike } from './types';

/**
 * Every run id owned by the session that owns `runId`, always including `runId`
 * itself, deduped and with `runId` first.
 *
 * Ordering is deliberate: `runId` leads so a consumer that shows only the head
 * of the list still shows the caller's own run, and the remainder is ordered by
 * `created_at` so the session's runs read chronologically.
 */
export function selectSessionRunScope(db: DatabaseLike, runId: string): string[] {
  let rows: Array<{ id?: unknown }> = [];
  try {
    rows = db
      .prepare(
        `SELECT r2.id AS id
           FROM workflow_runs r1
           JOIN workflow_runs r2 ON r2.session_id = r1.session_id
          WHERE r1.id = ? AND r1.session_id IS NOT NULL
          ORDER BY r2.created_at ASC, r2.id ASC`,
      )
      .all(runId) as Array<{ id?: unknown }>;
  } catch {
    // No session_id column (pre-019 schema / a migration-subset fixture) — the
    // single-run scope is the correct, unwidened answer.
    return [runId];
  }

  const scope = [runId];
  for (const row of rows) {
    const id = row.id;
    if (typeof id === 'string' && id.length > 0 && !scope.includes(id)) scope.push(id);
  }
  return scope;
}
