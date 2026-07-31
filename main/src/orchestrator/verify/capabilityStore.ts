/**
 * VerifyCapabilityStore — the per-(project, modality, runbook) capability
 * ledger backing the phase-0 `unsupported` mark and K-consecutive-env-failure
 * circuit breaker (docs/proposals/verification-setup-flow.md §3.3/§3.4),
 * persisted on migration 088's `verify_capability_state` / `verify_host_state`
 * tables.
 *
 * TWO MECHANISMS SHARE ONE ROW SHAPE, distinguished by `status`:
 *   - The BREAKER (`recordEnvFailure` / `recordHealthyOutcome`): a rolling
 *     `consecutive_env_failures` counter. K (CAPABILITY_BREAKER_THRESHOLD)
 *     consecutive env-CLASS failures for a (project, modality[, runbook]) trip
 *     it — status flips to `'suppressed'`. Ambiguous/deliverable failures never
 *     touch this counter (§3.1's classifier is the caller's job, not this
 *     store's — this store only records the ALREADY-classified outcome). A
 *     pass or a deliverable-attributed failure resets the counter to 0 and
 *     clears a `'suppressed'` mark (never an `'unsupported'` one).
 *   - The EXPLICIT MARK (`markUnsupported`): "cannot pass on this host, reason:
 *     X" — e.g. `native-desktop`/`mobile-flow` requests before phase 1 ships
 *     the roster (§3.3), or a modality the project's runbook never declared.
 *     Independent of the counter; set directly.
 *
 * SELF-REFRESHING RE-PROBE (§3.3 — the reason this store exists at all, not
 * just a boolean flag): a naive "suppress forever until manually cleared"
 * design is a RECOVERY DEADLOCK, because phase-3 probes run AT VERIFICATION
 * TIME — a fully suppressed capability would never re-probe to discover it
 * recovered. So a `'suppressed'`/`'unsupported'` row is only an ACTIVE
 * suppression (i.e. `getActiveSuppression` returns non-null) while BOTH hold:
 *   1. `suppressed_until` is still in the future (a TTL — CAPABILITY_
 *      SUPPRESSION_TTL_MS — so even an untouched host eventually re-tries), AND
 *   2. the row's stamped `host_generation` still equals the CURRENT host
 *      generation (`verify_host_state.capability_generation`, bumped by
 *      `bumpHostGeneration` — any probe, any project, observing a changed host
 *      fact bumps it immediately, independent of the TTL).
 * Either condition failing makes the row INACTIVE: the caller's next request
 * is free to re-attempt, and — cheaply, per §3.3 — re-mark the row if it is
 * still bad. This applies identically to BOTH `'suppressed'` (the breaker) and
 * `'unsupported'` (the explicit mark); re-marking `'unsupported'` on the next
 * request is deliberately cheap, unlike re-running a real probe.
 *
 * Standalone-typecheck invariant: imports ONLY the narrow DatabaseLike/
 * LoggerLike (mirrors mergeGateLaneAdvance.ts's import pattern) + the shared
 * VerificationModality type — no 'electron' / 'better-sqlite3' / 'fs' import.
 *
 * FAIL-SOFT BY DESIGN: every method catches its own SQL errors (a missing
 * table on a pre-088 DB, a locked file, a malformed row) and degrades to the
 * "no suppression / nothing recorded" answer rather than throwing — mirrors
 * the defensive reads throughout verificationScheduler.ts (e.g.
 * `agentColumnsForRow`). A capability-ledger hiccup must never abort a
 * verification request; it only means this call's caching/breaker signal is
 * unavailable for this one read/write.
 */
import type { DatabaseLike, LoggerLike } from '../types';
import type { VerificationModality } from '../../../../shared/types/visualVerification';

/**
 * K — the number of CONSECUTIVE env-class failures for a (project, modality[,
 * runbook]) that trips the circuit breaker (§3.4). Chosen to match the
 * proposal's own framing ("the 5 agent-era failures each burned the full
 * deadline; nothing tripped") — low enough to stop the bleeding quickly,
 * high enough that one transient blip (a momentarily-occupied port) does not
 * suppress a healthy modality.
 */
export const CAPABILITY_BREAKER_THRESHOLD = 3;

/**
 * The suppression TTL — 24 hours (§3.3) — after which a `'suppressed'` /
 * `'unsupported'` row self-refreshes (its next `getActiveSuppression` check
 * reports inactive) even absent any host-generation bump. Bounds the worst
 * case: an unattended host that never runs another probe still gets a fresh
 * attempt once a day rather than staying suppressed indefinitely.
 */
export const CAPABILITY_SUPPRESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The active suppression `getActiveSuppression` returns — just enough for a caller to skip-with-reason. */
export interface ActiveSuppression {
  status: 'suppressed' | 'unsupported';
  reason: string;
}

/** Raw `verify_capability_state` row shape, as read back from SQLite. */
interface CapabilityStateRow {
  status: string;
  reason: string;
  consecutive_env_failures: number;
  host_generation: number;
  suppressed_until: string | null;
}

