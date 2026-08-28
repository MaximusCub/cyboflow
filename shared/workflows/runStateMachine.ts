import type { WorkflowRunStatus } from '../types/cyboflow';

/**
 * Allowed state transitions for `workflow_runs.status`, per
 * `docs/cyboflow_system_design.md` §5.3.
 *
 * Source state -> set of target states it may transition to.
 * Terminal states (completed, failed, canceled) map to an empty set:
 * once a run reaches a terminal state, NO further transitions are legal —
 * not even same-status no-ops (e.g. completed -> completed is rejected).
 *
 * Rationale: the database CHECK constraint enforces "status is one of 10
 * values" but cannot enforce "this transition from A to B is legal".
 * This table is the in-process source of truth.
 *
 * `failed` is terminal to THIS state machine — but six sanctioned recovery
 * paths revive a failed (or, for retry/rewind, a resting awaiting_review) run
 * anyway, via a guarded raw `UPDATE workflow_runs SET status = ...` that
 * deliberately bypasses `assertTransitionAllowed` rather than widening the
 * table above:
 *   1. runRecovery.recoverActiveStateOrphans — boot sweep, resets stranded
 *      programmatic runs to 'starting'.
 *   2. reopenRunHandler — SDK-only failed -> running via --resume.
 *   3. reviveQuickRunToRunning (services/cyboflow/transitions.ts) —
 *      quick-session sentinel run repair, any status -> running.
 *   4. retryRunHandler — failed / resting-awaiting_review -> starting at a
 *      chosen step, programmatic-only.
 *   5. rewindRunHandler — running / awaiting_review / failed / paused ->
 *      starting at an EARLIER step, aborting a live walk first.
 *   6. chatSentinelProvider's `reviveChatSentinel` — the inlined orchestrator
 *      MIRROR of (3), kept in lockstep with it. It is the seam BOTH substrates
 *      funnel through (the interactive REPL has no revive seam of its own), so
 *      it is a distinct bypass site, not a duplicate of the transitions.ts one.
 * Each is a narrow, explicitly-reasoned escape hatch, not a general exception
 * to terminality.
 *
 * Every OTHER production write to `workflow_runs.status` must validate against
 * this table — either through a guarded helper in
 * `main/src/services/cyboflow/transitions.ts` (services-side callers) or, for
 * `main/src/orchestrator/**` code that may not import services at runtime, by
 * calling `assertTransitionAllowed` immediately before its raw UPDATE. The
 * surviving raw sites are frozen by
 * `main/src/orchestrator/__tests__/runStatusWriteChokepoint.test.ts`.
 */
export const ALLOWED_TRANSITIONS: Record<
  WorkflowRunStatus,
  readonly WorkflowRunStatus[]
> = {
  queued:          ['starting', 'canceled'],
  starting:        ['running', 'failed', 'canceled'],
  // running -> awaiting_input: the only way to enter awaiting_input — QuestionRouter
  // transitions atomically with the question INSERT (TASK-758).
  // running -> paused: SDK-only Pause from a live turn (Phase 4b). The active turn
  //   stops but claude_session_id + current_step_id are preserved for Resume.
  running:         ['awaiting_review', 'awaiting_input', 'completed', 'failed', 'canceled', 'stuck', 'paused'],
  // awaiting_review -> completed: the user accepted the run's artifact (Merge or
  //   Create-PR). The executor never auto-completes; a run RESTS in awaiting_review
  //   on SDK drain and only the user's accept decision drives it to completed.
  // awaiting_review -> running: existing approval cycle — an in-flight tool approval
  //   resolves back to running (transitionFromAwaitingReview).
  // awaiting_review -> paused: SDK-only Pause from an idle-rested run (Phase 4b).
  awaiting_review: ['running', 'completed', 'canceled', 'stuck', 'failed', 'paused'],
  // awaiting_input -> running: symmetric return when QuestionRouter.respond resolves.
  // awaiting_input -> canceled: user/system cancellation while a question is in flight.
  // awaiting_input -> failed: defensive — SDK loop crashed mid-question.
  // awaiting_input -> stuck is intentionally NOT allowed: per IDEA-025 Q2 resolution,
  // awaiting_input runs are exempt from stuck classification.
  awaiting_input:  ['running', 'canceled', 'failed'],
  // stuck -> completed: the user accepted the artifact of a run that the
  //   StuckDetector flagged (e.g. an orphaned PTY) but whose worktree still holds
  //   deliverable work. Merge / Create-PR is valid from a stuck run.
  stuck:           ['running', 'completed', 'canceled', 'failed'],
  // paused (Phase 4b, SDK-only, NON-terminal):
  //   paused -> running: Resume re-drives via the SDK --resume path
  //     (transitionPausedToRunning).
  //   paused -> canceled / failed: a paused run can still be canceled or fail.
  //   No paused -> completed/awaiting_review edge: Resume returns to 'running'
  //     first; the run rests/completes from there.
  paused:          ['running', 'canceled', 'failed'],
  completed:       [],
  failed:          [],
  canceled:        [],
};

