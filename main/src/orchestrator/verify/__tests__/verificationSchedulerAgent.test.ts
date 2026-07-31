/**
 * VerificationScheduler — verification-AGENT dispatch (redesign §5.4/§5.7/§5.8).
 *
 * Focus: a run stamped verify_chain=['agent'] routes its requests to the injected
 * VerificationAgentRunner (NOT the capture-backend waterfall), the runner's mapped
 * verdict + report are persisted in the terminal write (report_json), a LEGACY stamp
 * still selects backends, and the agent deadline is honored via the existing
 * per-request abort machinery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  VerificationScheduler,
  ResourceLeasePool,
  VERIFY_NO_RUNBOOK_REASON,
  type OnVerdict,
} from '../verificationScheduler';
import { VerifyCapabilityStore, CAPABILITY_BREAKER_THRESHOLD } from '../capabilityStore';
import { Mutex } from '../../../utils/mutex';
import { setSeamErrorSink } from '../../telemetrySink';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type {
  VerificationAgentRunnerLike,
  VerificationAgentRequest,
  VerificationAgentRunResult,
} from '../verificationAgentRunner';
import type {
  CaptureResult,
  ResolvedVisualVerifyConfig,
  VerificationTaskV1,
  VisualBackend,
  VisualBackendId,
  VlmJudge,
  VerdictV1,
} from '../../../../../shared/types/visualVerification';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id                        INTEGER PRIMARY KEY,
      visual_verify_budget_calls INTEGER
    );
    CREATE TABLE workflow_runs (
      id             TEXT PRIMARY KEY,
      project_id     INTEGER NOT NULL,
      verify_chain   TEXT,
      worktree_path  TEXT,
      agent_provider TEXT,
      model          TEXT,
      batch_id       TEXT
    );
    CREATE TABLE verification_requests (
      id               TEXT PRIMARY KEY,
      run_id           TEXT NOT NULL,
      project_id       INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'queued',
      verify_type      TEXT NOT NULL,
      deliverable_json TEXT NOT NULL,
      chain_json       TEXT,
      current_backend  TEXT,
      attempt          INTEGER NOT NULL DEFAULT 0,
      verdict_json     TEXT,
      report_json      TEXT,
      error_message    TEXT,
      enqueued_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      leased_at        DATETIME,
      ended_at         DATETIME,
      task_json        TEXT,
      delivery_state   TEXT,
      snapshot_sha     TEXT,
      enqueue_key      TEXT,
      judge_calls_used INTEGER NOT NULL DEFAULT 0,
      -- migration 088 (docs/proposals/verification-setup-flow.md §3)
      failure_class         TEXT,
      failure_evidence_json TEXT,
      modality              TEXT,
      preflight_json        TEXT,
      setup_proof           INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE verify_capability_state (
      project_id               INTEGER NOT NULL,
      modality                 TEXT NOT NULL,
      runbook_hash             TEXT NOT NULL DEFAULT '',
      status                   TEXT NOT NULL CHECK (status IN ('active','suppressed','unsupported')),
      reason                   TEXT NOT NULL DEFAULT '',
      consecutive_env_failures INTEGER NOT NULL DEFAULT 0,
      host_generation          INTEGER NOT NULL DEFAULT 0,
      suppressed_until         DATETIME,
      updated_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, modality, runbook_hash)
    );
    CREATE TABLE verify_host_state (
      id                    INTEGER PRIMARY KEY CHECK (id = 1),
      capability_generation INTEGER NOT NULL DEFAULT 0,
      fingerprint_json      TEXT,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, visual_verify_budget_calls) VALUES (1, NULL)').run();
  return db;
}

function seedRun(
  db: Database.Database,
  runId: string,
  verifyChain: string | null,
): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, project_id, verify_chain, worktree_path, agent_provider, model)
     VALUES (?, 1, ?, '/live/worktree', 'claude', 'claude-sonnet-5')`,
  ).run(runId, verifyChain);
}

const CONFIG: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'static-render-snapshot',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  devServerPorts: [29260, 29262],
  simulatorDevices: [],
  queuedAgeCeilingMs: 15 * 60 * 1000,
};

const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'agent says pass',
  judgedFileNames: ['s.png'],
  baselineUsed: false,
  model: 'claude-x',
};

const fakeJudge: VlmJudge = { judge: async () => PASS_VERDICT };

function fakeBackend(capture: ReturnType<typeof vi.fn>): VisualBackend {
  return {
    id: 'capturePage' as VisualBackendId,
    rung: 0,
    requiredLease: () => null,
    healthCheck: async () => true,
    capture: capture as unknown as VisualBackend['capture'],
  };
}

async function flushDrain(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

let db: Database.Database;

beforeEach(() => {
  setSeamErrorSink(() => {});
  db = buildDb();
  VerificationScheduler._resetForTesting();
});

afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
});

describe("VerificationScheduler — ['agent'] stamp dispatch", () => {
  it('routes an agent-stamped run to the runner, persists report_json + a passed verdict, never touches backends', async () => {
    seedRun(db, 'run-agent', JSON.stringify(['agent']));

    const report = {
      version: 1 as const,
      behaviors: [{ id: 'b1', result: 'pass' as const, evidence: { screenshots: ['s.png'], notes: 'ok' } }],
      screenshots: [{ fileName: 's.png', caption: 'c' }],
      outcome: 'pass' as const,
      confidence: 0.9,
      feedback: 'good',
      issues: [],
    };
    const runResult: VerificationAgentRunResult = {
      status: 'passed',
      verdict: PASS_VERDICT,
      report,
      fileNames: ['s.png'],
      deployed: true,
      provisionMode: 'snapshot',
    };
    const run = vi.fn(async (_req: VerificationAgentRequest) => runResult);
    const agentRunner: VerificationAgentRunnerLike = { run };

    const captureSpy = vi.fn(async () => ({ ok: true, fileNames: ['x.png'] }) satisfies CaptureResult);
    const verdicts: Array<{ status: string }> = [];
    const onVerdict: OnVerdict = (args) => {
      verdicts.push({ status: args.status });
    };

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend(captureSpy) },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict,
      agentRunner,
      // The composed task below has a serve step, so the §3.2 degrade gate would
      // skip it on the default 'absent' runbook status. This test is about the
      // dispatch path, so it stands in for a project phase 2 has already proven.
      runbookStatus: () => 'proven',
    });

    scheduler.enqueue({
      runId: 'run-agent',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'verify the widget', taskRef: 'TASK-1' },
      chain: [],
      task: {
        version: 1,
        summary: 'verify the widget',
        behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
        serve: { cmd: 'pnpm dev --port ${PORT}' },
        // Above the 10-min query default, below the 20-min ceiling — proves the
        // extended deadline threads through to the runner request.
        timeoutMs: 900_000,
      },
      snapshotSha: 'sha-1',
    });
    await flushDrain();

    // The runner was deployed; the backend was NOT.
    expect(run).toHaveBeenCalledTimes(1);
    expect(captureSpy).not.toHaveBeenCalled();

    // The runner received the composed task + snapshot sha + a leased port (serve implies a server).
    const req = run.mock.calls[0][0];
    expect(req.task.summary).toBe('verify the widget');
    expect(req.snapshotSha).toBe('sha-1');
    expect(req.verifyPort).not.toBeNull();
    expect(req.verifyDriverPort).toBe((req.verifyPort as number) + 1);
    // The scheduler's effective deadline (task.timeoutMs capped by the ceiling)
    // rides on the request so the query boundary uses the SAME bound.
    expect(req.timeoutMs).toBe(900_000);

    // Terminal status + report_json persisted in the SAME row.
    const row = db
      .prepare('SELECT status, report_json, verdict_json FROM verification_requests LIMIT 1')
      .get() as { status: string; report_json: string | null; verdict_json: string | null };
    expect(row.status).toBe('passed');
    expect(JSON.parse(row.report_json ?? 'null').outcome).toBe('pass');
    expect(JSON.parse(row.verdict_json ?? 'null').status).toBe('pass');
    expect(verdicts).toEqual([{ status: 'passed' }]);
  });

  it('leaves the LEGACY-stamped run on the backend path (runner untouched)', async () => {
    seedRun(db, 'run-legacy', JSON.stringify(['capturePage']));

    const run = vi.fn(async (_req: VerificationAgentRequest): Promise<VerificationAgentRunResult> => ({
      status: 'passed',
      fileNames: [],
      deployed: true,
    }));
    const captureSpy = vi.fn(async () => ({ ok: true, fileNames: ['x.png'] }) satisfies CaptureResult);

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: { capturePage: fakeBackend(captureSpy) },
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: { run },
    });

    scheduler.enqueue({
      runId: 'run-legacy',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: ['capturePage'],
    });
    await flushDrain();

    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    const row = db.prepare('SELECT status FROM verification_requests LIMIT 1').get() as { status: string };
    expect(row.status).toBe('passed');
  });

  it("skips (fail-open) an agent-stamped run when no runner is configured", async () => {
    seedRun(db, 'run-agent-2', JSON.stringify(['agent']));
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      // no agentRunner injected
    });
    scheduler.enqueue({
      runId: 'run-agent-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();
    const row = db
      .prepare('SELECT status, error_message FROM verification_requests LIMIT 1')
      .get() as { status: string; error_message: string | null };
    expect(row.status).toBe('skipped');
    expect(row.error_message).toContain('not configured');
  });

  it('honors the agent deadline (a runner that never settles → timeout)', async () => {
    seedRun(db, 'run-agent-3', JSON.stringify(['agent']));
    const run = vi.fn(
      (_req: VerificationAgentRequest) => new Promise<VerificationAgentRunResult>(() => {}), // never resolves
    );
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: { run },
      agentRequestTimeoutMs: 20, // tiny deadline
      agentRequestCeilingMs: 1000,
    });
    scheduler.enqueue({
      runId: 'run-agent-3',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    // Wait past the 20ms deadline, then flush.
    await new Promise((r) => setTimeout(r, 60));
    await flushDrain();
    const row = db
      .prepare('SELECT status, judge_calls_used FROM verification_requests LIMIT 1')
      .get() as { status: string; judge_calls_used: number };
    expect(row.status).toBe('timeout');
    // §3.6: a deadline expiry IS charged — the deadline is minutes long while
    // preflight settles in under a second, so a timed-out runner was past its
    // pre-deploy gate and an SDK session was spent (the runner's own `deployed`
    // flag is unobservable on this path because raceWithAbort rejects).
    expect(row.judge_calls_used).toBe(1);
  });
});

describe('VerificationScheduler — legacy kill-switch boot terminalization (§5.8)', () => {
  /** Insert a row directly at `status`, attributed to `runId`, for boot-recovery tests. */
  function insertRow(
    dbX: Database.Database,
    opts: { id: string; runId: string; status: 'queued' | 'leased' | 'running'; taskRef?: string },
  ): void {
    dbX
      .prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt, enqueued_at)
         VALUES (?, ?, 1, ?, 'static-render-snapshot', ?, '[]', 0, CURRENT_TIMESTAMP)`,
      )
      .run(
        opts.id,
        opts.runId,
        opts.status,
        JSON.stringify({ intent: 'x', ...(opts.taskRef ? { taskRef: opts.taskRef } : {}) }),
      );
  }

  it('flag SET: terminalizes queued/leased/running agent-stamped rows as skipped + delivers, legacy-stamped rows untouched', async () => {
    seedRun(db, 'run-agent', JSON.stringify(['agent']));
    seedRun(db, 'run-legacy', JSON.stringify(['capturePage']));

    insertRow(db, { id: 'vr_a_queued', runId: 'run-agent', status: 'queued', taskRef: 'TASK-1' });
    insertRow(db, { id: 'vr_a_leased', runId: 'run-agent', status: 'leased' });
    insertRow(db, { id: 'vr_a_running', runId: 'run-agent', status: 'running' });
    insertRow(db, { id: 'vr_l_queued', runId: 'run-legacy', status: 'queued' });

    const verdicts: Array<{ requestId: string; status: string }> = [];
    const onVerdict: OnVerdict = (a) => void verdicts.push({ requestId: a.requestId, status: a.status });

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict,
      legacyKillSwitch: () => true,
    });

    const n = await scheduler.runRecovery();
    expect(n).toBe(3); // the three agent-stamped rows

    const agentRows = db
      .prepare(`SELECT id, status, error_message AS error FROM verification_requests WHERE run_id = 'run-agent' ORDER BY id`)
      .all() as Array<{ id: string; status: string; error: string | null }>;
    for (const row of agentRows) {
      expect(row.status).toBe('skipped');
      expect(row.error).toContain('agent engine disabled');
      expect(row.error).toContain('CYBOFLOW_VERIFY_LEGACY');
    }

    // legacy-stamped row is completely untouched by the kill switch — still queued
    // (the pre-existing recovery only terminalizes leased/running orphans + stale
    // queued rows past the age ceiling; a fresh queued row is left queued either way).
    const legacyRow = db
      .prepare(`SELECT status FROM verification_requests WHERE id = 'vr_l_queued'`)
      .get() as { status: string };
    expect(legacyRow.status).toBe('queued');

    // The lane advanced through the normal delivery path (non-blocking finding raised).
    expect(verdicts.sort((a, b) => a.requestId.localeCompare(b.requestId))).toEqual(
      [
        { requestId: 'vr_a_leased', status: 'skipped' },
        { requestId: 'vr_a_queued', status: 'skipped' },
        { requestId: 'vr_a_running', status: 'skipped' },
      ].sort((a, b) => a.requestId.localeCompare(b.requestId)),
    );
  });

  it('flag UNSET (default posture): byte-identical recovery — agent rows keep their pre-existing fate, not the kill-switch reason', async () => {
    seedRun(db, 'run-agent', JSON.stringify(['agent']));
    insertRow(db, { id: 'vr_a_queued', runId: 'run-agent', status: 'queued' });
    insertRow(db, { id: 'vr_a_leased', runId: 'run-agent', status: 'leased' });

    const verdicts: string[] = [];
    const onVerdict: OnVerdict = (a) => void verdicts.push(a.status);

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      onVerdict,
      legacyKillSwitch: () => false,
    });

    const n = await scheduler.runRecovery();
    // Only the pre-existing orphan sweep fires (the leased row → timeout); the
    // fresh queued row is untouched (not over the age ceiling).
    expect(n).toBe(1);

    const leased = db
      .prepare(`SELECT status, error_message AS error FROM verification_requests WHERE id = 'vr_a_leased'`)
      .get() as { status: string; error: string | null };
    expect(leased.status).toBe('timeout');
    expect(leased.error).toBe('orphaned by process restart');
    expect(leased.error).not.toContain('CYBOFLOW_VERIFY_LEGACY');

    const queued = db
      .prepare(`SELECT status FROM verification_requests WHERE id = 'vr_a_queued'`)
      .get() as { status: string };
    expect(queued.status).toBe('queued');
    expect(verdicts).toEqual(['timeout']);
  });

  it('defaults to reading process.env.CYBOFLOW_VERIFY_LEGACY when no legacyKillSwitch dep is injected', async () => {
    seedRun(db, 'run-agent', JSON.stringify(['agent']));
    insertRow(db, { id: 'vr_a_queued', runId: 'run-agent', status: 'queued' });

    const prior = process.env.CYBOFLOW_VERIFY_LEGACY;
    process.env.CYBOFLOW_VERIFY_LEGACY = '1';
    try {
      const scheduler = VerificationScheduler.initialize({
        db: dbAdapter(db),
        backends: {},
        judge: fakeJudge,
        artifactsDirResolver: () => '/artifacts',
        config: CONFIG,
        leasePool: new ResourceLeasePool(new Mutex()),
        // no legacyKillSwitch injected — must fall back to process.env
      });
      const n = await scheduler.runRecovery();
      expect(n).toBe(1);
      const row = db
        .prepare(`SELECT status FROM verification_requests WHERE id = 'vr_a_queued'`)
        .get() as { status: string };
      expect(row.status).toBe('skipped');
    } finally {
      if (prior === undefined) delete process.env.CYBOFLOW_VERIFY_LEGACY;
      else process.env.CYBOFLOW_VERIFY_LEGACY = prior;
    }
  });
});

describe('ResourceLeasePool.quarantine (§5.4 step 6)', () => {
  it('holds a leaked lease until its re-probe reports the resource free', async () => {
    const pool = new ResourceLeasePool(new Mutex());
    const handle = await pool.tryAcquire('verify:port:29260');
    expect(handle).not.toBeNull();

    let free = false;
    pool.quarantine(handle!, async () => free, 'leaked port');
    expect(pool.isQuarantined('verify:port:29260')).toBe(true);

    // Still bound ⇒ a later acquisition of the quarantined slot is refused.
    expect(await pool.tryAcquireOneOf(['verify:port:29260'])).toBeNull();

    // The resource frees ⇒ the re-probe clears the quarantine and hands the slot out.
    free = true;
    const reacquired = await pool.tryAcquireOneOf(['verify:port:29260']);
    expect(reacquired).not.toBeNull();
    expect(pool.isQuarantined('verify:port:29260')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase 0 — honest failures (docs/proposals/verification-setup-flow.md §3)
// ---------------------------------------------------------------------------

/** A composed task WITH a serve step — the shape the §3.2 degrade gate acts on. */
const SERVE_TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'verify the widget',
  behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
  serve: { cmd: 'pnpm dev --port ${PORT}' },
};

/** The DEGENERATE task — a bare pre-live target, no build and no serve. */
const TARGET_ONLY_TASK: VerificationTaskV1 = {
  version: 1,
  summary: 'verify the live page',
  behaviors: [{ id: 'b1', description: 'renders', expected: 'visible' }],
  target: { url: 'https://example.test/page' },
};

/** A runner stub that records every call and returns a caller-supplied result. */
function stubRunner(
  result: VerificationAgentRunResult,
): { runner: VerificationAgentRunnerLike; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (_req: VerificationAgentRequest) => result);
  return { runner: { run }, run };
}

function requestRow(dbX: Database.Database): {
  status: string;
  error_message: string | null;
  failure_class: string | null;
  failure_evidence_json: string | null;
  modality: string | null;
  preflight_json: string | null;
  judge_calls_used: number;
} {
  return dbX
    .prepare(
      `SELECT status, error_message, failure_class, failure_evidence_json, modality, preflight_json, judge_calls_used
         FROM verification_requests LIMIT 1`,
    )
    .get() as ReturnType<typeof requestRow>;
}

describe('VerificationScheduler — §3.3 unsupported modality + suppression (pre-lease gates)', () => {
  it("a native-desktop request resolves 'skipped' with an explicit reason, marks the modality unsupported, and NEVER deploys", async () => {
    seedRun(db, 'run-native', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const markUnsupported = vi.spyOn(store, 'markUnsupported');
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: store,
    });
    scheduler.enqueue({
      runId: 'run-native',
      projectId: 1,
      type: 'native-desktop',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.modality).toBe('native-screen');
    expect(row.error_message).toContain("unsupported modality 'native-screen'");
    expect(row.error_message).toContain('not yet wired');
    expect(row.failure_class).toBe('env');
    expect(JSON.parse(row.failure_evidence_json ?? '[]')).toHaveLength(1);
    expect(markUnsupported).toHaveBeenCalledWith(1, 'native-screen', expect.stringContaining('unsupported modality'));
  });

  it("a mobile-flow request skips with the 'deferred — pending Xcode MCP' reason", async () => {
    seedRun(db, 'run-mobile', JSON.stringify(['agent']));
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: new VerifyCapabilityStore(dbAdapter(db)),
    });
    scheduler.enqueue({
      runId: 'run-mobile',
      projectId: 1,
      type: 'mobile-flow',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.modality).toBe('mobile');
    expect(row.error_message).toContain('Xcode MCP');
    expect(row.failure_class).toBe('env');
  });

  it('an ACTIVE suppression short-circuits the request before any lease', async () => {
    seedRun(db, 'run-suppressed', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    store.markUnsupported(1, 'web', 'no chromium on this host');
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });

    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: store,
    });
    scheduler.enqueue({
      runId: 'run-suppressed',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.error_message).toContain('verification suppressed for web');
    expect(row.error_message).toContain('no chromium on this host');
    expect(row.failure_class).toBe('env');
  });
});

describe('VerificationScheduler — §3.2 degrade path (no proven runbook)', () => {
  /** Initialize a scheduler with a stub runner; returns the run spy. */
  function initWith(
    opts: Partial<Parameters<typeof VerificationScheduler.initialize>[0]> = {},
  ): { scheduler: VerificationScheduler; run: ReturnType<typeof vi.fn> } {
    const { runner, run } = stubRunner({ status: 'passed', fileNames: [], deployed: true });
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: new VerifyCapabilityStore(dbAdapter(db)),
      ...opts,
    });
    return { scheduler, run };
  }

  it('a task with a serve step + NO proven runbook → skipped with the setup reason, never deployed', async () => {
    seedRun(db, 'run-degrade', JSON.stringify(['agent']));
    const { scheduler, run } = initWith(); // runbookStatus defaults to 'absent'
    scheduler.enqueue({
      runId: 'run-degrade',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = requestRow(db);
    expect(row.status).toBe('skipped');
    expect(row.error_message).toBe(VERIFY_NO_RUNBOOK_REASON);
    expect(row.failure_class).toBe('env');
  });

  it("an 'unproven-draft' runbook is NOT a pass — a written config nobody proved is exactly what already failed", async () => {
    seedRun(db, 'run-draft', JSON.stringify(['agent']));
    const { scheduler, run } = initWith({ runbookStatus: () => 'unproven-draft' });
    scheduler.enqueue({
      runId: 'run-draft',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();
    expect(run).not.toHaveBeenCalled();
    expect(requestRow(db).error_message).toBe(VERIFY_NO_RUNBOOK_REASON);
  });

  it('a PROVEN runbook lets the same task through', async () => {
    seedRun(db, 'run-proven', JSON.stringify(['agent']));
    const { scheduler, run } = initWith({ runbookStatus: () => 'proven' });
    scheduler.enqueue({
      runId: 'run-proven',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
  });

  it('a DEGENERATE target-only task bypasses the gate (it derives no environment)', async () => {
    seedRun(db, 'run-degenerate', JSON.stringify(['agent']));
    const { scheduler, run } = initWith();
    scheduler.enqueue({
      runId: 'run-degenerate',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
      task: TARGET_ONLY_TASK,
    });
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
  });

  it('a setup_proof row bypasses the gate (proving the runbook is how a project stops being unproven)', async () => {
    seedRun(db, 'run-setup-proof', JSON.stringify(['agent']));
    const { scheduler, run } = initWith();
    scheduler.enqueue({
      runId: 'run-setup-proof',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
      setupProof: true,
    });
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestRow(db).status).toBe('passed');
  });
});

describe('VerificationScheduler — §3.6 budget accounting', () => {
  function initWith(result: VerificationAgentRunResult): {
    scheduler: VerificationScheduler;
    run: ReturnType<typeof vi.fn>;
  } {
    const { runner, run } = stubRunner(result);
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: new VerifyCapabilityStore(dbAdapter(db)),
    });
    return { scheduler, run };
  }

  it('deployed:true → judge_calls_used is incremented', async () => {
    seedRun(db, 'run-budget-1', JSON.stringify(['agent']));
    const { scheduler } = initWith({ status: 'passed', fileNames: [], deployed: true });
    scheduler.enqueue({
      runId: 'run-budget-1',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();
    expect(requestRow(db).judge_calls_used).toBe(1);
  });

  it('deployed:false (a §3.5 preflight skip) → judge_calls_used is NOT incremented', async () => {
    seedRun(db, 'run-budget-2', JSON.stringify(['agent']));
    const { scheduler } = initWith({
      status: 'skipped',
      fileNames: [],
      deployed: false,
      errorMessage: 'chromium not resolved (absent)',
      preflight: {
        ok: false,
        checks: [{ id: 'chromium', ok: false, detail: 'chromium not resolved (absent)' }],
      },
    });
    scheduler.enqueue({
      runId: 'run-budget-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();
    const row = requestRow(db);
    expect(row.judge_calls_used).toBe(0);
    expect(row.status).toBe('skipped');
    // The preflight is persisted for the phase-3 health panel either way.
    expect(JSON.parse(row.preflight_json ?? 'null')).toMatchObject({ ok: false });
  });

  it('a setup_proof row BYPASSES an exhausted budget and is never counted against it', async () => {
    seedRun(db, 'run-budget-3', JSON.stringify(['agent']));
    // Budget of 1, already fully consumed by a prior request for this project.
    db.prepare('UPDATE projects SET visual_verify_budget_calls = 1 WHERE id = 1').run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, judge_calls_used)
       VALUES ('vr_spent', 'run-budget-3', 1, 'passed', 'static-render-snapshot', '{}', 1)`,
    ).run();

    const { scheduler, run } = initWith({ status: 'passed', fileNames: [], deployed: true });
    const requestId = scheduler.enqueue({
      runId: 'run-budget-3',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
      setupProof: true,
    });
    await flushDrain();

    expect(run).toHaveBeenCalledTimes(1); // NOT short-circuited by the exhausted budget
    const row = db
      .prepare('SELECT status, judge_calls_used AS used FROM verification_requests WHERE id = ?')
      .get(requestId) as { status: string; used: number };
    expect(row.status).toBe('passed');
    expect(row.used).toBe(0); // never charged
  });

  it('an ORDINARY row still fail-opens to skipped on an exhausted budget (unchanged)', async () => {
    seedRun(db, 'run-budget-4', JSON.stringify(['agent']));
    db.prepare('UPDATE projects SET visual_verify_budget_calls = 1 WHERE id = 1').run();
    db.prepare(
      `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, judge_calls_used)
       VALUES ('vr_spent2', 'run-budget-4', 1, 'passed', 'static-render-snapshot', '{}', 1)`,
    ).run();

    const { scheduler, run } = initWith({ status: 'passed', fileNames: [], deployed: true });
    const requestId = scheduler.enqueue({
      runId: 'run-budget-4',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    await flushDrain();

    expect(run).not.toHaveBeenCalled();
    const row = db
      .prepare('SELECT status, error_message AS err FROM verification_requests WHERE id = ?')
      .get(requestId) as { status: string; err: string | null };
    expect(row.status).toBe('skipped');
    expect(row.err).toContain('budget exhausted');
  });
});

