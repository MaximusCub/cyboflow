/**
 * Integration tests for the orchestrator tRPC verificationRequests router (S7/L6).
 *
 * Exercises the live verificationRequestsRouter.list/.budget procedures via
 * createCaller, using an in-memory SQLite DB built from projects + migrations
 * 006/011/014/015/016/019/055/056(/088) (so workflow_runs + verification_requests
 * + judge_calls_used + the migration-088 failure-classification columns all
 * exist), the shared dbAdapter fixture, and a real DatabaseLike — mirroring the
 * verificationScheduler test's DB harness.
 *
 * Tests:
 *  1. list filters by projectId (rows from another project are excluded).
 *  2. optional runId filter narrows to a single run.
 *  3. optional status filter narrows to a single lifecycle status.
 *  4. runId + status filters compose.
 *  5. results are ordered by enqueued_at DESC (newest first).
 *  6. each row matches the VerificationRequestRow shape (chain_json NULL -> '[]').
 *  7. an empty projectId result returns [].
 *  8. zod rejects projectId 0 / negative + an out-of-domain status.
 *  9. PRECONDITION_FAILED when ctx.db is missing.
 *  10. migration-088 surfacing (verification-setup-flow.md §3.1/§3.6):
 *      failureClass/modality parse valid values and fail-soft on invalid ones;
 *      failureEvidence parses/fail-softs off failure_evidence_json;
 *      setupProof reflects the raw 0/1 flag; a pre-088 DB (columns absent
 *      entirely) renders every new field exactly as today (undefined/false).
 *  11. budget: sums judge_calls_used per project, reads
 *      visual_verify_budget_calls (null = unlimited), zod validation, and
 *      PRECONDITION_FAILED parity with list.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../../../types';
import type { RequestStatus } from '../../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// Test DB: projects + 006 + 011 + 014 + 015 + 016 + 019 + 055 + 056 (+ 088).
// ---------------------------------------------------------------------------

const MIG_DIR = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
const MIGRATIONS_PRE_088 = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  // 019 adds workflow_runs.session_id — the hop the list query LEFT-JOINs
  // through to attribute each request to its origin session.
  '019_workflow_run_session_id.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
];
// The default migration set every test builds against, UNLESS it explicitly
// wants a pre-088 DB (the "absent columns render exactly as today" case) —
// those tests pass MIGRATIONS_PRE_088 to buildDb/buildCaller directly.
const MIGRATIONS = [...MIGRATIONS_PRE_088, '088_verify_failure_classes.sql'];

function buildDb(migrations: readonly string[] = MIGRATIONS): Database.Database {
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
  // Minimal sessions table — migration 019 backfills workflow_runs.session_id
  // from it, and the list query joins it for the session pill's display name.
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, run_id TEXT);`);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('ProjA', '/tmp/p1');
  db.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('ProjB', '/tmp/p2');
  for (const f of migrations) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  return db;
}

/**
 * Seed a run, optionally attached to a session (`sessionName` also inserts the
 * sessions row the join resolves). Omitting it leaves session_id NULL — the
 * unattributed-run case the panel falls back to the run id for.
 */
function seedRun(
  db: Database.Database,
  runId: string,
  projectId: number,
  session?: { id: string; name: string },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, ?, 'sprint', '{}')`,
  ).run(`wf-${projectId}`, projectId);
  if (session !== undefined) {
    db.prepare('INSERT OR IGNORE INTO sessions (id, name, run_id) VALUES (?, ?, ?)').run(
      session.id,
      session.name,
      runId,
    );
  }
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, session_id)
     VALUES (?, ?, ?, 'running', 'default', ?)`,
  ).run(runId, `wf-${projectId}`, projectId, session?.id ?? null);
}