export class VerifyCapabilityStore {
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
  ) {}

  /**
   * The active suppression for (project, modality, runbookHash), or `null`
   * when the modality is currently usable — either no row exists, the row's
   * status is `'active'` (still counting, not yet tripped), or the row IS
   * `'suppressed'`/`'unsupported'` but has SELF-REFRESHED per the class doc
   * (TTL elapsed, or the host generation moved on). `runbookHash` defaults to
   * `''` — the pre-runbook (phase-0) world where no portable runbook exists
   * yet, matching migration 088's column default.
   */
  getActiveSuppression(
    projectId: number,
    modality: VerificationModality,
    runbookHash = '',
  ): ActiveSuppression | null {
    try {
      const row = this.db
        .prepare(
          `SELECT status, reason, consecutive_env_failures, host_generation, suppressed_until
           FROM verify_capability_state
           WHERE project_id = ? AND modality = ? AND runbook_hash = ?`,
        )
        .get(projectId, modality, runbookHash) as CapabilityStateRow | undefined;
      if (!row) return null;
      if (row.status !== 'suppressed' && row.status !== 'unsupported') return null;
      if (!this.isSuppressionActive(row)) return null;
      return { status: row.status, reason: row.reason };
    } catch (err) {
      this.logger?.warn('[VerifyCapabilityStore] getActiveSuppression failed (fail-soft)', {
        projectId,
        modality,
        runbookHash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Both conditions from the class doc's SELF-REFRESHING RE-PROBE section. */
  private isSuppressionActive(row: CapabilityStateRow): boolean {
    if (!row.suppressed_until) return false;
    const untilMs = Date.parse(row.suppressed_until);
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return false;
    return row.host_generation === this.currentHostGeneration();
  }

  /**
   * Record ONE env-class failure for (project, modality[, runbook]),
   * incrementing the consecutive-failure counter. When the increment JUST
   * crosses CAPABILITY_BREAKER_THRESHOLD (i.e. the row was not already
   * `'suppressed'`/`'unsupported'`), the breaker TRIPS: status flips to
   * `'suppressed'`, `reason` is stamped, and `suppressed_until` /
   * `host_generation` are set so `getActiveSuppression` reports it active
   * immediately. A row already tripped keeps counting (harmlessly) but is not
   * re-tripped a second time by this call — `recordHealthyOutcome` (or TTL /
   * generation expiry) is what clears it.
   *
   * Returns `{ tripped: true }` only on the call that performed that
   * transition; every other call (under-threshold, or already-tripped)
   * returns `{ tripped: false }`.
   */
  recordEnvFailure(
    projectId: number,
    modality: VerificationModality,
    reason: string,
    runbookHash = '',
  ): { tripped: boolean } {
    try {
      const now = new Date().toISOString();
      const hostGeneration = this.currentHostGeneration();
      const txn = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO verify_capability_state
               (project_id, modality, runbook_hash, status, reason, consecutive_env_failures, host_generation, suppressed_until, updated_at)
             VALUES (?, ?, ?, 'active', '', 1, ?, NULL, ?)
             ON CONFLICT(project_id, modality, runbook_hash) DO UPDATE SET
               consecutive_env_failures = verify_capability_state.consecutive_env_failures + 1,
               updated_at = excluded.updated_at`,
          )
          .run(projectId, modality, runbookHash, hostGeneration, now);

        const row = this.db
          .prepare(
            `SELECT status, consecutive_env_failures FROM verify_capability_state
             WHERE project_id = ? AND modality = ? AND runbook_hash = ?`,
          )
          .get(projectId, modality, runbookHash) as
          | { status: string; consecutive_env_failures: number }
          | undefined;

        const alreadySuppressed = row?.status === 'suppressed' || row?.status === 'unsupported';
        const count = row?.consecutive_env_failures ?? 0;
        if (alreadySuppressed || count < CAPABILITY_BREAKER_THRESHOLD) {
          return false;
        }

        const suppressedUntil = new Date(Date.now() + CAPABILITY_SUPPRESSION_TTL_MS).toISOString();
        this.db
          .prepare(
            `UPDATE verify_capability_state
             SET status = 'suppressed', reason = ?, host_generation = ?, suppressed_until = ?, updated_at = ?
             WHERE project_id = ? AND modality = ? AND runbook_hash = ?`,
          )
          .run(reason, hostGeneration, suppressedUntil, now, projectId, modality, runbookHash);
        return true;
      });
      const tripped = (txn as () => boolean)();
      if (tripped) {
        this.logger?.warn('[VerifyCapabilityStore] circuit breaker tripped', {
          projectId,
          modality,
          runbookHash,
          reason,
        });
      }
      return { tripped };
    } catch (err) {
      this.logger?.warn('[VerifyCapabilityStore] recordEnvFailure failed (fail-soft)', {
        projectId,
        modality,
        runbookHash,
        error: err instanceof Error ? err.message : String(err),
      });
      return { tripped: false };
    }
  }

  /**
   * A pass, or a DELIVERABLE-attributed failure (§3.1 — the deliverable is
   * genuinely broken, the environment is fine) — resets the consecutive-
   * failure counter to 0 and clears a `'suppressed'` (breaker) mark back to
   * `'active'`. Deliberately does NOT clear an `'unsupported'` mark (that is
   * an explicit "cannot pass on this host" statement, not a rolling counter —
   * only `markUnsupported`'s own self-refresh, or a fresh explicit call,
   * changes it). Ambiguous outcomes call NEITHER `recordEnvFailure` NOR this
   * method — the caller simply does not touch the ledger for them.
   *
   * A no-op (no row exists yet) is a normal, harmless case — nothing to reset.
   */
  recordHealthyOutcome(projectId: number, modality: VerificationModality, runbookHash = ''): void {
    try {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE verify_capability_state
           SET consecutive_env_failures = 0,
               status = CASE WHEN status = 'suppressed' THEN 'active' ELSE status END,
               reason = CASE WHEN status = 'suppressed' THEN '' ELSE reason END,
               suppressed_until = CASE WHEN status = 'suppressed' THEN NULL ELSE suppressed_until END,
               updated_at = ?
           WHERE project_id = ? AND modality = ? AND runbook_hash = ?`,
        )
        .run(now, projectId, modality, runbookHash);
    } catch (err) {
      this.logger?.warn('[VerifyCapabilityStore] recordHealthyOutcome failed (fail-soft)', {
        projectId,
        modality,
        runbookHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Explicit "cannot pass on this host, reason: X" mark (§3.3) — e.g. a
   * `native-desktop`/`mobile-flow` request before phase 1 ships the roster, or
   * a modality the project's runbook never declared. Independent of the
   * breaker counter (does not touch `consecutive_env_failures`). Stamps the
   * SAME `suppressed_until`/`host_generation` pair `recordEnvFailure`'s trip
   * does, so `getActiveSuppression`'s self-refresh logic treats both marks
   * identically.
   */
  markUnsupported(projectId: number, modality: VerificationModality, reason: string, runbookHash = ''): void {
    try {
      const now = new Date().toISOString();
      const hostGeneration = this.currentHostGeneration();
      const suppressedUntil = new Date(Date.now() + CAPABILITY_SUPPRESSION_TTL_MS).toISOString();
      this.db
        .prepare(
          `INSERT INTO verify_capability_state
             (project_id, modality, runbook_hash, status, reason, consecutive_env_failures, host_generation, suppressed_until, updated_at)
           VALUES (?, ?, ?, 'unsupported', ?, 0, ?, ?, ?)
           ON CONFLICT(project_id, modality, runbook_hash) DO UPDATE SET
             status = 'unsupported',
             reason = excluded.reason,
             host_generation = excluded.host_generation,
             suppressed_until = excluded.suppressed_until,
             updated_at = excluded.updated_at`,
        )
        .run(projectId, modality, runbookHash, reason, hostGeneration, suppressedUntil, now);
    } catch (err) {
      this.logger?.warn('[VerifyCapabilityStore] markUnsupported failed (fail-soft)', {
        projectId,
        modality,
        runbookHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Bump the singleton host-capability generation (§3.3) — called by ANY probe,
   * for ANY project, that observes a changed host fact (a chromium install/
   * removal, a TCC grant flip, a node/electron-ABI change). Every
   * `verify_capability_state` row stamped with the PRIOR generation
   * immediately goes inactive (`isSuppressionActive` returns false), letting
   * the next request re-attempt regardless of TTL. `fingerprintJson` is an
   * optional serialized host-fingerprint snapshot (§5.2 proof provenance —
   * chromium binary, TCC grant state, node major, app binary path) recorded
   * for diagnostics; when omitted, the previously-stored fingerprint (if any)
   * is preserved rather than clobbered with NULL.
   *
   * Returns the NEW generation value (best-effort — on a write failure this
   * fails soft to whatever `currentHostGeneration()` can still read, which may
   * be stale/0 rather than throwing).
   */
  bumpHostGeneration(fingerprintJson?: string): number {
    try {
      const now = new Date().toISOString();
      const txn = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO verify_host_state (id, capability_generation, fingerprint_json, updated_at)
             VALUES (1, 1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               capability_generation = verify_host_state.capability_generation + 1,
               fingerprint_json = COALESCE(excluded.fingerprint_json, verify_host_state.fingerprint_json),
               updated_at = excluded.updated_at`,
          )
          .run(fingerprintJson ?? null, now);
        const row = this.db
          .prepare('SELECT capability_generation FROM verify_host_state WHERE id = 1')
          .get() as { capability_generation: number } | undefined;
        return row?.capability_generation ?? 0;
      });
      return (txn as () => number)();
    } catch (err) {
      this.logger?.warn('[VerifyCapabilityStore] bumpHostGeneration failed (fail-soft)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.currentHostGeneration();
    }
  }

  /** The current host capability generation, or 0 when the singleton row is absent (fresh install — nothing is stale yet). */
  currentHostGeneration(): number {
    try {
      const row = this.db
        .prepare('SELECT capability_generation FROM verify_host_state WHERE id = 1')
        .get() as { capability_generation: number } | undefined;
      return row?.capability_generation ?? 0;
    } catch (err) {
      this.logger?.warn('[VerifyCapabilityStore] currentHostGeneration failed (fail-soft)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }
}
