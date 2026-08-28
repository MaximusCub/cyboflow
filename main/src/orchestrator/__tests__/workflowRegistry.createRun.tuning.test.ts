/**
 * WorkflowRegistry.createRun × tuning levels (migration 122 / plan D1, D4, D6).
 *
 * The dial is a read-time concept everywhere EXCEPT here: createRun is where a
 * level becomes a concrete frozen artifact — a `spec_json` text, its `spec_hash`,
 * a `workflow_revisions` row, and the `workflow_runs.tuning_level` stamp that
 * files the run under the level it actually ran. These tests pin that seam:
 *
 *   - standard freezes `'{}'` BYTE-FOR-BYTE, so a user who never touches the dial
 *     stamps the exact hash they always did (the whole zero-change promise);
 *   - a preset freezes its serialized transform AND leaves a revision row, which
 *     is the only place an efficient/thorough graph is ever written down — plan
 *     D4's restart has nothing to replay without it;
 *   - a variant wins the spec and voids the level stamp (a variant is its own
 *     definition; crediting a level to it would poison the estimate buckets);
 *   - the per-run override outranks the workflow's stamp but is refused for the
 *     shapes it cannot honestly mean (a variant pinned to ANOTHER level — since
 *     migration 126 a same-level pin is coherent and allowed — a bare variant
 *     spec with no level to compare, a non-built-in flow, an empty custom slot);
 *   - `evalDefault` supplies the eval default ONLY when the wizard pinned none.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { WorkflowRegistry } from '../workflowRegistry';
import { computeSpecHash } from '../specHash';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import { WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import {
  applyTuningPreset,
  serializeDefinition,
  type TuningLevel,
} from '../../../../shared/tuning/workflowTuning';
import { TUNING_OVERRIDE_CODE } from '../../../../shared/tuning/workflowTuningErrors';

const WF_SPRINT = 'wf-sprint';
const WF_PLANNER = 'wf-planner';
const WF_CUSTOM = 'wf-my-flow';
const SESSION = 'sess-1';

/** A structurally-valid definition distinguishable from any built-in graph. */
function editedDefinition(id: string): WorkflowDefinition {
  return {
    id,
    phases: [
      {
        id: 'p1',
        label: 'P1',
        color: '#3b6dd6',
        steps: [{ id: 's1', name: 'S1', agent: 'context', mcps: [], retries: 0 }],
      },
    ],
  };
}

const SLOT_SPEC = JSON.stringify(editedDefinition('slot-graph'));

