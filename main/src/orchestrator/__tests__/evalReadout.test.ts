/**
 * selectEvalReadout — the agent-facing eval verdict.
 *
 * The gap it closes: the jury's reasoning lives in `run_evals.per_sample_json`,
 * which no run-scope tool read, while `review_items` carried only the net-new /
 * catastrophic slice and (for an automatic eval) no score at all. These pin the
 * merge, the cross-link — including the null that marks a finding the queue
 * never got — and the fail-soft paths.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { selectEvalReadout, MAX_READOUT_ROWS } from '../evalReadout';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

function buildDb(withReviewItems = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE run_evals (
      run_id TEXT NOT NULL,
      rubric_version TEXT NOT NULL,
      eval_status TEXT NOT NULL DEFAULT 'pending',
      origin TEXT,
      snapshot_at TEXT,
      human_influenced INTEGER NOT NULL DEFAULT 0,
      overall_score INTEGER,
      band TEXT,
      ci_low REAL,
      ci_high REAL,
      sample_count INTEGER,
      judge_model TEXT,
      gated INTEGER NOT NULL DEFAULT 0,
      security_flag INTEGER NOT NULL DEFAULT 0,
      requirements_unmet INTEGER NOT NULL DEFAULT 0,
      cap_triggers_json TEXT,
      dimensions_json TEXT,
      per_sample_json TEXT,
      error TEXT,
      PRIMARY KEY (run_id, rubric_version)
    );
  `);
  if (withReviewItems) {
    db.exec(`
      CREATE TABLE review_items (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        kind TEXT,
        status TEXT,
        title TEXT,
        source TEXT
      );
    `);
  }
  return db;
}

interface EvalSeed {
  runId?: string;
  humanInfluenced?: number;
  snapshotAt?: string;
  perSample?: unknown;
  score?: number | null;
  origin?: string | null;
  capTriggers?: unknown;
}

function seedEval(db: Database.Database, opts: EvalSeed = {}): void {
  db.prepare(
    `INSERT INTO run_evals
       (run_id, rubric_version, eval_status, origin, snapshot_at, human_influenced,
        overall_score, band, ci_low, ci_high, sample_count, judge_model, gated,
        security_flag, requirements_unmet, cap_triggers_json, dimensions_json, per_sample_json)
     VALUES (?, '1.1', 'complete', ?, ?, ?, ?, 'Fair', 60.5, 71.2, 3, 'opus', 0, 1, 0, ?, ?, ?)`,
  ).run(
    opts.runId ?? 'run-flow',
    opts.origin ?? null,
    opts.snapshotAt ?? '2026-08-26T10:00:00Z',
    opts.humanInfluenced ?? 0,
    opts.score === undefined ? 66 : opts.score,
    JSON.stringify(opts.capTriggers ?? ['SEC-2']),
    JSON.stringify([{ key: 'security', name: 'Security', score: 40, active: true }]),
    opts.perSample === undefined ? null : JSON.stringify(opts.perSample),
  );
}

function seedReviewItem(
  db: Database.Database,
  opts: { id: string; runId: string; title: string; status?: string; source?: string },
): void {
  db.prepare(
    `INSERT INTO review_items (id, run_id, kind, status, title, source)
     VALUES (?, ?, 'finding', ?, ?, ?)`,
  ).run(opts.id, opts.runId, opts.status ?? 'pending', opts.title, opts.source ?? 'agent:eval');
}

describe('selectEvalReadout', () => {
  it('returns the rollup the review queue never carries for an automatic eval', () => {
    const db = buildDb();
    // origin NULL = the automatic / A-B eval, the one that writes no summary
    // review item at all — so this rollup exists nowhere else an agent can see.
    seedEval(db, { origin: null });

    const readout = selectEvalReadout(dbAdapter(db), 'run-flow')!;
    expect(readout).toMatchObject({
      runId: 'run-flow',
      evalStatus: 'complete',
      origin: null,
      overallScore: 66,
      band: 'Fair',
      ciLow: 60.5,
      ciHigh: 71.2,
      sampleCount: 3,
      securityFlag: true,
      requirementsUnmet: false,
      capTriggers: ['SEC-2'],
    });
    expect(readout.dimensions).toEqual([
      { key: 'security', name: 'Security', score: 40, active: true },
    ]);
  });

  it('merges findings across jury samples, counting votes and catastrophic votes', () => {
    const db = buildDb();
    seedEval(db, {
      perSample: [
        {
          verdicts: [],
          findings: [
            { subCheckId: 'SEC-2', dimension: 'security', severity: 'error', title: 'SQL injection', body: 'b', file: 'a.ts', line: 9, catastrophic: true },
            { subCheckId: '', dimension: 'style', severity: 'info', title: 'Naming nit', body: 'n', catastrophic: false },
          ],
        },
        {
          verdicts: [],
          findings: [
            // Same sub-check + file → one merged row with two votes.
            { subCheckId: 'SEC-2', dimension: 'security', severity: 'error', title: 'SQL injection (paraphrased)', body: 'b2', file: 'a.ts', catastrophic: true },
          ],
        },
      ],
    });

    const { findings } = selectEvalReadout(dbAdapter(db), 'run-flow')!;
    // Catastrophic-first ordering, so a cap trims the least important tail.
    expect(findings.map((f) => f.title)).toEqual(['SQL injection', 'Naming nit']);
    expect(findings[0]).toMatchObject({
      subCheckId: 'SEC-2',
      dimension: 'security',
      file: 'a.ts',
      line: 9,
      votes: 2,
      catastrophicVotes: 2,
    });
    expect(findings[1]).toMatchObject({ subCheckId: null, votes: 1, catastrophicVotes: 0 });
  });

  it('surfaces the sub-checks the jury FAILED, with evidence and vote counts', () => {
    const db = buildDb();
    seedEval(db, {
      perSample: [
        {
          verdicts: [
            { id: 'COR-2', verdict: 'FAIL', evidence: 'the guard is inverted' },
            { id: 'SEC-1', verdict: 'PASS', evidence: '' },
            { id: 'ROB-3', verdict: 'FAIL', evidence: 'no rollback' },
          ],
          findings: [],
        },
        {
          verdicts: [
            { id: 'COR-2', verdict: 'FAIL', evidence: 'same, restated' },
            { id: 'SEC-1', verdict: 'PASS', evidence: '' },
            { id: 'ROB-3', verdict: 'PASS', evidence: '' },
          ],
          findings: [],
        },
      ],
    });

    const { failedSubChecks } = selectEvalReadout(dbAdapter(db), 'run-flow')!;
    // Only FAILs, most-failed first; PASS-only sub-checks never appear.
    expect(failedSubChecks).toEqual([
      { id: 'COR-2', failVotes: 2, votes: 2, evidence: 'the guard is inverted' },
      { id: 'ROB-3', failVotes: 1, votes: 2, evidence: 'no rollback' },
    ]);
  });

  it('cross-links a filed finding and leaves the capped-out one null', () => {
    // The null is the point: a finding the worker deduped or dropped under
    // MAX_FINDINGS_PER_EVAL exists ONLY here.
    const db = buildDb();
    seedEval(db, {
      perSample: [
        {
          verdicts: [],
          findings: [
            { subCheckId: 'SEC-2', title: 'Filed one', body: 'b', catastrophic: true },
            { subCheckId: 'STY-1', title: 'Dropped by the cap', body: 'b', catastrophic: false },
          ],
        },
      ],
    });
    seedReviewItem(db, { id: 'ri_1', runId: 'run-flow', title: 'Filed one', status: 'pending' });

    const byTitle = new Map(
      selectEvalReadout(dbAdapter(db), 'run-flow')!.findings.map((f) => [f.title, f]),
    );
    expect(byTitle.get('Filed one')).toMatchObject({
      reviewItemId: 'ri_1',
      reviewItemStatus: 'pending',
    });
    expect(byTitle.get('Dropped by the cap')).toMatchObject({
      reviewItemId: null,
      reviewItemStatus: null,
    });
  });

  it("links against an in-flow reviewer's item too, not just source 'agent:eval'", () => {
    // EvalWorker dedups a jury finding against a code-review item and then
    // writes no row of its own, so the representing item carries that source.
    const db = buildDb();
    seedEval(db, {
      perSample: [{ verdicts: [], findings: [{ subCheckId: 'COR-1', title: 'Off-by-one', body: 'b' }] }],
    });
    seedReviewItem(db, {
      id: 'ri_cr',
      runId: 'run-flow',
      title: 'Off-by-one',
      source: 'agent:code-review',
    });

    expect(selectEvalReadout(dbAdapter(db), 'run-flow')!.findings[0].reviewItemId).toBe('ri_cr');
  });

  it('prefers the pristine pre-human snapshot, matching getRunEval', () => {
    const db = buildDb();
    // Inserted influenced-first so row order cannot be what selects the winner.
    seedEval(db, { humanInfluenced: 1, snapshotAt: '2026-08-26T09:00:00Z', score: 90 });
    db.prepare(
      `INSERT INTO run_evals (run_id, rubric_version, eval_status, snapshot_at, human_influenced, overall_score)
       VALUES ('run-flow', '1.0', 'complete', '2026-08-26T11:00:00Z', 0, 55)`,
    ).run();

    expect(selectEvalReadout(dbAdapter(db), 'run-flow')!.overallScore).toBe(55);
  });

  it('reports truncation rather than silently shortening the list', () => {
    const db = buildDb();
    const findings = Array.from({ length: MAX_READOUT_ROWS + 5 }, (_, i) => ({
      subCheckId: `X-${i}`,
      title: `finding ${i}`,
      body: 'b',
    }));
    seedEval(db, { perSample: [{ verdicts: [], findings }] });

    const readout = selectEvalReadout(dbAdapter(db), 'run-flow')!;
    expect(readout.findings).toHaveLength(MAX_READOUT_ROWS);
    expect(readout.truncated).toBe(true);
  });

  // ── Fail-soft paths ──────────────────────────────────────────────────────

  it('returns null for a run that was never graded', () => {
    expect(selectEvalReadout(dbAdapter(buildDb()), 'run-ungraded')).toBeNull();
  });

  it('returns null when there is no run_evals table (pre-043 DB)', () => {
    expect(selectEvalReadout(dbAdapter(new Database(':memory:')), 'run-flow')).toBeNull();
  });

  it('still returns the verdict when per_sample_json is absent or malformed', () => {
    const db = buildDb();
    seedEval(db, { perSample: undefined });
    db.prepare(`UPDATE run_evals SET per_sample_json = 'not json'`).run();

    const readout = selectEvalReadout(dbAdapter(db), 'run-flow')!;
    expect(readout.overallScore).toBe(66);
    expect(readout.findings).toEqual([]);
    expect(readout.failedSubChecks).toEqual([]);
    expect(readout.truncated).toBe(false);
  });

  it('leaves links null when there is no review_items table at all', () => {
    const db = buildDb(false);
    seedEval(db, { perSample: [{ verdicts: [], findings: [{ title: 'A thing', body: 'b' }] }] });

    expect(selectEvalReadout(dbAdapter(db), 'run-flow')!.findings[0].reviewItemId).toBeNull();
  });
});
