/**
 * Migration 126_variant_tuning_level.sql — scoping A/B variants (and their
 * rotation experiments) to a TUNING LEVEL.
 *
 * Mirrors migration124.test.ts's two-boot real-upgrade-path pattern: a DB is
 * migrated by a DatabaseService whose migrations dir stops BEFORE 126, rows are
 * seeded in the pre-126 shape, then a second DatabaseService pointed at the full
 * dir boots on the same file — exactly what happens when a user updates the app.
 *
 * Three things are load-bearing here and nothing else in the suite covers them:
 *
 *   (a) the BACKFILL attributes an existing variant to the level its parent flow
 *       is stamped with — but ONLY for a built-in flow. A "save as new" custom
 *       flow is outside the level system (its runs stamp NULL), so its variants
 *       must stay NULL or they would silently drop out of every launch's pool;
 *   (b) label uniqueness moves from (workflow, label) to (workflow, LEVEL,
 *       label) — and the NULL level must still be ONE bucket, not a bucket per
 *       row, which is what SQLite's every-NULL-is-distinct rule would give a
 *       naive index;
 *   (c) a rotation experiment inherits the level of its own arm snapshot, so the
 *       reconcile chokepoint keeps finding the rotation it opened.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_126 = '126_variant_tuning_level.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration126-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration BEFORE 126 — i.e. the pre-126 app. */
