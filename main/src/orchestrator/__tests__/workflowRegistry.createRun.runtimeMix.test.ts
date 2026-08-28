/**
 * WorkflowRegistry.createRun × runtime mixes (migration 127 / plan D3, D6).
 *
 * The mix is a pure transform everywhere EXCEPT here: createRun is the single
 * site where it becomes concrete — a base PROVIDER, a forced execution PLANE, a
 * frozen `spec_json` carrying the per-agent provider pins, and the
 * `workflow_runs.runtime_mix` stamp that files the run under the routing it
 * actually ran. These tests pin that seam:
 *
 *   - the `'claude'` default is byte-for-byte today's run (same spec hash, same
 *     orchestrated plane) — the whole zero-change promise;
 *   - a non-claude mix derives the provider BEFORE the runtime/substrate ladder
 *     and forces `'programmatic'`, because only that plane honors the pins the
 *     transform writes (an EXPLICIT orchestrated request is refused instead);
 *   - a requested provider RECONCILES the mix rather than being rejected, so the
 *     legacy launch surfaces keep their meaning;
 *   - every arm that voids the mix (variant, omp/pi lane, non-built-in flow)
 *     stamps NULL and changes nothing else;
 *   - a saved codex mix is gated by Settings → Integrations exactly like an
 *     explicit request — it fails closed rather than spawning a disabled provider;
 *   - a restart replays the mix it froze, outranking the workflow's current stamp;
 *   - the backstop guard is symmetric: a claude-sdk pin on a codex-BASE
 *     orchestrated run trips it, just like the codex-on-claude case always has.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { WorkflowRegistry, type WorkflowConfigProvider } from '../workflowRegistry';
import { computeSpecHash } from '../specHash';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../__test_fixtures__/loggerLikeSpy';
import { createTestDb } from '../__test_fixtures__/orchestratorTestDb';
import type { AgentProviderAccess } from '../../../../shared/types/agentRuntime';
import type { WorkflowDefinition } from '../../../../shared/types/workflows';
import { parseWorkflowDefinition } from '../../../../shared/types/workflows';
import { materializeForLevel, type TuningLevel } from '../../../../shared/tuning/workflowTuning';
import {
  materializeForLevelAndMix,
  type RuntimeMix,
} from '../../../../shared/tuning/runtimeMix';
import { RUNTIME_MIX_OVERRIDE_CODE } from '../../../../shared/tuning/workflowTuningErrors';
import {
  MIXED_PROVIDER_ORCHESTRATED_CODE,
  RUNTIME_MIX_ORCHESTRATED_CODE,
} from '../../../../shared/types/executionModelErrors';

const WF_SPRINT = 'wf-sprint';
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
const VARIANT_SPEC = JSON.stringify(editedDefinition('variant-graph'));

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
  // A "save as new" flow: no verification class, so it sits outside the mix
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

/** A registry whose config answers only the provider-access question. */
function registryWithAccess(access: AgentProviderAccess): WorkflowRegistry {
  const config: WorkflowConfigProvider = {
    getDefaultAgentPermissionMode: () => 'default',
    getDefaultSubstrate: () => 'sdk',
    getAgentProviderAccess: () => access,
  };
  return new WorkflowRegistry(dbAdapter(db), makeSpyLogger(), config);
}

interface RunStamps {
  specHash: string | null;
  level: string | null;
  mix: string | null;
  provider: string;
  runtime: string;
  executionModel: string;
  substrate: string;
}

function stampsOf(runId: string): RunStamps {
  return db
    .prepare(
      `SELECT spec_hash AS specHash, tuning_level AS level, runtime_mix AS mix,
              agent_provider AS provider, agent_runtime AS runtime,
              execution_model AS executionModel, substrate
         FROM workflow_runs WHERE id = ?`,
    )
    .get(runId) as RunStamps;
}

/** The revision text a run's frozen address resolves to, or undefined. */
function revisionOf(workflowId: string, specHash: string | null): string | undefined {
  if (specHash === null) return undefined;
  const row = db
    .prepare('SELECT spec_json AS specJson FROM workflow_revisions WHERE workflow_id = ? AND spec_hash = ?')
    .get(workflowId, specHash) as { specJson: string } | undefined;
  return row?.specJson;
}

function setMix(workflowId: string, mix: RuntimeMix): void {
  db.prepare('UPDATE workflows SET runtime_mix = ? WHERE id = ?').run(mix, workflowId);
}

function setLevel(workflowId: string, level: TuningLevel): void {
  db.prepare('UPDATE workflows SET tuning_level = ? WHERE id = ?').run(level, workflowId);
}

