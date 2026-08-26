/**
 * selectSessionRunScope — the chat-turn run-identity fix.
 *
 * The defect it exists for: a chat turn's CYBOFLOW_RUN_ID is the session's
 * `__quick__` sentinel (chatSentinelProvider), never the flow run whose findings
 * the human is asking about, so every run-bound read replied with an empty set.
 * These pin the widening AND its four fail-soft narrowings, since a scope that
 * throws or over-widens is worse than the single-run behavior it replaces.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { selectSessionRunScope } from '../sessionRunScope';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

/** Minimal workflow_runs with the migration-019 session_id forward link. */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      created_at TEXT
    );
  `);
  return db;
}

function seedRun(db: Database.Database, id: string, sessionId: string | null, createdAt: string): void {
  db.prepare('INSERT INTO workflow_runs (id, session_id, created_at) VALUES (?, ?, ?)').run(
    id,
    sessionId,
    createdAt,
  );
}

describe('selectSessionRunScope', () => {
  it('widens a chat sentinel to every run its session owns, sentinel first', () => {
    const db = buildDb();
    seedRun(db, 'run-flow', 'sess-1', '2026-08-26T10:00:00Z');
    seedRun(db, 'run-sentinel', 'sess-1', '2026-08-26T11:00:00Z');
    seedRun(db, 'run-handover', 'sess-1', '2026-08-26T12:00:00Z');
    // A different session's run must never leak in.
    seedRun(db, 'run-elsewhere', 'sess-2', '2026-08-26T10:30:00Z');

    // Called with the SENTINEL — the id a chat turn actually carries.
    const scope = selectSessionRunScope(dbAdapter(db), 'run-sentinel');
    expect(scope[0]).toBe('run-sentinel');
    expect(new Set(scope)).toEqual(new Set(['run-sentinel', 'run-flow', 'run-handover']));
    expect(scope).not.toContain('run-elsewhere');
  });

  it('is symmetric — the flow run resolves to the same session set', () => {
    const db = buildDb();
    seedRun(db, 'run-flow', 'sess-1', '2026-08-26T10:00:00Z');
    seedRun(db, 'run-sentinel', 'sess-1', '2026-08-26T11:00:00Z');

    const scope = selectSessionRunScope(dbAdapter(db), 'run-flow');
    expect(scope[0]).toBe('run-flow');
    expect(new Set(scope)).toEqual(new Set(['run-flow', 'run-sentinel']));
  });

  it('orders the widened tail chronologically and never duplicates the head', () => {
    const db = buildDb();
    seedRun(db, 'run-c', 'sess-1', '2026-08-26T12:00:00Z');
    seedRun(db, 'run-a', 'sess-1', '2026-08-26T10:00:00Z');
    seedRun(db, 'run-b', 'sess-1', '2026-08-26T11:00:00Z');

    expect(selectSessionRunScope(dbAdapter(db), 'run-b')).toEqual(['run-b', 'run-a', 'run-c']);
  });

  // ── Fail-soft narrowings: every one collapses to the pre-existing behavior ──

  it('narrows to the single run when it has no session (legacy parentless run)', () => {
    const db = buildDb();
    seedRun(db, 'run-orphan', null, '2026-08-26T10:00:00Z');
    seedRun(db, 'run-other', null, '2026-08-26T11:00:00Z');

    // NULL session_id must NOT join every other NULL-session run together.
    expect(selectSessionRunScope(dbAdapter(db), 'run-orphan')).toEqual(['run-orphan']);
  });

  it('narrows to the single run when the run row is missing entirely', () => {
    expect(selectSessionRunScope(dbAdapter(buildDb()), 'run-ghost')).toEqual(['run-ghost']);
  });

  it('narrows to the single run on a pre-019 schema with no session_id column', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, created_at TEXT);');
    db.prepare('INSERT INTO workflow_runs (id, created_at) VALUES (?, ?)').run('run-1', 'x');

    // The SQL throws on the unknown column; the caller must still get a usable scope.
    expect(selectSessionRunScope(dbAdapter(db), 'run-1')).toEqual(['run-1']);
  });

  it('narrows to the single run when there is no workflow_runs table at all', () => {
    expect(selectSessionRunScope(dbAdapter(new Database(':memory:')), 'run-1')).toEqual(['run-1']);
  });
});
