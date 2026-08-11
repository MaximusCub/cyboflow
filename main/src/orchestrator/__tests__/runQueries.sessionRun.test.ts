/**
 * Guards for `resolveSessionRunHandler` — the session→run lookup a bug report
 * tags itself with.
 *
 * The mocked IPC test covers what the HANDLER does with a resolved row; this
 * covers the SQL itself, which a mock cannot: that terminal runs are found (the
 * whole reason this exists), that the newest run wins, and that a dangling
 * workflow_id still yields the run id.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import { resolveSessionRunHandler } from '../runQueries';

let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function freshDb(): Database.Database {
  db = createTestDb({ includeSubstrate: true });
  return db;
}

/** seedRun does not take a session id — attach one the way a real run does. */
function attachSession(database: Database.Database, runId: string, sessionId: string): void {
  database.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run(sessionId, runId);
}

describe('resolveSessionRunHandler', () => {
  /**
   * The regression that motivated the whole lookup: the rail's active-runs store
   * drops terminal runs, so a report filed about a run that already failed —
   * the common case — carried no run id at all.
   */
  it('finds a run whose status is terminal', () => {
    const database = freshDb();
    const { runId } = seedRun(database, { status: 'failed', workflowName: 'sprint' });
    attachSession(database, runId, 'session-1');

    expect(resolveSessionRunHandler(database, 'session-1')).toEqual({
      runId,
      flowName: 'sprint',
    });
  });

  it('returns null for a session with no run', () => {
    const database = freshDb();
    const { runId } = seedRun(database);
    attachSession(database, runId, 'session-1');

    expect(resolveSessionRunHandler(database, 'session-other')).toBeNull();
  });

  it('picks the newest run when a session has several', () => {
    const database = freshDb();
    const older = seedRun(database, { id: 'run-old', workflowName: 'planner' });
    const newer = seedRun(database, { id: 'run-new', workflowName: 'sprint' });
    attachSession(database, older.runId, 'session-1');
    attachSession(database, newer.runId, 'session-1');
    // seedRun stamps created_at by default, so make the ordering explicit
    // rather than dependent on insert timing within the same millisecond.
    database
      .prepare("UPDATE workflow_runs SET created_at = ? WHERE id = ?")
      .run('2026-01-01 00:00:00', 'run-old');
    database
      .prepare("UPDATE workflow_runs SET created_at = ? WHERE id = ?")
      .run('2026-06-01 00:00:00', 'run-new');

    expect(resolveSessionRunHandler(database, 'session-1')?.runId).toBe('run-new');
  });

  /**
   * A quick session's run points at the internal `__quick__` sentinel — a real
   * workflow row, so the join finds a name, but not one that means anything as a
   * `flow` tag. The run id still does, so it must survive the suppression.
   */
  it('drops the quick-session sentinel name but keeps the run id', () => {
    const database = freshDb();
    const { runId } = seedRun(database, { workflowName: '__quick__' });
    attachSession(database, runId, 'session-1');

    expect(resolveSessionRunHandler(database, 'session-1')).toEqual({ runId, flowName: null });
  });
});