function migrationsDirBefore126(): string {
  const dir = join(tmpDir, 'migrations-pre-126');
  mkdirSync(dir);
  const cutoff = Number(MIGRATION_126.slice(0, 3));
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (!/^\d{3}_.*\.sql$/.test(name)) continue;
    if (Number(name.slice(0, 3)) >= cutoff) continue;
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

function openAt(migrationsDir: string): DatabaseService {
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(migrationsDir);
  svc.initialize();
  return svc;
}

/** Seed one GLOBAL workflow row (project_id NULL) so no `projects` row is needed. */
function seedWorkflow(db: Database.Database, id: string, name: string, specJson: string): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json, workflow_path, permission_mode)
     VALUES (?, NULL, ?, ?, NULL, 'default')`,
  ).run(id, name, specJson);
}

function seedVariant(db: Database.Database, id: string, workflowId: string, label: string): void {
  db.prepare(
    "INSERT INTO workflow_variants (id, workflow_id, label, spec_json) VALUES (?, ?, ?, '{}')",
  ).run(id, workflowId, label);
}

function variantLevel(db: Database.Database, id: string): string | null {
  return (
    db.prepare('SELECT tuning_level FROM workflow_variants WHERE id = ?').get(id) as {
      tuning_level: string | null;
    }
  ).tuning_level;
}

describe('Migration 126: variant tuning level', () => {
  it('(a) backfills a BUILT-IN flow’s variants to its level and leaves a custom flow’s at NULL', () => {
    const pre = openAt(migrationsDirBefore126());
    const preDb = pre.getDb();
    expect(
      (preDb.prepare('PRAGMA table_info(workflow_variants)').all() as Array<{ name: string }>).some(
        (c) => c.name === 'tuning_level',
      ),
    ).toBe(false);

    // A built-in parked on a NON-default level: its variants were snapshotted
    // from that level's graph, so that is what they challenge.
    seedWorkflow(preDb, 'wf-sprint', 'sprint', '{}');
    preDb.prepare("UPDATE workflows SET tuning_level = 'thorough' WHERE id = 'wf-sprint'").run();
    seedVariant(preDb, 'wfv_sprint', 'wf-sprint', 'challenger');

    // A built-in on the default level.
    seedWorkflow(preDb, 'wf-planner', 'planner', '{}');
    seedVariant(preDb, 'wfv_planner', 'wf-planner', 'challenger');

    // A "save as new" flow. Migration 124 stamped it 'custom' (it has a spec),
    // but it is outside the level system — copying that stamp onto its variants
    // would take them out of every launch's pool, since its runs stamp NULL.
    seedWorkflow(preDb, 'wf-mine', 'my-flow', '{"id":"x","phases":[]}');
    seedVariant(preDb, 'wfv_mine', 'wf-mine', 'challenger');
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    expect(variantLevel(db, 'wfv_sprint')).toBe('thorough');
    expect(variantLevel(db, 'wfv_planner')).toBe('standard');
    expect(variantLevel(db, 'wfv_mine')).toBeNull();

    svc.close();
  });

  it('(b) label uniqueness is per (workflow, level), with all NULL levels in ONE bucket', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedWorkflow(db, 'wf-sprint', 'sprint', '{}');

    const insert = (id: string, label: string, level: string | null): void => {
      db.prepare(
        'INSERT INTO workflow_variants (id, workflow_id, label, spec_json, tuning_level) VALUES (?, ?, ?, ?, ?)',
      ).run(id, 'wf-sprint', label, '{}', level);
    };

    // Same label at two different levels is now legal — they are challengers of
    // different configurations that happen to share a name.
    insert('wfv_a', 'aggressive', 'standard');
    expect(() => insert('wfv_b', 'aggressive', 'thorough')).not.toThrow();
    // ...but not twice at the SAME level.
    expect(() => insert('wfv_c', 'aggressive', 'standard')).toThrow(/UNIQUE constraint failed/i);

    // NULL is a level, not an absence: two NULL-level rows with one label must
    // collide (SQLite would treat the bare column as distinct-per-NULL, which is
    // why the index coalesces).
    insert('wfv_d', 'flow-scoped', null);
    expect(() => insert('wfv_e', 'flow-scoped', null)).toThrow(/UNIQUE constraint failed/i);

    svc.close();
  });

  it('(c) a rotation experiment inherits the level of its arm snapshot; side-by-side stays NULL', () => {
    const pre = openAt(migrationsDirBefore126());
    const preDb = pre.getDb();
    seedWorkflow(preDb, 'wf-sprint', 'sprint', '{}');
    preDb.prepare("UPDATE workflows SET tuning_level = 'efficient' WHERE id = 'wf-sprint'").run();
    seedVariant(preDb, 'wfv_a', 'wf-sprint', 'a');
    seedVariant(preDb, 'wfv_b', 'wf-sprint', 'b');

    preDb
      .prepare(
        `INSERT INTO experiments (id, project_id, workflow_id, kind, base_branch, base_sha,
           variant_a_id, variant_b_id, status)
         VALUES ('exp_rot', NULL, 'wf-sprint', 'rotation', NULL, NULL, NULL, NULL, 'running')`,
      )
      .run();
    // The BASELINE arm has no workflow_variants row, so only the real arm can
    // supply the level — the join must not be confused by the sentinel.
    for (const [variantId, label] of [
      ['__baseline__', 'Baseline'],
      ['wfv_a', 'a'],
    ]) {
      preDb
        .prepare(
          'INSERT INTO experiment_rotation_arms (experiment_id, variant_id, label, weight_at_open) VALUES (?, ?, ?, 1)',
        )
        .run('exp_rot', variantId, label);
    }

    preDb
      .prepare(
        `INSERT INTO experiments (id, project_id, workflow_id, kind, base_branch, base_sha,
           variant_a_id, variant_b_id, status)
         VALUES ('exp_sbs', 1, 'wf-sprint', 'side_by_side', 'main', 'sha0', 'wfv_a', 'wfv_b', 'running')`,
      )
      .run();
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    const levelOfExp = (id: string): string | null =>
      (db.prepare('SELECT tuning_level FROM experiments WHERE id = ?').get(id) as {
        tuning_level: string | null;
      }).tuning_level;

    expect(levelOfExp('exp_rot')).toBe('efficient');
    // A head-to-head is not a pool; it pins its two arms explicitly.
    expect(levelOfExp('exp_sbs')).toBeNull();

    svc.close();
  });

  it('(d) both new columns are nullable and reject a bogus level', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedWorkflow(db, 'wf-sprint', 'sprint', '{}');
    seedVariant(db, 'wfv_x', 'wf-sprint', 'x');

    expect(variantLevel(db, 'wfv_x')).toBeNull();
    for (const level of ['efficient', 'standard', 'thorough', 'custom']) {
      expect(
        () =>
          db.prepare('UPDATE workflow_variants SET tuning_level = ? WHERE id = ?').run(level, 'wfv_x'),
        `level='${level}'`,
      ).not.toThrow();
    }
    expect(() =>
      db.prepare('UPDATE workflow_variants SET tuning_level = ? WHERE id = ?').run('turbo', 'wfv_x'),
    ).toThrow(/CHECK constraint failed/i);

    svc.close();
  });
});
