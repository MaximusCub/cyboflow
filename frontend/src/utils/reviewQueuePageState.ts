/**
 * reviewQueuePageState — pure top-level state derivation for the redesigned
 * Human Review Queue landing page.
 *
 * No React, no I/O. `nowMs` is not needed here (no elapsed-time math at this
 * level) but every caller-supplied count is a plain number/boolean so the
 * function is trivially unit-testable and deterministic.
 */

/**
 * The landing page's single top-level rendering state.
 *
 * Precedence (checked in this exact order — the first matching branch wins):
 *   1. `error`        — the landing fan-out itself failed (project list fetch
 *                        threw or returned success:false). Nothing else below
 *                        can be trusted while this is true.
 *   2. `no-accounts`   — no provider account is connected yet (nothing can run).
 *   3. `no-projects`   — accounts are fine, but the user has zero projects.
 *   4. `no-sessions`   — projects exist, but there is no quick session AND no
 *                        non-terminal flow run anywhere — a true bootstrap state.
 *   5. `caught-up`     — sessions/runs exist and nothing is waiting on the user
 *                        (agents may still be actively working).
 *   6. `all-idle`      — sessions/runs exist, something IS waiting on the user,
 *                        but nothing is blocked and nothing is actively running
 *                        (the whole board is quiet/idle).
 *   7. `normal`        — the default, fully-populated board render.
 */
export type QueuePageState =
  | 'error'
  | 'no-accounts'
  | 'no-projects'
  | 'no-sessions'
  | 'caught-up'
  | 'all-idle'
  | 'normal';

/** Typed input the precedence chain reads — every field is a pre-aggregated scalar. */
export interface QueuePageStateInput {
  /** The landing store's cross-project fan-out failed (see landingStore's `loadError`). */
  loadError: boolean;
  /** At least one provider account is connected. */
  providersConnected: boolean;
  /** Total project count across the workspace. */
  projectsCount: number;
  /** Total session count of ANY kind (quick sessions + non-terminal flow runs). */
  sessionsCount: number;
  /** Sessions/items that need the user's attention right now (blocked + idle-unviewed + blocking findings, etc). */
  waitingCount: number;
  /** Sessions/runs currently in a blocked state (a pending gate). */
  blockedCount: number;
  /** Sessions/runs currently actively working. */
  workingCount: number;
}

/**
 * Derive the landing page's top-level {@link QueuePageState} from the
 * aggregate counts, applying the exact precedence documented on the type.
 */
export function deriveQueuePageState(input: QueuePageStateInput): QueuePageState {
  if (input.loadError) return 'error';
  if (!input.providersConnected) return 'no-accounts';
  if (input.projectsCount === 0) return 'no-projects';
  if (input.sessionsCount === 0) return 'no-sessions';
  if (input.waitingCount === 0) return 'caught-up';
  if (input.blockedCount === 0 && input.workingCount === 0) return 'all-idle';
  return 'normal';
}