/** The `agentConfigs` entry a run's FROZEN spec carries for `agentKey`. */
function frozenAgentConfig(
  runId: string,
  agentKey: string,
): { runtime?: string; providerModel?: string; model?: string; effort?: string } | undefined {
  const spec = revisionOf(WF_SPRINT, stampsOf(runId).specHash);
  const def = parseWorkflowDefinition(spec ?? '');
  return def?.agentConfigs?.[agentKey];
}

const runCount = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get() as { n: number }).n;

// ---------------------------------------------------------------------------
// The identity mix — zero behaviour change
// ---------------------------------------------------------------------------

describe('createRun — the claude mix is the identity', () => {
  it('stamps claude and freezes the byte-identical pre-mix spec', () => {
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const stamps = stampsOf(runId);

    expect(stamps.mix).toBe('claude');
    // The exact text the level materialization produced before migration 127 —
    // `materializeForLevelAndMix` short-circuits 'claude' through it verbatim.
    expect(stamps.specHash).toBe(computeSpecHash(materializeForLevel('sprint', '{}', 'standard')));
    // Untouched by the mix: the plane still floors to orchestrated and the run
    // still resolves onto Claude.
    expect(stamps.executionModel).toBe('orchestrated');
    expect(stamps.provider).toBe('claude');
    expect(stamps.runtime).toBe('claude-sdk');
    // No provider pins in the frozen graph at all.
    expect(frozenAgentConfig(runId, 'code-review')?.runtime).toBeUndefined();
  });

  it('holds at a preset level too', () => {
    setLevel(WF_SPRINT, 'efficient');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    expect(stampsOf(runId).specHash).toBe(
      computeSpecHash(materializeForLevel('sprint', '{}', 'efficient')),
    );
    expect(stampsOf(runId).executionModel).toBe('orchestrated');
  });
});

// ---------------------------------------------------------------------------
// The three routing mixes
// ---------------------------------------------------------------------------

