/**
 * cyboflow.feedback sub-router — in-artifact feedback on the idea-spec /
 * arch-design document tabs (IDEA-033) AND element-tagged comments on design
 * prototypes (Design Mode v1).
 *
 * Typed tRPC contract for the renderer's feedback surfaces:
 *   - list              : query        -> { comments, batches } (a run's feedback)
 *   - createComment     : mutation     -> { commentId }
 *   - updateComment     : mutation     -> { commentId }
 *   - deleteComment     : mutation     -> { commentId }
 *   - sendBatch         : mutation     -> SendFeedbackResult (refusals are DATA)
 *   - onFeedbackChanged : subscription -> FeedbackChangedEvent (project-scoped)
 *
 * TWO SURFACES, ONE GATE SPLIT. The parked-run guard chain — run status in
 * FEEDBACK_PARKED_RUN_STATUSES plus an open pending blocking decision gate, all
 * enforced inside sendFeedbackHandler — is a DOCUMENT-path rule: a planner/ship
 * document can only influence a decision while that decision is still open. A
 * design session is a live chat that is never parked and has no gate, so the
 * design-prototype atypes must NOT be routed through it. `sendBatch` therefore
 * accepts the document atypes ONLY (a prototype atype is a BAD_REQUEST naming the
 * design path); comment CRUD accepts both, gated only by the anchor↔atype pairing
 * the FeedbackRouter chokepoint enforces. Sending a design batch is the outbox's
 * job (FeedbackRouter.createDesignBatch), wired by a later stage.
 *
 * Comment CRUD forwards to the FeedbackRouter chokepoint (getInstance()); sendBatch
 * forwards to sendFeedbackHandler (guards + detached revision launch). `projectId`
 * for every write is resolved from workflow_runs — a client-supplied projectId is
 * never trusted. Refusals from sendBatch are returned as `{ noOp, reason }` data,
 * not thrown; FeedbackRouter chokepoint errors are surfaced as typed TRPCErrors.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. The service-backed revision launcher is injected at boot
 * via setRevisionLauncher (sendFeedbackHandler.ts) and read here through
 * getRevisionLauncher().
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import type {
  FeedbackBatch,
  FeedbackChangedEvent,
  FeedbackComment,
} from '../../../../../shared/types/feedback';
import type { SendFeedbackResult } from '../../../../../shared/types/feedback';
import { FeedbackRouter, FeedbackError } from '../../feedbackRouter';
import { sendFeedbackHandler, getRevisionLauncher } from '../../sendFeedbackHandler';
import { eventToAsyncIterable, feedbackEvents, feedbackProjectChannel } from './events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[feedback.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

/** Resolve the run's project (writes never trust a client-supplied projectId). */
function resolveProjectId(db: DatabaseLike, runId: string, where: string): number {
  const run = db
    .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
    .get(runId) as { projectId: number } | undefined;
  if (!run) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `[feedback.${where}] run ${runId} not found` });
  }
  return run.projectId;
}

/** Map a FeedbackError code to a TRPCError (code carried in the message). */
function rethrowAsTRPCError(err: unknown): never {
  if (err instanceof FeedbackError) {
    const codeMap: Record<FeedbackError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_atype: 'BAD_REQUEST',
      invalid_body: 'BAD_REQUEST',
      invalid_anchor: 'BAD_REQUEST',
      not_draft: 'CONFLICT',
      busy: 'CONFLICT',
      no_comments: 'BAD_REQUEST',
      invalid_transition: 'CONFLICT',
      invalid_op: 'BAD_REQUEST',
    };
    throw new TRPCError({ code: codeMap[err.code], message: `${err.code}: ${err.message}`, cause: err });
  }
  throw err;
}

/** The document atypes — the ONLY atypes the parked-gate sendBatch path accepts. */
const docAtypeSchema = z.enum(['idea-spec', 'arch-design']);
/** The design-prototype atypes — never parked-gated. */
const designAtypeSchema = z.enum(['ui-prototype', 'interactive-prototype']);
/** Either surface — comment CRUD and the read paths accept both. */
const feedbackAtypeSchema = z.union([docAtypeSchema, designAtypeSchema]);

/** Quote anchor (document surface). Legacy stored anchors carry no `kind` field. */
const quoteAnchorSchema = z.object({
  quote: z.string(),
  occurrence: z.number().int().min(0),
  bodyHash: z.string(),
});

/**
 * Element anchor (design-prototype surface). `ancestorStack` is ordered
 * innermost-first (index 0 = the picked element, last = body) and `pickedIndex`
 * indexes into it; the in-range check is left to the FeedbackRouter chokepoint so
 * the rule lives in exactly one place.
 */
const elementAnchorSchema = z.object({
  kind: z.literal('element'),
  designId: z.string().nullable(),
  ancestorStack: z
    .array(
      z.object({
        tag: z.string().min(1),
        designId: z.string().nullable(),
        label: z.string().nullable(),
      }),
    )
    .min(1),
  pickedIndex: z.number().int().min(0),
});

