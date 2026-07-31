/**
 * cyboflow.verificationRequests sub-router (L6 / S7).
 *
 * Read-only typed tRPC contract backing the renderer's Verify-Queue panel — a
 * pure observability view over the `verification_requests` work queue (migration
 * 036 + `judge_calls_used` from 037). It MIRRORS the artifacts router's `list`
 * query exactly: a `protectedProcedure`, reaching the DB via `ctx.db`
 * (DatabaseLike), returning the shared `VerificationRequestRow[]` consumed on the
 * frontend by AppRouter inference ONLY (native tRPC serialization — NO IPCResponse
 * wrapper, no `{ success; data?; error? }` shape).
 *
 *   - list   : query -> VerificationRequestListRow[] (a project's verify requests,
 *              optionally narrowed by runId + status), newest-enqueued first, each
 *              enriched with its ORIGIN SESSION (run → session LEFT JOIN) for the
 *              panel's per-card session pill, and — additively, migration 095 —
 *              the classifier's `failureClass`/`modality`/`setupProof`/
 *              `failureEvidence` (docs/proposals/verification-setup-flow.md §3.1/
 *              §3.6). See {@link shapeRow}.
 *   - budget : query -> VerificationBudgetSummary (§3.6 "surface budget state in
 *              the Verify Queue") — a SIBLING query, not a field folded into
 *              `list`'s response, so `list` stays a flat array the renderer can
 *              index with `[number]` (`useVerificationRequests.ts`). Mirrors the
 *              exact `projects.visual_verify_budget_calls` /
 *              `SUM(judge_calls_used)` pair `VerificationScheduler
 *              .isProjectBudgetExhausted` already enforces at enqueue time
 *              (migration 056), so the number the panel shows can never
 *              silently diverge from the number the scheduler acts on.
 *
 * The panel performs NO mutations (Accept-as-baseline lives on the artifact
 * verdict banner, S6) — this router stays read-only over the existing schema, so
 * there is no new migration and no chokepoint write path here.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import {
  REQUEST_STATUS,
  isVerificationFailureClass,
  isVerificationModality,
  type RequestStatus,
  type VerificationBudgetSummary,
  type VerificationFailureEvidence,
  type VerificationRequestListRow,
  type VerificationType,
  type VisualBackendId,
} from '../../../../../shared/types/visualVerification';

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[verificationRequests.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

/**
 * The raw `verification_requests` row as SQLite hands it back. snake_case mirrors
 * the columns; the nullable TEXT columns come back as `string | null`, numeric
 * columns as `number`. `chain_json` is nullable in the schema (NULL until the
 * scheduler resolves the live chain), but the panel-facing
 * {@link VerificationRequestRow} declares it non-null — {@link shapeRow}
 * normalizes NULL to an empty JSON array string so the renderer always parses a
 * valid `VisualBackendId[]`.
 */
interface VerificationRequestDbRow {
  id: string;
  run_id: string;
  project_id: number;
  status: string;
  verify_type: string;
  deliverable_json: string;
  chain_json: string | null;
  current_backend: string | null;
  attempt: number;
  verdict_json: string | null;
  error_message: string | null;
  enqueued_at: string;
  leased_at: string | null;
  ended_at: string | null;
  // Migration-078 columns (nullable on every pre-078 / legacy-engine row).
  task_json: string | null;
  report_json: string | null;
  delivery_state: string | null;
  snapshot_sha: string | null;
  enqueue_key: string | null;
  // Origin-session columns, LEFT-JOINed from workflow_runs → sessions (see the
  // list query). Both NULL when the run has no session row.
  session_id: string | null;
  session_name: string | null;
  // Migration-095 columns (verification-setup-flow.md §3.1/§3.6) — `undefined`
  // (not `null`) on a pre-095 DB, since `SELECT vr.*` simply omits a column
  // that does not exist yet; `null` on a post-095 row the classifier never
  // stamped (failure_class/modality/failure_evidence_json — all nullable TEXT,
  // no CHECK domain per the migration's own note) or a non-terminal/passed row.
  // `setup_proof` alone is `NOT NULL DEFAULT 0`, so it is a plain `number` on
  // every post-095 row and only `undefined` pre-095.
  failure_class: string | null | undefined;
  failure_evidence_json: string | null | undefined;
  modality: string | null | undefined;
  setup_proof: number | undefined;
}

/**
 * Parse `verification_requests.failure_evidence_json` into
 * {@link VerificationFailureEvidence}[] — FAIL-SOFT to `undefined` on
 * anything short of a well-shaped array (absent/NULL column, invalid JSON, a
 * non-array payload, or an array entry missing the `source`/`detail` strings
 * the type requires). Deliberately does not validate `source` against its
 * literal union — the health-panel audit trail (phase 3) is meant to survive
 * a future-added source value from a newer binary without this reader going
 * stale (mirrors the migration's own no-CHECK-domain posture on the column).
 */