describe('createRun — a saved non-claude mix routes the run', () => {
  it('claude-primary keeps the run on Claude and sends verification to Codex, programmatically', () => {
    setMix(WF_SPRINT, 'claude-primary');
    const { runId, executionModel } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const stamps = stampsOf(runId);

    expect(stamps.mix).toBe('claude-primary');
    // The EXECUTION class decides the base provider; only the verification steps
    // cross over, through their own pins.
    expect(stamps.provider).toBe('claude');
    expect(stamps.runtime).toBe('claude-sdk');
    // Forced: per-agent pins are honored by the programmatic runner only.
    expect(executionModel).toBe('programmatic');
    expect(stamps.executionModel).toBe('programmatic');

    expect(stamps.specHash).toBe(
      computeSpecHash(materializeForLevelAndMix('sprint', '{}', 'standard', 'claude-primary')),
    );
    const review = frozenAgentConfig(runId, 'code-review');
    expect(review?.runtime).toBe('codex-sdk');
    expect(review?.providerModel).toMatch(/^gpt-/);
    // Execution agents are left alone — they inherit the run's Claude provider.
    expect(frozenAgentConfig(runId, 'implement')?.runtime).toBeUndefined();
  });

  it('codex-primary derives the codex provider and pins verification back to claude-sdk', () => {
    setMix(WF_SPRINT, 'codex-primary');
    const { runId, substrate } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const stamps = stampsOf(runId);

    expect(stamps.mix).toBe('codex-primary');
    // Derived from the mix with NO explicit request — this is the ladder rung the
    // mix adds, and it must flow through runtime + substrate like a real request.
    expect(stamps.provider).toBe('codex');
    expect(stamps.runtime).toBe('codex-sdk');
    expect(substrate).toBe('sdk');
    expect(stamps.executionModel).toBe('programmatic');

    // Without the explicit claude-sdk pin these agents would inherit the run's
    // codex provider in spawnStepRunner.
    expect(frozenAgentConfig(runId, 'code-review')?.runtime).toBe('claude-sdk');
    expect(frozenAgentConfig(runId, 'implement')?.runtime).toBe('codex-sdk');
  });

  it('codex routes the whole flow to codex', () => {
    setMix(WF_SPRINT, 'codex');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const stamps = stampsOf(runId);
    expect(stamps.mix).toBe('codex');
    expect(stamps.provider).toBe('codex');
    expect(stamps.executionModel).toBe('programmatic');
    expect(frozenAgentConfig(runId, 'code-review')?.runtime).toBe('codex-sdk');
    expect(frozenAgentConfig(runId, 'implement')?.runtime).toBe('codex-sdk');
  });

  it('a drifted mix value in the column reads as the identity rather than rerouting', () => {
    // The column's CHECK makes this unreachable through the app — parking the
    // value takes suspending it — but a reader must not decide a run's PROVIDER
    // off an unrecognized string even so.
    db.pragma('ignore_check_constraints = ON');
    db.prepare('UPDATE workflows SET runtime_mix = ? WHERE id = ?').run('gemini-only', WF_SPRINT);
    db.pragma('ignore_check_constraints = OFF');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    expect(stampsOf(runId).mix).toBe('claude');
    expect(stampsOf(runId).provider).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// Reconcile with the requested provider (plan D3 step 2)
// ---------------------------------------------------------------------------

describe('createRun — the requested provider reconciles the mix', () => {
  it('a codex request on a claude-mix flow swaps the primary, keeping the same-provider aspect', () => {
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      requestedAgentProvider: 'codex',
      requestedAgentRuntime: 'codex-sdk',
    });
    const stamps = stampsOf(runId);
    // 'claude' + codex -> 'codex' (both classes on one provider, as before).
    expect(stamps.mix).toBe('codex');
    expect(stamps.provider).toBe('codex');
    expect(stamps.executionModel).toBe('programmatic');
  });

  it('a claude request on a codex-primary flow swaps to claude-primary, keeping the CROSS aspect', () => {
    setMix(WF_SPRINT, 'codex-primary');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      requestedAgentProvider: 'claude',
      requestedAgentRuntime: 'claude-sdk',
    });
    const stamps = stampsOf(runId);
    // The user asked for Claude; the flow's "one provider verifies the other"
    // intent survives as claude-primary rather than being rejected.
    expect(stamps.mix).toBe('claude-primary');
    expect(stamps.provider).toBe('claude');
    expect(frozenAgentConfig(runId, 'code-review')?.runtime).toBe('codex-sdk');
  });

  it('a per-run override outranks the workflow stamp without writing the workflows row', () => {
    setMix(WF_SPRINT, 'claude');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      runtimeMix: 'codex-primary',
    });
    expect(stampsOf(runId).mix).toBe('codex-primary');
    expect(stampsOf(runId).provider).toBe('codex');
    expect(registry.getById(WF_SPRINT)?.runtime_mix).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// Execution model
// ---------------------------------------------------------------------------

describe('createRun — the plane a mix forces', () => {
  it('refuses an EXPLICIT orchestrated request under a non-claude mix, inserting nothing', () => {
    setMix(WF_SPRINT, 'claude-primary');
    expect(() =>
      registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
        requestedExecutionModel: 'orchestrated',
      }),
    ).toThrow(new RegExp(RUNTIME_MIX_ORCHESTRATED_CODE));
    expect(runCount()).toBe(0);
  });

  it('an explicit PROGRAMMATIC request under a non-claude mix is simply honoured', () => {
    setMix(WF_SPRINT, 'codex');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      requestedExecutionModel: 'programmatic',
    });
    expect(stampsOf(runId).executionModel).toBe('programmatic');
  });

  it('leaves an explicit orchestrated request alone under the claude mix', () => {
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      requestedExecutionModel: 'orchestrated',
    });
    expect(stampsOf(runId).executionModel).toBe('orchestrated');
  });
});

// ---------------------------------------------------------------------------
// The arms that void the mix
// ---------------------------------------------------------------------------

describe('createRun — mix-suppressing arms stamp NULL', () => {
  it('a variant run bypasses the mix machinery entirely', () => {
    setMix(WF_SPRINT, 'codex-primary');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      variantId: 'wfv_1',
      variantLabel: 'arm-a',
      variantSpecJson: VARIANT_SPEC,
    });
    const stamps = stampsOf(runId);
    // NULL, not 'codex-primary': a variant is its own frozen definition, so
    // attributing a mix to it would poison the per-mix buckets.
    expect(stamps.mix).toBeNull();
    expect(stamps.specHash).toBe(computeSpecHash(VARIANT_SPEC));
    // And nothing else moved: no derived provider, no forced plane.
    expect(stamps.provider).toBe('claude');
    expect(stamps.executionModel).toBe('orchestrated');
  });

  it('a non-built-in flow keeps freezing its own spec and stamps NULL', () => {
    const { runId } = registry.createRun(WF_CUSTOM, undefined, SESSION);
    const stamps = stampsOf(runId);
    expect(stamps.mix).toBeNull();
    expect(stamps.specHash).toBe(computeSpecHash(SLOT_SPEC));
  });

  it('an omp lane ignores the stamp — no derived provider, no reconcile, no forcing', () => {
    setMix(WF_SPRINT, 'codex-primary');
    const omp = registryWithAccess({ claude: true, codex: true, omp: true });
    // OMP is programmatic-only in this build, so the launch says so itself — the
    // point here is that the mix neither routes nor stamps.
    const { runId } = omp.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      requestedAgentProvider: 'omp',
      requestedAgentRuntime: 'omp-sdk',
      requestedExecutionModel: 'programmatic',
    });
    const stamps = stampsOf(runId);
    expect(stamps.mix).toBeNull();
    expect(stamps.provider).toBe('omp');
    expect(stamps.runtime).toBe('omp-sdk');
    // The frozen spec is the plain level materialization — no codex pins.
    expect(stamps.specHash).toBe(computeSpecHash(materializeForLevel('sprint', '{}', 'standard')));
  });
});

