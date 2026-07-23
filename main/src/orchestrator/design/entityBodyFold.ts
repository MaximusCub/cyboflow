/**
 * entityBodyFold — the sanctioned co-write helper the Approve state machine uses
 * to fold a design-spec section into an idea body in the SAME db.transaction() as
 * the design_handoffs state transition (design-mode.md "Approve" Step 2).
 *
 * WHY A BYPASS EXISTS. The canonical entity-write chokepoint
 * (TaskChangeRouter.applyChange) opens its OWN db.transaction() inside its own
 * per-project PQueue, so it cannot be composed into an ambient transaction — but
 * Step 2 requires the idea-body CAS AND the handoff `state='folded'` transition to
 * commit or roll back together (a crash between them must leave nothing half-done).
 * So this is the same sanctioned exception as reviewItemListing.ts's run-pause
 * fold: a plain SYNCHRONOUS, DB-injected function the caller invokes INSIDE its
 * open db.transaction(), writing rows shape-identical to what the chokepoint
 * produces — the guarded-conditional-UPDATE CAS (taskChangeRouter.ts:1476-1481 +
 * runUpdate's `version = version + 1, updated_at = ...`) plus the max-seq-then-
 * insert entity_events append (taskChangeRouter.ts:insertEvent). A folded body
 * edit is therefore indistinguishable from a chokepoint-produced one to every
 * reader (same version bump, same `body` field delta, same seq mint).
 *
 * Standalone-typecheck invariant (mirrors reviewItemListing.ts): NO imports from
 * 'electron', 'better-sqlite3', or any concrete service in main/src/services/*.
 * The DB is the narrow DatabaseLike interface.
 */
import type { DatabaseLike } from '../types';

/** One `entity_events.changes_json` field delta (mirrors the chokepoint shape). */
interface FieldDelta {
  field: string;
  from: unknown;
  to: unknown;
}

export interface CoWriteIdeaBodyReplaceArgs {
  /** The idea whose `body` to replace. */
  ideaId: string;
  /** Optimistic-concurrency guard — must equal the idea's CURRENT version. */
  expectedVersion: number;
  /** The already-composed full idea body (caller runs replaceDesignSpecSection). */
  newBody: string;
  /** Run id recorded on the entity_events row (nullable — SET NULL FK). */
  runId: string | null;
  /** entity_events.kind for the fold delta (Approve uses 'design-spec-folded'). */
  kind: string;
  /** ISO timestamp shared with the enclosing transaction's other writes. */
  now: string;
}

/**
 * Discriminated result. `concurrency` = the idea's current version did not match
 * `expectedVersion` (a concurrent edit landed first — the caller must surface a
 * user-visible re-read, never silently retry, per design-mode.md Step 2).
 * `not_found` = the idea row is gone (link broken mid-operation).
 */
export type CoWriteIdeaBodyReplaceResult =
  | { ok: true; version: number }
  | { ok: false; code: 'concurrency' | 'not_found' };

/**
 * Replace an idea's `body` with `newBody` under an optimistic-concurrency CAS,
 * appending a shape-identical `entity_events` delta — all synchronously, so the
 * caller can run it INSIDE its own open db.transaction() alongside the
 * design_handoffs state transition.
 *
 * MUST be called from inside an enclosing `db.transaction()` (the seq read +
 * INSERT and the version read + guarded UPDATE cannot interleave otherwise). The
 * UPDATE is doubly guarded: the explicit version compare AND `WHERE ... version=?`
 * (the guarded-conditional-UPDATE precedent, approvalRouter.ts:294-334) — a lost
 * race between the read and the UPDATE surfaces as `changes===0` → `concurrency`,
 * never a silent overwrite.
 */
export function coWriteIdeaBodyReplace(
  db: DatabaseLike,
  args: CoWriteIdeaBodyReplaceArgs,
): CoWriteIdeaBodyReplaceResult {
  const current = db
    .prepare('SELECT version, body FROM ideas WHERE id = ?')
    .get(args.ideaId) as { version: number; body: string | null } | undefined;
  if (!current) return { ok: false, code: 'not_found' };
  if (current.version !== args.expectedVersion) return { ok: false, code: 'concurrency' };

  const info = db
    .prepare(
      'UPDATE ideas SET body = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
    )
    .run(args.newBody, args.now, args.ideaId, args.expectedVersion) as { changes: number };
  // A 0-row UPDATE means the version moved between the SELECT and the UPDATE
  // (a concurrent write inside a sibling transaction) — treat as a lost race.
  if (info.changes === 0) return { ok: false, code: 'concurrency' };

  const maxRow = db
    .prepare('SELECT MAX(seq) AS maxSeq FROM entity_events WHERE entity_type = ? AND entity_id = ?')
    .get('idea', args.ideaId) as { maxSeq: number | null };
  const seq = (maxRow.maxSeq ?? 0) + 1;
  const deltas: FieldDelta[] = [{ field: 'body', from: current.body, to: args.newBody }];
  db.prepare(
    `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('idea', args.ideaId, seq, args.kind, 'orchestrator', args.runId, JSON.stringify(deltas), args.now);

  return { ok: true, version: args.expectedVersion + 1 };
}
