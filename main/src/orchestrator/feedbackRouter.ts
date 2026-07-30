/**
 * FeedbackRouter — the SINGLE write chokepoint for the two in-artifact
 * feedback tables (feedback_batches / feedback_comments, migrations 077 + 092).
 *
 * TWO surfaces share the tables:
 *
 * 1. DOCUMENT feedback (IDEA-033). Users highlight sections of the idea-spec /
 *    arch-design artifact tabs while a planner/ship run is parked at a human
 *    gate, save draft comments, and "send" the batch. Sending is the durable
 *    "changes requested" event: a host-driven scoped revision agent rewrites the
 *    target document (the idea's markdown body) through TaskChangeRouter while
 *    the gate stays open, then the batch flips to 'applied' and its comments to
 *    'addressed' (consumed — comments are per-round, not threaded). Ops:
 *    create/update/delete-comment, send-batch, batch-applied, batch-failed.
 *
 * 2. DESIGN-PROTOTYPE feedback (Design Mode v1 — docs/ideas/design-mode.md,
 *    "Design feedback v1 — acknowledged durable outbox"). Element-anchored
 *    comments on a ui-prototype / interactive-prototype are delivered to a LIVE
 *    design session over an acknowledged outbox:
 *      queued → dispatching → dispatched → applied | failed | blocked.
 *    This file owns the durable PRIMITIVES only (createDesignBatch,
 *    recordDispatchAttempt, transitionBatch, applyBatchResult); the pipeline that
 *    drives them — guards, SDK dispatch, boot recovery — lives elsewhere. A
 *    design session is never a parked run, so NONE of the parked-gate guard chain
 *    applies to these ops.
 *
 * Content identity mirrors the per-entity artifact identity (migration 073):
 * (run_id, atype, source_ref), where source_ref is the owning idea id.
 *
 * Mirrors the per-project PQueue serialization pattern in reviewItemRouter.ts /
 * artifactRouter.ts (feedback is project-scoped, via the owning run). UNLIKE
 * those two chokepoints, feedback writes do NOT append to the polymorphic
 * `entity_events` audit log — feedback comments/batches are review-side
 * annotations, not entity mutations. The eventual body write a batch produces
 * (once a revision agent applies it) IS audited, but that audit trail lives on
 * the idea entity via TaskChangeRouter, not here.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface. The feedbackEvents emitter is
 * hosted in trpc/routers/events.ts (see that file for why) — importing it here
 * is safe under the invariant because events.ts itself only imports zod, the
 * tRPC procedure factories, and type-only shared-type imports.
 */
import { randomBytes } from 'node:crypto';
import PQueue from 'p-queue';
import type { DatabaseLike } from './types';
import { feedbackEvents, feedbackProjectChannel } from './trpc/routers/events';
import {
  isDesignFeedbackAtype,
  isElementAnchor,
  isFeedbackAtype,
  type CommentAnchor,
  type DesignFeedbackAtype,
  type ElementCommentAnchor,
  type FeedbackAnchor,
  type FeedbackAtype,
  type FeedbackBatch,
  type FeedbackBatchStatus,
  type FeedbackChangedEvent,
  type FeedbackComment,
  type FeedbackCommentStatus,
} from '../../../shared/types/feedback';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type FeedbackErrorCode =
  | 'not_found'
  | 'invalid_atype'
  | 'invalid_body'
  /** The anchor variant does not match the atype's surface (element vs quote). */
  | 'invalid_anchor'
  /** update-comment / delete-comment target a non-draft (sent/addressed) comment. */
  | 'not_draft'
  /** send-batch / create-design-batch: an in-flight batch already exists for this (runId, atype, sourceRef). */
  | 'busy'
  /** send-batch: no draft comments exist for this document. */
  | 'no_comments'
  /** transition-batch / record-dispatch-attempt: the move is not in the transition table, or `from` no longer holds. */
  | 'invalid_transition'
  /** Exhaustiveness-guard fallback — unreachable at runtime, TS enforces it at compile time. */
  | 'invalid_op';

/** Discriminated error for all chokepoint rejections. */
export class FeedbackError extends Error {
  constructor(
    public readonly code: FeedbackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedbackError';
  }
}

// ---------------------------------------------------------------------------
// Change request shapes
// ---------------------------------------------------------------------------

/** Create a new draft comment. Omit `commentId` (it is minted). */
export interface FeedbackCreateComment {
  op: 'create-comment';
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
  /** Must match the atype's surface — element anchors for prototypes, quote anchors for docs. */
  anchor: FeedbackAnchor;
  body: string;
}

/** Edit a draft comment's body and/or anchor. Rejected once the comment is sent/addressed. */
export interface FeedbackUpdateComment {
  op: 'update-comment';
  commentId: string;
  body?: string;
  /** Must match the STORED comment's atype surface. */
  anchor?: FeedbackAnchor;
}

/** Hard-delete a draft comment. Rejected once the comment is sent/addressed. */
export interface FeedbackDeleteComment {
  op: 'delete-comment';
  commentId: string;
}

/** "Send feedback": mint a batch from every draft comment on a document. */
export interface FeedbackSendBatch {
  op: 'send-batch';
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
}

/** The revision agent landed the batch's changes — flip it (and its comments) to applied/addressed. */
export interface FeedbackBatchApplied {
  op: 'batch-applied';
  batchId: string;
}

/** The revision agent failed — flip the batch to failed and revert its comments to editable drafts. */
export interface FeedbackBatchFailed {
  op: 'batch-failed';
  batchId: string;
  error: string;
}

// --- Design outbox ops (Design Mode v1) ------------------------------------

/**
 * Mint a design-feedback batch in the outbox's entry state ('queued') bound to a
 * design SESSION (not a parked run), stamping the named draft comments
 * sent/batch_id in the SAME transaction.
 */