describe('VerificationScheduler — §3.1 classification + §3.4 capability feedback', () => {
  const PREFLIGHT_FAIL = {
    ok: false,
    checks: [
      { id: 'port-free' as const, ok: false, detail: 'port 29260 is occupied — a connect probe succeeded (squatter)' },
    ],
  };

  function initWith(
    result: VerificationAgentRunResult,
    opts: {
      store?: VerifyCapabilityStore;
      capabilityFinding?: ReturnType<typeof vi.fn>;
    } = {},
  ): { scheduler: VerificationScheduler; run: ReturnType<typeof vi.fn> } {
    const { runner, run } = stubRunner(result);
    const scheduler = VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      agentRunner: runner,
      capabilityStore: opts.store ?? new VerifyCapabilityStore(dbAdapter(db)),
      ...(opts.capabilityFinding ? { capabilityFinding: opts.capabilityFinding } : {}),
    });
    return { scheduler, run };
  }

  function enqueueOne(scheduler: VerificationScheduler, runId: string): string {
    return scheduler.enqueue({
      runId,
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
  }

  it("a FAILED terminal with harness preflight evidence is CONVERTED to 'skipped' (env class)", async () => {
    seedRun(db, 'run-env', JSON.stringify(['agent']));
    const { scheduler } = initWith({
      status: 'failed',
      fileNames: [],
      deployed: true,
      provisionMode: 'snapshot',
      errorMessage: 'build blew up',
      preflight: PREFLIGHT_FAIL,
    });
    enqueueOne(scheduler, 'run-env');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('skipped'); // converted — the lane advances, no retry charged
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toContain('environment failure (harness-verified)');
    expect(row.error_message).toContain('squatter');
    const evidence = JSON.parse(row.failure_evidence_json ?? '[]') as Array<{ source: string }>;
    expect(evidence[0].source).toBe('port-probe');
  });

  it('a JUDGED snapshot FAIL stays FAILED (deliverable class) and records a HEALTHY outcome', async () => {
    seedRun(db, 'run-deliverable', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const healthy = vi.spyOn(store, 'recordHealthyOutcome');
    const { scheduler } = initWith(
      {
        status: 'failed',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        report: {
          version: 1,
          behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: [], notes: 'missing' } }],
          screenshots: [],
          outcome: 'fail',
          confidence: 0.9,
          feedback: 'broken',
          issues: [],
        },
        preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
      },
      { store },
    );
    enqueueOne(scheduler, 'run-deliverable');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('failed'); // NOT converted — the deliverable is what broke
    expect(row.failure_class).toBe('deliverable');
    expect(healthy).toHaveBeenCalledWith(1, 'web');
  });

  it("a model-authored build_failed with NO harness corroboration stays 'ambiguous' AND stays failed", async () => {
    seedRun(db, 'run-ambiguous', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const envFailure = vi.spyOn(store, 'recordEnvFailure');
    const healthy = vi.spyOn(store, 'recordHealthyOutcome');
    const { scheduler } = initWith(
      {
        status: 'failed',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        errorMessage: 'EADDRINUSE: port taken',
        report: {
          version: 1,
          behaviors: [],
          screenshots: [],
          outcome: 'build_failed',
          buildLogExcerpt: 'EADDRINUSE: port taken',
          confidence: 0.5,
          feedback: 'could not build',
          issues: [],
        },
        preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
      },
      { store },
    );
    enqueueOne(scheduler, 'run-ambiguous');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('failed'); // blocking, exactly like today
    expect(row.failure_class).toBe('ambiguous');
    // Ambiguity touches NEITHER side of the ledger.
    expect(envFailure).not.toHaveBeenCalled();
    expect(healthy).not.toHaveBeenCalled();
  });

  it("a timeout persists 'ambiguous' and is never converted", async () => {
    seedRun(db, 'run-ambiguous-timeout', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const envFailure = vi.spyOn(store, 'recordEnvFailure');
    const { scheduler } = initWith(
      {
        status: 'timeout',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        errorMessage: 'deadline exceeded',
        preflight: { ok: true, checks: [{ id: 'node', ok: true, detail: 'resolved' }] },
      },
      { store },
    );
    enqueueOne(scheduler, 'run-ambiguous-timeout');
    await flushDrain();

    const row = requestRow(db);
    expect(row.status).toBe('timeout');
    expect(row.failure_class).toBe('ambiguous');
    expect(envFailure).not.toHaveBeenCalled();
  });

  it('K consecutive env failures trip the breaker ONCE, and the NEXT request short-circuits on the suppression', async () => {
    seedRun(db, 'run-breaker', JSON.stringify(['agent']));
    const store = new VerifyCapabilityStore(dbAdapter(db));
    const capabilityFinding = vi.fn();
    const { scheduler, run } = initWith(
      {
        status: 'failed',
        fileNames: [],
        deployed: true,
        provisionMode: 'snapshot',
        errorMessage: 'boom',
        preflight: PREFLIGHT_FAIL,
      },
      { store, capabilityFinding },
    );

    // Three env-class terminals — the third crosses CAPABILITY_BREAKER_THRESHOLD.
    for (let i = 0; i < CAPABILITY_BREAKER_THRESHOLD; i++) {
      enqueueOne(scheduler, 'run-breaker');
      await flushDrain();
    }
    expect(run).toHaveBeenCalledTimes(CAPABILITY_BREAKER_THRESHOLD);
    expect(capabilityFinding).toHaveBeenCalledTimes(1);
    expect(capabilityFinding).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, runId: 'run-breaker', modality: 'web' }),
    );

    // The 4th request never reaches the runner — the ledger suppression gates it.
    const fourthId = enqueueOne(scheduler, 'run-breaker');
    await flushDrain();
    expect(run).toHaveBeenCalledTimes(CAPABILITY_BREAKER_THRESHOLD); // unchanged
    const fourth = db
      .prepare('SELECT status, error_message AS err FROM verification_requests WHERE id = ?')
      .get(fourthId) as { status: string; err: string | null };
    expect(fourth.status).toBe('skipped');
    expect(fourth.err).toContain('verification suppressed for web');
    // Still exactly one notice — a suppressed modality must not re-file it.
    expect(capabilityFinding).toHaveBeenCalledTimes(1);
  });
});