const anchorSchema = z.union([elementAnchorSchema, quoteAnchorSchema]);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const feedbackRouter = router({
  /** All feedback comments + batches for a run (optionally scoped by document). */
  list: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        atype: feedbackAtypeSchema.optional(),
        sourceRef: z.string().min(1).optional(),
      }),
    )
    .query(
      ({ input }): { comments: FeedbackComment[]; batches: FeedbackBatch[] } => {
        const feedback = FeedbackRouter.getInstance();
        return {
          comments: feedback.listComments(input.runId, input.atype, input.sourceRef),
          batches: feedback.listBatches(input.runId, input.atype, input.sourceRef),
        };
      },
    ),

  /**
   * Create a draft comment on a document OR a design prototype. Deliberately NOT
   * parked-run gated for either surface: drafting is always allowed, and the
   * design surface has no gate at all. The anchor↔atype pairing is enforced by the
   * FeedbackRouter chokepoint (surfaced here as `invalid_anchor` → BAD_REQUEST).
   */
  createComment: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        atype: feedbackAtypeSchema,
        sourceRef: z.string().min(1),
        anchor: anchorSchema,
        body: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ commentId: string }> => {
      const db = requireDb(ctx.db, 'createComment');
      const projectId = resolveProjectId(db, input.runId, 'createComment');
      try {
        return await FeedbackRouter.getInstance().apply(projectId, {
          op: 'create-comment',
          runId: input.runId,
          atype: input.atype,
          sourceRef: input.sourceRef,
          anchor: input.anchor,
          body: input.body,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Edit a draft comment's body and/or anchor. */
  updateComment: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        commentId: z.string().min(1),
        body: z.string().optional(),
        anchor: anchorSchema.optional(),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<{ commentId: string }> => {
      const db = requireDb(ctx.db, 'updateComment');
      const projectId = resolveProjectId(db, input.runId, 'updateComment');
      try {
        return await FeedbackRouter.getInstance().apply(projectId, {
          op: 'update-comment',
          commentId: input.commentId,
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.anchor !== undefined ? { anchor: input.anchor } : {}),
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Hard-delete a draft comment. */
  deleteComment: protectedProcedure
    .input(z.object({ runId: z.string().min(1), commentId: z.string().min(1) }))
    .mutation(async ({ input, ctx }): Promise<{ commentId: string }> => {
      const db = requireDb(ctx.db, 'deleteComment');
      const projectId = resolveProjectId(db, input.runId, 'deleteComment');
      try {
        return await FeedbackRouter.getInstance().apply(projectId, {
          op: 'delete-comment',
          commentId: input.commentId,
        });
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * "Send feedback" for the DOCUMENT surface: guard the request (parked run +
   * open blocking gate + idea not decomposed) and, on success, fire the
   * host-driven revision detached. Refusals are DATA (`{ noOp, reason }`), never
   * thrown.
   *
   * The input schema accepts the document atypes ONLY. A design prototype has no
   * parked gate to send against — its batches are minted into the durable outbox
   * via FeedbackRouter.createDesignBatch, so routing one here would hit
   * `not_parked` and read as a bug rather than a wrong door.
   */
  sendBatch: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        atype: docAtypeSchema,
        sourceRef: z.string().min(1),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<SendFeedbackResult> => {
      const db = requireDb(ctx.db, 'sendBatch');
      return sendFeedbackHandler(
        { runId: input.runId, atype: input.atype, sourceRef: input.sourceRef },
        {
          db,
          feedbackRouter: FeedbackRouter.getInstance(),
          launchRevision: getRevisionLauncher(),
        },
      );
    }),

  /**
   * "Send feedback" for the DESIGN surface: mint the drafts into a durable
   * 'queued' outbox batch bound to the design session (FeedbackRouter
   * createDesignBatch — no parked gate; a design session is a live chat).
   *
   * QUEUE-ONLY SEAM for now: the design-feedback outbox pipeline picks queued
   * batches up for dispatch (guards → dispatching → SDK revision turn →
   * acknowledged result); until it is wired here, a queued batch simply waits.
   * The pipeline stage extends THIS procedure with its dispatch poke.
   */
  sendDesignBatch: protectedProcedure
    .input(
      z.object({
        runId: z.string().min(1),
        sessionId: z.string().min(1),
        atype: designAtypeSchema,
        sourceRef: z.string().min(1),
        commentIds: z.array(z.string().min(1)).min(1),
      }),
    )
    .mutation(
      async ({
        input,
        ctx,
      }): Promise<{ batchId: string; round: number; commentIds: string[] }> => {
        const db = requireDb(ctx.db, 'sendDesignBatch');
        const projectId = resolveProjectId(db, input.runId, 'sendDesignBatch');
        try {
          return await FeedbackRouter.getInstance().apply(projectId, {
            op: 'create-design-batch',
            runId: input.runId,
            sessionId: input.sessionId,
            atype: input.atype,
            sourceRef: input.sourceRef,
            commentIds: input.commentIds,
          });
        } catch (err) {
          rethrowAsTRPCError(err);
        }
      },
    ),

  /** Project-scoped feedback change stream (comment + batch lifecycle). */
  onFeedbackChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<FeedbackChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<FeedbackChangedEvent>(
        feedbackEvents,
        feedbackProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
