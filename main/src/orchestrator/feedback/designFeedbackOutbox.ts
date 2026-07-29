/**
 * designFeedbackOutbox — the DELIVERY PIPELINE for design-prototype feedback
 * (Design Mode v1 — docs/ideas/design-mode.md, "Design feedback v1 —
 * acknowledged durable outbox").
 *
 * FeedbackRouter owns the durable primitives (create-design-batch,
 * record-dispatch-attempt, transition-batch, apply-batch-result); THIS file owns
 * the machine that drives them:
 *
 *   queued → dispatching → dispatched → applied | failed | blocked
 *
 * Two entry points:
 *
 *   - `notifyQueued(batchId)` — the live poke, fired (undetached) by the
 *     cyboflow.feedback.sendDesignBatch mutation right after the batch is minted.
 *   - `recoverOnBoot()` — the restart scan over every in-flight batch
 *     (DESIGN_BATCH_INFLIGHT_STATUSES / migration 090's partial index).
 *
 * Three invariants this file exists to hold:
 *
 * 1. GUARDS AT EVERY TRANSITION, not just send. Queue AND recovery re-validate
 *    session-alive + idea-link-valid + prototype-artifact-present. A guard
 *    failure moves the batch to the user-visible terminal 'blocked' state with
 *    the reason, instead of dispatching a turn that has no valid destination —
 *    and a 'blocked' batch is NEVER re-delivered.
 *
 * 2. THE DISPATCH BOUNDARY IS PRE-PERSISTED. SDK acceptance and a DB write
 *    cannot commit atomically, so the attempt row moves to 'dispatching' BEFORE
 *    the SDK call and to 'dispatched' only after it returns. A crash in between
 *    leaves 'dispatching', which recovery treats as POSSIBLY-DELIVERED: it
 *    re-delivers under the SAME batch id with a NEW attempt id and a prompt that
 *    says the feedback may already be applied — never as if it were fresh.
 *
 * 3. DUPLICATES ARE HARMLESS HOST-SIDE. The prompt carries the batch + attempt
 *    ids verbatim and the agent echoes them to cyboflow_design_ack_feedback; the
 *    router's one-result CAS makes the first ack win and later ones
 *    acknowledged-and-discarded. The "skip if already addressed" phrasing in the
 *    prompt is an optimization, not the mechanism.
 *
 * NEITHER public method ever rejects: every failure path is caught and leaves the
 * batch in a legal, visible state.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*. The SDK turn is the injected
 * `dispatchTurn` seam (wired to the Claude panel continue path in
 * main/src/index.ts), the DB is the narrow DatabaseLike, and each lifecycle guard
 * is an injectable predicate with a DB-backed default.
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseLike, LoggerLike } from '../types';
import {
  DESIGN_BATCH_INFLIGHT_STATUSES,
  DESIGN_FEEDBACK_ATYPES,
  isElementAnchor,
  type FeedbackAnchor,
  type FeedbackBatchStatus,
} from '../../../../shared/types/feedback';

// ---------------------------------------------------------------------------
// Injected collaborator interfaces
// ---------------------------------------------------------------------------

/**
 * Narrow slice of FeedbackRouter's design-outbox primitives. The concrete
 * FeedbackRouter satisfies this structurally.
 */
export interface DesignOutboxRouterLike {
  transitionBatch(input: {
    batchId: string;
    from: FeedbackBatchStatus;
    to: FeedbackBatchStatus;
    blockedReason?: string;
    error?: string;
    now?: string;
  }): Promise<{ batchId: string; status: FeedbackBatchStatus }>;
  recordDispatchAttempt(input: {
    batchId: string;
    attemptId: string;
    now?: string;
  }): Promise<{ batchId: string; attemptId: string; attemptCount: number }>;
}

/**
 * Deliver ONE revision turn to a live design session. Resolves when the SDK
 * ACCEPTED the turn (that acceptance is what 'dispatched' records); rejects
 * otherwise. Wired in main/src/index.ts to the Claude panel continue path.
 */
export type DesignOutboxDispatchTurn = (args: { sessionId: string; prompt: string }) => Promise<void>;

/**
 * The three lifecycle guards, as individually injectable predicates. Each has a
 * DB-backed default (see makeDefaultGuards); tests override them one at a time.
 * A guard that THROWS is not a guard failure — it is an unknown, and the batch is
 * left in its current in-flight state for the next recovery pass rather than
 * being blocked terminally on a transient DB error.
 */
