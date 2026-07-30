/**
 * Unit tests for FeedbackRouter's DESIGN-OUTBOX primitives (Design Mode v1,
 * migration 092) — the durable half of "Design feedback v1 — acknowledged
 * durable outbox" in docs/ideas/design-mode.md.
 *
 * Covered:
 *  - anchor <-> atype cross-validation on create-comment AND update-comment:
 *    element anchors only on the prototype atypes, quote anchors only on the doc
 *    atypes, plus malformed-element rejection.
 *  - createDesignBatch: mints 'queued' with the session binding and stamps the
 *    named drafts sent/batch_id in ONE transaction, with NO parked run and NO
 *    open gate anywhere in the DB; round increments per document; refuses a
 *    second in-flight batch ('busy') and foreign/non-draft comment ids.
 *  - send-batch refuses a design atype (wrong lifecycle door).
 *  - the transition table: every legal edge, plus a sample of illegal ones, plus
 *    the `from` CAS mismatch, plus the blockedReason/error requirements.
 *  - recordDispatchAttempt: monotonic attempt_count, current_attempt_id update,
 *    and the recovery re-dispatch from 'dispatching'/'dispatched'.
 *  - applyBatchResult: the ONE-RESULT CAS — two acks for the same batch yield
 *    exactly one { applied: true }, the loser gets { applied: false } (no throw),
 *    and the comments flip to 'addressed' exactly once.
 *  - listBatches surfaces the new columns in camelCase.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeedbackRouter, FeedbackError, DESIGN_TRANSITIONS } from '../feedbackRouter';
import { feedbackEvents } from '../trpc/routers/events';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../types';
import type {
  CommentAnchor,
  ElementCommentAnchor,
  FeedbackBatchStatus,
} from '../../../../shared/types/feedback';

// ---------------------------------------------------------------------------
// Test DB
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '077_artifact_feedback.sql',
    '092_design_feedback_outbox.sql',
  ]) {
    const sql = readFileSync(join(migDir, f), 'utf-8');
    const needsFkOff = sql.includes('PRAGMA foreign_keys=OFF');
    if (needsFkOff) db.pragma('foreign_keys = OFF');
    db.exec(sql);
    if (needsFkOff) db.pragma('foreign_keys = ON');
  }
  return db;
}

/**
 * A design session's run: status 'running' (NOT one of
 * FEEDBACK_PARKED_RUN_STATUSES) and no review_items row anywhere — so any test
 * that passes here proves the design path is free of the parked-gate chain.
 */