function setupDb(): Database.Database {
  const db = createTestDb({ includeWorkflowRunTaskColumns: true, includeWorkflowArchivedAt: true });
  db.exec("ALTER TABLE workflow_runs ADD COLUMN substrate TEXT NOT NULL DEFAULT 'sdk'");
  db.exec('ALTER TABLE workflow_runs ADD COLUMN spec_hash TEXT');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
  db.exec(`
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(workflow_id, spec_hash)
    );
    -- Migration 126: an override + variant pin is now judged by the PINNED
    -- VARIANT'S LEVEL, so the guard reads this table.
    CREATE TABLE workflow_variants (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
      spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT,
      execution_model TEXT, agent_provider TEXT, agent_runtime TEXT,
      weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
      archived_at TEXT, tuning_level TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'sprint', '{}')").run(
    WF_SPRINT,
  );
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'planner', '{}')").run(
    WF_PLANNER,
  );
  // A "save as new" flow: no built-in baseline, so it sits outside the level
  // system entirely and its runs must stamp NULL.
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'my-flow', ?)").run(
    WF_CUSTOM,
    SLOT_SPEC,
  );
  return db;
}

let db: Database.Database;
let registry: WorkflowRegistry;

beforeEach(() => {
  db = setupDb();
  registry = new WorkflowRegistry(dbAdapter(db), makeSpyLogger());
});

/** The (spec_hash, tuning_level) pair a run froze. */
function frozenOf(runId: string): { specHash: string | null; level: string | null } {
  const row = db
    .prepare('SELECT spec_hash AS specHash, tuning_level AS level FROM workflow_runs WHERE id = ?')
    .get(runId) as { specHash: string | null; level: string | null };
  return row;
}

/** The revision text a run's frozen address resolves to, or undefined. */
function revisionOf(workflowId: string, specHash: string | null): string | undefined {
  if (specHash === null) return undefined;
  const row = db
    .prepare('SELECT spec_json AS specJson FROM workflow_revisions WHERE workflow_id = ? AND spec_hash = ?')
    .get(workflowId, specHash) as { specJson: string } | undefined;
  return row?.specJson;
}

function setLevel(workflowId: string, level: TuningLevel): void {
  db.prepare('UPDATE workflows SET tuning_level = ? WHERE id = ?').run(level, workflowId);
}

/** The exact spec text a preset level materializes for a built-in flow. */
function presetSpec(flow: 'sprint' | 'planner', level: 'efficient' | 'standard' | 'thorough'): string {
  return serializeDefinition(applyTuningPreset(WORKFLOW_DEFINITIONS[flow], flow, level));
}

// ---------------------------------------------------------------------------
// Materialization matrix
// ---------------------------------------------------------------------------

describe('createRun — materialization by level', () => {
  it('standard on a calibrated flow freezes the aligned-defaults pins as a resolvable revision', () => {
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const frozen = frozenOf(runId);
    const expected = presetSpec('sprint', 'standard');
    expect(frozen.specHash).toBe(computeSpecHash(expected));
    expect(frozen.level).toBe('standard');
    expect(revisionOf(WF_SPRINT, frozen.specHash)).toBe(expected);
  });

  it("standard ignores the custom slot even when it holds a definition", () => {
    // The slot is the CUSTOM level's storage, not standard's. Standard is the
    // built-in plus the aligned pins, so a flow parked there ignores whatever
    // the slot holds — exactly what the read path (getEffectiveDefinition) returns.
    db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?').run(SLOT_SPEC, WF_SPRINT);
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    expect(frozenOf(runId).specHash).toBe(computeSpecHash(presetSpec('sprint', 'standard')));
  });

  it('efficient freezes the serialized preset AND records it as a resolvable revision', () => {
    setLevel(WF_SPRINT, 'efficient');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const frozen = frozenOf(runId);
    const expected = presetSpec('sprint', 'efficient');

    expect(frozen.level).toBe('efficient');
    expect(frozen.specHash).toBe(computeSpecHash(expected));
    // The revision row is the ONLY written-down copy of a preset graph — the
    // dial never touches spec_json — so plan D4's restart depends on it.
    expect(revisionOf(WF_SPRINT, frozen.specHash)).toBe(expected);
    expect(frozen.specHash).not.toBe(computeSpecHash('{}'));
  });

  it('thorough freezes its own distinct preset spec', () => {
    setLevel(WF_PLANNER, 'thorough');
    const { runId } = registry.createRun(WF_PLANNER, undefined, SESSION);
    const frozen = frozenOf(runId);
    expect(frozen.level).toBe('thorough');
    expect(frozen.specHash).toBe(computeSpecHash(presetSpec('planner', 'thorough')));
  });

  it('two runs of the same flow at the same level share one revision row (idempotent)', () => {
    setLevel(WF_SPRINT, 'efficient');
    registry.createRun(WF_SPRINT, undefined, SESSION);
    registry.createRun(WF_SPRINT, undefined, SESSION);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM workflow_revisions WHERE workflow_id = ?')
      .get(WF_SPRINT) as { n: number };
    expect(count.n).toBe(1);
  });

  it('custom freezes the slot — today’s exact path', () => {
    db.prepare('UPDATE workflows SET spec_json = ?, tuning_level = ? WHERE id = ?').run(
      SLOT_SPEC,
      'custom',
      WF_SPRINT,
    );
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const frozen = frozenOf(runId);
    expect(frozen.level).toBe('custom');
    expect(frozen.specHash).toBe(computeSpecHash(SLOT_SPEC));
    expect(revisionOf(WF_SPRINT, frozen.specHash)).toBe(SLOT_SPEC);
  });

  it('a non-built-in flow keeps freezing its own spec and stamps NULL', () => {
    const { runId } = registry.createRun(WF_CUSTOM, undefined, SESSION);
    const frozen = frozenOf(runId);
    expect(frozen.specHash).toBe(computeSpecHash(SLOT_SPEC));
    expect(frozen.level).toBeNull();
  });

  it('a variant wins the spec and voids the level stamp', () => {
    setLevel(WF_SPRINT, 'efficient');
    const variantSpec = JSON.stringify(editedDefinition('variant-graph'));
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      variantId: 'wfv_1',
      variantLabel: 'arm-a',
      variantSpecJson: variantSpec,
    });
    const frozen = frozenOf(runId);
    expect(frozen.specHash).toBe(computeSpecHash(variantSpec));
    // NULL, not 'efficient': a variant is its own frozen definition, so
    // attributing a level to it would poison the per-level estimate buckets.
    expect(frozen.level).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-run override (plan D4)
// ---------------------------------------------------------------------------

describe('createRun — per-run tuning override', () => {
  it('an override outranks the workflow stamp without writing the workflows row', () => {
    setLevel(WF_SPRINT, 'standard');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      tuningLevel: 'efficient',
    });
    const frozen = frozenOf(runId);
    expect(frozen.level).toBe('efficient');
    expect(frozen.specHash).toBe(computeSpecHash(presetSpec('sprint', 'efficient')));
    // The dial itself is untouched — an override is for THIS run only.
    expect(registry.getById(WF_SPRINT)?.tuning_level).toBe('standard');
  });

  it('an override hashes identically to the same level applied persistently', () => {
    const { runId: overridden } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      tuningLevel: 'efficient',
    });
    setLevel(WF_SPRINT, 'efficient');
    const { runId: persistent } = registry.createRun(WF_SPRINT, undefined, SESSION);
    // Same hash ⇒ revision stats bucket coherently across both paths (D4).
    expect(frozenOf(overridden).specHash).toBe(frozenOf(persistent).specHash);
  });

  it('an override to standard runs a preset-stamped flow at the aligned defaults', () => {
    setLevel(WF_SPRINT, 'efficient');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      tuningLevel: 'standard',
    });
    const frozen = frozenOf(runId);
    expect(frozen.level).toBe('standard');
    expect(frozen.specHash).toBe(computeSpecHash(presetSpec('sprint', 'standard')));
  });

  /** Seed a variant of `WF_SPRINT` scoped to `level` (migration 126). */
  const seedVariant = (id: string, level: string | null): void => {
    db.prepare(
      "INSERT INTO workflow_variants (id, workflow_id, label, spec_json, tuning_level) VALUES (?, ?, ?, ?, ?)",
    ).run(id, WF_SPRINT, id, JSON.stringify(editedDefinition('variant-graph')), level);
  };

  it('rejects an override combined with a variant pinned to a DIFFERENT level', () => {
    seedVariant('wfv_std', 'standard');
    expect(() =>
      registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
        tuningLevel: 'efficient',
        variantId: 'wfv_std',
        variantSpecJson: JSON.stringify(editedDefinition('variant-graph')),
      }),
    ).toThrow(new RegExp(`${TUNING_OVERRIDE_CODE}:variant_conflict`));
    // Nothing was inserted — the guard runs before the INSERT transaction.
    const count = db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('ACCEPTS an override combined with a variant pinned to the SAME level', () => {
    // Migration 126's containment model: the level picks the pool, the pin picks
    // inside it. The variant's own frozen graph still wins for the spec, and the
    // run stays level-UNATTRIBUTED (its cost is the variant's, not the level's).
    seedVariant('wfv_eff', 'efficient');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      tuningLevel: 'efficient',
      variantId: 'wfv_eff',
      variantSpecJson: JSON.stringify(editedDefinition('variant-graph')),
    });
    expect(frozenOf(runId).level).toBeNull();
    expect(frozenOf(runId).specHash).toBe(
      computeSpecHash(JSON.stringify(editedDefinition('variant-graph'))),
    );
  });

  it('rejects an override combined with a bare variantSpecJson (no id, no level to compare)', () => {
    expect(() =>
      registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
        tuningLevel: 'efficient',
        variantSpecJson: JSON.stringify(editedDefinition('variant-graph')),
      }),
    ).toThrow(new RegExp(`${TUNING_OVERRIDE_CODE}:variant_conflict`));
  });

  it("rejects an override to 'custom' when the slot is empty", () => {
    expect(() =>
      registry.createRun(WF_SPRINT, undefined, SESSION, undefined, { tuningLevel: 'custom' }),
    ).toThrow(new RegExp(`${TUNING_OVERRIDE_CODE}:empty_custom_slot`));
  });

  it("accepts an override to 'custom' once the slot holds a definition", () => {
    db.prepare('UPDATE workflows SET spec_json = ? WHERE id = ?').run(SLOT_SPEC, WF_SPRINT);
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      tuningLevel: 'custom',
    });
    expect(frozenOf(runId).specHash).toBe(computeSpecHash(SLOT_SPEC));
    expect(frozenOf(runId).level).toBe('custom');
  });

  it('rejects an override on a non-built-in flow', () => {
    expect(() =>
      registry.createRun(WF_CUSTOM, undefined, SESSION, undefined, { tuningLevel: 'efficient' }),
    ).toThrow(new RegExp(`${TUNING_OVERRIDE_CODE}:not_built_in`));
  });
});

// ---------------------------------------------------------------------------
// evalDefault consumption (plan D6)
// ---------------------------------------------------------------------------

describe('createRun — evalDefault by level', () => {
  function evalOf(runId: string): number | null {
    const row = db.prepare('SELECT eval_enabled AS e FROM workflow_runs WHERE id = ?').get(runId) as {
      e: number | null;
    };
    return row.e;
  }

  it("efficient defaults eval OFF when the wizard pinned nothing", () => {
    setLevel(WF_SPRINT, 'efficient');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    expect(evalOf(runId)).toBe(0);
  });

  it('an explicit wizard ON beats the efficient default', () => {
    setLevel(WF_SPRINT, 'efficient');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      requestedEvalEnabled: true,
    });
    expect(evalOf(runId)).toBe(1);
  });

  it('standard and thorough leave eval NULL (inherit the global toggle, unchanged)', () => {
    const { runId: std } = registry.createRun(WF_SPRINT, undefined, SESSION);
    setLevel(WF_SPRINT, 'thorough');
    const { runId: tho } = registry.createRun(WF_SPRINT, undefined, SESSION);
    expect(evalOf(std)).toBeNull();
    expect(evalOf(tho)).toBeNull();
  });

  it('an efficient OVERRIDE also supplies the default', () => {
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      tuningLevel: 'efficient',
    });
    expect(evalOf(runId)).toBe(0);
  });

  it('a variant run consults no preset (its graph is the variant’s, not a level’s)', () => {
    setLevel(WF_SPRINT, 'efficient');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      variantId: 'wfv_1',
      variantSpecJson: JSON.stringify(editedDefinition('variant-graph')),
    });
    expect(evalOf(runId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Restart replay (plan D4) — the createRun half of the contract
// ---------------------------------------------------------------------------

describe('createRun — frozenSpec replay', () => {
  it('replays the exact spec + stamp instead of re-deriving from the current level', () => {
    setLevel(WF_SPRINT, 'efficient');
    const { runId: original } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const originalFrozen = frozenOf(original);

    // Simulate the world moving on between run and restart: the flow is now
    // parked on thorough. A re-derivation would produce the thorough graph.
    setLevel(WF_SPRINT, 'thorough');
    const { runId: restarted } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      frozenSpec: {
        specJson: revisionOf(WF_SPRINT, originalFrozen.specHash) ?? '',
        tuningLevel: 'efficient',
      },
    });

    expect(frozenOf(restarted)).toEqual(originalFrozen);
  });

  it('replays a NULL stamp for a run that was itself unattributed', () => {
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      frozenSpec: { specJson: '{}', tuningLevel: null },
    });
    const frozen = frozenOf(runId);
    expect(frozen.level).toBeNull();
    expect(frozen.specHash).toBe(computeSpecHash('{}'));
  });
});
