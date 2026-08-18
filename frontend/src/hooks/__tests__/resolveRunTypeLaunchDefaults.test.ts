/**
 * Unit tests for THE canonical run-type launch resolver
 * (shared/types/sessionDefaults.ts) — the single source every launch seam now
 * shares. Covers the three-rung precedence ladder, the per-KIND model /
 * substrate floors (a workflow key can no longer be resolved against the quick
 * floor by hand), and the quick-only rule for reasoningEffort.
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_QUICK_MODEL,
  DEFAULT_QUICK_SUBSTRATE,
  DEFAULT_WORKFLOW_MODEL,
  QUICK_RUN_TYPE_KEY,
  isQuickRunTypeKey,
  resolveRunTypeLaunchDefaults,
  runTypeKindForKey,
  workflowRunTypeKey,
} from '../../../../shared/types/sessionDefaults';
import { DEFAULT_SUBSTRATE } from '../../../../shared/types/substrate';
import type { RunTypeDefaults } from '../../../../shared/types/sessionDefaults';

describe('run-type key helpers', () => {
  it('builds a workflow key and recognizes the quick key', () => {
    expect(QUICK_RUN_TYPE_KEY).toBe('quick');
    expect(workflowRunTypeKey('wf-sprint')).toBe('workflow:wf-sprint');
    expect(isQuickRunTypeKey('quick')).toBe(true);
    expect(isQuickRunTypeKey(workflowRunTypeKey('quick'))).toBe(false);
    expect(runTypeKindForKey('quick')).toBe('quick');
    expect(runTypeKindForKey('workflow:wf-sprint')).toBe('workflow');
  });
});

describe('resolveRunTypeLaunchDefaults — precedence ladder', () => {
  const stored: Record<string, RunTypeDefaults> = {
    'workflow:wf-sprint': {
      model: 'sonnet',
      permissionMode: 'dontAsk',
      substrate: 'interactive',
      agentRuntime: 'codex-sdk',
    },
  };

  it('rung 1: a stored per-type value beats both the global default and the floor', () => {
    const resolved = resolveRunTypeLaunchDefaults('workflow:wf-sprint', stored, {
      model: 'haiku',
      permissionMode: 'acceptEdits',
      substrate: 'sdk',
      agentRuntime: 'claude-interactive',
    });
    expect(resolved).toEqual({
      model: 'sonnet',
      permissionMode: 'dontAsk',
      substrate: 'interactive',
      agentRuntime: 'codex-sdk',
      reasoningEffort: undefined,
    });
  });

  it('rung 2: the global default applies when nothing is stored for the key', () => {
    const resolved = resolveRunTypeLaunchDefaults('workflow:wf-planner', stored, {
      model: 'haiku',
      permissionMode: 'acceptEdits',
      substrate: 'interactive',
      agentRuntime: 'claude-interactive',
    });
    expect(resolved).toEqual({
      model: 'haiku',
      permissionMode: 'acceptEdits',
      substrate: 'interactive',
      agentRuntime: 'claude-interactive',
      reasoningEffort: undefined,
    });
  });

  it('rung 3: the floor applies when neither a stored value nor a global exists', () => {
    expect(resolveRunTypeLaunchDefaults('workflow:wf-planner', undefined)).toEqual({
      model: DEFAULT_WORKFLOW_MODEL,
      permissionMode: 'default',
      substrate: DEFAULT_SUBSTRATE,
      // No agentRuntime floor — an unconfigured install must send NOTHING, so
      // the payload stays byte-identical to the pre-feature behavior.
      agentRuntime: undefined,
      reasoningEffort: undefined,
    });
  });

  it('resolves each field independently — a partial stored row falls through per-field', () => {
    const resolved = resolveRunTypeLaunchDefaults(
      'workflow:wf-sprint',
      { 'workflow:wf-sprint': { model: 'sonnet' } },
      { permissionMode: 'acceptEdits' },
    );
    expect(resolved.model).toBe('sonnet');
    expect(resolved.permissionMode).toBe('acceptEdits');
    expect(resolved.substrate).toBe(DEFAULT_SUBSTRATE);
    expect(resolved.agentRuntime).toBeUndefined();
  });

  it('does not leak a different key’s stored row', () => {
    const resolved = resolveRunTypeLaunchDefaults('workflow:wf-planner', stored);
    expect(resolved.model).toBe(DEFAULT_WORKFLOW_MODEL);
    expect(resolved.permissionMode).toBe('default');
  });
});

describe('resolveRunTypeLaunchDefaults — per-kind floors', () => {
  it('floors a workflow key to the WORKFLOW model + sdk substrate', () => {
    const resolved = resolveRunTypeLaunchDefaults(workflowRunTypeKey('wf-a'), {});
    expect(resolved.model).toBe(DEFAULT_WORKFLOW_MODEL);
    expect(resolved.substrate).toBe(DEFAULT_SUBSTRATE);
  });

  it('floors the quick key to the QUICK model + interactive substrate', () => {
    const resolved = resolveRunTypeLaunchDefaults(QUICK_RUN_TYPE_KEY, {});
    expect(resolved.model).toBe(DEFAULT_QUICK_MODEL);
    expect(resolved.substrate).toBe(DEFAULT_QUICK_SUBSTRATE);
    expect(DEFAULT_QUICK_SUBSTRATE).toBe('interactive');
  });

  it('picks the floor table BY KEY, so the two kinds cannot be crossed by a caller', () => {
    // The constants happen to be equal today; assert the SELECTION, not the
    // value, so this test fails the day DEFAULT_QUICK_MODEL diverges rather
    // than silently passing (the SessionStartWizard latent bug this replaces).
    const byKey = (key: string) => resolveRunTypeLaunchDefaults(key, undefined).model;
    expect(byKey(QUICK_RUN_TYPE_KEY)).toBe(DEFAULT_QUICK_MODEL);
    expect(byKey(workflowRunTypeKey('wf-a'))).toBe(DEFAULT_WORKFLOW_MODEL);
    // An unrecognized key shape is treated as a workflow, never as quick.
    expect(byKey('something-else')).toBe(DEFAULT_WORKFLOW_MODEL);
  });
});

describe('resolveRunTypeLaunchDefaults — reasoningEffort is quick-only', () => {
  it('returns a stored effort for the quick key', () => {
    const resolved = resolveRunTypeLaunchDefaults(QUICK_RUN_TYPE_KEY, {
      quick: { reasoningEffort: 'high' },
    });
    expect(resolved.reasoningEffort).toBe('high');
  });

  it('falls through to the global effort for the quick key', () => {
    const resolved = resolveRunTypeLaunchDefaults(QUICK_RUN_TYPE_KEY, {}, { reasoningEffort: 'low' });
    expect(resolved.reasoningEffort).toBe('low');
  });

  it('DROPS a stale stored effort on a workflow key', () => {
    // v1 only ever writes effort under `quick`; a workflow row carrying one is
    // stale/hand-edited and must never reach a run payload.
    const resolved = resolveRunTypeLaunchDefaults('workflow:wf-a', {
      'workflow:wf-a': { model: 'sonnet', reasoningEffort: 'xhigh' },
    });
    expect(resolved.model).toBe('sonnet');
    expect(resolved.reasoningEffort).toBeUndefined();
  });

  it('ignores even a GLOBAL effort on a workflow key', () => {
    const resolved = resolveRunTypeLaunchDefaults('workflow:wf-a', {}, { reasoningEffort: 'high' });
    expect(resolved.reasoningEffort).toBeUndefined();
  });
});
