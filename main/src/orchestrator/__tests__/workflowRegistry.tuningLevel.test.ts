/**
 * WorkflowRegistry × tuning levels (migration 122 / plan D1–D3).
 *
 * The dial and the custom slot are independent halves, and these tests pin the
 * seam between them:
 *   - `setTuningLevel` writes ONLY the stamp, so switching levels is lossless —
 *     a saved custom definition survives a round trip through a preset level.
 *   - `updateSpec` (the single chokepoint behind BOTH the tRPC editor save and
 *     MCP `cyboflow_update_workflow`) stamps `'custom'`, because writing the
 *     slot IS selecting it.
 *   - `resetSpec` empties the slot and flips `'custom'` back to `'standard'`,
 *     but does NOT knock a flow off a preset level it happened to be parked on.
 *   - `getEffectiveDefinition` is the read-path chokepoint: what comes back is
 *     decided by the level, not by whether the slot happens to be filled.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { WorkflowRegistry } from '../workflowRegistry';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import { WORKFLOW_DEFINITIONS } from '../../../../shared/types/workflows';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import { applyTuningPreset, TUNING_LEVELS } from '../../../../shared/tuning/workflowTuning';
import type { TuningLevel } from '../../../../shared/tuning/workflowTuning';

const WF_SPRINT = 'wf-global-sprint';
const WF_CUSTOM = 'wf-1-custom-abcd1234';

let db: Database.Database;
let registry: WorkflowRegistry;

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

function levelOf(workflowId: string): TuningLevel {
  const row = registry.getById(workflowId);
  if (!row) throw new Error(`no workflow ${workflowId}`);
  return row.tuning_level;
}

function specOf(workflowId: string): string {
  const row = registry.getById(workflowId);
  if (!row) throw new Error(`no workflow ${workflowId}`);
  return row.spec_json;
}

beforeEach(() => {
  db = createTestDb({ includeWorkflowRunTaskColumns: true, includeWorkflowArchivedAt: true });
  // updateSpec / resetSpec snapshot a workflow_revisions row (migration 026).
  db.exec(`
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (workflow_id, spec_hash),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    )
  `);
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, NULL, 'sprint', '{}')").run(
    WF_SPRINT,
  );
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, 'my-flow', ?)").run(
    WF_CUSTOM,
    JSON.stringify(editedDefinition('my-flow')),
  );
  registry = new WorkflowRegistry(dbAdapter(db), makeSpyLogger());
});

describe('WorkflowRegistry.setTuningLevel', () => {
  it('persists every preset level, and is readable off the row', () => {
    for (const level of ['efficient', 'standard', 'thorough'] as const) {
      registry.setTuningLevel(WF_SPRINT, level);
      expect(levelOf(WF_SPRINT)).toBe(level);
    }
  });

  it('never touches the custom slot, so a level round trip is lossless', () => {
    const saved = editedDefinition('sprint');
    registry.updateSpec(WF_SPRINT, saved);
    expect(levelOf(WF_SPRINT)).toBe('custom');

    registry.setTuningLevel(WF_SPRINT, 'efficient');
    expect(levelOf(WF_SPRINT)).toBe('efficient');
    // The slot is still there, dormant.
    expect(specOf(WF_SPRINT)).toBe(JSON.stringify(saved));

    registry.setTuningLevel(WF_SPRINT, 'custom');
    expect(registry.getEffectiveDefinition(WF_SPRINT)).toEqual(saved);
  });

  it("rejects 'custom' while the slot is empty — there is nothing for it to select", () => {
    expect(() => registry.setTuningLevel(WF_SPRINT, 'custom')).toThrow(/empty custom slot/);
    expect(levelOf(WF_SPRINT)).toBe('standard');
  });

  it('rejects a non-built-in flow: it has no baseline for a preset to transform', () => {
    for (const level of TUNING_LEVELS) {
      expect(() => registry.setTuningLevel(WF_CUSTOM, level), `level='${level}'`).toThrow(
        /not a built-in/,
      );
    }
  });

  it('rejects an unknown workflow and a bogus level', () => {
    expect(() => registry.setTuningLevel('wf-nope', 'efficient')).toThrow(/not found/);
    // The DB CHECK is the last line of defence; the registry guard is the first,
    // so an untyped caller (IPC payload, MCP arg) never reaches the UPDATE.
    expect(() => registry.setTuningLevel(WF_SPRINT, 'turbo' as TuningLevel)).toThrow(
      /invalid tuning level/,
    );
    expect(levelOf(WF_SPRINT)).toBe('standard');
  });
});

describe('WorkflowRegistry.updateSpec / resetSpec × the tuning stamp', () => {
  it("updateSpec stamps 'custom' in the same write as the slot", () => {
    registry.setTuningLevel(WF_SPRINT, 'thorough');
    registry.updateSpec(WF_SPRINT, editedDefinition('sprint'));
    expect(levelOf(WF_SPRINT)).toBe('custom');
  });

  it("resetSpec empties the slot and returns a 'custom' flow to 'standard'", () => {
    registry.updateSpec(WF_SPRINT, editedDefinition('sprint'));
    registry.resetSpec(WF_SPRINT);
    expect(specOf(WF_SPRINT)).toBe('{}');
    expect(levelOf(WF_SPRINT)).toBe('standard');
    expect(registry.getEffectiveDefinition(WF_SPRINT)).toEqual(
      applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'standard'),
    );
  });

  it('resetSpec does NOT knock a flow off a preset level it was parked on', () => {
    registry.updateSpec(WF_SPRINT, editedDefinition('sprint'));
    registry.setTuningLevel(WF_SPRINT, 'efficient');
    registry.resetSpec(WF_SPRINT);
    expect(specOf(WF_SPRINT)).toBe('{}');
    expect(levelOf(WF_SPRINT)).toBe('efficient');
  });
});

describe('WorkflowRegistry.getEffectiveDefinition', () => {
  it("'standard' on a calibrated flow is the built-in plus the aligned-defaults pins", () => {
    const effective = registry.getEffectiveDefinition(WF_SPRINT);
    expect(effective).toEqual(applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'standard'));
    // Pins only: stripping agentConfigs recovers the as-authored graph.
    expect({ ...effective, agentConfigs: undefined }).toEqual({
      ...WORKFLOW_DEFINITIONS.sprint,
      agentConfigs: undefined,
    });
  });

  it("'efficient' returns the preset transform over the built-in, not the built-in", () => {
    registry.setTuningLevel(WF_SPRINT, 'efficient');
    const effective = registry.getEffectiveDefinition(WF_SPRINT);
    expect(effective).toEqual(applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'efficient'));
    // Non-vacuous: the sprint efficient preset is a real transform, so routing
    // through it must produce something OTHER than the as-authored graph.
    expect(effective).not.toEqual(WORKFLOW_DEFINITIONS.sprint);
  });

  it("a preset level wins over a filled slot — the slot is dormant until 'custom'", () => {
    const saved = editedDefinition('sprint');
    registry.updateSpec(WF_SPRINT, saved);
    registry.setTuningLevel(WF_SPRINT, 'thorough');
    const effective = registry.getEffectiveDefinition(WF_SPRINT);
    expect(effective).toEqual(applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'thorough'));
    expect(effective).not.toEqual(saved);
  });

  it('a non-built-in flow always resolves its own spec, whatever the stamp says', () => {
    // updateSpec stamps 'custom' on a custom flow too; the point is that the
    // level is inert there — there is no built-in to transform.
    expect(registry.getEffectiveDefinition(WF_CUSTOM)).toEqual(editedDefinition('my-flow'));
  });

  it('returns null for an unknown workflow', () => {
    expect(registry.getEffectiveDefinition('wf-nope')).toBeNull();
  });
});

describe('WorkflowRegistry.createVariantFromCurrent × tuning levels', () => {
  beforeEach(() => {
    db.exec(`
      CREATE TABLE workflow_variants (
        id TEXT PRIMARY KEY, tuning_level TEXT, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
        spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT,
        execution_model TEXT, agent_provider TEXT, agent_runtime TEXT,
        weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
        archived_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Migration 126: uniqueness is per (workflow, LEVEL).
      CREATE UNIQUE INDEX idx_workflow_variants_wf_level_label
        ON workflow_variants(workflow_id, COALESCE(tuning_level, ''), label);
    `);
  });

  it("snapshots what the flow ACTUALLY runs — the level's materialized graph", () => {
    registry.setTuningLevel(WF_SPRINT, 'efficient');
    const variant = registry.createVariantFromCurrent(WF_SPRINT, 'from-efficient');
    expect(JSON.parse(variant.spec_json)).toEqual(
      applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'efficient'),
    );
  });

  it("a 'standard' flow still snapshots the CONCRETE effective graph, not '{}'", () => {
    const variant = registry.createVariantFromCurrent(WF_SPRINT, 'from-standard');
    expect(JSON.parse(variant.spec_json)).toEqual(
      applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'standard'),
    );
  });

  // -- Migration 126: a variant belongs to ONE level --------------------------

  it("stamps the flow's SAVED level when the caller names none", () => {
    registry.setTuningLevel(WF_SPRINT, 'thorough');
    expect(registry.createVariantFromCurrent(WF_SPRINT, 'inherits').tuning_level).toBe('thorough');
  });

  it('snapshots the NAMED level, not the saved one, and stamps it', () => {
    // The editor's Efficient page creates an Efficient challenger even while the
    // flow itself is parked on Standard — otherwise "create variant from current"
    // would freeze a graph the page never showed.
    const variant = registry.createVariantFromCurrent(WF_SPRINT, 'from-page', {
      tuningLevel: 'efficient',
    });
    expect(variant.tuning_level).toBe('efficient');
    expect(JSON.parse(variant.spec_json)).toEqual(
      applyTuningPreset(WORKFLOW_DEFINITIONS.sprint, 'sprint', 'efficient'),
    );
    // The flow's own stamp is untouched.
    expect(registry.getById(WF_SPRINT)?.tuning_level).toBe('standard');
  });

  it('allows the SAME label at two different levels, but not twice at one', () => {
    registry.createVariantFromCurrent(WF_SPRINT, 'aggressive', { tuningLevel: 'standard' });
    expect(() =>
      registry.createVariantFromCurrent(WF_SPRINT, 'aggressive', { tuningLevel: 'thorough' }),
    ).not.toThrow();
    expect(() =>
      registry.createVariantFromCurrent(WF_SPRINT, 'aggressive', { tuningLevel: 'standard' }),
    ).toThrow(/already exists/);
  });

  it('stores NULL for a non-built-in flow and REFUSES an explicit level there', () => {
    expect(registry.createVariantFromCurrent(WF_CUSTOM, 'flow-scoped').tuning_level).toBeNull();
    expect(() =>
      registry.createVariantFromCurrent(WF_CUSTOM, 'levelled', { tuningLevel: 'thorough' }),
    ).toThrow(/no tuning levels/);
  });
});
