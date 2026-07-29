/**
 * In-artifact feedback — TWO surfaces sharing one pair of tables.
 *
 * 1. DOCUMENT feedback (IDEA-033). Users highlight sections of the idea-spec /
 *    arch-design artifact tabs while a planner/ship run is parked at a human
 *    gate, save comments, and send the batch. Sending is the durable "changes
 *    requested" event: a host-driven scoped revision agent rewrites the target
 *    document (the idea's markdown body — these artifacts re-derive from it)
 *    through TaskChangeRouter while the gate stays open, then the batch flips to
 *    'applied' and its comments to 'addressed' (consumed — per-round, not
 *    threaded). Anchors are quote-based (CommentAnchor).
 *
 * 2. DESIGN-PROTOTYPE feedback (Design Mode v1 — docs/ideas/design-mode.md,
 *    "Design feedback v1 — acknowledged durable outbox"). Users tag elements of a
 *    ui-prototype / interactive-prototype in comment mode and send the batch to
 *    the live design session. Anchors are element-based (ElementCommentAnchor)
 *    and the batch rides an acknowledged outbox lifecycle
 *    (queued → dispatching → dispatched → applied | failed | blocked). A design
 *    session is a live chat, NEVER a parked run — the parked-gate guard chain
 *    (FEEDBACK_PARKED_RUN_STATUSES / sendFeedbackHandler) applies to the document
 *    surface ONLY.
 *
 * Backed by migrations 077 + 090 (feedback_batches / feedback_comments); all
 * writes go through the FeedbackRouter chokepoint
 * (main/src/orchestrator/feedbackRouter.ts).
 */

/** Artifacts that support highlight/element + comment feedback. */
export type FeedbackAtype = 'idea-spec' | 'arch-design' | 'ui-prototype' | 'interactive-prototype';

/** The document artifacts — quote anchors, parked-run gated (IDEA-033). */
export type DocFeedbackAtype = 'idea-spec' | 'arch-design';

/** The design-prototype artifacts — element anchors, outbox lifecycle (Design Mode v1). */
export type DesignFeedbackAtype = 'ui-prototype' | 'interactive-prototype';

export const DOC_FEEDBACK_ATYPES: readonly DocFeedbackAtype[] = ['idea-spec', 'arch-design'];

export const DESIGN_FEEDBACK_ATYPES: readonly DesignFeedbackAtype[] = [
  'ui-prototype',
  'interactive-prototype',
];

export const FEEDBACK_ATYPES: readonly FeedbackAtype[] = [
  ...DOC_FEEDBACK_ATYPES,
  ...DESIGN_FEEDBACK_ATYPES,
];

export function isDocFeedbackAtype(value: unknown): value is DocFeedbackAtype {
  return value === 'idea-spec' || value === 'arch-design';
}

export function isDesignFeedbackAtype(value: unknown): value is DesignFeedbackAtype {
  return value === 'ui-prototype' || value === 'interactive-prototype';
}

export function isFeedbackAtype(value: unknown): value is FeedbackAtype {
  return isDocFeedbackAtype(value) || isDesignFeedbackAtype(value);
}

/**
 * Run statuses that count as "parked at a human gate" for feedback purposes.
 * Human gates park runs under TWO statuses depending on the gate surface:
 * `awaiting_review` (HumanStepManager human steps, blocking findings) and
 * `awaiting_input` (QuestionRouter inline AskUserQuestion gates — e.g. the
 * single-idea `approve-idea` stub gate). Both co-write a pending blocking
 * `decision` review item, which is the actual gate binding; the status check is
 * only the cheap first-line guard, so it must accept both.
 */
export const FEEDBACK_PARKED_RUN_STATUSES: readonly string[] = [
  'awaiting_review',
  'awaiting_input',
];