export interface DesignOutboxGuards {
  /** The design session row still exists and is not archived. */
  isSessionAlive(sessionId: string): boolean;
  /** The session's design_idea_id still resolves to a live, same-project idea. */
  isIdeaLinkValid(sessionId: string): boolean;
  /** A prototype-family artifact with real bytes exists for the batch's run. */
  hasPrototypeArtifact(runId: string): boolean;
}

export interface DesignFeedbackOutboxDeps {
  db: DatabaseLike;
  feedbackRouter: DesignOutboxRouterLike;
  dispatchTurn: DesignOutboxDispatchTurn;
  /** Partial guard overrides; anything omitted falls back to the DB-backed default. */
  guards?: Partial<DesignOutboxGuards>;
  logger?: LoggerLike;
  /** Clock seam — ISO timestamps stamped onto every transition. */
  now?: () => string;
  /** Delivery-attempt id minter (seam so tests can assert distinct ids deterministically). */
  newAttemptId?: () => string;
}

// ---------------------------------------------------------------------------
// User-visible blocked reasons (design-mode.md: "link broken, session closed,
// prototype missing")
// ---------------------------------------------------------------------------

export const DESIGN_OUTBOX_BLOCKED_REASONS = {
  sessionClosed: 'the design session was closed — reopen it and resend this feedback',
  ideaLinkBroken: 'the idea link is broken — relink the design session and resend this feedback',
  prototypeMissing: 'no prototype exists for this design session yet — there is nothing to apply the feedback to',
  noSessionBinding: 'this feedback batch has no design session to deliver to',
} as const;

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface OutboxBatchRow {
  id: string;
  run_id: string;
  atype: string;
  source_ref: string;
  round: number;
  status: FeedbackBatchStatus;
  session_id: string | null;
}

interface OutboxCommentRow {
  anchor_json: string;
  body: string;
}

/** The prototype-family atypes, as a SQL IN-list of quoted literals. */
const PROTOTYPE_ATYPE_SQL_IN = `(${DESIGN_FEEDBACK_ATYPES.map((a) => `'${a}'`).join(', ')})`;

/** The in-flight statuses, as a SQL IN-list of quoted literals (mirrors migration 090's partial index). */
const INFLIGHT_STATUS_SQL_IN = `(${DESIGN_BATCH_INFLIGHT_STATUSES.map((s) => `'${s}'`).join(', ')})`;

// ---------------------------------------------------------------------------
// Default (DB-backed) guards
// ---------------------------------------------------------------------------

/**
 * The production guards. Deliberately built as a standalone factory so the class
 * can merge partial overrides over them without the tests having to restate the
 * ones they do not care about.
 */
