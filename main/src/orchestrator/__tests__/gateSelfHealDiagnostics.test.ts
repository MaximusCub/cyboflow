/**
 * Diagnostic tags on the `gate-hook-timeout` self-heal beacon (CYBOFLOW-APP-K).
 *
 * The self-heal itself is covered in questionRouter.test.ts ("supersede-and-
 * reopen"). This file covers only what the beacon REPORTS, because the beacon
 * is the sole production signal for a wedge nobody can reproduce on demand:
 *
 *   - the message stays CONSTANT (it is Sentry's grouping key) and asserts no
 *     cause;
 *   - healSource / priorGateAge / priorGateCount carry the wedge's shape and
 *     stay inside a bounded vocabulary (telemetrySink scrubs `extra`, so tags
 *     are the only channel, and unbounded tags would blow up cardinality).
 *
 * telemetrySink is mocked module-wide here so emitSeamError is observable;
 * that is why these live in their own file rather than in questionRouter.test.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  QuestionRouter,
  buildSelfHealTags,
  bucketGateAgeSeconds,
  bucketPriorGateCount,
  parseGateCreatedAtMs,
} from '../questionRouter';
import { emitSeamError } from '../telemetrySink';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { QuestionPayload } from '../../../../shared/types/questions';

vi.mock('../telemetrySink', () => ({
  emitSeamError: vi.fn(),
  emitUsage: vi.fn(),
  setSeamErrorSink: vi.fn(),
  setTelemetrySink: vi.fn(),
}));

const emitSeamErrorMock = vi.mocked(emitSeamError);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseGateCreatedAtMs', () => {
  it('parses the ISO-8601 form requestQuestion writes', () => {
    expect(parseGateCreatedAtMs('2026-07-31T23:52:23.304Z')).toBe(
      Date.parse('2026-07-31T23:52:23.304Z'),
    );
  });

  it("reads SQLite's CURRENT_TIMESTAMP default as UTC, not host-local", () => {
    // Migration 010 defaults created_at to CURRENT_TIMESTAMP, which renders as
    // 'YYYY-MM-DD HH:MM:SS' with no zone marker. A bare Date.parse would treat
    // it as local time and skew every age by the host's UTC offset.
    expect(parseGateCreatedAtMs('2026-07-31 23:52:23')).toBe(
      Date.parse('2026-07-31T23:52:23Z'),
    );
  });

  it('returns null for missing or unparseable values', () => {
    expect(parseGateCreatedAtMs(null)).toBeNull();
    expect(parseGateCreatedAtMs(undefined)).toBeNull();
    expect(parseGateCreatedAtMs('')).toBeNull();
    expect(parseGateCreatedAtMs(1234)).toBeNull();
    expect(parseGateCreatedAtMs('not-a-date')).toBeNull();
  });
});

describe('bucketGateAgeSeconds', () => {
  it('isolates the 600s PreToolUse hook-timeout window in its own bucket', () => {
    // The whole point of the bucketing: if the standing 600s-hook-timeout
    // hypothesis holds, occurrences cluster here and nowhere else.
    expect(bucketGateAgeSeconds(540)).toBe('540-660s');
    expect(bucketGateAgeSeconds(600)).toBe('540-660s');
    expect(bucketGateAgeSeconds(660)).toBe('540-660s');
    // Just outside, on both sides.
    expect(bucketGateAgeSeconds(539.9)).toBe('300-540s');
    expect(bucketGateAgeSeconds(660.1)).toBe('660-1800s');
  });

  it('covers the range with a bounded vocabulary', () => {
    expect(bucketGateAgeSeconds(0)).toBe('<60s');
    expect(bucketGateAgeSeconds(59)).toBe('<60s');
    expect(bucketGateAgeSeconds(60)).toBe('60-300s');
    expect(bucketGateAgeSeconds(299)).toBe('60-300s');
    expect(bucketGateAgeSeconds(300)).toBe('300-540s');
    expect(bucketGateAgeSeconds(1799)).toBe('660-1800s');
    expect(bucketGateAgeSeconds(1800)).toBe('>1800s');
    expect(bucketGateAgeSeconds(86_400)).toBe('>1800s');
  });
});

describe('bucketPriorGateCount', () => {
  it('collapses the tail so the tag stays bounded', () => {
    expect(bucketPriorGateCount(0)).toBe('0');
    expect(bucketPriorGateCount(1)).toBe('1');
    expect(bucketPriorGateCount(2)).toBe('2');
    expect(bucketPriorGateCount(3)).toBe('3+');
    expect(bucketPriorGateCount(97)).toBe('3+');
  });
});

describe('buildSelfHealTags', () => {
  const NOW = Date.parse('2026-07-31T23:52:23.000Z');
  const agoIso = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

  it('classifies an orphan sweep (DB rows, no in-memory entry)', () => {
    expect(buildSelfHealTags([agoIso(600)], 0, NOW)).toEqual({
      healSource: 'orphan-sweep',
      priorGateCount: '1',
      priorGateAge: '540-660s',
    });
  });

  it('classifies a live in-memory entry', () => {
    expect(buildSelfHealTags([agoIso(12)], 1, NOW)).toEqual({
      healSource: 'in-memory',
      priorGateCount: '1',
      priorGateAge: '<60s',
    });
  });

  it('classifies a mixed heal (one tracked entry + one orphan row)', () => {
    expect(buildSelfHealTags([agoIso(30), agoIso(900)], 1, NOW)).toEqual({
      healSource: 'mixed',
      priorGateCount: '2',
      // Dated by the OLDEST wedged gate — that is when the run actually stuck.
      priorGateAge: '660-1800s',
    });
  });

  it('reports the no-surviving-gate shape distinctly', () => {
    // awaiting_input with no pending question row: the wedge was in the run
    // status, not in a gate. Must not read as an ordinary 0-second heal.
    expect(buildSelfHealTags([], 0, NOW)).toEqual({
      healSource: 'none',
      priorGateCount: '0',
      priorGateAge: 'none',
    });
  });

  it('degrades to unknown rather than a bogus age when created_at is unparseable', () => {
    expect(buildSelfHealTags(['garbage'], 0, NOW)).toEqual({
      healSource: 'orphan-sweep',
      priorGateCount: '1',
      priorGateAge: 'unknown',
    });
  });

  it('never emits a negative age from a future-dated row', () => {
    expect(buildSelfHealTags([agoIso(-5000)], 0, NOW).priorGateAge).toBe('<60s');
  });
});

// ---------------------------------------------------------------------------
// End-to-end through requestQuestion's self-heal branch
// ---------------------------------------------------------------------------

describe('requestQuestion self-heal beacon', () => {
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
    db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p-diag');
    const migDir = join(__dirname, '..', '..', 'database', 'migrations');
    for (const f of [
      '006_cyboflow_schema.sql',
      '007_add_stuck_reason.sql',
      '010_questions.sql',
      '011_workflow_step_tracking.sql',
      '014_native_tasks.sql',
      '015_entity_model_rebuild.sql',
      '016_review_items.sql',
      '085_review_item_audience.sql',
      '017_run_seed_idea.sql',
    ]) {
      db.exec(readFileSync(join(migDir, f), 'utf-8'));
    }
    return db;
  }

  const QUESTIONS: QuestionPayload[] = [
    { question: 'Which path?', header: 'Path', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
  ];

  function seedRun(db: Database.Database, runId: string, status: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-d', 1, 'planner', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, 'wf-d', 1, ?)`,
    ).run(runId, status);
  }

  /** The single gate-hook-timeout beacon, or undefined if none fired. */
  function beacon() {
    const call = emitSeamErrorMock.mock.calls.find((c) => c[0] === 'gate-hook-timeout');
    if (!call) return undefined;
    return { error: call[1] as Error, tags: call[2] as Record<string, string> };
  }

  beforeEach(() => {
    emitSeamErrorMock.mockClear();
  });

  afterEach(() => {
    QuestionRouter._resetForTesting();
  });

  it('does NOT fire on the ordinary path (a running run opening its first gate)', async () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    seedRun(db, 'run-diag-0', 'running');

    void router.requestQuestion('run-diag-0', 'tool-diag-0', QUESTIONS, vi.fn());
    await router['getQuestionQueue']('run-diag-0').onIdle();

    expect(beacon()).toBeUndefined();
  });

  it('tags an orphan-swept 600s-old gate with the hook-timeout age bucket', async () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    const runId = 'run-diag-1';

    // A run wedged by a PREVIOUS process: awaiting_input + a pending question
    // row aged into the 600s PreToolUse hook-timeout window, no in-memory entry.
    seedRun(db, runId, 'awaiting_input');
    db.prepare(
      `INSERT INTO questions (id, run_id, tool_use_id, questions_json, status, created_at)
       VALUES ('orphan-q-1', ?, 'orphan-tool-1', '[]', 'pending', ?)`,
    ).run(runId, new Date(Date.now() - 600_000).toISOString());

    void router.requestQuestion(runId, 'tool-diag-1', QUESTIONS, vi.fn());
    await router['getQuestionQueue'](runId).onIdle();

    const fired = beacon();
    expect(fired).toBeDefined();
    expect(fired!.tags).toMatchObject({
      gateKind: 'question',
      errorClass: 'gate-hook-timeout',
      healSource: 'orphan-sweep',
      priorGateCount: '1',
      priorGateAge: '540-660s',
    });
  });

  it('tags a live in-memory gate as in-memory, and keeps the message constant + cause-free', async () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    const runId = 'run-diag-2';
    seedRun(db, runId, 'running');

    // Gate #1 opens normally (no beacon), then gate #2 supersedes it.
    void router.requestQuestion(runId, 'tool-diag-2a', QUESTIONS, vi.fn());
    await router['getQuestionQueue'](runId).onIdle();
    expect(beacon()).toBeUndefined();

    void router.requestQuestion(runId, 'tool-diag-2b', QUESTIONS, vi.fn());
    await router['getQuestionQueue'](runId).onIdle();

    const fired = beacon();
    expect(fired).toBeDefined();
    expect(fired!.tags).toMatchObject({
      healSource: 'in-memory',
      priorGateCount: '1',
      priorGateAge: '<60s',
    });

    // The message is Sentry's grouping key: it must carry no varying detail and
    // must not assert a cause the code cannot actually observe.
    expect(fired!.error.message).toBe(
      'AskUserQuestion gate self-heal: a prior gate was wedged at awaiting_input',
    );
    expect(fired!.error.message).not.toMatch(/600s|PreToolUse|likely/);
  });

  it('reports healSource=none when the run is wedged with no surviving gate row', async () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    const runId = 'run-diag-3';
    // awaiting_input, but nothing pending — the status itself is the wedge.
    seedRun(db, runId, 'awaiting_input');

    void router.requestQuestion(runId, 'tool-diag-3', QUESTIONS, vi.fn());
    await router['getQuestionQueue'](runId).onIdle();

    expect(beacon()!.tags).toMatchObject({
      healSource: 'none',
      priorGateCount: '0',
      priorGateAge: 'none',
    });
  });

  it('emits only bounded, non-identifying tag values', async () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    const runId = 'run-diag-4';
    seedRun(db, runId, 'awaiting_input');
    db.prepare(
      `INSERT INTO questions (id, run_id, tool_use_id, questions_json, status, created_at)
       VALUES ('orphan-q-4', ?, 'orphan-tool-4', '[]', 'pending', ?)`,
    ).run(runId, new Date().toISOString());

    void router.requestQuestion(runId, 'tool-diag-4', QUESTIONS, vi.fn());
    await router['getQuestionQueue'](runId).onIdle();

    const tags = beacon()!.tags;
    // No run id, question id, or tool_use_id may reach Sentry tags.
    const values = Object.values(tags).join('|');
    expect(values).not.toContain(runId);
    expect(values).not.toContain('orphan-q-4');
    expect(values).not.toContain('orphan-tool-4');

    // Every value comes from a fixed vocabulary.
    expect(['none', 'in-memory', 'orphan-sweep', 'mixed']).toContain(tags.healSource);
    expect(['0', '1', '2', '3+']).toContain(tags.priorGateCount);
    expect(
      ['none', 'unknown', '<60s', '60-300s', '300-540s', '540-660s', '660-1800s', '>1800s'],
    ).toContain(tags.priorGateAge);
  });
});
