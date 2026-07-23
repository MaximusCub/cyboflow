/**
 * designHandoffRecovery — boot recovery for the Approve state machine
 * (design-mode.md "Approve — intent-first recoverable state machine": "Recovery:
 * boot ... resumes from the recorded state — a crash after the fold cannot strand
 * the operation").
 *
 * A previous process may have died mid-Approve, leaving a design_handoffs row in a
 * NON-terminal state (intent / snapshotted / folded). recoverDesignHandoffs scans
 * those rows and drives each forward through the SAME step functions the first-run
 * approve uses (driveHandoffForward) — so recovery and first-run execute identical
 * code and cannot diverge:
 *   - 'intent'      resumes from Step 1 (runSnapshotStep re-validates the Step 0 CAS
 *                   first: an artifact that advanced while down marks the handoff
 *                   'failed' with a stale-draft error — never snapshot mismatched
 *                   bytes);
 *   - 'snapshotted' resumes from Step 2 (the fold + its state transition, atomic);
 *   - 'folded'      resumes at Step 3 (the fold already committed — recovery must
 *                   converge to a single current approved_designs row, no double
 *                   fold, because the publish is guarded on state='folded').
 *
 * Non-fatal by contract: each handoff is driven under its own try/catch so one bad
 * row cannot block boot. Standalone-typecheck-safe (only DatabaseLike + the shared
 * service module).
 */
import type { DesignHandoffDeps } from './designHandoffService';
import { driveHandoffForward } from './designHandoffService';

export interface DesignHandoffRecoverySummary {
  /** Handoffs that were driven to a terminal 'complete'. */
  completed: number;
  /** Handoffs that ended at a non-complete terminal (failed / superseded / stuck). */
  unresolved: number;
  /** Handoffs whose drive threw (logged + skipped, boot continues). */
  errored: number;
}

/**
 * Drive every non-terminal design_handoffs row forward. Returns a summary; never
 * throws (per-row try/catch). Fire it at boot right after the run-recovery sweep.
 */
export async function recoverDesignHandoffs(
  deps: DesignHandoffDeps,
): Promise<DesignHandoffRecoverySummary> {
  const { db, logger } = deps;
  const summary: DesignHandoffRecoverySummary = { completed: 0, unresolved: 0, errored: 0 };

  let rows: Array<{ id: string }>;
  try {
    rows = db
      .prepare(
        `SELECT id FROM design_handoffs
          WHERE state IN ('intent', 'snapshotted', 'folded')
          ORDER BY created_at ASC, id ASC`,
      )
      .all() as Array<{ id: string }>;
  } catch (err) {
    // A pre-migration-078 DB (no design_handoffs table) — nothing to recover.
    logger?.debug('[designHandoff] recovery scan skipped (table absent?)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return summary;
  }

  for (const row of rows) {
    try {
      const result = await driveHandoffForward(deps, row.id);
      if (result.ok) summary.completed += 1;
      else summary.unresolved += 1;
      logger?.info('[designHandoff] recovered handoff', {
        handoffId: row.id,
        outcome: result.ok ? 'complete' : result.code,
      });
    } catch (err) {
      summary.errored += 1;
      logger?.error('[designHandoff] recovery drive threw (skipping row, boot continues)', {
        handoffId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}