function parseFailureEvidence(json: string | null | undefined): VerificationFailureEvidence[] | undefined {
  if (json === null || json === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return undefined;
    const wellShaped = parsed.every(
      (entry): entry is VerificationFailureEvidence =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { source?: unknown }).source === 'string' &&
        typeof (entry as { detail?: unknown }).detail === 'string',
    );
    return wellShaped ? (parsed as VerificationFailureEvidence[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map one DB row to the shared {@link VerificationRequestRow}. The `status` /
 * `verify_type` / `current_backend` TEXT columns are constrained at write time
 * (the SQL CHECK domain + the resolver), so the read side asserts them onto their
 * union types rather than re-validating. `chain_json` NULL → '[]' (see the row
 * doc) keeps the renderer's `JSON.parse(chain_json)` safe.
 */
function shapeRow(r: VerificationRequestDbRow): VerificationRequestListRow {
  return {
    id: r.id,
    run_id: r.run_id,
    project_id: r.project_id,
    status: r.status as RequestStatus,
    verify_type: r.verify_type as VerificationType,
    deliverable_json: r.deliverable_json,
    chain_json: r.chain_json ?? '[]',
    current_backend: (r.current_backend as VisualBackendId | null) ?? null,
    attempt: r.attempt,
    verdict_json: r.verdict_json,
    error_message: r.error_message,
    enqueued_at: r.enqueued_at,
    leased_at: r.leased_at,
    ended_at: r.ended_at,
    // Migration-078 columns — `SELECT *` already fetches them; `?? null` keeps a
    // pre-078 test DB (column absent ⇒ undefined) shaping to the declared null.
    task_json: r.task_json ?? null,
    report_json: r.report_json ?? null,
    delivery_state: r.delivery_state ?? null,
    snapshot_sha: r.snapshot_sha ?? null,
    enqueue_key: r.enqueue_key ?? null,
    // LEFT-JOIN columns — `undefined` (no matching run/session row) shapes to the
    // declared null so the renderer's pill fallback has one shape to test.
    session_id: r.session_id ?? null,
    session_name: r.session_name ?? null,
    // Migration-095 derived fields (§3.1/§3.6) — see the VerificationRequestListRow
    // doc for why these are OPTIONAL/camelCase rather than the raw-passthrough
    // `| null` convention above: each one FAIL-SOFT's to `undefined`, never
    // passing an unvalidated raw value through.
    failureClass: isVerificationFailureClass(r.failure_class) ? r.failure_class : undefined,
    modality: isVerificationModality(r.modality) ? r.modality : undefined,
    // `=== 1` (not a bare truthiness check) — `undefined` (pre-095 column absent)
    // must resolve to `false` exactly like `0` does, never to `undefined` itself:
    // setupProof is a concrete boolean on every row the type declares it on.
    setupProof: r.setup_proof === 1,
    failureEvidence: parseFailureEvidence(r.failure_evidence_json),
  };
}

export const verificationRequestsRouter = router({
  /**
   * List a project's verification requests (newest enqueued first), optionally
   * narrowed to a single run and/or a single lifecycle status. Read-only over the
   * existing 036/037 schema — every column the {@link VerificationRequestRow}
   * shape declares is projected; columns it does not declare (`judge_calls_used`)
   * are ignored.
   */
  list: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        runId: z.string().min(1).optional(),
        status: z.enum(REQUEST_STATUS as readonly [RequestStatus, ...RequestStatus[]]).optional(),
      }),
    )
    .query(async ({ input, ctx }): Promise<VerificationRequestListRow[]> => {
      const db = requireDb(ctx.db, 'list');
      // Every predicate is qualified with the `vr.` alias — workflow_runs carries
      // its OWN project_id / status columns, so an unqualified clause would be
      // ambiguous (or worse, silently filter on the RUN's status) once joined.
      const clauses = ['vr.project_id = ?'];
      const params: unknown[] = [input.projectId];
      if (input.runId !== undefined) {
        clauses.push('vr.run_id = ?');
        params.push(input.runId);
      }
      if (input.status !== undefined) {
        clauses.push('vr.status = ?');
        params.push(input.status);
      }
      // Two LEFT JOINs resolve the request's ORIGIN SESSION (run → session) for
      // the panel's session pill. LEFT (not INNER) so a request whose run or
      // session row is gone still lists — the pill degrades to the run id.
      const rows = db
        .prepare(
          `SELECT vr.*, wr.session_id AS session_id, s.name AS session_name
             FROM verification_requests vr
             LEFT JOIN workflow_runs wr ON wr.id = vr.run_id
             LEFT JOIN sessions s ON s.id = wr.session_id
            WHERE ${clauses.join(' AND ')}
            ORDER BY vr.enqueued_at DESC, vr.id DESC`,
        )
        .all(...params) as VerificationRequestDbRow[];
      return rows.map(shapeRow);
    }),

  /**
   * Per-project verify-budget summary (§3.6). A SIBLING query to `list` — see
   * the file header doc for why this is not a field folded into the list
   * response. Reads the EXACT SAME pair
   * `VerificationScheduler.isProjectBudgetExhausted` enforces at enqueue time
   * (`projects.visual_verify_budget_calls`, NULL = unlimited;
   * `SUM(verification_requests.judge_calls_used)` for the project's
   * lifetime, migration 056) so the panel's number can never silently
   * diverge from the number the scheduler actually acts on. `projectName`
   * is `undefined` only when the project row itself is gone (a router-
   * integrity edge case, not expected in practice — the caller always has a
   * live project selected).
   */
  budget: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(async ({ input, ctx }): Promise<VerificationBudgetSummary> => {
      const db = requireDb(ctx.db, 'budget');
      const proj = db
        .prepare('SELECT name, visual_verify_budget_calls AS budget FROM projects WHERE id = ?')
        .get(input.projectId) as { name: string; budget: number | null } | undefined;
      const usedRow = db
        .prepare(
          'SELECT COALESCE(SUM(judge_calls_used), 0) AS used FROM verification_requests WHERE project_id = ?',
        )
        .get(input.projectId) as { used: number } | undefined;
      return {
        projectId: input.projectId,
        projectName: proj?.name,
        budgetCalls: typeof proj?.budget === 'number' ? proj.budget : null,
        usedCalls: usedRow?.used ?? 0,
      };
    }),
});
