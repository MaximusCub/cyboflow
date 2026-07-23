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
 *   - list : query -> VerificationRequestListRow[] (a project's verify requests,
 *            optionally narrowed by runId + status), newest-enqueued first, each
 *            enriched with its ORIGIN SESSION (run → session LEFT JOIN) for the
 *            panel's per-card session pill.
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
  type RequestStatus,
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
});