export interface FeedbackCreateDesignBatch {
  op: 'create-design-batch';
  runId: string;
  /** The design session the batch is delivered to. */
  sessionId: string;
  atype: DesignFeedbackAtype;
  sourceRef: string;
  /** The draft comments to send. Every id must be a draft on this exact document. */
  commentIds: string[];
  /** ISO timestamp; defaults to now. */
  now?: string;
}

/**
 * Guarded outbox transition. `from` is a CAS on the batch's current status: a
 * mismatch is rejected (`invalid_transition`), never silently applied. The
 * from→to edge must exist in DESIGN_TRANSITIONS.
 */
export interface FeedbackTransitionBatch {
  op: 'transition-batch';
  batchId: string;
  from: FeedbackBatchStatus;
  to: FeedbackBatchStatus;
  /** REQUIRED when to='blocked' — the user-visible reason. */
  blockedReason?: string;
  /** REQUIRED when to='failed' — human-readable detail, never a raw stack trace. */
  error?: string;
  /** ISO timestamp; defaults to now. */
  now?: string;
}

/**
 * Open a delivery attempt: move to 'dispatching', stamp current_attempt_id and
 * increment attempt_count — all in one transaction, so the attempt is durable
 * BEFORE the SDK call (a crash between the two leaves 'dispatching', which
 * recovery treats as possibly-delivered).
 */
export interface FeedbackRecordDispatchAttempt {
  op: 'record-dispatch-attempt';
  batchId: string;
  attemptId: string;
  /** ISO timestamp; defaults to now. */
  now?: string;
}

/**
 * The ONE-RESULT CAS: the agent acknowledged the batch, naming the prototype
 * artifact revision that addressed it. Succeeds only while the batch is
 * 'dispatching' or 'dispatched'; a duplicate ack is acknowledged-and-discarded
 * (`{ applied: false }`), NOT an error.
 */
export interface FeedbackApplyBatchResult {
  op: 'apply-batch-result';
  batchId: string;
  /** The attempt that produced this result — recorded as the winning attempt. */
  attemptId: string;
  /** The artifact revision the revision turn produced. */
  prototypeRevision: number;
  /** ISO timestamp; defaults to now. */
  now?: string;
}

export type FeedbackChange =
  | FeedbackCreateComment
  | FeedbackUpdateComment
  | FeedbackDeleteComment
  | FeedbackSendBatch
  | FeedbackBatchApplied
  | FeedbackBatchFailed
  | FeedbackCreateDesignBatch
  | FeedbackTransitionBatch
  | FeedbackRecordDispatchAttempt
  | FeedbackApplyBatchResult;

/** Union of every op's return shape — the implementation signature of apply(). */
export type FeedbackApplyResult =
  | { commentId: string }
  | { batchId: string; round: number; commentIds: string[] }
  | { batchId: string; applied: boolean }
  | { batchId: string; failed: boolean }
  | { batchId: string; status: FeedbackBatchStatus }
  | { batchId: string; attemptId: string; attemptCount: number };

// ---------------------------------------------------------------------------
// Design-outbox transition table
// ---------------------------------------------------------------------------

/**
 * The ONLY legal design-outbox moves. Everything absent here is rejected by
 * transitionBatch, including same-status self-edges and any move out of a
 * terminal state ('applied' is terminal by contract — "nothing silently reverts
 * sent feedback to drafts"; 'failed'/'blocked' are terminal for delivery, and
 * recovery never re-delivers a blocked batch).
 *
 * The legacy document status 'pending' is deliberately absent: the document
 * surface transitions through its own ops (batch-applied / batch-failed).
 */
export const DESIGN_TRANSITIONS: Readonly<Record<FeedbackBatchStatus, readonly FeedbackBatchStatus[]>> = {
  pending: [],
  queued: ['dispatching', 'blocked', 'failed'],
  // 'applied' is reachable straight from 'dispatching': a crash between SDK
  // acceptance and the 'dispatched' write can leave the batch here while the turn
  // completes normally, so the ack must still land (see applyBatchResult).
  dispatching: ['dispatched', 'applied', 'blocked', 'failed'],
  dispatched: ['applied', 'blocked', 'failed'],
  applied: [],
  failed: [],
  blocked: [],
};

/**
 * Statuses from which a (re-)dispatch attempt may be opened. 'dispatching' and
 * 'dispatched' are included on purpose: that is boot recovery re-delivering the
 * same batch id under a NEW attempt id.
 */
const DISPATCHABLE_FROM: readonly FeedbackBatchStatus[] = ['queued', 'dispatching', 'dispatched'];

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface FeedbackCommentDbRow {
  id: string;
  project_id: number;
  run_id: string;
  atype: FeedbackAtype;
  source_ref: string;
  batch_id: string | null;
  anchor_json: string;
  body: string;
  status: FeedbackCommentStatus;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  addressed_at: string | null;
}

interface FeedbackBatchDbRow {
  id: string;
  project_id: number;
  run_id: string;
  atype: FeedbackAtype;
  source_ref: string;
  round: number;
  status: FeedbackBatchStatus;
  error: string | null;
  created_at: string;
  applied_at: string | null;
  session_id: string | null;
  current_attempt_id: string | null;
  attempt_count: number;
  blocked_reason: string | null;
  dispatched_at: string | null;
  applied_prototype_revision: number | null;
}

// ---------------------------------------------------------------------------
// Anchor <-> atype cross-validation
// ---------------------------------------------------------------------------