/**
 * Anchors a comment to a span of the RENDERED document text.
 *
 * The documents live on `ideas.body` (a moving target — revisions rewrite it),
 * so anchoring is quote-based, not offset-based: `quote` is the selected plain
 * text, `occurrence` disambiguates repeats (0-based index among identical
 * matches in the rendered text), and `bodyHash` records which body version the
 * highlight was made against (hashDocumentText) so consumers can tell a
 * still-valid anchor from a stale one after a revision.
 */
export interface CommentAnchor {
  quote: string;
  occurrence: number;
  bodyHash: string;
}

/** One rung of an ElementCommentAnchor's ancestor stack. */
export interface ElementAncestor {
  /** Lowercased tag name, e.g. 'button'. */
  tag: string;
  /** The generator-stamped `data-design-id`, or null when the element carries none. */
  designId: string | null;
  /** Short human/agent-readable label (trimmed text, aria-label, …); null when there is none. */
  label: string | null;
}

/**
 * Anchors a comment to an ELEMENT of a rendered design prototype (the frozen
 * comment frame's inspector produces it — see docs/ideas/design-mode.md,
 * "Comment mode").
 *
 * `designId` is the primary key: the generator stamps stable `data-design-id`
 * attributes (prompt contract in design.md) and a regeneration that preserves
 * the id keeps the anchor exact. It is nullable because a prototype may omit the
 * attribute on the picked element; the ancestor stack is then the relocation
 * fallback AND the human/agent-readable context for the revision turn.
 *
 * `ancestorStack` is ordered INNERMOST-FIRST: index 0 is the element the user
 * picked, each subsequent entry is its parent, and the last entry is the
 * outermost captured element (`body`). `pickedIndex` is the index within that
 * stack the comment is anchored at — it is 0 for a plain pick, and >0 when the
 * user walked the picker UP the stack to tag a containing element (so the
 * captured descendants stay available as relocation context). `designId` mirrors
 * `ancestorStack[pickedIndex].designId`.
 */
export interface ElementCommentAnchor {
  kind: 'element';
  designId: string | null;
  ancestorStack: ElementAncestor[];
  pickedIndex: number;
}

/**
 * The stored `anchor_json` shape: a quote anchor for the document atypes, an
 * element anchor for the design-prototype atypes.
 *
 * Discriminated by the PRESENCE of `kind === 'element'` rather than by a field
 * both variants carry: quote anchors predate the union (migration 077) and their
 * stored JSON has NO `kind` field at all, so every guard must treat "no kind" as
 * the quote variant. Do not add a `kind: 'quote'` literal to CommentAnchor — the
 * legacy rows on disk would not match it.
 */
export type FeedbackAnchor = CommentAnchor | ElementCommentAnchor;

/** True for an element anchor (design-prototype feedback). */
export function isElementAnchor(anchor: FeedbackAnchor): anchor is ElementCommentAnchor {
  return (anchor as Partial<ElementCommentAnchor>).kind === 'element';
}

/** True for a quote anchor (document feedback) — including legacy rows with no `kind`. */
export function isQuoteAnchor(anchor: FeedbackAnchor): anchor is CommentAnchor {
  return !isElementAnchor(anchor);
}

export type FeedbackCommentStatus = 'draft' | 'sent' | 'addressed';

/**
 * Two lifecycles share this column (migration 090):
 *   - document feedback (IDEA-033): pending → applied | failed;
 *   - design outbox (Design Mode v1):
 *       queued → dispatching → dispatched → applied | failed | blocked.
 * 'applied' is terminal for both. FeedbackRouter's transition table is the
 * authority on which moves are legal; the DB CHECK is only the storage floor.
 */
export type FeedbackBatchStatus =
  | 'pending'
  | 'applied'
  | 'failed'
  | 'queued'
  | 'dispatching'
  | 'dispatched'
  | 'blocked';

/** The design-outbox subset of FeedbackBatchStatus (statuses the doc path never uses). */
export type DesignBatchStatus = 'queued' | 'dispatching' | 'dispatched' | 'applied' | 'failed' | 'blocked';

