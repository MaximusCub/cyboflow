/**
 * Unit tests for composePartialSprintGateBody (Item 2) — the enriched terminal
 * human-gate body for a sprint/ship run that settled with failed lanes.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { composePartialSprintGateBody } from '../partialSprintGateSummary';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, batch_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, ref TEXT, title TEXT);
    CREATE TABLE sprint_batch_tasks (
      batch_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      current_step_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function seedRun(db: Database.Database, runId: string, batchId: string | null): void {
  db.prepare('INSERT INTO workflow_runs (id, batch_id) VALUES (?, ?)').run(runId, batchId);
}
function seedTask(db: Database.Database, id: string, ref: string | null, title: string | null): void {
  db.prepare('INSERT INTO tasks (id, ref, title) VALUES (?, ?, ?)').run(id, ref, title);
}
function seedLane(
  db: Database.Database,
  batchId: string,
  taskId: string,
  status: string,
  currentStepId: string | null,
  attempts: number,
): void {
  db.prepare(
    'INSERT INTO sprint_batch_tasks (batch_id, task_id, status, current_step_id, attempts) VALUES (?, ?, ?, ?, ?)',
  ).run(batchId, taskId, status, currentStepId, attempts);
}

describe('composePartialSprintGateBody', () => {
  it('returns null for a run with no batch (a non-sprint gate keeps its generic body)', () => {
    const db = buildDb();
    seedRun(db, 'run-1', null);
    expect(composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review')).toBeNull();
  });

  it('returns null when every lane integrated (a clean sprint keeps its generic body)', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', 'TASK-001', 'Do a thing');
    seedLane(db, 'batch-1', 't1', 'integrated', 'visual-verify', 1);
    expect(composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review')).toBeNull();
  });

  it('enumerates each failed lane with ref/title, failing step, and attempt count', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', 'TASK-107', 'Add chat panel');
    seedTask(db, 't2', 'TASK-108', 'Wire the store');
    seedTask(db, 't3', 'TASK-109', 'Integrated one');
    // Two failed lanes (one exhausted 3×, one failed on its first pass), one integrated.
    seedLane(db, 'batch-1', 't1', 'failed', 'code-review', 3);
    seedLane(db, 'batch-1', 't2', 'failed', 'implement', 0);
    seedLane(db, 'batch-1', 't3', 'integrated', 'visual-verify', 1);

    const body = composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review');
    expect(body).not.toBeNull();
    expect(body).toContain('**2 failed lanes**');
    expect(body).toContain('Human review');
    expect(body).toContain('`TASK-107` — Add chat panel — failed at `code-review` after 3 attempts');
    // attempts=0 (first-pass failure) renders as "1 attempt".
    expect(body).toContain('`TASK-108` — Wire the store — failed at `implement` after 1 attempt');
    // The integrated lane is not listed.
    expect(body).not.toContain('TASK-109');
    // Singular/plural + backlog guidance present.
    expect(body).toContain('returns to the backlog');
  });

  it('falls back to the opaque task id + "an early step" when ref/current_step are null', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', null, null); // task row present but unref'd
    seedLane(db, 'batch-1', 't1', 'failed', null, 0);

    const body = composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review');
    expect(body).toContain('**1 failed lane**');
    expect(body).toContain('`t1`');
    expect(body).toContain('an early step');
  });

  it('returns null fail-soft when the sprint_batch_tasks table is absent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, batch_id TEXT)');
    seedRun(db, 'run-1', 'batch-1');
    expect(composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review')).toBeNull();
    db.close();
  });
});
