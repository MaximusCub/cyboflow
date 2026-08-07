/**
 * runTypeOverrides — the pure rules behind the session-type override list.
 *
 * These pin the two things the rendered list depends on and that no snapshot
 * would catch: the per-key BASELINES (which must match what the launch surfaces
 * resolve, or the list invents overrides that do not exist) and the merge patch
 * shape (which must send explicit nulls so ConfigManager can merge a key to
 * empty and delete it).
 */
import { describe, it, expect } from 'vitest';
import {
  QUICK_RUN_TYPE_KEY,
  buildRunTypeGroups,
  draftFromStored,
  patchFromDraft,
  resolveRunTypeBaseline,
  runTypeOverrideChips,
  runTypeStatusLabel,
  workflowRunTypeKey,
  type RunTypeWorkflowSource,
} from '../runTypeOverrides';
import type { AppConfig } from '../../../types/config';
import type { WorkflowRow } from '../../../../../shared/types/workflows';

function wf(id: string, name: string, projectName = '', projectId: number | null = null): RunTypeWorkflowSource {
  const row: WorkflowRow = {
    id,
    project_id: projectId,
    name,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: '{}',
    created_at: '2026-01-01T00:00:00Z',
    archived_at: null,
  };
  return { row, projectName };
}

const NO_CONFIG: AppConfig = { gitRepoPath: '/repo' };

describe('resolveRunTypeBaseline', () => {
  it('floors a flow key to the workflow launch defaults (Opus / SDK / claude-sdk / default)', () => {
    expect(resolveRunTypeBaseline('workflow:wf-1', NO_CONFIG)).toEqual({
      model: 'opus',
      substrate: 'sdk',
      agentRuntime: 'claude-sdk',
      permissionMode: 'default',
    });
  });

  it('floors the quick key to the quick-session launch defaults (Opus / interactive)', () => {
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, NO_CONFIG)).toEqual({
      model: 'opus',
      substrate: 'interactive',
      agentRuntime: 'claude-sdk',
      permissionMode: 'default',
    });
  });

  it('honors the global config knobs the launch surfaces read', () => {
    const config: AppConfig = {
      gitRepoPath: '/repo',
      defaultAgentPermissionMode: 'dontAsk',
      quickSessionDefaultSubstrate: 'sdk',
    };
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config).substrate).toBe('sdk');
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, config).permissionMode).toBe('dontAsk');
    // quickSessionDefaultSubstrate governs QUICK only — a flow key keeps 'sdk'
    // via DEFAULT_SUBSTRATE, and the permission knob is shared by both.
    expect(resolveRunTypeBaseline('workflow:wf-1', config).substrate).toBe('sdk');
    expect(resolveRunTypeBaseline('workflow:wf-1', config).permissionMode).toBe('dontAsk');
  });

  it('tolerates a null config (the modal renders before the first fetch resolves)', () => {
    expect(resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, null).permissionMode).toBe('default');
  });
});

describe('runTypeOverrideChips', () => {
  const baseline = resolveRunTypeBaseline('workflow:wf-1', NO_CONFIG);

  it('is empty for an absent key', () => {
    expect(runTypeOverrideChips(undefined, baseline)).toEqual([]);
    expect(runTypeStatusLabel(0)).toBe('Following defaults');
  });

  it('drops fields whose stored value equals the baseline', () => {
    expect(runTypeOverrideChips({ model: 'opus', substrate: 'sdk' }, baseline)).toEqual([]);
  });

  it('keeps only the differing fields, with the baseline they differ from', () => {
    const chips = runTypeOverrideChips({ model: 'haiku', substrate: 'interactive' }, baseline);
    expect(chips.map((c) => c.field)).toEqual(['model', 'substrate']);
    expect(chips[0]).toMatchObject({ label: 'Model', baseline: 'Opus 5 · 1M' });
    expect(chips[1]).toMatchObject({ value: 'Interactive terminal', baseline: 'SDK' });
    expect(runTypeStatusLabel(chips.length)).toBe('2 overrides');
  });

  it('treats any stored reasoning effort as an override (there is no global baseline)', () => {
    const chips = runTypeOverrideChips(
      { reasoningEffort: 'high' },
      resolveRunTypeBaseline(QUICK_RUN_TYPE_KEY, NO_CONFIG),
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({ field: 'reasoningEffort', value: 'High', baseline: null });
    expect(runTypeStatusLabel(1)).toBe('1 override');
  });
});

describe('buildRunTypeGroups', () => {
  it('splits built-ins, the synthetic quick row, global custom flows and per-project ones', () => {
    const groups = buildRunTypeGroups(
      [
        wf('wf-3-custom-bb', 'nightly', 'Cyboflow', 3),
        wf('wf-global-custom-aa', 'triage'),
        wf('wf-global-ship', 'ship'),
        wf('wf-global-planner', 'planner'),
      ],
      [],
    );

    expect(groups.map((g) => g.title)).toEqual([
      'Built-in flows',
      'Quick sessions',
      'Custom flows',
      'Custom flows · Cyboflow',
    ]);
    // Built-ins keep the canonical planner → sprint → compound → ship order.
    expect(groups[0].rows.map((r) => r.label)).toEqual(['Planner', 'Ship']);
    expect(groups[1].rows.map((r) => r.key)).toEqual([QUICK_RUN_TYPE_KEY]);
  });

  it("lists the setup flow with the other built-ins so its stored default stays reachable", () => {
    const groups = buildRunTypeGroups([wf('wf-global-verify', 'verify-setup')], []);
    expect(groups[0].title).toBe('Built-in flows');
    expect(groups[0].rows.map((r) => r.label)).toEqual(['Verify Setup']);
  });

  it('renders a stale key as-is instead of pruning it', () => {
    const groups = buildRunTypeGroups(
      [wf('wf-global-sprint', 'sprint')],
      [QUICK_RUN_TYPE_KEY, workflowRunTypeKey('wf-global-sprint'), 'workflow:wf-archived-77'],
    );

    const staleGroup = groups.find((g) => g.id === 'stale');
    expect(staleGroup?.rows).toEqual([
      {
        key: 'workflow:wf-archived-77',
        label: 'workflow:wf-archived-77',
        sublabel: 'No matching flow in the current project list',
        stale: true,
      },
    ]);
    // The quick key and a key that DOES resolve never land in the stale bucket.
    expect(staleGroup?.rows).toHaveLength(1);
  });

  it('always offers the quick row, even with no workflows at all', () => {
    const groups = buildRunTypeGroups([], []);
    expect(groups.map((g) => g.id)).toEqual(['quick']);
  });
});

describe('draft ⇄ patch', () => {
  it('round-trips a stored override into a draft', () => {
    expect(draftFromStored({ model: 'sonnet', reasoningEffort: 'high' })).toEqual({
      model: 'sonnet',
      reasoningEffort: 'high',
      substrate: null,
      agentRuntime: null,
      permissionMode: null,
    });
  });

  it('sends EVERY member so a cleared field is deleted and an emptied key is dropped', () => {
    expect(patchFromDraft(draftFromStored(undefined))).toEqual({
      model: null,
      reasoningEffort: null,
      substrate: null,
      agentRuntime: null,
      permissionMode: null,
    });
  });
});