export function makeDefaultGuards(db: DatabaseLike): DesignOutboxGuards {
  return {
    isSessionAlive(sessionId: string): boolean {
      const row = db
        .prepare(`SELECT 1 AS ok FROM sessions WHERE id = ? AND (archived = 0 OR archived IS NULL)`)
        .get(sessionId) as { ok?: number } | undefined;
      return row !== undefined;
    },

    isIdeaLinkValid(sessionId: string): boolean {
      // Mirrors resolveDesignRunContext's integrity contract (design-mode.md
      // "Idea link — integrity contract"): the idea must exist, belong to the
      // session's project, and be neither decomposed nor archived.
      const row = db
        .prepare(
          `SELECT 1 AS ok
             FROM sessions s
             JOIN ideas i ON i.id = s.design_idea_id
            WHERE s.id = ?
              AND i.project_id = s.project_id
              AND i.decomposed_at IS NULL
              AND i.archived_at IS NULL`,
        )
        .get(sessionId) as { ok?: number } | undefined;
      return row !== undefined;
    },

    hasPrototypeArtifact(runId: string): boolean {
      // `payload_json IS NOT NULL` is the bytes test: the re-entry stub is minted
      // as a payload-less ui-prototype row, and a batch dispatched against it
      // would ask the agent to revise a prototype that was never generated.
      const row = db
        .prepare(
          `SELECT 1 AS ok FROM artifacts
            WHERE run_id = ? AND atype IN ${PROTOTYPE_ATYPE_SQL_IN} AND payload_json IS NOT NULL
            LIMIT 1`,
        )
        .get(runId) as { ok?: number } | undefined;
      return row !== undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// DesignFeedbackOutbox
// ---------------------------------------------------------------------------

export class DesignFeedbackOutbox {
  private readonly db: DatabaseLike;
  private readonly feedbackRouter: DesignOutboxRouterLike;
  private readonly dispatchTurn: DesignOutboxDispatchTurn;
  private readonly guards: DesignOutboxGuards;
  private readonly logger?: LoggerLike;
  private readonly now: () => string;
  private readonly newAttemptId: () => string;

  /**
   * Batches currently being driven. Delivery is serialized PER BATCH: a second
   * poke (or a recovery pass racing a live poke) is dropped rather than opening a
   * concurrent second attempt for the same batch.
   */
  private readonly inFlight = new Set<string>();

  constructor(deps: DesignFeedbackOutboxDeps) {
    this.db = deps.db;
    this.feedbackRouter = deps.feedbackRouter;
    this.dispatchTurn = deps.dispatchTurn;
    this.guards = { ...makeDefaultGuards(deps.db), ...(deps.guards ?? {}) };
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newAttemptId = deps.newAttemptId ?? (() => `fba_${randomBytes(10).toString('hex')}`);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Drive a freshly queued batch through guards → dispatch. Called (not awaited)
   * by the sendDesignBatch mutation. NEVER rejects.
   */
  async notifyQueued(batchId: string): Promise<void> {
    await this.drive(batchId, 'notifyQueued');
  }

  /**
   * Restart recovery: re-drive every batch a crash could have left mid-delivery.
   * Processed SEQUENTIALLY so two batches never contend for the same session, and
   * NEVER rejects. Returns the number of batches whose delivery was attempted
   * (i.e. that were dispatched or re-dispatched), for the boot log.
   */
  async recoverOnBoot(): Promise<number> {
    let rows: Array<{ id: string }>;
    try {
      rows = this.db
        .prepare(
          `SELECT id FROM feedback_batches
            WHERE status IN ${INFLIGHT_STATUS_SQL_IN} AND session_id IS NOT NULL
            ORDER BY created_at ASC`,
        )
        .all() as Array<{ id: string }>;
    } catch (err) {
      this.logger?.error('[designFeedbackOutbox] boot recovery scan failed', { error: describeError(err) });
      return 0;
    }

    let dispatched = 0;
    for (const row of rows) {
      if (await this.drive(row.id, 'recoverOnBoot')) dispatched++;
    }
    if (dispatched > 0) {
      this.logger?.info('[designFeedbackOutbox] re-delivered in-flight design feedback at boot', {
        count: dispatched,
      });
    }
    return dispatched;
  }

  // --------------------------------------------------------------------------
  // The machine
  // --------------------------------------------------------------------------

  /**
   * Guard → dispatch one batch. Returns true when a delivery attempt was made.
   * Swallows every failure (logging it) so neither public entry point rejects.
   */
  private async drive(batchId: string, origin: 'notifyQueued' | 'recoverOnBoot'): Promise<boolean> {
    if (this.inFlight.has(batchId)) {
      this.logger?.debug('[designFeedbackOutbox] delivery already in flight — poke dropped', { batchId, origin });
      return false;
    }
    this.inFlight.add(batchId);
    try {
      const batch = this.readBatch(batchId);
      if (!batch) {
        this.logger?.warn('[designFeedbackOutbox] batch not found', { batchId, origin });
        return false;
      }
      // Terminal ('applied' / 'failed' / 'blocked') — nothing to do. A blocked
      // batch is NEVER re-delivered, which is exactly this early return.
      if (!DESIGN_BATCH_INFLIGHT_STATUSES.some((s) => s === batch.status)) {
        this.logger?.debug('[designFeedbackOutbox] batch is already terminal — no delivery', {
          batchId,
          status: batch.status,
          origin,
        });
        return false;
      }

      const blockedReason = this.evaluateGuards(batch);
      if (blockedReason !== null) {
        await this.block(batch, blockedReason);
        return false;
      }

      // 'queued' is a fresh send; 'dispatching'/'dispatched' mean a previous
      // attempt may already have reached the agent (design-mode.md: the crash
      // window between SDK acceptance and the status write).
      const possiblyDelivered = batch.status !== 'queued';
      return await this.deliver(batch, possiblyDelivered);
    } catch (err) {
      // Anything unexpected: the batch keeps its current legal status and the
      // next recovery pass retries it.
      this.logger?.error('[designFeedbackOutbox] delivery failed unexpectedly', {
        batchId,
        origin,
        error: describeError(err),
      });
      return false;
    } finally {
      this.inFlight.delete(batchId);
    }
  }

  /**
   * Run the three lifecycle guards. Returns the user-visible blocked reason, or
   * null when every guard holds. A guard that throws propagates (see
   * DesignOutboxGuards) — an unknown is not a failure.
   */
  private evaluateGuards(batch: OutboxBatchRow): string | null {
    const sessionId = batch.session_id;
    if (sessionId === null || sessionId.length === 0) {
      return DESIGN_OUTBOX_BLOCKED_REASONS.noSessionBinding;
    }
    if (!this.guards.isSessionAlive(sessionId)) {
      return DESIGN_OUTBOX_BLOCKED_REASONS.sessionClosed;
    }
    if (!this.guards.isIdeaLinkValid(sessionId)) {
      return DESIGN_OUTBOX_BLOCKED_REASONS.ideaLinkBroken;
    }
    if (!this.guards.hasPrototypeArtifact(batch.run_id)) {
      return DESIGN_OUTBOX_BLOCKED_REASONS.prototypeMissing;
    }
    return null;
  }

  /** Move a batch to the terminal, user-visible 'blocked' state. */
  private async block(batch: OutboxBatchRow, reason: string): Promise<void> {
    this.logger?.info('[designFeedbackOutbox] blocking batch — a lifecycle guard failed', {
      batchId: batch.id,
      status: batch.status,
      reason,
    });
    await this.safeTransition(batch.id, batch.status, 'blocked', { blockedReason: reason });
  }

  /**
   * Open an attempt, compose the prompt, and hand the turn to the SDK.
   *
   * ORDER IS THE CONTRACT: record-dispatch-attempt ('dispatching' + a new attempt
   * id, one transaction) commits BEFORE dispatchTurn is called, so a crash in the
   * window is recoverable; 'dispatched' is written only once the SDK accepted.
   */
  private async deliver(batch: OutboxBatchRow, possiblyDelivered: boolean): Promise<boolean> {
    const sessionId = batch.session_id;
    if (sessionId === null) return false; // unreachable: evaluateGuards blocked it

    const comments = this.readComments(batch.id);
    if (comments.length === 0) {
      // Degenerate shape (nothing to ask the agent to do) — fail it visibly
      // rather than dispatching an empty turn.
      await this.safeTransition(batch.id, batch.status, 'failed', {
        error: 'no sent comments were found for this feedback batch',
      });
      return false;
    }

    const attemptId = this.newAttemptId();
    await this.feedbackRouter.recordDispatchAttempt({ batchId: batch.id, attemptId, now: this.now() });

    const prompt = buildDesignRevisionPrompt({
      batchId: batch.id,
      attemptId,
      atype: batch.atype,
      sourceRef: batch.source_ref,
      round: batch.round,
      comments,
      possiblyDelivered,
    });

    try {
      await this.dispatchTurn({ sessionId, prompt });
    } catch (err) {
      this.logger?.warn('[designFeedbackOutbox] the SDK refused the revision turn', {
        batchId: batch.id,
        attemptId,
        error: describeError(err),
      });
      await this.safeTransition(batch.id, 'dispatching', 'failed', {
        error: concise(err, 'the design session could not accept the revision turn'),
      });
      return false;
    }

    // SDK acceptance recorded. This CAS can legitimately lose: a fast agent may
    // already have acked (dispatching → applied) before we got here, and
    // 'applied' is terminal — safeTransition swallows exactly that.
    await this.safeTransition(batch.id, 'dispatching', 'dispatched', {});
    this.logger?.info('[designFeedbackOutbox] revision turn dispatched', {
      batchId: batch.id,
      attemptId,
      sessionId,
      possiblyDelivered,
    });
    return true;
  }

  /**
   * Transition, tolerating the CAS losing. Every caller is in a race with the
   * agent's own ack (which can move the batch to the terminal 'applied' out from
   * under us), so an invalid_transition here is expected, not exceptional — it is
   * logged and swallowed, never rethrown into a public method.
   */
  private async safeTransition(
    batchId: string,
    from: FeedbackBatchStatus,
    to: FeedbackBatchStatus,
    extra: { blockedReason?: string; error?: string },
  ): Promise<void> {
    try {
      await this.feedbackRouter.transitionBatch({ batchId, from, to, ...extra, now: this.now() });
    } catch (err) {
      this.logger?.debug('[designFeedbackOutbox] transition did not apply (batch moved underneath us)', {
        batchId,
        from,
        to,
        error: describeError(err),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  private readBatch(batchId: string): OutboxBatchRow | undefined {
    return this.db
      .prepare(
        `SELECT id, run_id, atype, source_ref, round, status, session_id
           FROM feedback_batches WHERE id = ?`,
      )
      .get(batchId) as OutboxBatchRow | undefined;
  }

  private readComments(batchId: string): OutboxCommentRow[] {
    return this.db
      .prepare(
        `SELECT anchor_json, body FROM feedback_comments
          WHERE batch_id = ? AND status = 'sent'
          ORDER BY created_at ASC`,
      )
      .all(batchId) as OutboxCommentRow[];
  }
}

// ---------------------------------------------------------------------------
// Notifier registry — the seam the standalone tRPC feedback router reaches the
// outbox through, mirroring setRevisionLauncher/getRevisionLauncher for the
// document path. Deliberately returns null (rather than throwing) when boot
// wiring has not run: the batch is already durably minted at that point, so
// failing the mutation would be strictly worse than letting boot recovery pick it
// up.
// ---------------------------------------------------------------------------

let designBatchNotifier: ((batchId: string) => void) | null = null;

/** Register the production dispatch poke (called once from main/src/index.ts). */
export function setDesignBatchNotifier(fn: (batchId: string) => void): void {
  designBatchNotifier = fn;
}

/** Read the wired dispatch poke, or null when boot wiring has not run. */
export function getDesignBatchNotifier(): ((batchId: string) => void) | null {
  return designBatchNotifier;
}

/** Reset the registry — intended for tests only. */
export function _resetDesignBatchNotifierForTesting(): void {
  designBatchNotifier = null;
}

// ---------------------------------------------------------------------------
// Prompt composition (HOST-OWNED)
// ---------------------------------------------------------------------------

export interface DesignRevisionPromptArgs {
  batchId: string;
  attemptId: string;
  /** The prototype atype the agent must RE-REPORT (same atype = enrich in place). */
  atype: string;
  /** The owning idea id (feedback source_ref IS the idea id). */
  sourceRef: string;
  round: number;
  comments: Array<{ anchor_json: string; body: string }>;
  /** True on a recovery re-delivery — the feedback may already have been applied. */
  possiblyDelivered: boolean;
}

/**
 * Compose the revision turn. Carries the batch + attempt ids VERBATIM (the ack
 * must echo them) and renders each comment's element anchor as a human/agent
 * readable breadcrumb built from the stored ancestor stack.
 */
export function buildDesignRevisionPrompt(args: DesignRevisionPromptArgs): string {
  const { batchId, attemptId, atype, sourceRef, round, comments, possiblyDelivered } = args;

  const commentBlocks = comments
    .map((c, i) => {
      const anchor = parseAnchor(c.anchor_json);
      const location = anchor === null ? '(no anchor captured)' : renderAnchor(anchor);
      return [`### Comment ${i + 1}`, '', location, '', c.body.trim()].join('\n');
    })
    .join('\n\n');

  const lines: string[] = [
    `# Design feedback — round ${round}`,
    '',
    'The user tagged elements of your prototype and sent the comments below. Apply them.',
    '',
    '## Delivery identity (echo these back — do not alter them)',
    '',
    `- Batch id: \`${batchId}\``,
    `- Attempt id: \`${attemptId}\``,
    `- Prototype artifact type: \`${atype}\``,
    `- Idea: \`${sourceRef}\``,
    '',
  ];

  if (possiblyDelivered) {
    lines.push(
      '## This feedback may ALREADY have been delivered',
      '',
      'The app restarted mid-delivery, so an earlier turn may already have applied these',
      'comments. Look at the current prototype FIRST: if it already reflects every comment',
      'below, do NOT change it — just acknowledge (step 3). Only apply what is genuinely',
      'still missing.',
      '',
    );
  }

  lines.push(
    '## Comments',
    '',
    commentBlocks,
    '',
    '## What to do',
    '',
    '1. Apply the feedback to the prototype HTML file, minimally and faithfully — change',
    '   only what the comments ask for, and keep every existing `data-design-id` stable',
    '   (they are the anchors these comments are attached to).',
    `2. Re-report the artifact with the SAME atype (\`${atype}\`) so it enriches in place,`,
    '   then refresh the design-spec draft with `cyboflow_design_update_draft` — its',
    '   `boundArtifactRevision` is the prototype revision the next step needs.',
    '3. Acknowledge with `cyboflow_design_ack_feedback`, passing `batch_id`',
    `   \`${batchId}\`, \`attempt_id\` \`${attemptId}\`, and \`prototype_revision\` = the`,
    '   `boundArtifactRevision` you just got back. THIS STEP IS MANDATORY — without it the',
    '   feedback stays un-applied in the user\'s queue no matter what you changed.',
  );

  return lines.join('\n');
}

/**
 * Render an anchor as the human/agent-readable location line(s).
 *
 * For an element anchor: a breadcrumb walked OUTERMOST-FIRST (the stored stack is
 * innermost-first), with the picked rung called out — that rung is what the
 * comment is actually about, and it is not always index 0 (the user can walk the
 * picker up to a containing element).
 */
function renderAnchor(anchor: FeedbackAnchor): string {
  if (!isElementAnchor(anchor)) {
    const quoted = anchor.quote
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return quoted.length > 0 ? quoted : '(no excerpt captured)';
  }

  const outermostFirst = [...anchor.ancestorStack].reverse();
  const breadcrumb = outermostFirst.map(renderRung).join(' › ');
  const picked = anchor.ancestorStack[anchor.pickedIndex];
  const pickedLine = picked ? `Commented element: ${renderRung(picked)}` : 'Commented element: (unresolved)';
  return [pickedLine, `Path: ${breadcrumb}`].join('\n');
}

/** One breadcrumb rung: `button[data-design-id="hero-cta"] "Get started"`. */
function renderRung(rung: { tag: string; designId: string | null; label: string | null }): string {
  let out = rung.tag;
  if (rung.designId !== null && rung.designId.length > 0) out += `[data-design-id="${rung.designId}"]`;
  if (rung.label !== null && rung.label.trim().length > 0) out += ` "${collapse(rung.label)}"`;
  return out;
}

/** Collapse whitespace and cap a captured label so one rung cannot dominate the prompt. */
function collapse(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

/** Parse a stored anchor_json, fail-soft to null (the comment body still ships). */
function parseAnchor(anchorJson: string): FeedbackAnchor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(anchorJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const el = parsed as Partial<{ kind: string; designId: unknown; ancestorStack: unknown; pickedIndex: unknown }>;
  if (el.kind === 'element') {
    if (!Array.isArray(el.ancestorStack) || el.ancestorStack.length === 0) return null;
    const stack = el.ancestorStack.map((rung) => {
      const r = rung as Partial<{ tag: unknown; designId: unknown; label: unknown }>;
      return {
        tag: typeof r?.tag === 'string' ? r.tag : 'element',
        designId: typeof r?.designId === 'string' ? r.designId : null,
        label: typeof r?.label === 'string' ? r.label : null,
      };
    });
    const pickedIndex =
      typeof el.pickedIndex === 'number' && Number.isInteger(el.pickedIndex) && el.pickedIndex >= 0
        ? Math.min(el.pickedIndex, stack.length - 1)
        : 0;
    return {
      kind: 'element',
      designId: typeof el.designId === 'string' ? el.designId : null,
      ancestorStack: stack,
      pickedIndex,
    };
  }

  const q = parsed as Partial<{ quote: unknown; occurrence: unknown; bodyHash: unknown }>;
  if (typeof q.quote !== 'string') return null;
  return {
    quote: q.quote,
    occurrence: typeof q.occurrence === 'number' ? q.occurrence : 0,
    bodyHash: typeof q.bodyHash === 'string' ? q.bodyHash : '',
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A concise, human-readable failure reason — never a raw stack trace. */
function concise(err: unknown, fallback: string): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const firstLine = msg.split('\n')[0]?.trim() ?? '';
  return firstLine.length > 0 ? firstLine.slice(0, 300) : fallback;
}