/** Insert one verification_requests row with explicit fields. */
function seedRequest(
  db: Database.Database,
  opts: {
    id: string;
    runId: string;
    projectId: number;
    status: RequestStatus;
    verifyType?: string;
    deliverableJson?: string;
    chainJson?: string | null;
    currentBackend?: string | null;
    attempt?: number;
    verdictJson?: string | null;
    errorMessage?: string | null;
    enqueuedAt: string;
    // Migration-088 columns (verification-setup-flow.md §3.1/§3.6). Leave all
    // five OMITTED (the default) on a pre-088 test DB — providing any one
    // triggers the follow-up UPDATE below, which requires the caller's DB to
    // actually carry migration 088 (the default MIGRATIONS set does; a
    // pre-088 test always builds via MIGRATIONS_PRE_088 and never passes
    // these).
    failureClass?: string | null;
    modality?: string | null;
    failureEvidenceJson?: string | null;
    setupProof?: number;
    judgeCallsUsed?: number;
  },
): void {
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, chain_json,
        current_backend, attempt, verdict_json, error_message, enqueued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.runId,
    opts.projectId,
    opts.status,
    opts.verifyType ?? 'static-render-snapshot',
    opts.deliverableJson ?? JSON.stringify({ intent: 'looks right' }),
    opts.chainJson === undefined ? JSON.stringify(['capturePage']) : opts.chainJson,
    opts.currentBackend ?? null,
    opts.attempt ?? 0,
    opts.verdictJson ?? null,
    opts.errorMessage ?? null,
    opts.enqueuedAt,
  );
  // Migration-088 columns are set via a follow-up UPDATE (rather than folded
  // into the INSERT above) so a pre-088 test DB — which lacks these columns
  // entirely — keeps calling this helper unmodified; only a test that
  // explicitly passes one of the five new fields touches the new columns.
  if (
    opts.failureClass !== undefined ||
    opts.modality !== undefined ||
    opts.failureEvidenceJson !== undefined ||
    opts.setupProof !== undefined ||
    opts.judgeCallsUsed !== undefined
  ) {
    db.prepare(
      `UPDATE verification_requests
          SET failure_class = ?, modality = ?, failure_evidence_json = ?, setup_proof = ?, judge_calls_used = ?
        WHERE id = ?`,
    ).run(
      opts.failureClass ?? null,
      opts.modality ?? null,
      opts.failureEvidenceJson ?? null,
      opts.setupProof ?? 0,
      opts.judgeCallsUsed ?? 0,
      opts.id,
    );
  }
}

function buildCaller(migrations?: readonly string[]): {
  caller: ReturnType<typeof appRouter.createCaller>;
  db: Database.Database;
  adapter: DatabaseLike;
} {
  const db = buildDb(migrations);
  const adapter = dbAdapter(db);
  const caller = appRouter.createCaller(createContext({ db: adapter }));
  return { caller, db, adapter };
}

let openDb: Database.Database | null = null;

afterEach(() => {
  openDb?.close();
  openDb = null;
});