// ---------------------------------------------------------------------------
// Override rejections
// ---------------------------------------------------------------------------

describe('createRun — per-run mix override rejections', () => {
  it('rejects an override combined with a variant', () => {
    expect(() =>
      registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
        runtimeMix: 'codex',
        variantId: 'wfv_1',
        variantSpecJson: VARIANT_SPEC,
      }),
    ).toThrow(new RegExp(`${RUNTIME_MIX_OVERRIDE_CODE}:variant_conflict`));
    expect(runCount()).toBe(0);
  });

  it('rejects an invalid mix value', () => {
    expect(() =>
      registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
        // A stale payload / scripted launch is the only way to get here.
        runtimeMix: 'gemini-primary' as RuntimeMix,
      }),
    ).toThrow(new RegExp(`${RUNTIME_MIX_OVERRIDE_CODE}:invalid_mix`));
  });

  it('rejects an override on a non-built-in flow', () => {
    expect(() =>
      registry.createRun(WF_CUSTOM, undefined, SESSION, undefined, { runtimeMix: 'codex' }),
    ).toThrow(new RegExp(`${RUNTIME_MIX_OVERRIDE_CODE}:not_built_in`));
  });
});

// ---------------------------------------------------------------------------
// Provider access
// ---------------------------------------------------------------------------

describe('createRun — a saved mix obeys the provider-access gate', () => {
  it('fails closed when the mix would resolve onto a disabled Codex', () => {
    setMix(WF_SPRINT, 'codex');
    const gated = registryWithAccess({ claude: true, codex: false });
    expect(() => gated.createRun(WF_SPRINT, undefined, SESSION)).toThrow(
      /Codex provider is disabled/,
    );
    expect(runCount()).toBe(0);
  });

  it('lets a claude-base mix through on the same install', () => {
    // claude-primary's PRIMARY is Claude, so the run itself resolves onto an
    // enabled provider; the disabled-provider question is about the base route.
    setMix(WF_SPRINT, 'claude-primary');
    const gated = registryWithAccess({ claude: true, codex: false });
    const { runId } = gated.createRun(WF_SPRINT, undefined, SESSION);
    expect(stampsOf(runId).provider).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// Restart replay (plan D6) — the createRun half
// ---------------------------------------------------------------------------

describe('createRun — frozenSpec replays the mix it froze', () => {
  it('routes and stamps from the REPLAYED mix, not the workflow’s current one', () => {
    setMix(WF_SPRINT, 'claude-primary');
    const { runId: original } = registry.createRun(WF_SPRINT, undefined, SESSION);
    const originalStamps = stampsOf(original);

    // The world moves on: the flow is back on plain Claude.
    setMix(WF_SPRINT, 'claude');
    const { runId: restarted } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      frozenSpec: {
        specJson: revisionOf(WF_SPRINT, originalStamps.specHash) ?? '',
        tuningLevel: 'standard',
        runtimeMix: 'claude-primary',
      },
    });
    const replay = stampsOf(restarted);

    expect(replay.mix).toBe('claude-primary');
    expect(replay.specHash).toBe(originalStamps.specHash);
    // The replayed spec carries codex pins, so the plane must still be forced —
    // an orchestrated replay would silently ignore them.
    expect(replay.executionModel).toBe('programmatic');
  });

  it('replays a NULL stamp for a run that was itself unattributed', () => {
    setMix(WF_SPRINT, 'codex');
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
      frozenSpec: { specJson: '{}', tuningLevel: null, runtimeMix: null },
    });
    const stamps = stampsOf(runId);
    expect(stamps.mix).toBeNull();
    expect(stamps.specHash).toBe(computeSpecHash('{}'));
    // Unattributed means unrouted: the workflow's current codex stamp must not
    // leak into a replay of a run that never used it.
    expect(stamps.provider).toBe('claude');
    expect(stamps.executionModel).toBe('orchestrated');
  });
});

