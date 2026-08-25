/**
 * The efficient sprint preset ADAPTS THE LANE MACHINERY — end to end from the
 * frozen spec (migration 122 / plan D1 + phase 3).
 *
 * The efficient calibration collapses the five-stage lane to implement ->
 * task-verify by removing three inner steps. Nothing in the lane machinery is
 * told about tuning levels: both seams derive their vocabulary from the run's
 * FROZEN definition, so the collapse has to fall out of the materialized spec
 * alone. That is exactly what this file proves, over the REAL preset output
 * rather than a hand-written stand-in — a recalibration that broke the chain
 * would trip here:
 *
 *   1. `resolveRunFanOutInner` (the orchestrated-plane vocabulary) returns the
 *      collapsed chain, with task-verify's `loopback: 'implement'` intact — a
 *      dangling loopback would be rejected by the write-path schema and would
 *      send both execution planes to a step that is not there.
 *   2. `cyboflow_update_sprint_task`'s `current_step` validation — the exact two
 *      lines `mcpQueryHandler.handleUpdateSprintTask` runs to build
 *      `allowedStepIds`, then `SprintLaneStore.updateLane` — ACCEPTS the two
 *      surviving ids and REJECTS `write-tests`, which no longer exists on this
 *      run. (The MCP handler itself is a socket seam; the validation it delegates
 *      to is reproduced here verbatim.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRunFanOutInner } from '../laneChainResolution';
import { SprintLaneStore, SprintLaneError } from '../sprintLaneStore';
import { computeSpecHash } from '../specHash';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';
import { AWAITING_VERIFY_STEP } from '../../../../shared/types/sprintBatch';
import { applyTuningPreset, serializeDefinition } from '../../../../shared/tuning/workflowTuning';

/** The spec text an efficient sprint run freezes at createRun. */
const EFFICIENT_SPRINT_SPEC = serializeDefinition(
  applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'efficient'),
);

const RUN_ID = 'run-efficient';
const WF_ID = 'wf-sprint';
const BATCH_ID = 'batch-1';
const TASK_ID = 'task-1';

/**
 * Migration-backed DB (the sprintLaneStore.test.ts chain) plus the frozen-spec
 * surface `resolveRunFanOutInner` reads: a workflows row, a run stamped with a
 * spec_hash, and the workflow_revisions row that resolves it.
 */
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

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const file of [
    '006_cyboflow_schema.sql',
    '011_workflow_step_tracking.sql',
    '014_native_tasks.sql',
    '015_entity_model_rebuild.sql',
    '022_sprint_batches.sql',
    '023_sprint_lane_step.sql',
    '025_sprint_lane_attempts.sql',
  ]) {
    db.exec(readFileSync(join(migDir, file), 'utf-8'));
  }
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec(`
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, UNIQUE (workflow_id, spec_hash)
    );
  `);

  const specHash = computeSpecHash(EFFICIENT_SPRINT_SPEC);
  // The workflow row's own slot stays EMPTY — the dial never writes it. The
  // preset graph exists only as this run's frozen revision, which is precisely
  // what the two seams below have to resolve through.
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'sprint', '{}')").run(WF_ID);
  db.prepare(
    "INSERT INTO workflow_runs (id, workflow_id, project_id, status, spec_hash) VALUES (?, ?, 1, 'running', ?)",
  ).run(RUN_ID, WF_ID, specHash);
  db.prepare(
    'INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES (?, ?, ?)',
  ).run(WF_ID, specHash, EFFICIENT_SPRINT_SPEC);

  db.prepare(
    `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
     VALUES (?, 1, 'TASK-1', 'A task', 'board-1-default', 'stage-board-1-default-5')`,
  ).run(TASK_ID);

  // The batch + its one lane, inserted directly rather than through
  // createForRun: that entry point also runs the sprint ELIGIBILITY guard
  // (approved_at + board stage), which is a different contract from the lane
  // step vocabulary under test here.
  db.prepare(
    "INSERT INTO sprint_batches (id, project_id, substrate, status) VALUES (?, 1, 'sdk', 'running')",
  ).run(BATCH_ID);
  db.prepare('INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES (?, ?)').run(BATCH_ID, TASK_ID);
  db.prepare('UPDATE workflow_runs SET batch_id = ? WHERE id = ?').run(BATCH_ID, RUN_ID);
  return db;
}

let db: Database.Database;
let store: SprintLaneStore;

beforeEach(() => {
  db = buildDb();
  store = SprintLaneStore.initialize(dbAdapter(db));
});

afterEach(() => {
  db.close();
});

/** The two lines mcpQueryHandler.handleUpdateSprintTask runs to build the vocabulary. */
function allowedStepIdsForRun(runId: string): readonly string[] | undefined {
  const inner = resolveRunFanOutInner(dbAdapter(db), runId);
  return inner ? [...inner.map((s) => s.id), AWAITING_VERIFY_STEP] : undefined;
}

describe('efficient sprint — lane chain adaptation', () => {
  it('the built-in chain this preset narrows is the full five-stage lane', () => {
    // Anchors the delta. Without it, a preset that silently stopped removing
    // anything could still satisfy the assertions below if the BUILT-IN were the
    // thing that changed — the collapse would then be measured against itself.
    const builtInChain = WORKFLOW_DEFINITIONS.sprint.phases
      .flatMap((phase) => phase.steps)
      .flatMap((step) => step.fanOut?.inner ?? [])
      .map((inner) => inner.id);
    expect(builtInChain).toEqual([
      'implement',
      'write-tests',
      'code-review',
      'task-verify',
      'visual-verify',
    ]);
  });

  it('resolveRunFanOutInner returns the collapsed chain over the frozen preset spec', () => {
    const inner = resolveRunFanOutInner(dbAdapter(db), RUN_ID);
    expect(inner?.map((s) => s.id)).toEqual(['implement', 'task-verify']);
    // The surviving loopback still points at a step that exists.
    expect(inner?.find((s) => s.id === 'task-verify')?.loopback).toBe('implement');
  });

  it('the lane write ACCEPTS a surviving step id', () => {
    const lane = store.updateLane({
      runId: RUN_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      currentStepId: 'task-verify',
      ...(allowedStepIdsForRun(RUN_ID) !== undefined
        ? { allowedStepIds: allowedStepIdsForRun(RUN_ID) }
        : {}),
    });
    expect(lane.currentStepId).toBe('task-verify');
  });

  it("the lane write REJECTS 'write-tests' — the preset removed it from this run", () => {
    let thrown: unknown;
    try {
      store.updateLane({
        runId: RUN_ID,
        batchId: BATCH_ID,
        taskId: TASK_ID,
        currentStepId: 'write-tests',
        ...(allowedStepIdsForRun(RUN_ID) !== undefined
          ? { allowedStepIds: allowedStepIdsForRun(RUN_ID) }
          : {}),
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SprintLaneError);
    expect((thrown as SprintLaneError).code).toBe('bad_request');
    expect((thrown as SprintLaneError).message).toContain("unknown lane step 'write-tests'");
  });

  it('the merge-gate park step stays writable alongside the collapsed chain', () => {
    const lane = store.updateLane({
      runId: RUN_ID,
      batchId: BATCH_ID,
      taskId: TASK_ID,
      currentStepId: AWAITING_VERIFY_STEP,
      ...(allowedStepIdsForRun(RUN_ID) !== undefined
        ? { allowedStepIds: allowedStepIdsForRun(RUN_ID) }
        : {}),
    });
    expect(lane.currentStepId).toBe(AWAITING_VERIFY_STEP);
  });
});