describe('cyboflow.verificationRequests.list', () => {
  it('filters by projectId (excludes other projects)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-b', 2);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-b', projectId: 2, status: 'queued', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('vr-1');
    expect(result[0].project_id).toBe(1);
  });

  it('narrows to a single run via the optional runId filter', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-c', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-c', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1, runId: 'run-c' });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
  });

  it('narrows to a single status via the optional status filter', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:02.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'passed' });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
    expect(result[0].status).toBe('passed');
  });

  it('composes the runId + status filters', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-c', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'failed', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-c', projectId: 1, status: 'failed', enqueuedAt: '2026-06-28T00:00:02.000Z' });
    seedRequest(db, { id: 'vr-3', runId: 'run-c', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:03.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({
      projectId: 1,
      runId: 'run-c',
      status: 'failed',
    });

    expect(result.map((r) => r.id)).toEqual(['vr-2']);
  });

  it('orders by enqueued_at DESC (newest first)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, { id: 'vr-old', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });
    seedRequest(db, { id: 'vr-new', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:09.000Z' });
    seedRequest(db, { id: 'vr-mid', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:05.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.map((r) => r.id)).toEqual(['vr-new', 'vr-mid', 'vr-old']);
  });

  it('returns rows matching the VerificationRequestRow shape (chain_json NULL -> "[]")', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'running',
      verifyType: 'interactive-web-behavior',
      deliverableJson: JSON.stringify({ intent: 'click works' }),
      chainJson: null, // unresolved chain -> normalized to '[]'
      currentBackend: 'playwright',
      attempt: 1,
      verdictJson: null,
      errorMessage: null,
      enqueuedAt: '2026-06-28T00:00:01.000Z',
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row).toEqual({
      id: 'vr-1',
      run_id: 'run-a',
      project_id: 1,
      status: 'running',
      verify_type: 'interactive-web-behavior',
      deliverable_json: JSON.stringify({ intent: 'click works' }),
      chain_json: '[]',
      current_backend: 'playwright',
      attempt: 1,
      verdict_json: null,
      error_message: null,
      enqueued_at: '2026-06-28T00:00:01.000Z',
      leased_at: null,
      ended_at: null,
      task_json: null,
      report_json: null,
      delivery_state: null,
      snapshot_sha: null,
      enqueue_key: null,
      session_id: null,
      session_name: null,
      // Migration-088 columns — every field NULL/unset on this row, so every
      // derived field fail-softs to its default (undefined/false).
      failureClass: undefined,
      modality: undefined,
      setupProof: false,
      failureEvidence: undefined,
    });
    // chain_json is always a parseable VisualBackendId[] for the renderer.
    expect(() => JSON.parse(row.chain_json)).not.toThrow();
  });

  it('attributes each row to its origin session (run -> session join)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1, { id: 'sess-a', name: 'twilight-leaf' });
    seedRun(db, 'run-b', 1, { id: 'sess-b', name: 'curious-basin' });
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:02.000Z' });
    seedRequest(db, { id: 'vr-2', runId: 'run-b', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z' });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.map((r) => [r.id, r.session_id, r.session_name])).toEqual([
      ['vr-1', 'sess-a', 'twilight-leaf'],
      ['vr-2', 'sess-b', 'curious-basin'],
    ]);
  });

  it('reads back NULL session fields for a run with no session (LEFT JOIN, row still lists)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1); // no session attached
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'queued', enqueuedAt: '2026-06-28T00:00:01.000Z' });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.id).toBe('vr-1');
    expect(row.session_id).toBeNull();
    expect(row.session_name).toBeNull();
  });

  it('filters on the REQUEST status/project, not the joined run\'s columns', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    // The run is 'running' while its request is terminal — an unqualified
    // `status = ?` predicate would silently filter on workflow_runs.status here.
    seedRun(db, 'run-a', 1, { id: 'sess-a', name: 'twilight-leaf' });
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z' });

    const passed = await caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'passed' });
    const running = await caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'running' });

    expect(passed.map((r) => r.id)).toEqual(['vr-1']);
    expect(running).toEqual([]);
  });

  it('returns [] when the project has no requests', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });
    expect(result).toEqual([]);
  });

  it('rejects projectId 0 without querying', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: 0 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('rejects a negative projectId', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: -2 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('rejects an out-of-domain status', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      // @ts-expect-error — 'bogus' is not a RequestStatus; the zod enum rejects it.
      caller.cyboflow.verificationRequests.list({ projectId: 1, status: 'bogus' }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.verificationRequests.list({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });

  // --- migration-088 surfacing (verification-setup-flow.md §3.1/§3.6) -----

  it('parses a valid failure_class/modality into failureClass/modality', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'skipped',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      failureClass: 'env',
      modality: 'cdp-app',
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.failureClass).toBe('env');
    expect(row.modality).toBe('cdp-app');
  });

  it('fail-softs an out-of-domain failure_class/modality to undefined', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'failed',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      // Neither is a real VerificationFailureClass/VerificationModality member
      // — simulates a future-added value from a newer binary, or corruption.
      failureClass: 'not-a-real-class',
      modality: 'not-a-real-modality',
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.failureClass).toBeUndefined();
    expect(row.modality).toBeUndefined();
  });

  it('parses failure_evidence_json into failureEvidence', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    const evidence = [{ source: 'preflight', check: 'chromium', detail: 'chromium binary not resolvable' }];
    seedRequest(db, {
      id: 'vr-1',
      runId: 'run-a',
      projectId: 1,
      status: 'skipped',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      failureClass: 'env',
      failureEvidenceJson: JSON.stringify(evidence),
    });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.failureEvidence).toEqual(evidence);
  });

  it('fail-softs malformed failure_evidence_json to undefined (invalid JSON, non-array, and ill-shaped entries)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-invalid-json',
      runId: 'run-a',
      projectId: 1,
      status: 'failed',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      failureClass: 'ambiguous',
      failureEvidenceJson: '{not json',
    });
    seedRequest(db, {
      id: 'vr-not-array',
      runId: 'run-a',
      projectId: 1,
      status: 'failed',
      enqueuedAt: '2026-06-28T00:00:02.000Z',
      failureClass: 'ambiguous',
      failureEvidenceJson: JSON.stringify({ source: 'runner', detail: 'not an array' }),
    });
    seedRequest(db, {
      id: 'vr-ill-shaped',
      runId: 'run-a',
      projectId: 1,
      status: 'failed',
      enqueuedAt: '2026-06-28T00:00:03.000Z',
      failureClass: 'ambiguous',
      failureEvidenceJson: JSON.stringify([{ source: 'runner' /* missing detail */ }]),
    });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.every((r) => r.failureEvidence === undefined)).toBe(true);
  });

  it('setupProof reflects the raw 0/1 flag', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, {
      id: 'vr-proof',
      runId: 'run-a',
      projectId: 1,
      status: 'passed',
      enqueuedAt: '2026-06-28T00:00:01.000Z',
      setupProof: 1,
    });
    seedRequest(db, {
      id: 'vr-ordinary',
      runId: 'run-a',
      projectId: 1,
      status: 'passed',
      enqueuedAt: '2026-06-28T00:00:02.000Z',
      setupProof: 0,
    });

    const result = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(result.find((r) => r.id === 'vr-proof')?.setupProof).toBe(true);
    expect(result.find((r) => r.id === 'vr-ordinary')?.setupProof).toBe(false);
  });

  it('a pre-088 DB (columns absent entirely) renders every new field exactly as today', async () => {
    const { caller, db } = buildCaller(MIGRATIONS_PRE_088);
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z' });

    const [row] = await caller.cyboflow.verificationRequests.list({ projectId: 1 });

    expect(row.id).toBe('vr-1');
    expect(row.failureClass).toBeUndefined();
    expect(row.modality).toBeUndefined();
    expect(row.setupProof).toBe(false);
    expect(row.failureEvidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// budget (§3.6 "surface budget state in the Verify Queue")
// ---------------------------------------------------------------------------

describe('cyboflow.verificationRequests.budget', () => {
  it('sums judge_calls_used across the project\'s requests, ignoring other projects', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    seedRun(db, 'run-a', 1);
    seedRun(db, 'run-b', 2);
    seedRequest(db, { id: 'vr-1', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z', judgeCallsUsed: 2 });
    seedRequest(db, { id: 'vr-2', runId: 'run-a', projectId: 1, status: 'passed', enqueuedAt: '2026-06-28T00:00:02.000Z', judgeCallsUsed: 3 });
    seedRequest(db, { id: 'vr-3', runId: 'run-b', projectId: 2, status: 'passed', enqueuedAt: '2026-06-28T00:00:01.000Z', judgeCallsUsed: 100 });

    const result = await caller.cyboflow.verificationRequests.budget({ projectId: 1 });

    expect(result.usedCalls).toBe(5);
    expect(result.projectId).toBe(1);
    expect(result.projectName).toBe('ProjA');
  });

  it('reads budgetCalls as null when visual_verify_budget_calls is unset (unlimited)', async () => {
    const { caller, db } = buildCaller();
    openDb = db;

    const result = await caller.cyboflow.verificationRequests.budget({ projectId: 1 });

    expect(result.budgetCalls).toBeNull();
    expect(result.usedCalls).toBe(0);
  });

  it('reads a numeric budgetCalls when the project sets one', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    db.prepare('UPDATE projects SET visual_verify_budget_calls = ? WHERE id = ?').run(50, 1);

    const result = await caller.cyboflow.verificationRequests.budget({ projectId: 1 });

    expect(result.budgetCalls).toBe(50);
  });

  it('rejects a non-positive projectId', async () => {
    const { caller, db } = buildCaller();
    openDb = db;
    await expect(
      caller.cyboflow.verificationRequests.budget({ projectId: 0 }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('throws PRECONDITION_FAILED when ctx.db is missing', async () => {
    const caller = appRouter.createCaller(createContext());
    await expect(
      caller.cyboflow.verificationRequests.budget({ projectId: 1 }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'PRECONDITION_FAILED',
    );
  });
});