// ---------------------------------------------------------------------------
// setRuntimeMix
// ---------------------------------------------------------------------------

describe('setRuntimeMix', () => {
  it('round-trips through getById and leaves the level + slot alone', () => {
    db.prepare('UPDATE workflows SET spec_json = ?, tuning_level = ? WHERE id = ?').run(
      SLOT_SPEC,
      'custom',
      WF_SPRINT,
    );
    registry.setRuntimeMix(WF_SPRINT, 'codex-primary');
    const row = registry.getById(WF_SPRINT);
    expect(row?.runtime_mix).toBe('codex-primary');
    expect(row?.tuning_level).toBe('custom');
    expect(row?.spec_json).toBe(SLOT_SPEC);
  });

  it('is idempotent', () => {
    registry.setRuntimeMix(WF_SPRINT, 'codex');
    registry.setRuntimeMix(WF_SPRINT, 'codex');
    expect(registry.getById(WF_SPRINT)?.runtime_mix).toBe('codex');
  });

  it('refuses a non-built-in flow, an unknown row, and an invalid mix', () => {
    expect(() => registry.setRuntimeMix(WF_CUSTOM, 'codex')).toThrow(/not a built-in flow/);
    expect(() => registry.setRuntimeMix('wf-nope', 'codex')).toThrow(/not found/);
    expect(() => registry.setRuntimeMix(WF_SPRINT, 'gemini' as RuntimeMix)).toThrow(
      /invalid runtime mix/,
    );
  });
});

// ---------------------------------------------------------------------------
// The symmetric backstop guard (plan D3, review finding 6)
// ---------------------------------------------------------------------------

describe('createRun — the mixed-provider guard is symmetric', () => {
  /** A sprint slot whose `implement` agent is hand-pinned to `runtime`. */
  function slotPinning(runtime: string): string {
    return JSON.stringify({
      id: 'sprint',
      phases: [
        {
          id: 'p1',
          label: 'P1',
          color: '#3b6dd6',
          steps: [{ id: 'implement', name: 'Implement', agent: 'implement', mcps: [], retries: 0 }],
        },
      ],
      agentConfigs: { implement: { runtime } },
    });
  }

  it('trips on a CLAUDE pin in a codex-base orchestrated run', () => {
    db.prepare('UPDATE workflows SET spec_json = ?, tuning_level = ? WHERE id = ?').run(
      slotPinning('claude-sdk'),
      'custom',
      WF_SPRINT,
    );
    // An explicit codex launch (the mix stays 'claude' and reconciles to 'codex',
    // which would force programmatic), so ask for the orchestrated plane the old
    // one-way guard waved through — and get refused for the RIGHT reason.
    expect(() =>
      registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
        runtimeMix: 'claude',
        requestedAgentProvider: 'codex',
        requestedAgentRuntime: 'codex-sdk',
        requestedExecutionModel: 'orchestrated',
      }),
    ).toThrow(new RegExp(RUNTIME_MIX_ORCHESTRATED_CODE));

    // With the mix out of the picture entirely (a variant carries the same graph),
    // the guard itself is what refuses the launch.
    expect(() =>
      registry.createRun(WF_SPRINT, undefined, SESSION, undefined, {
        variantId: 'wfv_pin',
        variantSpecJson: slotPinning('claude-sdk'),
        requestedAgentProvider: 'codex',
        requestedAgentRuntime: 'codex-sdk',
        requestedExecutionModel: 'orchestrated',
      }),
    ).toThrow(new RegExp(MIXED_PROVIDER_ORCHESTRATED_CODE));
    expect(runCount()).toBe(0);
  });

  it('still trips on a CODEX pin in a claude-base orchestrated run (unchanged)', () => {
    db.prepare('UPDATE workflows SET spec_json = ?, tuning_level = ? WHERE id = ?').run(
      slotPinning('codex-sdk'),
      'custom',
      WF_SPRINT,
    );
    expect(() => registry.createRun(WF_SPRINT, undefined, SESSION)).toThrow(
      new RegExp(MIXED_PROVIDER_ORCHESTRATED_CODE),
    );
  });

  it('does NOT trip when every pin matches the run’s own provider', () => {
    db.prepare('UPDATE workflows SET spec_json = ?, tuning_level = ? WHERE id = ?').run(
      slotPinning('claude-sdk'),
      'custom',
      WF_SPRINT,
    );
    const { runId } = registry.createRun(WF_SPRINT, undefined, SESSION);
    expect(stampsOf(runId).provider).toBe('claude');
  });
});
