/**
 * The `sessions.status` write funnel — `DatabaseService.updateSession`'s
 * validation against `shared/workflows/sessionStateMachine`.
 *
 * Two things are pinned here that only this layer can see:
 *   1. TYPE PARITY between `Session['status']` (main/src/database/models.ts) and
 *      the `SessionStatus` union declared in shared/. shared/ may not import
 *      main/, so the two declarations are separate by necessity; if they drift,
 *      the funnel starts validating against a vocabulary the column does not use.
 *   2. The funnel's TWO-MODE behavior: throw in dev/test so a new illegal edge
 *      fails CI, log-and-write in production so a mis-stamped status can never
 *      wedge a user's session.
 *
 * A REAL DatabaseService over a temp-file DB — the validation reads the current
 * status back out of the row, so a mock would prove nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';
import type { Session } from '../models';
import type { SessionStatus } from '../../../../shared/workflows/sessionStateMachine';

// ---------------------------------------------------------------------------
// (1) Type parity — compile-time, no runtime assertion needed.
// ---------------------------------------------------------------------------

/** Fails to compile if either union grows a member the other lacks. */
type Assignable<A extends B, B> = A;
type _SessionStatusCoversDbStatus = Assignable<Session['status'], SessionStatus>;
type _DbStatusCoversSessionStatus = Assignable<SessionStatus, Session['status']>;

let tmpDir: string;
let db: DatabaseService;
let projectId: number;

function seedSession(id: string, status: Session['status']): void {
  db.createSession({
    id,
    name: id,
    initial_prompt: 'p',
    worktree_name: id,
    worktree_path: join(tmpDir, id),
    project_id: projectId,
  });
  // createSession INSERTs 'pending'; move it to the wanted start status through
  // the funnel itself (every such edge is legal, so this cannot mask a failure).
  if (status !== 'pending') db.updateSession(id, { status });
}

/** The raw column value, read around the funnel. */
function rawStatus(id: string): string | undefined {
  const row = db.getDb().prepare('SELECT status FROM sessions WHERE id = ?').get(id) as
    | { status?: string }
    | undefined;
  return row?.status;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-session-status-'));
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (2) Legal edges — the real caller families, all of which must still work.
// ---------------------------------------------------------------------------

describe('legal session status edges pass through the funnel', () => {
  const ALL: readonly SessionStatus[] = ['pending', 'running', 'stopped', 'completed', 'failed'];

  it('writes every ordered pair, self-edges included', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const id = `s-${from}-${to}`;
        seedSession(id, from);
        expect(() => db.updateSession(id, { status: to })).not.toThrow();
        expect(rawStatus(id), `${from} -> ${to}`).toBe(to);
      }
    }
  });

  it('wakes a rested session on a follow-up turn (the `{ status: running }` writers)', () => {
    for (const from of ['stopped', 'completed', 'failed'] as const) {
      const id = `wake-${from}`;
      seedSession(id, from);
      db.updateSession(id, { status: 'running' });
      expect(rawStatus(id)).toBe('running');
    }
  });

  it('leaves a status-less update completely unvalidated', () => {
    seedSession('no-status', 'completed');
    expect(() => db.updateSession('no-status', { name: 'renamed' })).not.toThrow();
    expect(rawStatus('no-status')).toBe('completed');
  });

  it('does not validate against a row that does not exist (the caller no-ops anyway)', () => {
    expect(() => db.updateSession('ghost', { status: 'running' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (3) Illegal edges — the vocabulary guard, in both modes.
// ---------------------------------------------------------------------------

describe('illegal session status writes', () => {
  /**
   * The union is total over the five valid statuses, so the only illegal write
   * is one carrying a status the column's vocabulary does not contain. A cast is
   * how such a value actually arrives: `ipc/ptyPanelDispatch.ts` types its
   * structural `updateSession` dependency's status as a bare `string`.
   */
  const BOGUS = 'in_progress' as Session['status'];

  it('THROWS under a test runner, naming both ends and the session', () => {
    seedSession('bad-dev', 'running');
    expect(() => db.updateSession('bad-dev', { status: BOGUS })).toThrow(
      /Illegal session status transition: running -> in_progress .*bad-dev/,
    );
    // The whole update is abandoned — nothing was written.
    expect(rawStatus('bad-dev')).toBe('running');
  });

  it('rejects an app-level status that bypassed mapSessionStatusToDbStatus', () => {
    seedSession('bad-map', 'running');
    expect(() => db.updateSession('bad-map', { status: 'waiting' as Session['status'] })).toThrow(
      /running -> waiting/,
    );
  });

  it('LOGS AND WRITES outside a test runner — the funnel must never wedge a live session', () => {
    seedSession('bad-prod', 'running');
    // The gate throws only under a test runner (VITEST set, or NODE_ENV ===
    // 'test') — NOT on `NODE_ENV !== 'production'`, because the packaged app
    // detects itself via app.isPackaged and may run with NODE_ENV unset.
    // Simulate the packaged runtime by clearing both signals.
    const prevVitest = process.env.VITEST;
    const prevNodeEnv = process.env.NODE_ENV;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    try {
      expect(() => db.updateSession('bad-prod', { status: BOGUS })).not.toThrow();
      expect(rawStatus('bad-prod')).toBe('in_progress');
      expect(warn.mock.calls.flat().join(' ')).toMatch(/running -> in_progress/);
    } finally {
      if (prevVitest !== undefined) process.env.VITEST = prevVitest;
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      warn.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// (4) markSessionsAsStopped stays an EXPLICIT bypass.
// ---------------------------------------------------------------------------

describe('markSessionsAsStopped', () => {
  it('writes without going through the funnel (documented boot-sweep bypass)', () => {
    seedSession('sweep-1', 'running');
    seedSession('sweep-2', 'pending');
    db.markSessionsAsStopped(['sweep-1', 'sweep-2']);
    expect(rawStatus('sweep-1')).toBe('stopped');
    expect(rawStatus('sweep-2')).toBe('stopped');
  });
});