describe('VerificationScheduler.enqueue — modality + setup_proof stamping', () => {
  function initBare(): VerificationScheduler {
    return VerificationScheduler.initialize({
      db: dbAdapter(db),
      backends: {},
      judge: fakeJudge,
      artifactsDirResolver: () => '/artifacts',
      config: CONFIG,
      leasePool: new ResourceLeasePool(new Mutex()),
      // no agentRunner: rows resolve 'skipped' immediately, which is fine — this
      // block asserts only what the INSERT stamped.
    });
  }

  it("stamps 'cdp-app' for an attach:'cdp' task and 'web' otherwise", () => {
    seedRun(db, 'run-stamp', JSON.stringify(['agent']));
    const scheduler = initBare();
    const cdpId = scheduler.enqueue({
      runId: 'run-stamp',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: { ...SERVE_TASK, serve: { cmd: 'electron .', attach: 'cdp' } },
    });
    const webId = scheduler.enqueue({
      runId: 'run-stamp',
      projectId: 1,
      type: 'interactive-web-behavior',
      input: { intent: 'x' },
      chain: [],
      task: SERVE_TASK,
    });
    const modalityOf = (id: string): string | null =>
      (db.prepare('SELECT modality FROM verification_requests WHERE id = ?').get(id) as { modality: string | null })
        .modality;
    expect(modalityOf(cdpId)).toBe('cdp-app');
    expect(modalityOf(webId)).toBe('web');
  });

  it('stamps setup_proof 0/1 from the option', () => {
    seedRun(db, 'run-stamp-2', JSON.stringify(['agent']));
    const scheduler = initBare();
    const proofId = scheduler.enqueue({
      runId: 'run-stamp-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
      setupProof: true,
    });
    const laneId = scheduler.enqueue({
      runId: 'run-stamp-2',
      projectId: 1,
      type: 'static-render-snapshot',
      input: { intent: 'x' },
      chain: [],
    });
    const proofOf = (id: string): number =>
      (db.prepare('SELECT setup_proof AS p FROM verification_requests WHERE id = ?').get(id) as { p: number }).p;
    expect(proofOf(proofId)).toBe(1);
    expect(proofOf(laneId)).toBe(0);
  });
});