function seedLiveRun(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'design', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, 'running', 'default')`,
  ).run(runId);
}

const QUOTE_ANCHOR: CommentAnchor = { quote: 'the quoted text', occurrence: 0, bodyHash: 'abcd1234' };

const ELEMENT_ANCHOR: ElementCommentAnchor = {
  kind: 'element',
  designId: 'hero-cta',
  ancestorStack: [
    { tag: 'button', designId: 'hero-cta', label: 'Get started' },
    { tag: 'section', designId: 'hero', label: null },
    { tag: 'body', designId: null, label: null },
  ],
  pickedIndex: 0,
};

function makeRouter(db: Database.Database): FeedbackRouter {
  return FeedbackRouter.initialize(dbAdapter(db) as DatabaseLike);
}

async function draftElementComment(
  router: FeedbackRouter,
  runId = 'run-1',
  sourceRef = 'idea-1',
  body = 'make this bigger',
): Promise<string> {
  const { commentId } = await router.apply(1, {
    op: 'create-comment',
    runId,
    atype: 'interactive-prototype',
    sourceRef,
    anchor: ELEMENT_ANCHOR,
    body,
  });
  return commentId;
}

/** Read the raw batch row (the tests assert on stored columns, not just the API shape). */
function batchRow(db: Database.Database, batchId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM feedback_batches WHERE id = ?').get(batchId) as Record<string, unknown>;
}

describe('FeedbackRouter — anchor <-> atype cross-validation', () => {
  afterEach(() => {
    FeedbackRouter._resetForTesting();
    feedbackEvents.removeAllListeners();
  });

  it('accepts an element anchor on a design-prototype atype', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const commentId = await draftElementComment(router);
    const row = db.prepare('SELECT atype, anchor_json FROM feedback_comments WHERE id = ?').get(commentId) as {
      atype: string;
      anchor_json: string;
    };
    expect(row.atype).toBe('interactive-prototype');
    expect(JSON.parse(row.anchor_json)).toEqual(ELEMENT_ANCHOR);
  });

  it('rejects an element anchor on a DOCUMENT atype', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    await expect(
      router.apply(1, {
        op: 'create-comment',
        runId: 'run-1',
        atype: 'idea-spec',
        sourceRef: 'idea-1',
        anchor: ELEMENT_ANCHOR,
        body: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'invalid_anchor' });
  });

  it('rejects a quote anchor on a DESIGN-PROTOTYPE atype', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    await expect(
      router.apply(1, {
        op: 'create-comment',
        runId: 'run-1',
        atype: 'ui-prototype',
        sourceRef: 'idea-1',
        anchor: QUOTE_ANCHOR,
        body: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'invalid_anchor' });
  });

  it('rejects a malformed element anchor (empty stack / out-of-range pickedIndex)', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    for (const bad of [
      { ...ELEMENT_ANCHOR, ancestorStack: [] },
      { ...ELEMENT_ANCHOR, pickedIndex: 3 },
      { ...ELEMENT_ANCHOR, pickedIndex: -1 },
    ] as ElementCommentAnchor[]) {
      await expect(
        router.apply(1, {
          op: 'create-comment',
          runId: 'run-1',
          atype: 'ui-prototype',
          sourceRef: 'idea-1',
          anchor: bad,
          body: 'nope',
        }),
      ).rejects.toMatchObject({ code: 'invalid_anchor' });
    }
  });

  it('update-comment cross-validates the new anchor against the STORED atype', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const commentId = await draftElementComment(router);

    // A quote anchor cannot be smuggled onto a prototype comment...
    await expect(
      router.apply(1, { op: 'update-comment', commentId, anchor: QUOTE_ANCHOR }),
    ).rejects.toMatchObject({ code: 'invalid_anchor' });

    // ...but a different element anchor is fine.
    const relocated: ElementCommentAnchor = { ...ELEMENT_ANCHOR, pickedIndex: 1, designId: 'hero' };
    await router.apply(1, { op: 'update-comment', commentId, anchor: relocated });
    const row = db.prepare('SELECT anchor_json FROM feedback_comments WHERE id = ?').get(commentId) as {
      anchor_json: string;
    };
    expect(JSON.parse(row.anchor_json)).toEqual(relocated);
  });

  it('listComments shapes an element anchor back out (and fail-softs a malformed one)', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const commentId = await draftElementComment(router);
    db.prepare(
      `INSERT INTO feedback_comments (id, project_id, run_id, atype, source_ref, anchor_json, body, status,
                                      created_at, updated_at)
       VALUES ('fbc_broken', 1, 'run-1', 'interactive-prototype', 'idea-1',
               '{"kind":"element","ancestorStack":[],"pickedIndex":0}', 'broken', 'draft',
               '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z')`,
    ).run();

    const comments = router.listComments('run-1', 'interactive-prototype', 'idea-1');
    expect(comments.map((c) => c.id)).toEqual([commentId]);
    expect(comments[0].anchor).toEqual(ELEMENT_ANCHOR);
  });
});

describe('FeedbackRouter.createDesignBatch', () => {
  afterEach(() => {
    FeedbackRouter._resetForTesting();
    feedbackEvents.removeAllListeners();
  });

  it('mints a queued batch bound to the session with NO parked run and NO gate', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const c1 = await draftElementComment(router, 'run-1', 'idea-1', 'first');
    const c2 = await draftElementComment(router, 'run-1', 'idea-1', 'second');

    // Proof of the split: the run is 'running' and the review queue is empty.
    expect(
      (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-1') as { status: string }).status,
    ).toBe('running');
    expect((db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n).toBe(0);

    const result = await router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [c1, c2],
      now: '2026-07-27T10:00:00.000Z',
    });

    expect(result.batchId.startsWith('fbb_')).toBe(true);
    expect(result.round).toBe(1);
    expect(result.commentIds).toEqual([c1, c2]);
    expect(batchRow(db, result.batchId)).toMatchObject({
      status: 'queued',
      session_id: 'sess-1',
      atype: 'interactive-prototype',
      source_ref: 'idea-1',
      attempt_count: 0,
      current_attempt_id: null,
      dispatched_at: null,
      applied_prototype_revision: null,
      created_at: '2026-07-27T10:00:00.000Z',
    });

    // Same transaction stamped the drafts.
    const comments = db
      .prepare('SELECT id, status, batch_id, sent_at FROM feedback_comments ORDER BY created_at')
      .all() as Array<{ id: string; status: string; batch_id: string | null; sent_at: string | null }>;
    expect(comments.every((c) => c.status === 'sent' && c.batch_id === result.batchId)).toBe(true);
    expect(comments.every((c) => c.sent_at === '2026-07-27T10:00:00.000Z')).toBe(true);
  });

  it('increments round per document and refuses a second IN-FLIGHT batch', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const c1 = await draftElementComment(router);
    const first = await router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [c1],
    });

    const c2 = await draftElementComment(router, 'run-1', 'idea-1', 'another');
    await expect(
      router.createDesignBatch({
        projectId: 1,
        runId: 'run-1',
        sessionId: 'sess-1',
        atype: 'interactive-prototype',
        sourceRef: 'idea-1',
        commentIds: [c2],
      }),
    ).rejects.toMatchObject({ code: 'busy' });

    // Once the first batch reaches a terminal state, the next round is allowed.
    await router.recordDispatchAttempt({ batchId: first.batchId, attemptId: 'att-1' });
    await router.applyBatchResult({ batchId: first.batchId, attemptId: 'att-1', prototypeRevision: 2 });
    const second = await router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [c2],
    });
    expect(second.round).toBe(2);
  });

  it('refuses comment ids that are not drafts on THIS document, and an empty list', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const mine = await draftElementComment(router, 'run-1', 'idea-1');
    const other = await draftElementComment(router, 'run-1', 'idea-2', 'other doc');

    await expect(
      router.createDesignBatch({
        projectId: 1,
        runId: 'run-1',
        sessionId: 'sess-1',
        atype: 'interactive-prototype',
        sourceRef: 'idea-1',
        commentIds: [mine, other],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(
      router.createDesignBatch({
        projectId: 1,
        runId: 'run-1',
        sessionId: 'sess-1',
        atype: 'interactive-prototype',
        sourceRef: 'idea-1',
        commentIds: [],
      }),
    ).rejects.toMatchObject({ code: 'no_comments' });

    // Nothing was written by either refusal.
    expect((db.prepare('SELECT COUNT(*) AS n FROM feedback_batches').get() as { n: number }).n).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_comments WHERE status = 'draft'").get() as { n: number })
        .n,
    ).toBe(2);
  });

  it('send-batch refuses a design atype (wrong lifecycle door)', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    await draftElementComment(router);
    await expect(
      // send-batch's `atype` is the full FeedbackAtype union (both surfaces share
      // the change type), so the RUNTIME guard is what keeps a design atype out of
      // the document lifecycle.
      router.apply(1, { op: 'send-batch', runId: 'run-1', atype: 'interactive-prototype', sourceRef: 'idea-1' }),
    ).rejects.toMatchObject({ code: 'invalid_atype' });
  });
});

describe('FeedbackRouter.transitionBatch (the transition table)', () => {
  afterEach(() => {
    FeedbackRouter._resetForTesting();
    feedbackEvents.removeAllListeners();
  });

  /** Mint a queued batch and force it to `status` by raw UPDATE (bypassing the table under test). */
  async function batchAt(
    db: Database.Database,
    router: FeedbackRouter,
    status: FeedbackBatchStatus,
    sourceRef = 'idea-1',
  ): Promise<string> {
    const c = await draftElementComment(router, 'run-1', sourceRef);
    const { batchId } = await router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef,
      commentIds: [c],
    });
    if (status !== 'queued') {
      db.prepare('UPDATE feedback_batches SET status = ? WHERE id = ?').run(status, batchId);
    }
    return batchId;
  }

  const LEGAL: Array<[FeedbackBatchStatus, FeedbackBatchStatus]> = [
    ['queued', 'dispatching'],
    ['queued', 'blocked'],
    ['queued', 'failed'],
    ['dispatching', 'dispatched'],
    ['dispatching', 'applied'],
    ['dispatching', 'blocked'],
    ['dispatching', 'failed'],
    ['dispatched', 'applied'],
    ['dispatched', 'blocked'],
    ['dispatched', 'failed'],
  ];

  it('DESIGN_TRANSITIONS is exactly the legal edge set (and every terminal is empty)', () => {
    const declared = Object.entries(DESIGN_TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => `${from}->${to}`),
    );
    expect(declared.sort()).toEqual(LEGAL.map(([f, t]) => `${f}->${t}`).sort());
    expect(DESIGN_TRANSITIONS.applied).toEqual([]);
    expect(DESIGN_TRANSITIONS.failed).toEqual([]);
    expect(DESIGN_TRANSITIONS.blocked).toEqual([]);
    expect(DESIGN_TRANSITIONS.pending).toEqual([]);
  });

  it.each(LEGAL)('allows %s -> %s', async (from, to) => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const batchId = await batchAt(db, router, from);
    const res = await router.transitionBatch({
      batchId,
      from,
      to,
      blockedReason: to === 'blocked' ? 'idea link broken' : undefined,
      error: to === 'failed' ? 'the regeneration failed' : undefined,
      now: '2026-07-27T12:00:00.000Z',
    });
    expect(res).toEqual({ batchId, status: to });
    expect(batchRow(db, batchId).status).toBe(to);
  });

  const ILLEGAL: Array<[FeedbackBatchStatus, FeedbackBatchStatus]> = [
    ['queued', 'dispatched'],
    ['queued', 'applied'],
    ['queued', 'queued'],
    ['dispatched', 'dispatching'],
    ['applied', 'failed'],
    ['applied', 'dispatching'],
    ['failed', 'queued'],
    ['blocked', 'dispatching'],
    ['pending', 'applied'],
  ];

  it.each(ILLEGAL)('rejects %s -> %s', async (from, to) => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const batchId = await batchAt(db, router, from);
    await expect(
      router.transitionBatch({ batchId, from, to, blockedReason: 'x', error: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(batchRow(db, batchId).status).toBe(from);
  });

  it("rejects a `from` that no longer holds (the CAS), leaving the row untouched", async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const batchId = await batchAt(db, router, 'dispatched');
    await expect(
      router.transitionBatch({ batchId, from: 'queued', to: 'dispatching' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(batchRow(db, batchId).status).toBe('dispatched');
  });

  it('requires blockedReason for blocked and error for failed', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const b1 = await batchAt(db, router, 'queued', 'idea-1');
    await expect(router.transitionBatch({ batchId: b1, from: 'queued', to: 'blocked' })).rejects.toMatchObject(
      { code: 'invalid_transition' },
    );
    await expect(
      router.transitionBatch({ batchId: b1, from: 'queued', to: 'failed', error: '   ' }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    expect(batchRow(db, b1).status).toBe('queued');
  });

  it('stamps dispatched_at / blocked_reason / error / applied_at on the matching move', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);

    const dispatchedBatch = await batchAt(db, router, 'dispatching', 'idea-1');
    await router.transitionBatch({
      batchId: dispatchedBatch,
      from: 'dispatching',
      to: 'dispatched',
      now: '2026-07-27T12:00:00.000Z',
    });
    expect(batchRow(db, dispatchedBatch)).toMatchObject({
      status: 'dispatched',
      dispatched_at: '2026-07-27T12:00:00.000Z',
      blocked_reason: null,
      error: null,
      applied_at: null,
    });

    const blockedBatch = await batchAt(db, router, 'queued', 'idea-2');
    await router.transitionBatch({
      batchId: blockedBatch,
      from: 'queued',
      to: 'blocked',
      blockedReason: 'prototype missing',
      now: '2026-07-27T12:05:00.000Z',
    });
    expect(batchRow(db, blockedBatch)).toMatchObject({
      status: 'blocked',
      blocked_reason: 'prototype missing',
      dispatched_at: null,
    });

    const failedBatch = await batchAt(db, router, 'dispatched', 'idea-3');
    await router.transitionBatch({
      batchId: failedBatch,
      from: 'dispatched',
      to: 'failed',
      error: 'the session ended mid-turn',
      now: '2026-07-27T12:10:00.000Z',
    });
    expect(batchRow(db, failedBatch)).toMatchObject({
      status: 'failed',
      error: 'the session ended mid-turn',
    });
  });

  it('throws not_found for an unknown batch id', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    makeRouter(db);
    await expect(
      FeedbackRouter.getInstance().transitionBatch({ batchId: 'fbb_nope', from: 'queued', to: 'dispatching' }),
    ).rejects.toBeInstanceOf(FeedbackError);
  });
});

describe('FeedbackRouter.recordDispatchAttempt', () => {
  afterEach(() => {
    FeedbackRouter._resetForTesting();
    feedbackEvents.removeAllListeners();
  });

  async function queuedBatch(db: Database.Database, router: FeedbackRouter): Promise<string> {
    const c = await draftElementComment(router);
    const { batchId } = await router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [c],
    });
    return batchId;
  }

  it('moves queued -> dispatching, stamps the attempt id and bumps attempt_count', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const batchId = await queuedBatch(db, router);

    const res = await router.recordDispatchAttempt({ batchId, attemptId: 'att-1' });
    expect(res).toEqual({ batchId, attemptId: 'att-1', attemptCount: 1 });
    expect(batchRow(db, batchId)).toMatchObject({
      status: 'dispatching',
      current_attempt_id: 'att-1',
      attempt_count: 1,
    });
  });

  it('is monotonic across recovery re-dispatch from dispatching AND dispatched', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const batchId = await queuedBatch(db, router);

    await router.recordDispatchAttempt({ batchId, attemptId: 'att-1' });
    // Recovery finds 'dispatching' (possibly-delivered) and re-delivers.
    const second = await router.recordDispatchAttempt({ batchId, attemptId: 'att-2' });
    expect(second.attemptCount).toBe(2);
    expect(batchRow(db, batchId).current_attempt_id).toBe('att-2');

    await router.transitionBatch({ batchId, from: 'dispatching', to: 'dispatched' });
    const third = await router.recordDispatchAttempt({ batchId, attemptId: 'att-3' });
    expect(third.attemptCount).toBe(3);
    expect(batchRow(db, batchId)).toMatchObject({
      status: 'dispatching',
      current_attempt_id: 'att-3',
      attempt_count: 3,
    });
  });

  it('refuses to open an attempt on a terminal batch', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const batchId = await queuedBatch(db, router);
    await router.transitionBatch({ batchId, from: 'queued', to: 'blocked', blockedReason: 'link broken' });

    await expect(router.recordDispatchAttempt({ batchId, attemptId: 'att-9' })).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(batchRow(db, batchId)).toMatchObject({ status: 'blocked', attempt_count: 0 });
  });
});

describe('FeedbackRouter.applyBatchResult (the one-result CAS)', () => {
  afterEach(() => {
    FeedbackRouter._resetForTesting();
    feedbackEvents.removeAllListeners();
  });

  async function dispatchedBatch(
    db: Database.Database,
    router: FeedbackRouter,
  ): Promise<{ batchId: string; commentIds: string[] }> {
    const c1 = await draftElementComment(router, 'run-1', 'idea-1', 'one');
    const c2 = await draftElementComment(router, 'run-1', 'idea-1', 'two');
    const { batchId, commentIds } = await router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [c1, c2],
    });
    await router.recordDispatchAttempt({ batchId, attemptId: 'att-1' });
    await router.transitionBatch({ batchId, from: 'dispatching', to: 'dispatched' });
    return { batchId, commentIds };
  }

  it('applies once: records the revision, the winning attempt, and addresses the comments', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const { batchId, commentIds } = await dispatchedBatch(db, router);

    const res = await router.applyBatchResult({
      batchId,
      attemptId: 'att-1',
      prototypeRevision: 5,
      now: '2026-07-27T13:00:00.000Z',
    });
    expect(res).toEqual({ batchId, applied: true });
    expect(batchRow(db, batchId)).toMatchObject({
      status: 'applied',
      applied_at: '2026-07-27T13:00:00.000Z',
      current_attempt_id: 'att-1',
      applied_prototype_revision: 5,
    });
    const comments = db
      .prepare(`SELECT id, status, addressed_at FROM feedback_comments WHERE batch_id = ?`)
      .all(batchId) as Array<{ id: string; status: string; addressed_at: string | null }>;
    expect(comments).toHaveLength(commentIds.length);
    expect(comments.every((c) => c.status === 'addressed')).toBe(true);
    expect(comments.every((c) => c.addressed_at === '2026-07-27T13:00:00.000Z')).toBe(true);
  });

  it('TWO acks for the same batch yield exactly one { applied: true } — the loser is data, not a throw', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const { batchId } = await dispatchedBatch(db, router);

    const results = await Promise.all([
      router.applyBatchResult({ batchId, attemptId: 'att-1', prototypeRevision: 5 }),
      router.applyBatchResult({ batchId, attemptId: 'att-2', prototypeRevision: 6 }),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(results.filter((r) => !r.applied)).toHaveLength(1);

    // Whichever won, the recorded revision is that ONE result's — never overwritten.
    const row = batchRow(db, batchId);
    expect(row.status).toBe('applied');
    expect([5, 6]).toContain(row.applied_prototype_revision);
    const winner = row.applied_prototype_revision === 5 ? 'att-1' : 'att-2';
    expect(row.current_attempt_id).toBe(winner);
  });

  it('a LATE ack from a superseded attempt still lands (recovery re-delivers under a new attempt id)', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const { batchId } = await dispatchedBatch(db, router);
    // Recovery opened a second attempt; the FIRST turn then acknowledges.
    await router.recordDispatchAttempt({ batchId, attemptId: 'att-2' });

    const res = await router.applyBatchResult({ batchId, attemptId: 'att-1', prototypeRevision: 5 });
    expect(res.applied).toBe(true);
    expect(batchRow(db, batchId)).toMatchObject({ status: 'applied', current_attempt_id: 'att-1' });
  });

  it('does NOT apply outside the CAS window (queued / blocked)', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const c = await draftElementComment(router);
    const { batchId } = await router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [c],
    });

    expect(await router.applyBatchResult({ batchId, attemptId: 'att-1', prototypeRevision: 5 })).toEqual({
      batchId,
      applied: false,
    });
    expect(batchRow(db, batchId).status).toBe('queued');

    await router.transitionBatch({ batchId, from: 'queued', to: 'blocked', blockedReason: 'session closed' });
    expect(await router.applyBatchResult({ batchId, attemptId: 'att-1', prototypeRevision: 5 })).toEqual({
      batchId,
      applied: false,
    });
    expect(batchRow(db, batchId).status).toBe('blocked');
    // The comments stay 'sent' — nothing silently reverts them.
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM feedback_comments WHERE status = 'sent'").get() as { n: number })
        .n,
    ).toBe(1);
  });
});

describe('FeedbackRouter.listBatches — outbox columns', () => {
  afterEach(() => {
    FeedbackRouter._resetForTesting();
    feedbackEvents.removeAllListeners();
  });

  it('surfaces the new columns in camelCase', async () => {
    const db = buildDb();
    seedLiveRun(db, 'run-1');
    const router = makeRouter(db);
    const c = await draftElementComment(router);
    const { batchId } = await router.createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-42',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [c],
    });
    await router.recordDispatchAttempt({ batchId, attemptId: 'att-1' });
    await router.transitionBatch({
      batchId,
      from: 'dispatching',
      to: 'dispatched',
      now: '2026-07-27T14:00:00.000Z',
    });
    await router.applyBatchResult({ batchId, attemptId: 'att-1', prototypeRevision: 9 });

    const [batch] = router.listBatches('run-1', 'interactive-prototype', 'idea-1');
    expect(batch).toMatchObject({
      id: batchId,
      status: 'applied',
      sessionId: 'sess-42',
      currentAttemptId: 'att-1',
      attemptCount: 1,
      blockedReason: null,
      dispatchedAt: '2026-07-27T14:00:00.000Z',
      appliedPrototypeRevision: 9,
    });
  });
});