/**
 * Pure predicate: is the (from -> to) transition allowed?
 * Returns false for any transition out of a terminal state, including
 * same-status no-ops.
 */
export function isTransitionAllowed(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * Typed error thrown when an illegal transition is attempted. Carries the
 * from/to states and the optional runId so callers can log a tight
 * forensic line without re-stringifying.
 */
export class IllegalTransitionError extends Error {
  public readonly from: WorkflowRunStatus;
  public readonly to: WorkflowRunStatus;
  public readonly runId: string | undefined;

  constructor(
    from: WorkflowRunStatus,
    to: WorkflowRunStatus,
    runId?: string,
  ) {
    const suffix = runId !== undefined ? ` (runId=${runId})` : '';
    super(`Illegal workflow_run status transition: ${from} -> ${to}${suffix}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
    this.runId = runId;
  }
}

/**
 * Assert variant: throws `IllegalTransitionError` if the transition is
 * not in `ALLOWED_TRANSITIONS`. Use this at the head of every code path
 * that issues an `UPDATE workflow_runs SET status = ?` statement.
 */
export function assertTransitionAllowed(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
  runId?: string,
): void {
  if (!isTransitionAllowed(from, to)) {
    throw new IllegalTransitionError(from, to, runId);
  }
}

/**
 * Assert a MULTI-SOURCE write: one `UPDATE ... WHERE status IN (a, b, c)` whose
 * SQL guard admits several source states. Every listed source must have a legal
 * edge to `to`.
 *
 * `from === to` entries are SKIPPED rather than rejected. Such a member is not a
 * transition at all — it is an idempotent RE-STAMP of the status the row already
 * holds, which several writers rely on (the approval-decision restore accepts a
 * run already back in 'running'; humanStepManager re-parks a run already in
 * 'awaiting_review' for a back-to-back gate). The terminal lockdown is unaffected:
 * a terminal source with a DIFFERENT target still throws, and no writer lists a
 * terminal status in an `IN (...)` guard whose target is that same status.
 */
export function assertTransitionAllowedFromAny(
  froms: readonly WorkflowRunStatus[],
  to: WorkflowRunStatus,
  runId?: string,
): void {
  for (const from of froms) {
    if (from === to) continue;
    assertTransitionAllowed(from, to, runId);
  }
}

/**
 * Every source state with a legal edge to `to` — the table read backwards.
 *
 * This is what a writer that cannot name a single `fromStatus` should guard on:
 * a close-out `UPDATE ... SET status='completed'` wants "the states completion is
 * reachable from", not a hand-maintained `NOT IN (terminal)` list that silently
 * admits 'queued' and 'starting'. Deriving it here keeps the guard and the table
 * from drifting apart.
 */
export function allowedSourcesFor(to: WorkflowRunStatus): readonly WorkflowRunStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as WorkflowRunStatus[]).filter(from =>
    ALLOWED_TRANSITIONS[from].includes(to),
  );
}

/**
 * {@link allowedSourcesFor} rendered as a SQL `IN` list — `('a', 'b')` — for
 * inlining into a guarded `UPDATE ... WHERE status IN ...`.
 *
 * Safe to interpolate: every element is a `WorkflowRunStatus` key of the table
 * above, never caller input. Throws for a target no state can reach, so a typo'd
 * call can never render `IN ()` (a SQL syntax error at prepare time in some
 * builds, and a silently-never-matching guard in others).
 */
export function allowedSourcesSqlIn(to: WorkflowRunStatus): string {
  const sources = allowedSourcesFor(to);
  if (sources.length === 0) {
    throw new Error(`No workflow_run status has a legal edge to '${to}'`);
  }
  return `(${sources.map(s => `'${s}'`).join(', ')})`;
}