/** Shape-check an element anchor (the renderer's inspector is untrusted input). */
function isWellFormedElementAnchor(anchor: ElementCommentAnchor): boolean {
  if (!Array.isArray(anchor.ancestorStack) || anchor.ancestorStack.length === 0) return false;
  if (!Number.isInteger(anchor.pickedIndex)) return false;
  if (anchor.pickedIndex < 0 || anchor.pickedIndex >= anchor.ancestorStack.length) return false;
  return anchor.ancestorStack.every(
    (a) =>
      typeof a?.tag === 'string' &&
      a.tag.length > 0 &&
      (a.designId === null || typeof a.designId === 'string') &&
      (a.label === null || typeof a.label === 'string'),
  );
}

/**
 * The anchor variant is bound to the atype's SURFACE, and the binding is
 * enforced on every write that carries an anchor: element anchors only on the
 * design-prototype atypes, quote anchors only on the document atypes. Without
 * this a quote anchor could be stored against a prototype (nothing to highlight)
 * or an element anchor against a document (no DOM to relocate into), and the
 * mismatch would only surface much later, in the revision turn.
 */
function assertAnchorMatchesAtype(atype: FeedbackAtype, anchor: FeedbackAnchor): void {
  const isDesign = isDesignFeedbackAtype(atype);
  if (isElementAnchor(anchor)) {
    if (!isDesign) {
      throw new FeedbackError(
        'invalid_anchor',
        `element anchors are only valid on the design-prototype atypes (got atype '${atype}')`,
      );
    }
    if (!isWellFormedElementAnchor(anchor)) {
      throw new FeedbackError(
        'invalid_anchor',
        'element anchor is malformed (needs a non-empty ancestorStack and an in-range pickedIndex)',
      );
    }
    return;
  }
  if (isDesign) {
    throw new FeedbackError(
      'invalid_anchor',
      `quote anchors are only valid on the document atypes (got atype '${atype}')`,
    );
  }
  if (typeof anchor.quote !== 'string' || !Number.isInteger(anchor.occurrence) || typeof anchor.bodyHash !== 'string') {
    throw new FeedbackError('invalid_anchor', 'quote anchor is malformed (needs quote + occurrence + bodyHash)');
  }
}

// ---------------------------------------------------------------------------
// Exhaustiveness guard for the FeedbackChange dispatch switch. A new op added
// to the union without a switch case is a compile error here (TS2345), never a
// silent fall-through.
// ---------------------------------------------------------------------------

function assertNeverChange(change: never): never {
  throw new FeedbackError('invalid_op', `unhandled feedback change op: ${JSON.stringify(change)}`);
}

// ---------------------------------------------------------------------------
// Stored-anchor parsing
// ---------------------------------------------------------------------------

/**
 * Parse a stored `anchor_json` into the FeedbackAnchor union, FAIL-SOFT: `null`
 * for malformed JSON or a shape matching neither variant, so listComments can
 * skip the row instead of taking down a whole document's read.
 *
 * Legacy quote anchors (migration 077) have NO `kind` field, so the element
 * variant is detected by `kind === 'element'` and everything else is validated as
 * a quote anchor.
 */
function parseStoredAnchor(anchorJson: string): FeedbackAnchor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(anchorJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  if ((parsed as Partial<ElementCommentAnchor>).kind === 'element') {
    const el = parsed as Partial<ElementCommentAnchor>;
    const candidate: ElementCommentAnchor = {
      kind: 'element',
      designId: typeof el.designId === 'string' ? el.designId : null,
      ancestorStack: Array.isArray(el.ancestorStack) ? el.ancestorStack : [],
      pickedIndex: typeof el.pickedIndex === 'number' ? el.pickedIndex : -1,
    };
    return isWellFormedElementAnchor(candidate) ? candidate : null;
  }

  const q = parsed as Partial<CommentAnchor>;
  if (typeof q.quote !== 'string' || typeof q.occurrence !== 'number' || typeof q.bodyHash !== 'string') {
    return null;
  }
  return { quote: q.quote, occurrence: q.occurrence, bodyHash: q.bodyHash };
}

// ---------------------------------------------------------------------------
// FeedbackRouter
// ---------------------------------------------------------------------------

export class FeedbackRouter {
  private static instance: FeedbackRouter | null = null;

  /** Per-project serialization queues (feedback is project-scoped, via the owning run). */
  private projectQueues = new Map<number, PQueue>();

