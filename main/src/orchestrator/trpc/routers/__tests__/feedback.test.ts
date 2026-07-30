/**
 * Integration tests for the cyboflow.feedback tRPC router, focused on THE GATE
 * SPLIT introduced by Design Mode v1.
 *
 * The document surface (idea-spec / arch-design) may only send while its run is
 * parked at an open blocking decision gate. A design session is a live chat that
 * is never parked and has no gate, so the design-prototype atypes must not touch
 * that chain at all. This suite pins both halves against the live router
 * (appRouter.createCaller) over an in-memory DB with the real FeedbackRouter
 * chokepoint:
 *   - createComment with an ELEMENT anchor on a prototype atype succeeds against a
 *     'running' run with an EMPTY review queue (no parked status, no gate);
 *   - update/delete of that draft likewise need no gate;
 *   - the doc path still refuses to send when the run is not parked
 *     ({ noOp: 'not_parked' }) and sends once parked at a real gate;
 *   - sendBatch's input schema rejects a design atype outright (wrong door);
 *   - anchor↔atype mismatches surface as BAD_REQUEST from the chokepoint.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { FeedbackRouter } from '../../../feedbackRouter';
import { feedbackEvents } from '../events';
import {
  setRevisionLauncher,
  _resetRevisionLauncherForTesting,
  type RevisionBatchInfo,
} from '../../../sendFeedbackHandler';
import {
  setDesignBatchNotifier,
  _resetDesignBatchNotifierForTesting,
} from '../../../feedback/designFeedbackOutbox';
import type { CommentAnchor, ElementCommentAnchor } from '../../../../../../shared/types/feedback';

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

  const migDir = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql',
    '007_add_stuck_reason.sql', // stuck columns 010's table rebuild copies
    '010_questions.sql', // widens the run-status CHECK to include 'awaiting_input'
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '016_review_items.sql',
    '035_artifacts.sql',
    '077_artifact_feedback.sql',
    '085_review_item_audience.sql',
    '092_design_feedback_outbox.sql',
  ]) {
    const sql = readFileSync(join(migDir, f), 'utf-8');
    const needsFkOff = sql.includes('PRAGMA foreign_keys=OFF');
    if (needsFkOff) db.pragma('foreign_keys = OFF');
    db.exec(sql);
    if (needsFkOff) db.pragma('foreign_keys = ON');
  }
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at DATETIME'); // migration 042 slice
  // Hand-seeded ideas use placeholder board/stage refs; no FK behavior is under test.
  db.pragma('foreign_keys = OFF');
  return db;
}

function seedRun(db: Database.Database, runId: string, status = 'running'): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'planner', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, ?, 'default')`,
  ).run(runId, status);
}

function seedIdea(db: Database.Database, ideaId: string): void {
  db.prepare(
    `INSERT INTO ideas (id, project_id, board_id, stage_id, ref, title, body, decomposed_at)
     VALUES (?, 1, 'board-1', 'stage-1', 'IDEA-001', 'An idea', 'body', NULL)`,
  ).run(ideaId);
}

/** The per-entity artifact row sendFeedbackHandler requires as the (run, atype, ref) binding. */
function seedArtifact(db: Database.Database, runId: string, atype: string, sourceRef: string): void {
  db.prepare(
    `INSERT INTO artifacts (id, run_id, atype, label, mode, source_ref)
     VALUES (?, ?, ?, 'A doc', 'template', ?)`,
  ).run(`art_${atype}_${sourceRef}`, runId, atype, sourceRef);
}

