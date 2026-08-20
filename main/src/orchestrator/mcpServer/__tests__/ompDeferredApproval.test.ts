/**
 * The omp-sdk lane's approval lifecycle — the half that outlives its requester.
 *
 * OMP kills extension handlers at 30s, so cyboflow's gate can only block for
 * ~25s. Before this behaviour existed, the gate hanging up was read as a dead
 * requester and every unanswered ask was settled as a system deny: on
 * 2026-08-19 a live run produced 17 approvals, 17 system rejections, and zero
 * human verdicts, because 25 seconds is not a window a human can be expected to
 * hit. These tests pin the three things that make the ask outlive the wait:
 *
 *   1. the hang-up parks the requester and keeps the approval pending,
 *   2. an identical retry re-attaches instead of opening a duplicate card,
 *   3. a verdict that lands with nobody waiting is replayed to the next retry —
 *      exactly once.
 *
 * The interactive-Claude path is pinned too, from the other side: a socket that
 * dies there really is a dead subprocess, and must still settle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';
import type net from 'net';
import { McpQueryHandler } from '../mcpQueryHandler';
import type { McpQueryMessage } from '../mcpQueryHandler';
import { ApprovalRouter } from '../../approvalRouter';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface SocketDouble {
  socket: net.Socket;
  writes: string[];
  /** Fire the socket's 'close' — what the gate's budget expiry looks like here. */
  hangUp: () => void;
}

/**
 * A net.Socket double with the listener surface the in-flight registry needs.
 * `write` captures, `on`/`off` maintain real listener sets so `hangUp()` drives
 * the same disconnect path production does.
 */
function makeSocketDouble(): SocketDouble {
  const writes: string[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const socket = {
    write: (chunk: string | Buffer) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      return true;
    },
    on: (event: string, fn: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      set.add(fn);
      listeners.set(event, set);
    },
    off: (event: string, fn: () => void) => {
      listeners.get(event)?.delete(fn);
    },
    end: () => undefined,
    destroy: () => undefined,
  } as unknown as net.Socket;
  return {
    socket,
    writes,
    hangUp: () => {
      for (const fn of [...(listeners.get('close') ?? [])]) fn();
    },
  };
}

function lastVerdict(writes: string[]): { permissionDecision?: string } | undefined {
  const last = writes[writes.length - 1];
  if (last === undefined) return undefined;
  const parsed = JSON.parse(last) as { data?: { permissionDecision?: string } };
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const RUN_ID = 'run-omp';

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

  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
  // resolveRunPermissionMode joins the owning session; this fixture predates the
  // migrations that add those columns, so add the minimal join surface. No mode
  // ⇒ null ⇒ every call routes to the router gate, which is what we are testing.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_permission_mode TEXT)');

  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-o', 1, 'quick', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, 'wf-o', 1, 'running')`,
  ).run(RUN_ID);
  return db;
}

function ask(
  requestId: string,
  opts: { substrate?: 'omp'; command?: string } = {},
): Extract<McpQueryMessage, { type: 'shell-approval-request' }> {
  return {
    type: 'shell-approval-request',
    requestId,
    runId: RUN_ID,
    toolName: 'Bash',
    toolInput: { command: opts.command ?? 'pnpm test' },
    ...(opts.substrate ? { substrate: opts.substrate } : {}),
  };
}

// ---------------------------------------------------------------------------

