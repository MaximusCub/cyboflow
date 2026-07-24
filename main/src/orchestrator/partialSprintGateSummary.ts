/**
 * partialSprintGateSummary — composes the enriched decision-item body for a
 * sprint/ship run's terminal `human-review` gate when the fan-out settled with
 * one or more FAILED lanes (Item 2).
 *
 * Why: the escalation already exists — a failed lane increments the controller's
 * incompleteCount, which skips the automated closing stages (sprint-verify /
 * sprint-review) and parks the run at the terminal human gate (see
 * workflowController `skipToHumanGate` and sprint.md's closing-stage gate). But
 * the gate that opens carried only the generic "a human decision is required"
 * body, so a human had to open the swimlane to learn WHICH lanes failed and how
 * far they got. This composes that per-lane picture into the gate body itself.
 *
 * Scope: this reads what is ALREADY persisted per lane at gate-open time — the
 * task ref/title, the inner step the lane died on (`current_step_id`), and the
 * attempt count (`attempts`). It does NOT surface each attempt's failure TEXT:
 * the controller does not retain per-attempt error text today (only the
 * closure-local visual `pendingLoopbackFeedback` + systemic error), so that
 * richer detail is a follow-up requiring a per-lane failure-text accumulator.
 *
 * Self-contained: a direct SQL read over sprint_batch_tasks (LEFT JOIN tasks),
 * matching HumanStepManager's own direct-DB style — no SprintLaneStore import, so
 * the standalone-typecheck invariant (no electron/better-sqlite3/services) holds.
 */
import type { DatabaseLike } from './types';

interface FailedLaneRow {
  task_id: string;
  ref: string | null;
  title: string | null;
  current_step_id: string | null;
  attempts: number;
}

/**
 * Compose an enriched gate body for a run's terminal human gate, or return null
 * when the run has no batch OR no failed lanes (leaving the caller's generic body
 * unchanged). Fail-soft: any read error returns null (the gate still opens with
 * the generic body — surfacing must never block the escalation itself).
 *
 * `stepName` is the human-readable gate name (e.g. "Human review") woven into the
 * lead line so the body reads naturally regardless of the flow.
 */
export function composePartialSprintGateBody(
  db: DatabaseLike,
  runId: string,
  stepName: string,
): string | null {
  let rows: FailedLaneRow[];
  try {
    rows = db
      .prepare(
        `SELECT sbt.task_id AS task_id, sbt.current_step_id AS current_step_id,
                sbt.attempts AS attempts, t.ref AS ref, t.title AS title
           FROM sprint_batch_tasks sbt
           LEFT JOIN tasks t ON t.id = sbt.task_id
          WHERE sbt.batch_id = (SELECT batch_id FROM workflow_runs WHERE id = ?)
            AND sbt.status = 'failed'
          ORDER BY t.ref IS NULL, t.ref, sbt.task_id`,
      )
      .all(runId) as FailedLaneRow[];
  } catch {
    return null; // no batch table / read error → generic body
  }

  if (rows.length === 0) return null; // clean sprint (or non-sprint run) → generic body

  const n = rows.length;
  const lines: string[] = [
    `This sprint reached **${stepName}** with **${n} failed lane${n === 1 ? '' : 's'}** — its ` +
      `automated closing checks (full-suite verify + cross-task review) were skipped so you can ` +
      `decide what to do with the partial sprint first.`,
    '',
    '**Failed lanes**',
  ];
  for (const r of rows) {
    const label = r.ref ? `\`${r.ref}\`${r.title ? ` — ${r.title}` : ''}` : `\`${r.task_id}\``;
    const step = r.current_step_id ? `\`${r.current_step_id}\`` : 'an early step';
    // `attempts`: 0 = first pass (never re-delegated), >=2 once implement re-ran.
    // Present it as a human 1-based attempt count (a lane that failed on its first
    // pass reads "after 1 attempt", one that exhausted the 3× cap reads "3").
    const attemptCount = r.attempts >= 2 ? r.attempts : 1;
    lines.push(
      `- ${label} — failed at ${step} after ${attemptCount} attempt${attemptCount === 1 ? '' : 's'}.`,
    );
  }
  lines.push(
    '',
    'Approve to seal the partial sprint (each failed lane\'s task returns to the backlog), or ' +
      'reject to end the run. To re-drive a failed lane with guidance, rewind the run to the ' +
      'execute step.',
  );
  return lines.join('\n');
}