/** An open pending blocking decision gate — the document path's actual binding. */
function seedGate(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO review_items (id, project_id, run_id, kind, title, body, status, blocking)
     VALUES ('ri_gate', 1, ?, 'decision', 'Approve', 'body', 'pending', 1)`,
  ).run(runId);
}

const QUOTE_ANCHOR: CommentAnchor = { quote: 'the quoted text', occurrence: 0, bodyHash: 'abcd1234' };

const ELEMENT_ANCHOR: ElementCommentAnchor = {
  kind: 'element',
  designId: 'hero-cta',
  ancestorStack: [
    { tag: 'button', designId: 'hero-cta', label: 'Get started' },
    { tag: 'body', designId: null, label: null },
  ],
  pickedIndex: 0,
};

function buildCaller(): {
  caller: ReturnType<typeof appRouter.createCaller>;
  db: Database.Database;
} {
  const db = buildDb();
  const adapter = dbAdapter(db);
  FeedbackRouter.initialize(adapter);
  return { caller: appRouter.createCaller(createContext({ db: adapter })), db };
}

afterEach(() => {
  FeedbackRouter._resetForTesting();
  _resetRevisionLauncherForTesting();
  _resetDesignBatchNotifierForTesting();
  feedbackEvents.removeAllListeners();
});

// ---------------------------------------------------------------------------
// Design-prototype surface: NO parked run, NO gate
// ---------------------------------------------------------------------------

describe('cyboflow.feedback — design-prototype drafts need no parked run', () => {
  it.each(['ui-prototype', 'interactive-prototype'] as const)(
    'createComment succeeds on %s against a running run with an empty review queue',
    async (atype) => {
      const { caller, db } = buildCaller();
      seedRun(db, 'run-1', 'running');

      // The two things the document path insists on are both absent.
      expect(
        (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-1') as { status: string }).status,
      ).toBe('running');
      expect((db.prepare('SELECT COUNT(*) AS n FROM review_items').get() as { n: number }).n).toBe(0);

      const { commentId } = await caller.cyboflow.feedback.createComment({
        runId: 'run-1',
        atype,
        sourceRef: 'idea-1',
        anchor: ELEMENT_ANCHOR,
        body: 'tighten this spacing',
      });

      const row = db
        .prepare('SELECT atype, status, anchor_json FROM feedback_comments WHERE id = ?')
        .get(commentId) as { atype: string; status: string; anchor_json: string };
      expect(row).toMatchObject({ atype, status: 'draft' });
      expect(JSON.parse(row.anchor_json)).toEqual(ELEMENT_ANCHOR);
    },
  );

  it('update + delete of a prototype draft also need no gate', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    const { commentId } = await caller.cyboflow.feedback.createComment({
      runId: 'run-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      anchor: ELEMENT_ANCHOR,
      body: 'first',
    });

    await caller.cyboflow.feedback.updateComment({
      runId: 'run-1',
      commentId,
      body: 'edited',
      anchor: { ...ELEMENT_ANCHOR, pickedIndex: 1, designId: null },
    });
    expect(
      (db.prepare('SELECT body FROM feedback_comments WHERE id = ?').get(commentId) as { body: string }).body,
    ).toBe('edited');

    await caller.cyboflow.feedback.deleteComment({ runId: 'run-1', commentId });
    expect(db.prepare('SELECT id FROM feedback_comments WHERE id = ?').get(commentId)).toBeUndefined();
  });

  it('rejects an element anchor on a DOCUMENT atype as BAD_REQUEST', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    await expect(
      caller.cyboflow.feedback.createComment({
        runId: 'run-1',
        atype: 'idea-spec',
        sourceRef: 'idea-1',
        anchor: ELEMENT_ANCHOR,
        body: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a quote anchor on a PROTOTYPE atype as BAD_REQUEST', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    await expect(
      caller.cyboflow.feedback.createComment({
        runId: 'run-1',
        atype: 'ui-prototype',
        sourceRef: 'idea-1',
        anchor: QUOTE_ANCHOR,
        body: 'nope',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('sendBatch does not accept a design atype at all (input schema)', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    await expect(
      caller.cyboflow.feedback.sendBatch({
        runId: 'run-1',
        // @ts-expect-error — the sendBatch input is narrowed to the document atypes.
        atype: 'interactive-prototype',
        sourceRef: 'idea-1',
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});

// ---------------------------------------------------------------------------
// Design surface: sendDesignBatch mints the outbox batch AND pokes the pipeline
// ---------------------------------------------------------------------------

describe('cyboflow.feedback.sendDesignBatch', () => {
  it('mints a queued batch bound to the session and pokes the outbox EXACTLY once', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    const poked: string[] = [];
    setDesignBatchNotifier((batchId) => poked.push(batchId));

    const { commentId } = await caller.cyboflow.feedback.createComment({
      runId: 'run-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      anchor: ELEMENT_ANCHOR,
      body: 'make the CTA bigger',
    });

    const result = await caller.cyboflow.feedback.sendDesignBatch({
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [commentId],
    });

    expect(result).toMatchObject({ round: 1, commentIds: [commentId] });
    expect(poked).toEqual([result.batchId]);
    expect(
      db.prepare('SELECT status, session_id AS sessionId FROM feedback_batches WHERE id = ?').get(result.batchId),
    ).toMatchObject({ status: 'queued', sessionId: 'sess-1' });
  });

  it('does NOT poke when the mint is refused', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    const poked: string[] = [];
    setDesignBatchNotifier((batchId) => poked.push(batchId));

    await expect(
      caller.cyboflow.feedback.sendDesignBatch({
        runId: 'run-1',
        sessionId: 'sess-1',
        atype: 'interactive-prototype',
        sourceRef: 'idea-1',
        commentIds: ['fbc_ghost'],
      }),
    ).rejects.toBeInstanceOf(TRPCError);
    expect(poked).toEqual([]);
  });

  it('an UNWIRED notifier still mints the batch (boot recovery picks it up)', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    // Deliberately no setDesignBatchNotifier — the registry is null.
    const { commentId } = await caller.cyboflow.feedback.createComment({
      runId: 'run-1',
      atype: 'ui-prototype',
      sourceRef: 'idea-1',
      anchor: ELEMENT_ANCHOR,
      body: 'tighten this spacing',
    });

    const result = await caller.cyboflow.feedback.sendDesignBatch({
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'ui-prototype',
      sourceRef: 'idea-1',
      commentIds: [commentId],
    });
    expect(
      (db.prepare('SELECT status FROM feedback_batches WHERE id = ?').get(result.batchId) as { status: string })
        .status,
    ).toBe('queued');
  });
});

// ---------------------------------------------------------------------------
// Document surface: the parked gate still governs sending
// ---------------------------------------------------------------------------

describe('cyboflow.feedback — the document path still requires the parked gate', () => {
  it('refuses to send from a RUNNING run (not_parked), even with drafts and an artifact', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    seedIdea(db, 'idea-1');
    seedArtifact(db, 'run-1', 'idea-spec', 'idea-1');
    seedGate(db, 'run-1');
    setRevisionLauncher(async () => {});

    // Drafting is fine...
    await caller.cyboflow.feedback.createComment({
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: QUOTE_ANCHOR,
      body: 'please clarify',
    });

    // ...sending is not, because the run is not parked.
    expect(
      await caller.cyboflow.feedback.sendBatch({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' }),
    ).toEqual({ noOp: true, reason: 'not_parked' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM feedback_batches').get() as { n: number }).n).toBe(0);
  });

  it('refuses to send from a parked run with NO open gate (no_gate)', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'awaiting_review');
    seedIdea(db, 'idea-1');
    seedArtifact(db, 'run-1', 'idea-spec', 'idea-1');
    setRevisionLauncher(async () => {});

    await caller.cyboflow.feedback.createComment({
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: QUOTE_ANCHOR,
      body: 'please clarify',
    });

    expect(
      await caller.cyboflow.feedback.sendBatch({ runId: 'run-1', atype: 'idea-spec', sourceRef: 'idea-1' }),
    ).toEqual({ noOp: true, reason: 'no_gate' });
  });

  it('sends once the run IS parked at an open blocking gate', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'awaiting_review');
    seedIdea(db, 'idea-1');
    seedArtifact(db, 'run-1', 'idea-spec', 'idea-1');
    seedGate(db, 'run-1');
    const launched: RevisionBatchInfo[] = [];
    setRevisionLauncher(async (info) => {
      launched.push(info);
    });

    await caller.cyboflow.feedback.createComment({
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: QUOTE_ANCHOR,
      body: 'please clarify',
    });

    const result = await caller.cyboflow.feedback.sendBatch({
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
    });
    expect(result).toMatchObject({ sent: true, round: 1 });
    // The document lifecycle's entry state, NOT the outbox's 'queued'.
    expect(
      (
        db.prepare('SELECT status, session_id FROM feedback_batches LIMIT 1').get() as {
          status: string;
          session_id: string | null;
        }
      ),
    ).toEqual({ status: 'pending', session_id: null });
    expect(launched).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('cyboflow.feedback.list', () => {
  it('returns both surfaces for a run and shapes the outbox columns', async () => {
    const { caller, db } = buildCaller();
    seedRun(db, 'run-1', 'running');
    await caller.cyboflow.feedback.createComment({
      runId: 'run-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      anchor: ELEMENT_ANCHOR,
      body: 'design note',
    });
    await caller.cyboflow.feedback.createComment({
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      anchor: QUOTE_ANCHOR,
      body: 'doc note',
    });

    const all = await caller.cyboflow.feedback.list({ runId: 'run-1' });
    expect(all.comments.map((c) => c.atype).sort()).toEqual(['idea-spec', 'interactive-prototype']);

    const design = await caller.cyboflow.feedback.list({
      runId: 'run-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
    });
    expect(design.comments).toHaveLength(1);
    expect(design.comments[0].anchor).toEqual(ELEMENT_ANCHOR);

    const { batchId } = await FeedbackRouter.getInstance().createDesignBatch({
      projectId: 1,
      runId: 'run-1',
      sessionId: 'sess-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
      commentIds: [design.comments[0].id],
    });
    const after = await caller.cyboflow.feedback.list({
      runId: 'run-1',
      atype: 'interactive-prototype',
      sourceRef: 'idea-1',
    });
    expect(after.batches).toHaveLength(1);
    expect(after.batches[0]).toMatchObject({
      id: batchId,
      status: 'queued',
      sessionId: 'sess-1',
      attemptCount: 0,
      currentAttemptId: null,
      appliedPrototypeRevision: null,
    });
  });
});