  constructor(private readonly db: DatabaseLike) {}

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring ReviewItemRouter / ArtifactRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike): FeedbackRouter {
    FeedbackRouter.instance = new FeedbackRouter(db);
    return FeedbackRouter.instance;
  }

  static getInstance(): FeedbackRouter {
    if (!FeedbackRouter.instance) {
      throw new Error('FeedbackRouter has not been initialized. Call FeedbackRouter.initialize() from main/src/index.ts.');
    }
    return FeedbackRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    FeedbackRouter.instance = null;
  }

  private getProjectQueue(projectId: number): PQueue {
    let q = this.projectQueues.get(projectId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.projectQueues.set(projectId, q);
    }
    return q;
  }

  /** Test/seam helper — exposes the per-project queue for `.onIdle()` waits. */
  _queueForProject(projectId: number): PQueue {
    return this.getProjectQueue(projectId);
  }

  // --------------------------------------------------------------------------
  // Core API — apply() overloads give each op its own precise return shape.
  // --------------------------------------------------------------------------

  async apply(projectId: number, change: FeedbackCreateComment): Promise<{ commentId: string }>;
  async apply(projectId: number, change: FeedbackUpdateComment): Promise<{ commentId: string }>;
  async apply(projectId: number, change: FeedbackDeleteComment): Promise<{ commentId: string }>;
  async apply(
    projectId: number,
    change: FeedbackSendBatch,
  ): Promise<{ batchId: string; round: number; commentIds: string[] }>;
  async apply(projectId: number, change: FeedbackBatchApplied): Promise<{ batchId: string; applied: boolean }>;
  async apply(projectId: number, change: FeedbackBatchFailed): Promise<{ batchId: string; failed: boolean }>;
  async apply(
    projectId: number,
    change: FeedbackCreateDesignBatch,
  ): Promise<{ batchId: string; round: number; commentIds: string[] }>;
  async apply(
    projectId: number,
    change: FeedbackTransitionBatch,
  ): Promise<{ batchId: string; status: FeedbackBatchStatus }>;
  async apply(
    projectId: number,
    change: FeedbackRecordDispatchAttempt,
  ): Promise<{ batchId: string; attemptId: string; attemptCount: number }>;
  async apply(projectId: number, change: FeedbackApplyBatchResult): Promise<{ batchId: string; applied: boolean }>;
  async apply(projectId: number, change: FeedbackChange): Promise<FeedbackApplyResult> {
    return this.getProjectQueue(projectId).add(() => {
      switch (change.op) {
        case 'create-comment':
          return this.runCreateComment(projectId, change);
        case 'update-comment':
          return this.runUpdateComment(projectId, change);
        case 'delete-comment':
          return this.runDeleteComment(projectId, change);
        case 'send-batch':
          return this.runSendBatch(projectId, change);
        case 'batch-applied':
          return this.runBatchApplied(projectId, change);
        case 'batch-failed':
          return this.runBatchFailed(projectId, change);
        case 'create-design-batch':
          return this.runCreateDesignBatch(projectId, change);
        case 'transition-batch':
          return this.runTransitionBatch(projectId, change);
        case 'record-dispatch-attempt':
          return this.runRecordDispatchAttempt(projectId, change);
        case 'apply-batch-result':
          return this.runApplyBatchResult(projectId, change);
        default:
          return assertNeverChange(change);
      }
    }) as Promise<FeedbackApplyResult>;
  }

  // --------------------------------------------------------------------------
  // Design-outbox primitives — named wrappers over the apply() ops above, so the
  // pipeline reads as verbs while every write still goes through the single
  // dispatch + per-project queue. `projectId` is resolved from the batch row (the
  // caller never supplies it) for the batch-keyed ops.
  // --------------------------------------------------------------------------

  /**
   * Mint a design batch in 'queued' bound to `sessionId`, stamping the named
   * drafts sent/batch_id in the same transaction. Deliberately requires NO parked
   * run and NO open gate — a design session is a live chat.
   */
  async createDesignBatch(input: {
    projectId: number;
    runId: string;
    sessionId: string;
    atype: DesignFeedbackAtype;
    sourceRef: string;
    commentIds: string[];
    now?: string;
  }): Promise<{ batchId: string; round: number; commentIds: string[] }> {
    const { projectId, ...rest } = input;
    return this.apply(projectId, { op: 'create-design-batch', ...rest });
  }

  /** Guarded outbox transition (see DESIGN_TRANSITIONS). Throws on an illegal move or a `from` mismatch. */
  async transitionBatch(input: {
    batchId: string;
    from: FeedbackBatchStatus;
    to: FeedbackBatchStatus;
    blockedReason?: string;
    error?: string;
    now?: string;
  }): Promise<{ batchId: string; status: FeedbackBatchStatus }> {
    return this.apply(this.requireBatchProjectId(input.batchId), { op: 'transition-batch', ...input });
  }

  /** Open a delivery attempt: → 'dispatching', stamp attempt id, bump attempt_count (one transaction). */
  async recordDispatchAttempt(input: {
    batchId: string;
    attemptId: string;
    now?: string;
  }): Promise<{ batchId: string; attemptId: string; attemptCount: number }> {
    return this.apply(this.requireBatchProjectId(input.batchId), { op: 'record-dispatch-attempt', ...input });
  }

  /** The one-result CAS. The losing duplicate gets `{ applied: false }`, never a throw. */
  async applyBatchResult(input: {
    batchId: string;
    attemptId: string;
    prototypeRevision: number;
    now?: string;
  }): Promise<{ batchId: string; applied: boolean }> {
    return this.apply(this.requireBatchProjectId(input.batchId), { op: 'apply-batch-result', ...input });
  }

  // --------------------------------------------------------------------------
  // create-comment
  // --------------------------------------------------------------------------

  private runCreateComment(projectId: number, change: FeedbackCreateComment): { commentId: string } {
    if (!isFeedbackAtype(change.atype)) {
      throw new FeedbackError('invalid_atype', `unknown feedback atype '${String(change.atype)}'`);
    }
    const body = change.body.trim();
    if (body.length === 0) {
      throw new FeedbackError('invalid_body', 'comment body must not be empty');
    }
    assertAnchorMatchesAtype(change.atype, change.anchor);

    const now = new Date().toISOString();
    const commentId = `fbc_${randomBytes(10).toString('hex')}`;

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO feedback_comments
             (id, project_id, run_id, atype, source_ref, batch_id, anchor_json, body, status,
              created_at, updated_at, sent_at, addressed_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'draft', ?, ?, NULL, NULL)`,
        )
        .run(
          commentId,
          projectId,
          change.runId,
          change.atype,
          change.sourceRef,
          JSON.stringify(change.anchor),
          body,
          now,
          now,
        );
    });
    (txn as () => void)();

    this.emitChange(projectId, change.runId, change.atype, change.sourceRef);
    return { commentId };
  }

  // --------------------------------------------------------------------------
  // update-comment (draft-only)
  // --------------------------------------------------------------------------

  private runUpdateComment(projectId: number, change: FeedbackUpdateComment): { commentId: string } {
    const now = new Date().toISOString();
    const current = this.readComment(projectId, change.commentId);
    if (!current) {
      throw new FeedbackError('not_found', `feedback comment ${change.commentId} not found`);
    }
    if (current.status !== 'draft') {
      throw new FeedbackError(
        'not_draft',
        `feedback comment ${change.commentId} is not a draft (status='${current.status}')`,
      );
    }

    let nextBody = current.body;
    if (change.body !== undefined) {
      nextBody = change.body.trim();
      if (nextBody.length === 0) {
        throw new FeedbackError('invalid_body', 'comment body must not be empty');
      }
    }
    if (change.anchor !== undefined) {
      // Cross-validated against the STORED atype — an update can never smuggle in
      // the other surface's anchor variant.
      assertAnchorMatchesAtype(current.atype, change.anchor);
    }
    const nextAnchorJson = change.anchor !== undefined ? JSON.stringify(change.anchor) : current.anchor_json;

    const txn = this.db.transaction(() => {
      this.db
        .prepare('UPDATE feedback_comments SET body = ?, anchor_json = ?, updated_at = ? WHERE id = ?')
        .run(nextBody, nextAnchorJson, now, change.commentId);
    });
    (txn as () => void)();

    this.emitChange(projectId, current.run_id, current.atype, current.source_ref);
    return { commentId: change.commentId };
  }

  // --------------------------------------------------------------------------
  // delete-comment (draft-only, hard delete)
  // --------------------------------------------------------------------------

  private runDeleteComment(projectId: number, change: FeedbackDeleteComment): { commentId: string } {
    const current = this.readComment(projectId, change.commentId);
    if (!current) {
      throw new FeedbackError('not_found', `feedback comment ${change.commentId} not found`);
    }
    if (current.status !== 'draft') {
      throw new FeedbackError(
        'not_draft',
        `feedback comment ${change.commentId} is not a draft (status='${current.status}')`,
      );
    }

    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM feedback_comments WHERE id = ?').run(change.commentId);
    });
    (txn as () => void)();

    this.emitChange(projectId, current.run_id, current.atype, current.source_ref);
    return { commentId: change.commentId };
  }

  // --------------------------------------------------------------------------
  // send-batch — mint a batch from every draft comment on the document
  // --------------------------------------------------------------------------

  private runSendBatch(
    projectId: number,
    change: FeedbackSendBatch,
  ): { batchId: string; round: number; commentIds: string[] } {
    if (!isFeedbackAtype(change.atype)) {
      throw new FeedbackError('invalid_atype', `unknown feedback atype '${String(change.atype)}'`);
    }
    // send-batch is the DOCUMENT lifecycle (pending → applied | failed). A design
    // prototype must go through create-design-batch so it enters the outbox at
    // 'queued' with its session binding.
    if (isDesignFeedbackAtype(change.atype)) {
      throw new FeedbackError(
        'invalid_atype',
        `atype '${change.atype}' is a design prototype — use create-design-batch, not send-batch`,
      );
    }

    const now = new Date().toISOString();
    const batchId = `fbb_${randomBytes(10).toString('hex')}`;
    let round = 0;
    let commentIds: string[] = [];

    const txn = this.db.transaction(() => {
      const busy = this.db
        .prepare(
          `SELECT 1 AS ok FROM feedback_batches
            WHERE run_id = ? AND atype = ? AND source_ref = ? AND status = 'pending'`,
        )
        .get(change.runId, change.atype, change.sourceRef) as { ok: number } | undefined;
      if (busy) {
        throw new FeedbackError(
          'busy',
          `a feedback batch is already pending for run ${change.runId} atype ${change.atype} sourceRef ${change.sourceRef}`,
        );
      }

      const drafts = this.db
        .prepare(
          `SELECT id FROM feedback_comments
            WHERE run_id = ? AND atype = ? AND source_ref = ? AND status = 'draft'
            ORDER BY created_at ASC`,
        )
        .all(change.runId, change.atype, change.sourceRef) as Array<{ id: string }>;
      if (drafts.length === 0) {
        throw new FeedbackError(
          'no_comments',
          `no draft comments for run ${change.runId} atype ${change.atype} sourceRef ${change.sourceRef}`,
        );
      }
      commentIds = drafts.map((d) => d.id);

      const maxRoundRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(round), 0) AS maxRound FROM feedback_batches
            WHERE run_id = ? AND atype = ? AND source_ref = ?`,
        )
        .get(change.runId, change.atype, change.sourceRef) as { maxRound: number };
      round = maxRoundRow.maxRound + 1;

      this.db
        .prepare(
          `INSERT INTO feedback_batches
             (id, project_id, run_id, atype, source_ref, round, status, error, created_at, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
        )
        .run(batchId, projectId, change.runId, change.atype, change.sourceRef, round, now);

      const placeholders = commentIds.map(() => '?').join(', ');
      this.db
        .prepare(`UPDATE feedback_comments SET status = 'sent', batch_id = ?, sent_at = ? WHERE id IN (${placeholders})`)
        .run(batchId, now, ...commentIds);
    });
    (txn as () => void)();

    this.emitChange(projectId, change.runId, change.atype, change.sourceRef);
    return { batchId, round, commentIds };
  }

  // --------------------------------------------------------------------------
  // batch-applied — pending -> applied; comments sent -> addressed
  // --------------------------------------------------------------------------

  private runBatchApplied(projectId: number, change: FeedbackBatchApplied): { batchId: string; applied: boolean } {
    const now = new Date().toISOString();
    const batch = this.readBatch(projectId, change.batchId);
    if (!batch) {
      throw new FeedbackError('not_found', `feedback batch ${change.batchId} not found`);
    }

    let applied = false;
    const txn = this.db.transaction(() => {
      if (batch.status !== 'pending') return; // idempotent no-op — already terminal
      this.db
        .prepare(`UPDATE feedback_batches SET status = 'applied', applied_at = ? WHERE id = ? AND status = 'pending'`)
        .run(now, change.batchId);
      this.db
        .prepare(
          `UPDATE feedback_comments SET status = 'addressed', addressed_at = ?
            WHERE batch_id = ? AND status = 'sent'`,
        )
        .run(now, change.batchId);
      applied = true;
    });
    (txn as () => void)();

    if (applied) this.emitChange(projectId, batch.run_id, batch.atype, batch.source_ref);
    return { batchId: change.batchId, applied };
  }

  // --------------------------------------------------------------------------
  // batch-failed — pending -> failed; comments sent -> draft (editable retry)
  // --------------------------------------------------------------------------

  private runBatchFailed(
    projectId: number,
    change: FeedbackBatchFailed,
  ): { batchId: string; failed: boolean } {
    const batch = this.readBatch(projectId, change.batchId);
    if (!batch) {
      throw new FeedbackError('not_found', `feedback batch ${change.batchId} not found`);
    }

    let failed = false;
    const txn = this.db.transaction(() => {
      if (batch.status !== 'pending') return; // idempotent no-op — already terminal
      this.db
        .prepare(`UPDATE feedback_batches SET status = 'failed', error = ? WHERE id = ? AND status = 'pending'`)
        .run(change.error, change.batchId);
      // Revert sent comments to editable drafts (batch_id/sent_at cleared) so the
      // user can edit and retry; the failed batch row remains as the durable record.
      this.db
        .prepare(
          `UPDATE feedback_comments SET status = 'draft', batch_id = NULL, sent_at = NULL
            WHERE batch_id = ? AND status = 'sent'`,
        )
        .run(change.batchId);
      failed = true;
    });
    (txn as () => void)();

    if (failed) this.emitChange(projectId, batch.run_id, batch.atype, batch.source_ref);
    return { batchId: change.batchId, failed };
  }

  // --------------------------------------------------------------------------
  // create-design-batch — mint a 'queued' outbox batch bound to a design session
  // --------------------------------------------------------------------------

  private runCreateDesignBatch(
    projectId: number,
    change: FeedbackCreateDesignBatch,
  ): { batchId: string; round: number; commentIds: string[] } {
    if (!isDesignFeedbackAtype(change.atype)) {
      throw new FeedbackError(
        'invalid_atype',
        `create-design-batch requires a design-prototype atype (got '${String(change.atype)}')`,
      );
    }
    if (change.commentIds.length === 0) {
      throw new FeedbackError('no_comments', 'create-design-batch requires at least one draft comment');
    }

    const now = change.now ?? new Date().toISOString();
    const batchId = `fbb_${randomBytes(10).toString('hex')}`;
    const commentIds = [...new Set(change.commentIds)];
    let round = 0;

    const txn = this.db.transaction(() => {
      // One outbox per document at a time: a second queued batch would race the
      // first through dispatch and double-apply the same prototype.
      const busy = this.db
        .prepare(
          `SELECT 1 AS ok FROM feedback_batches
            WHERE run_id = ? AND atype = ? AND source_ref = ?
              AND status IN ('queued','dispatching','dispatched')`,
        )
        .get(change.runId, change.atype, change.sourceRef) as { ok: number } | undefined;
      if (busy) {
        throw new FeedbackError(
          'busy',
          `a design feedback batch is already in flight for run ${change.runId} atype ${change.atype} sourceRef ${change.sourceRef}`,
        );
      }

      // Every named comment must be a draft on THIS exact document — a caller
      // cannot sweep another document's (or another project's) comments into the batch.
      const placeholders = commentIds.map(() => '?').join(', ');
      const eligible = this.db
        .prepare(
          `SELECT id FROM feedback_comments
            WHERE id IN (${placeholders})
              AND project_id = ? AND run_id = ? AND atype = ? AND source_ref = ? AND status = 'draft'`,
        )
        .all(...commentIds, projectId, change.runId, change.atype, change.sourceRef) as Array<{ id: string }>;
      if (eligible.length !== commentIds.length) {
        throw new FeedbackError(
          'not_found',
          `create-design-batch: ${commentIds.length - eligible.length} of ${commentIds.length} comment ids are not drafts on this document`,
        );
      }

      const maxRoundRow = this.db
        .prepare(
          `SELECT COALESCE(MAX(round), 0) AS maxRound FROM feedback_batches
            WHERE run_id = ? AND atype = ? AND source_ref = ?`,
        )
        .get(change.runId, change.atype, change.sourceRef) as { maxRound: number };
      round = maxRoundRow.maxRound + 1;

      this.db
        .prepare(
          `INSERT INTO feedback_batches
             (id, project_id, run_id, atype, source_ref, round, status, error, created_at, applied_at,
              session_id, current_attempt_id, attempt_count, blocked_reason, dispatched_at,
              applied_prototype_revision)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, NULL, ?, NULL, 0, NULL, NULL, NULL)`,
        )
        .run(batchId, projectId, change.runId, change.atype, change.sourceRef, round, now, change.sessionId);

      this.db
        .prepare(`UPDATE feedback_comments SET status = 'sent', batch_id = ?, sent_at = ? WHERE id IN (${placeholders})`)
        .run(batchId, now, ...commentIds);
    });
    (txn as () => void)();

    this.emitChange(projectId, change.runId, change.atype, change.sourceRef);
    return { batchId, round, commentIds };
  }

  // --------------------------------------------------------------------------
  // transition-batch — the guarded outbox move
  // --------------------------------------------------------------------------

  private runTransitionBatch(
    projectId: number,
    change: FeedbackTransitionBatch,
  ): { batchId: string; status: FeedbackBatchStatus } {
    const batch = this.readBatch(projectId, change.batchId);
    if (!batch) {
      throw new FeedbackError('not_found', `feedback batch ${change.batchId} not found`);
    }
    if (batch.status !== change.from) {
      throw new FeedbackError(
        'invalid_transition',
        `feedback batch ${change.batchId} is '${batch.status}', not the expected '${change.from}'`,
      );
    }
    if (!DESIGN_TRANSITIONS[change.from].includes(change.to)) {
      throw new FeedbackError(
        'invalid_transition',
        `illegal feedback batch transition '${change.from}' -> '${change.to}'`,
      );
    }
    if (change.to === 'blocked' && (change.blockedReason ?? '').trim().length === 0) {
      throw new FeedbackError('invalid_transition', "transition to 'blocked' requires a blockedReason");
    }
    if (change.to === 'failed' && (change.error ?? '').trim().length === 0) {
      throw new FeedbackError('invalid_transition', "transition to 'failed' requires an error");
    }

    const now = change.now ?? new Date().toISOString();
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE feedback_batches
              SET status = ?,
                  dispatched_at = CASE WHEN ? = 'dispatched' THEN ? ELSE dispatched_at END,
                  applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END,
                  blocked_reason = CASE WHEN ? = 'blocked' THEN ? ELSE blocked_reason END,
                  error = CASE WHEN ? = 'failed' THEN ? ELSE error END
            WHERE id = ? AND status = ?`,
        )
        .run(
          change.to,
          change.to,
          now,
          change.to,
          now,
          change.to,
          change.blockedReason ?? null,
          change.to,
          change.error ?? null,
          change.batchId,
          change.from,
        );
    });
    (txn as () => void)();

    this.emitChange(projectId, batch.run_id, batch.atype, batch.source_ref);
    return { batchId: change.batchId, status: change.to };
  }

  // --------------------------------------------------------------------------
  // record-dispatch-attempt — durable attempt BEFORE the SDK call
  // --------------------------------------------------------------------------

  private runRecordDispatchAttempt(
    projectId: number,
    change: FeedbackRecordDispatchAttempt,
  ): { batchId: string; attemptId: string; attemptCount: number } {
    const batch = this.readBatch(projectId, change.batchId);
    if (!batch) {
      throw new FeedbackError('not_found', `feedback batch ${change.batchId} not found`);
    }
    // 'dispatching'/'dispatched' are legal sources too: that is the RECOVERY
    // re-delivery path — the same batch id, a NEW attempt id.
    if (!DISPATCHABLE_FROM.includes(batch.status)) {
      throw new FeedbackError(
        'invalid_transition',
        `cannot open a dispatch attempt on a '${batch.status}' feedback batch (${change.batchId})`,
      );
    }

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE feedback_batches
              SET status = 'dispatching', current_attempt_id = ?, attempt_count = attempt_count + 1
            WHERE id = ? AND status IN ('queued','dispatching','dispatched')`,
        )
        .run(change.attemptId, change.batchId);
    });
    (txn as () => void)();

    const after = this.readBatch(projectId, change.batchId);
    this.emitChange(projectId, batch.run_id, batch.atype, batch.source_ref);
    return {
      batchId: change.batchId,
      attemptId: change.attemptId,
      attemptCount: after?.attempt_count ?? batch.attempt_count + 1,
    };
  }

  // --------------------------------------------------------------------------
  // apply-batch-result — the ONE-RESULT CAS
  // --------------------------------------------------------------------------

  private runApplyBatchResult(
    projectId: number,
    change: FeedbackApplyBatchResult,
  ): { batchId: string; applied: boolean } {
    const batch = this.readBatch(projectId, change.batchId);
    if (!batch) {
      throw new FeedbackError('not_found', `feedback batch ${change.batchId} not found`);
    }

    const now = change.now ?? new Date().toISOString();
    let applied = false;
    const txn = this.db.transaction(() => {
      // The CAS is the WHERE clause, not the read above: a duplicate ack (or a
      // second turn that both applied the feedback) finds status='applied' and
      // changes nothing. Deliberately NOT gated on attemptId — recovery
      // re-delivers under a new attempt id, so a late ack from the PREVIOUS
      // attempt is still a valid result for this batch; the winning attempt is
      // recorded rather than required.
      const res = this.db
        .prepare(
          `UPDATE feedback_batches
              SET status = 'applied', applied_at = ?, current_attempt_id = ?, applied_prototype_revision = ?
            WHERE id = ? AND status IN ('dispatching','dispatched')`,
        )
        .run(now, change.attemptId, change.prototypeRevision, change.batchId);
      if (res.changes === 0) return;
      this.db
        .prepare(
          `UPDATE feedback_comments SET status = 'addressed', addressed_at = ?
            WHERE batch_id = ? AND status = 'sent'`,
        )
        .run(now, change.batchId);
      applied = true;
    });
    (txn as () => void)();

    if (applied) this.emitChange(projectId, batch.run_id, batch.atype, batch.source_ref);
    return { batchId: change.batchId, applied };
  }

  // --------------------------------------------------------------------------
  // Read helpers (no queue — plain reads)
  // --------------------------------------------------------------------------

  /** List a document's comments, newest-anchor-first-inserted (created_at ASC). */
  listComments(runId: string, atype?: FeedbackAtype, sourceRef?: string): FeedbackComment[] {
    const conditions = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (atype !== undefined) {
      conditions.push('atype = ?');
      params.push(atype);
    }
    if (sourceRef !== undefined) {
      conditions.push('source_ref = ?');
      params.push(sourceRef);
    }
    const rows = this.db
      .prepare(`SELECT * FROM feedback_comments WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`)
      .all(...params) as FeedbackCommentDbRow[];

    const result: FeedbackComment[] = [];
    for (const row of rows) {
      const shaped = FeedbackRouter.shapeCommentRow(row);
      if (shaped) result.push(shaped); // fail-soft: a malformed anchor_json row is skipped
    }
    return result;
  }

  /** List a document's batches in round order. */
  listBatches(runId: string, atype?: FeedbackAtype, sourceRef?: string): FeedbackBatch[] {
    const conditions = ['run_id = ?'];
    const params: unknown[] = [runId];
    if (atype !== undefined) {
      conditions.push('atype = ?');
      params.push(atype);
    }
    if (sourceRef !== undefined) {
      conditions.push('source_ref = ?');
      params.push(sourceRef);
    }
    const rows = this.db
      .prepare(`SELECT * FROM feedback_batches WHERE ${conditions.join(' AND ')} ORDER BY round ASC`)
      .all(...params) as FeedbackBatchDbRow[];
    return rows.map((row) => FeedbackRouter.shapeBatchRow(row));
  }

  // --------------------------------------------------------------------------
  // Boot recovery
  // --------------------------------------------------------------------------

  /**
   * Fail every batch left `pending` by an app exit (called once at boot). A
   * pending batch is orphaned when the process dies mid-revision: its comments
   * stay 'sent' and its (runId, atype, sourceRef) trips the send-batch 'busy'
   * guard forever. Each is routed through the normal `batch-failed` op — so the
   * per-project serialization, the sent→draft comment revert, and the change-event
   * emit all come for free — and the user can edit + resend. Returns the count
   * actually swept (a 0-count no-op when nothing is pending).
   *
   * Accepted edge: a crash AFTER the revision body write commits but BEFORE the
   * batch-applied flip leaves the revision applied while this sweep reverts the
   * comments to drafts — safe (no data loss: the user sees the updated doc and can
   * delete the re-drafted comments).
   *
   * Scope: 'pending' is the DOCUMENT lifecycle's only non-terminal state, so this
   * sweep touches document batches only. Design-outbox batches left
   * queued/dispatching/dispatched are deliberately NOT failed here — they are
   * re-delivered under the same batch id with a new attempt id by the outbox's own
   * recovery (see DESIGN_BATCH_INFLIGHT_STATUSES and migration 092's
   * idx_feedback_batches_inflight).
   */
  async sweepInterruptedBatches(): Promise<number> {
    const rows = this.db
      .prepare(`SELECT id, project_id FROM feedback_batches WHERE status = 'pending'`)
      .all() as Array<{ id: string; project_id: number }>;

    let swept = 0;
    for (const row of rows) {
      const result = await this.apply(row.project_id, {
        op: 'batch-failed',
        batchId: row.id,
        error: 'interrupted by app restart — resend to retry',
      });
      if (result.failed) swept++;
    }
    return swept;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private readComment(projectId: number, commentId: string): FeedbackCommentDbRow | undefined {
    return this.db
      .prepare('SELECT * FROM feedback_comments WHERE id = ? AND project_id = ?')
      .get(commentId, projectId) as FeedbackCommentDbRow | undefined;
  }

  private readBatch(projectId: number, batchId: string): FeedbackBatchDbRow | undefined {
    return this.db
      .prepare('SELECT * FROM feedback_batches WHERE id = ? AND project_id = ?')
      .get(batchId, projectId) as FeedbackBatchDbRow | undefined;
  }

  /**
   * Resolve the owning project of a batch so the batch-keyed design-outbox
   * primitives can pick the right serialization queue without the caller
   * threading a projectId (which would be a trust surface, not a convenience).
   */
  private requireBatchProjectId(batchId: string): number {
    const row = this.db
      .prepare('SELECT project_id AS projectId FROM feedback_batches WHERE id = ?')
      .get(batchId) as { projectId: number } | undefined;
    if (!row) {
      throw new FeedbackError('not_found', `feedback batch ${batchId} not found`);
    }
    return row.projectId;
  }

  private emitChange(projectId: number, runId: string, atype: FeedbackAtype, sourceRef: string): void {
    const event: FeedbackChangedEvent = {
      projectId,
      runId,
      atype,
      sourceRef,
      comments: this.listComments(runId, atype, sourceRef),
      batches: this.listBatches(runId, atype, sourceRef),
    };
    feedbackEvents.emit(feedbackProjectChannel(projectId), event);
  }

  /**
   * Map a raw feedback_comments row to the API shape, parsing anchor_json
   * FAIL-SOFT: a malformed/incomplete anchor is surfaced as `null` here so the
   * caller (listComments) can skip the row rather than throw and take down an
   * entire document's read.
   */
  static shapeCommentRow(row: FeedbackCommentDbRow): FeedbackComment | null {
    const anchor = parseStoredAnchor(row.anchor_json);
    if (!anchor) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      atype: row.atype,
      sourceRef: row.source_ref,
      batchId: row.batch_id,
      anchor,
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at,
      addressedAt: row.addressed_at,
    };
  }

  /** Map a raw feedback_batches row to the API shape (no JSON columns — never fails). */
  static shapeBatchRow(row: FeedbackBatchDbRow): FeedbackBatch {
    return {
      id: row.id,
      projectId: row.project_id,
      runId: row.run_id,
      atype: row.atype,
      sourceRef: row.source_ref,
      round: row.round,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
      sessionId: row.session_id,
      currentAttemptId: row.current_attempt_id,
      attemptCount: row.attempt_count,
      blockedReason: row.blocked_reason,
      dispatchedAt: row.dispatched_at,
      appliedPrototypeRevision: row.applied_prototype_revision,
    };
  }
}
