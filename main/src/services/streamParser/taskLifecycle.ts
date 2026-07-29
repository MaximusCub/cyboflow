/**
 * Background-task lifecycle vocabulary, shared by the turn-boundary tracker
 * (claudeCodeManager.trackBackgroundTasks) and the transcript projection
 * (MessageProjection.projectSystemEvent).
 *
 * SDK >=0.3.201 backgrounds Agent-tool subagents, and `local_bash` background
 * commands share the lifecycle: `task_started` opens a task, and EITHER a
 * settled `task_updated` patch OR a `task_notification` closes it. Both
 * consumers must agree on what "settled" means — a task the tracker retires but
 * the projection ignores is a task whose failure never reaches the user.
 */

/**
 * Statuses that still count as LIVE. Anything OUTSIDE this set settles the task
 * (completed / failed / cancelled / killed / future terminal vocab) — defaulting
 * unknown statuses to settled keeps a missed vocabulary word from wedging a turn
 * open forever.
 */
export const LIVE_TASK_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'pending',
  'queued',
  'in_progress',
]);

/** True when `status` settles a background task. */
export function isTerminalTaskStatus(status: string): boolean {
  return !LIVE_TASK_STATUSES.has(status);
}

/**
 * True when a settled status represents a FAILURE rather than clean completion.
 * A clean completion with nothing to report is fine to drop from the transcript;
 * a failure is the only terminal signal the user gets and must always surface.
 */
export function isFailedTaskStatus(status: string): boolean {
  return isTerminalTaskStatus(status) && status !== 'completed';
}