/**
 * Batches a crash could have left mid-delivery — the boot recovery scan's set,
 * mirroring migration 090's partial index idx_feedback_batches_inflight.
 * 'dispatching' is POSSIBLY-DELIVERED (the SDK call may have been accepted
 * before the process died), so recovery re-delivers under the same batch id with
 * a NEW attempt id rather than treating it as fresh.
 */
export const DESIGN_BATCH_INFLIGHT_STATUSES: readonly DesignBatchStatus[] = [
  'queued',
  'dispatching',
  'dispatched',
];

/** API shape of a feedback_comments row (camelCase; anchor parsed). */
export interface FeedbackComment {
  id: string;
  projectId: number;
  runId: string;
  atype: FeedbackAtype;
  /** Owning idea id (matches artifacts.source_ref for the per-entity atypes). */
  sourceRef: string;
  /** NULL while draft; stamped by send-batch / createDesignBatch. */
  batchId: string | null;
  /** Quote anchor on the doc atypes, element anchor on the prototype atypes. */
  anchor: FeedbackAnchor;
  /** The comment text the user typed. */
  body: string;
  status: FeedbackCommentStatus;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  addressedAt: string | null;
}

/** API shape of a feedback_batches row — one per "Send feedback" click. */
export interface FeedbackBatch {
  id: string;
  projectId: number;
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
  /** 1-based revision round per (runId, atype, sourceRef). */
  round: number;
  status: FeedbackBatchStatus;
  /** Human-readable failure detail when status='failed'. */
  error: string | null;
  createdAt: string;
  appliedAt: string | null;
  /**
   * The design session this batch is bound to. NULL on every document batch,
   * which binds to the parked run instead.
   */
  sessionId: string | null;
  /** Delivery-attempt id of the most recent dispatch — the idempotency key the revision turn echoes back. */
  currentAttemptId: string | null;
  /** Monotonic count of dispatch attempts (0 until the first recordDispatchAttempt). */
  attemptCount: number;
  /** User-visible reason for status='blocked' (link broken / session closed / prototype missing). */
  blockedReason: string | null;
  /** Stamped when the SDK accepted the revision turn (dispatching → dispatched). */
  dispatchedAt: string | null;
  /** The prototype artifact revision the acknowledged result produced. */
  appliedPrototypeRevision: number | null;
}

/**
 * Change delta emitted by the FeedbackRouter chokepoint after every committed
 * write, broadcast on the project-scoped feedback subscription
 * (cyboflow.feedback.onFeedbackChanged). Carries the full updated rows for the
 * touched document so subscribers replace state without a refetch.
 */
export interface FeedbackChangedEvent {
  projectId: number;
  runId: string;
  atype: FeedbackAtype;
  sourceRef: string;
  comments: FeedbackComment[];
  batches: FeedbackBatch[];
}

/** Reasons a send-feedback request is refused without starting a revision. */
export type SendFeedbackNoOpReason =
  /** Run row missing. */
  | 'not_found'
  /** Run is not parked in awaiting_review. */
  | 'not_parked'
  /** No pending blocking decision gate is open for the run. */
  | 'no_gate'
  /** The idea has been decomposed (approve-plan passed) — the document can no longer influence the decision. */
  | 'decomposed'
  /** No draft comments exist for the document. */
  | 'no_comments'
  /** A revision batch for this document is already pending. */
  | 'busy';

export type SendFeedbackResult =
  | { sent: true; batchId: string; round: number }
  | { noOp: true; reason: SendFeedbackNoOpReason };

/**
 * Stable content hash for CommentAnchor.bodyHash — FNV-1a 32-bit over UTF-16
 * code units, hex-encoded. Pure and dependency-free so the renderer (anchor
 * capture) and main process (staleness checks) compute identical values.
 */
export function hashDocumentText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
