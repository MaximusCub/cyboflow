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
  RUN_TYPE_FIELD_ORDER,
  agentRuntimeOptions,
  buildRunTypeGroups,
  draftFromStored,
  isQuickRunTypeKey,
  patchFromDraft,
  resolveRunTypeBaseline,
  runTypeOverrideChips,
  runTypeStatusLabel,
  runTypeValueLabel,
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

  // The inverse of "stored == baseline ⇒ no chip": the SAME stored value flips
  // to a chip once the global default moves away from it. The diff is computed
  // against the RESOLVED baseline, not against the hard-coded ship default.
  it('chips a stored value that equals the ship default but differs from the configured global', () => {
    const configured = resolveRunTypeBaseline('workflow:wf-1', {
      gitRepoPath: '/repo',
      defaultAgentPermissionMode: 'dontAsk',
    });
    // 'default' is PermissionMode's ship value, yet this user's global is dontAsk.
    const chips = runTypeOverrideChips({ permissionMode: 'default' }, configured);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toMatchObject({
      field: 'permissionMode',
      value: 'Ask before edits',
      baseline: "Don't ask",
    });
    // ...and against the untouched global it is not an override at all.
    expect(runTypeOverrideChips({ permissionMode: 'default' }, baseline)).toEqual([]);
  });

  it('emits chips in the display order, not the stored key order', () => {
    const chips = runTypeOverrideChips(
      { permissionMode: 'dontAsk', agentRuntime: 'codex-sdk', model: 'haiku' },
      baseline,
    );
    expect(chips.map((c) => c.field)).toEqual(['model', 'agentRuntime', 'permissionMode']);
    // The order is the module's single source, so a reordered field list moves
    // the chips with it rather than silently disagreeing with the detail screen.
    const order = RUN_TYPE_FIELD_ORDER.filter((f) => chips.some((c) => c.field === f));
    expect(chips.map((c) => c.field)).toEqual([...order]);
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

describe('keys', () => {
  it('only the synthetic quick key is quick — a workflow key never is', () => {
    expect(isQuickRunTypeKey(QUICK_RUN_TYPE_KEY)).toBe(true);
    expect(workflowRunTypeKey('wf-1')).toBe('workflow:wf-1');
    expect(isQuickRunTypeKey(workflowRunTypeKey('quick'))).toBe(false);
  });
});

describe('agentRuntimeOptions', () => {
  // The quick key is the only one whose launch can reach the Codex TUI; a flow
  // run has no PTY seam, so offering it there would be a control that cannot
  // take effect (the same rule that keeps effort quick-only).
  it('offers Codex terminal on the quick key and never on a flow key', () => {
    expect(agentRuntimeOptions(QUICK_RUN_TYPE_KEY)).toContain('codex-pty');
    expect(agentRuntimeOptions('workflow:wf-1')).not.toContain('codex-pty');
    // Both share the three Claude/Codex-SDK runtimes.
    for (const runtime of ['claude-sdk', 'claude-interactive', 'codex-sdk']) {
      expect(agentRuntimeOptions('workflow:wf-1')).toContain(runtime);
      expect(agentRuntimeOptions(QUICK_RUN_TYPE_KEY)).toContain(runtime);
    }
  });
});

describe('runTypeValueLabel', () => {
  it('labels every known value from the same maps the pickers use', () => {
    expect(runTypeValueLabel('model', 'sonnet')).toBe('Sonnet 5 · 1M');
    expect(runTypeValueLabel('substrate', 'interactive')).toBe('Interactive terminal');
    expect(runTypeValueLabel('agentRuntime', 'codex-pty')).toBe('Codex terminal');
    expect(runTypeValueLabel('permissionMode', 'dontAsk')).toBe("Don't ask");
    expect(runTypeValueLabel('reasoningEffort', 'xhigh')).toBe('Xhigh');
  });

  // A stored value can outlive the option that produced it (a retired model
  // alias, a runtime renamed in a later build). The row still has to render, so
  // every branch falls back to the RAW value rather than blank or undefined.
  it('falls back to the raw value for a value no option list still knows', () => {
    expect(runTypeValueLabel('model', 'claude-3-legacy')).toBe('claude-3-legacy');
    expect(runTypeValueLabel('substrate', 'quantum')).toBe('quantum');
    expect(runTypeValueLabel('agentRuntime', 'gemini-pty')).toBe('gemini-pty');
    expect(runTypeValueLabel('permissionMode', 'yolo')).toBe('yolo');
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

  it('gives every owning project its own group, ordered by project name', () => {
    const groups = buildRunTypeGroups(
      [
        wf('wf-9-zulu', 'nightly', 'Zulu', 9),
        wf('wf-2-alpha', 'triage', 'Alpha', 2),
        wf('wf-global', 'audit'),
      ],
      [],
    );

    expect(groups.map((g) => g.title)).toEqual([
      'Quick sessions',
      'Custom flows',
      'Custom flows · Alpha',
      'Custom flows · Zulu',
    ]);
    // A GLOBAL flow (project_id null ⇒ projectName '') stays ungrouped, which is
    // exactly the row workflowsStore emits once for the whole fan-out.
    expect(groups[1].rows.map((r) => r.key)).toEqual(['workflow:wf-global']);
    expect(groups[2].rows.map((r) => r.key)).toEqual(['workflow:wf-2-alpha']);
    expect(groups[3].rows.map((r) => r.key)).toEqual(['workflow:wf-9-zulu']);
  });

  it('keeps several stale keys, sorted, without ever touching the quick key', () => {
    const groups = buildRunTypeGroups(
      [wf('wf-global-sprint', 'sprint')],
      ['workflow:wf-zz-gone', QUICK_RUN_TYPE_KEY, 'workflow:wf-aa-gone'],
    );

    const stale = groups.find((g) => g.id === 'stale');
    expect(stale?.rows.map((r) => r.key)).toEqual(['workflow:wf-aa-gone', 'workflow:wf-zz-gone']);
    // Every stale row is labelled with its raw key and flagged, so the render
    // site can tell "renamed flow" apart from a live one without re-deriving it.
    expect(stale?.rows.every((r) => r.stale && r.label === r.key)).toBe(true);
    // The quick key is synthetic: it has no workflow row and must never be
    // mistaken for an unmatched one.
    expect(groups.find((g) => g.id === 'quick')?.rows[0].stale).toBe(false);
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

  it('sends a fully populated draft by value, with no member omitted', () => {
    const stored = {
      model: 'haiku',
      reasoningEffort: 'max',
      substrate: 'interactive',
      agentRuntime: 'codex-pty',
      permissionMode: 'dontAsk',
    } as const;
    const patch = patchFromDraft(draftFromStored(stored));
    expect(patch).toEqual(stored);
    // Every editable field is a patch member on EVERY save — an omitted member
    // is indistinguishable from "leave it alone" to ConfigManager's merge, so a
    // field dropped here would become unclearable.
    expect(Object.keys(patch).sort()).toEqual([...RUN_TYPE_FIELD_ORDER].sort());
  });

  it('clears exactly the fields the user cleared, keeping the rest', () => {
    const draft = draftFromStored({ model: 'sonnet', substrate: 'interactive' });
    expect(patchFromDraft({ ...draft, substrate: null })).toEqual({
      model: 'sonnet',
      reasoningEffort: null,
      substrate: null,
      agentRuntime: null,
      permissionMode: null,
    });
  });
});