describe('omp-sdk deferred approvals', () => {
  let db: Database.Database;
  let handler: McpQueryHandler;

  const approvalRows = (): Array<{ id: string; status: string }> =>
    db
      .prepare('SELECT id, status FROM approvals WHERE run_id = ? ORDER BY created_at')
      .all(RUN_ID) as Array<{ id: string; status: string }>;

  const runStatus = (): string =>
    (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(RUN_ID) as { status: string })
      .status;

  /** Let requestApproval's queued transaction commit before asserting on it. */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  beforeEach(() => {
    db = buildDb();
    ApprovalRouter.initialize(dbAdapter(db));
    handler = new McpQueryHandler(dbAdapter(db));
  });

  afterEach(() => {
    ApprovalRouter._resetForTesting();
    db.close();
  });

  it('keeps the approval pending when the gate stops waiting, and hands the run back', async () => {
    const first = makeSocketDouble();
    handler.handleMessage(ask('r1', { substrate: 'omp' }), first.socket);
    await settle();

    expect(approvalRows()).toHaveLength(1);
    expect(runStatus()).toBe('awaiting_review');

    first.hangUp();
    await settle();

    // The ask survives — this is the whole point. The run resumes so the session
    // keeps executing, which is what abandonPendingForRun bought at the cost of
    // settling; here we get the restore WITHOUT the settle.
    expect(approvalRows()[0]?.status).toBe('pending');
    expect(runStatus()).toBe('running');
    expect(lastVerdict(first.writes)).toBeUndefined();
  });

  it('re-attaches an identical retry to the same approval instead of opening a second card', async () => {
    const first = makeSocketDouble();
    handler.handleMessage(ask('r1', { substrate: 'omp' }), first.socket);
    await settle();
    const [approval] = approvalRows();
    first.hangUp();
    await settle();

    const retry = makeSocketDouble();
    handler.handleMessage(ask('r2', { substrate: 'omp' }), retry.socket);
    await settle();

    expect(approvalRows()).toHaveLength(1);
    expect(approvalRows()[0]?.id).toBe(approval?.id);

    // …and the human's answer reaches the socket that is actually waiting now.
    await ApprovalRouter.getInstance().respond(approval!.id, { behavior: 'allow' });
    expect(lastVerdict(retry.writes)?.permissionDecision).toBe('allow');
  });

  it('replays a verdict that landed with nobody waiting — to the next retry, once', async () => {
    const first = makeSocketDouble();
    handler.handleMessage(ask('r1', { substrate: 'omp' }), first.socket);
    await settle();
    const [approval] = approvalRows();

    first.hangUp();
    await settle();
    // The human answers while no requester is attached at all.
    await ApprovalRouter.getInstance().respond(approval!.id, { behavior: 'allow' });

    const retry = makeSocketDouble();
    handler.handleMessage(ask('r2', { substrate: 'omp' }), retry.socket);
    expect(lastVerdict(retry.writes)?.permissionDecision).toBe('allow');
    // Answered from the parked decision — no second approval was opened.
    expect(approvalRows()).toHaveLength(1);

    // SINGLE USE: a human's yes authorizes the call they were shown, not every
    // future call that serializes the same way. The next one asks again.
    const third = makeSocketDouble();
    handler.handleMessage(ask('r3', { substrate: 'omp' }), third.socket);
    await settle();
    expect(approvalRows()).toHaveLength(2);
    expect(lastVerdict(third.writes)).toBeUndefined();
  });

  it('matches a retry through reordered argument keys', async () => {
    const first = makeSocketDouble();
    handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'r1',
        runId: RUN_ID,
        toolName: 'Write',
        toolInput: { path: '/repo/x.json', content: '{}' },
        substrate: 'omp',
      },
      first.socket,
    );
    await settle();
    first.hangUp();
    await settle();

    // Same call, keys serialized the other way round by the model's retry.
    const retry = makeSocketDouble();
    handler.handleMessage(
      {
        type: 'shell-approval-request',
        requestId: 'r2',
        runId: RUN_ID,
        toolName: 'Write',
        toolInput: { content: '{}', path: '/repo/x.json' },
        substrate: 'omp',
      },
      retry.socket,
    );
    await settle();

    expect(approvalRows()).toHaveLength(1);
  });

  it('opens a separate approval for a DIFFERENT call while one is orphaned', async () => {
    const first = makeSocketDouble();
    handler.handleMessage(ask('r1', { substrate: 'omp' }), first.socket);
    await settle();
    first.hangUp();
    await settle();

    const other = makeSocketDouble();
    handler.handleMessage(ask('r2', { substrate: 'omp', command: 'rm -rf build' }), other.socket);
    await settle();

    expect(approvalRows()).toHaveLength(2);
  });

  it('still settles on disconnect for the interactive substrate', async () => {
    // No `substrate` field: the preToolUseShellHook subprocess. A dead socket
    // there means nothing will ever read the verdict, so the original
    // abandon-and-settle disposition must be untouched.
    const hook = makeSocketDouble();
    handler.handleMessage(ask('r1'), hook.socket);
    await settle();

    hook.hangUp();
    await settle();

    expect(approvalRows()[0]?.status).toBe('rejected');
    expect(runStatus()).toBe('running');
  });
});
