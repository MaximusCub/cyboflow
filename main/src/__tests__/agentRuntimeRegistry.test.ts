/**
 * The provider registry in shared/types/agentRuntime.ts — the single place that
 * answers "which provider owns this runtime", "do these two agree", and "which
 * runtime set does this seam mean".
 *
 * What is worth pinning here is the class of bug this registry replaced: a
 * `startsWith('codex-')` ternary duplicated at three seams, which mapped ANY
 * unregistered runtime onto Claude silently. A third provider's runtime would
 * have spawned a Claude process with no error anywhere. So the invariants are:
 *
 *   1. Every declared runtime resolves to its declared owner.
 *   2. An UNREGISTERED runtime never resolves quietly — it throws in dev/CI and
 *      logs an error before flooring in production (a packaged app must not die
 *      over a bad config value).
 *   3. An ABSENT runtime is not the same as an unknown one: a legacy row that
 *      predates the provider axis floors to Claude with no complaint.
 *   4. The provider×runtime consistency decision has ONE implementation, since
 *      the four launch seams that report it differ only in HOW they report.
 *   5. WORKFLOW_RUN_STORABLE_RUNTIMES (what a run row may carry, incl. the
 *      `__quick__` sentinel) and WORKFLOW_LAUNCHABLE_RUNTIMES (what a picker
 *      offers) are separate sets. Identical membership TODAY — the point is
 *      that each seam names the one it means, so they can diverge.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_REGISTRY,
  AGENT_PROVIDER_TABLE,
  ALL_AGENT_RUNTIMES,
  SESSION_AGENT_RUNTIMES,
  WORKFLOW_LAUNCHABLE_RUNTIMES,
  WORKFLOW_RUN_STORABLE_RUNTIMES,
  assertProviderRuntimeConsistent,
  formatProviderRuntimeConflict,
  isWorkflowLaunchableRuntime,
  isWorkflowRunStorableRuntime,
  providerForRuntime,
  providerForRuntimeIn,
  providerForRuntimeValue,
  providerRuntimeConflict,
  type AgentRuntime,
} from '../../../shared/types/agentRuntime';
import {
  AGENT_MODEL_FAMILY_PREDICATES,
  normalizeAgentModelSelection,
} from '../../../shared/types/agentModels';

/** An id no shipped provider claims — the misrouting case, spelled once. */
const UNREGISTERED_RUNTIME = 'someprovider-sdk';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
  vi.restoreAllMocks();
});

describe('provider registry', () => {
  it('declares one definition per provider, with a prefix matching the provider name', () => {
    for (const provider of AGENT_PROVIDERS) {
      expect(AGENT_PROVIDER_REGISTRY[provider].runtimePrefix).toBe(`${provider}-`);
    }
    expect(Object.keys(AGENT_PROVIDER_REGISTRY).sort()).toEqual([...AGENT_PROVIDERS].sort());
  });

  it('claims every declared runtime — no runtime is left to the fallback', () => {
    for (const runtime of ALL_AGENT_RUNTIMES) {
      expect(providerForRuntimeIn(AGENT_PROVIDER_TABLE, runtime)).not.toBeNull();
    }
  });
});

describe('providerForRuntime', () => {
  it.each([
    ['claude-sdk', 'claude'],
    ['claude-interactive', 'claude'],
    ['codex-sdk', 'codex'],
    ['codex-pty', 'codex'],
    ['codex-exec', 'codex'],
  ] as const)('maps %s to %s', (runtime, provider) => {
    expect(providerForRuntime(runtime)).toBe(provider);
  });

  it('throws on an unregistered runtime under NODE_ENV=test', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => providerForRuntime(UNREGISTERED_RUNTIME as AgentRuntime)).toThrow(
      /matches no registered provider prefix/,
    );
  });

  it('throws on an unregistered runtime under NODE_ENV=development', () => {
    process.env.NODE_ENV = 'development';
    expect(() => providerForRuntime(UNREGISTERED_RUNTIME as AgentRuntime)).toThrow(
      new RegExp(UNREGISTERED_RUNTIME),
    );
  });

  it('logs an error and floors to claude in production rather than taking the app down', () => {
    process.env.NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(providerForRuntime(UNREGISTERED_RUNTIME as AgentRuntime)).toBe('claude');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain(UNREGISTERED_RUNTIME);
  });
});

describe('providerForRuntimeValue (untyped DB/IPC values)', () => {
  it.each([[undefined], [null], ['']] as const)(
    'floors the absent value %j to claude without complaining',
    (value) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(providerForRuntimeValue(value)).toBe('claude');
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it('resolves a known runtime string', () => {
    expect(providerForRuntimeValue('codex-pty')).toBe('codex');
  });

  it('fails loudly on a non-empty unknown value, naming the calling seam', () => {
    expect(() => providerForRuntimeValue(UNREGISTERED_RUNTIME, 'providerForSession')).toThrow(
      /^providerForSession: /,
    );
  });
});

describe('provider × runtime consistency', () => {
  it('reports no conflict when either half is absent', () => {
    expect(providerRuntimeConflict(undefined, 'codex-sdk')).toBeNull();
    expect(providerRuntimeConflict('codex', undefined)).toBeNull();
    expect(providerRuntimeConflict(undefined, undefined)).toBeNull();
  });

  it.each([
    ['claude', 'claude-sdk'],
    ['claude', 'claude-interactive'],
    ['codex', 'codex-sdk'],
    ['codex', 'codex-pty'],
  ] as const)('accepts the agreeing pair %s / %s', (provider, runtime) => {
    expect(providerRuntimeConflict(provider, runtime)).toBeNull();
    expect(() => assertProviderRuntimeConsistent(provider, runtime)).not.toThrow();
  });

  it.each([
    ['codex', 'claude-sdk', 'claude'],
    ['codex', 'claude-interactive', 'claude'],
    ['claude', 'codex-sdk', 'codex'],
    ['claude', 'codex-pty', 'codex'],
  ] as const)('rejects %s / %s and names the real owner', (provider, runtime, expected) => {
    expect(providerRuntimeConflict(provider, runtime)).toEqual({ provider, runtime, expected });
  });

  it('keeps the wire sentence the launch seams have always emitted', () => {
    expect(formatProviderRuntimeConflict('claude', 'codex-sdk')).toBe(
      'agentProvider claude conflicts with agentRuntime codex-sdk',
    );
  });

  it('prefixes the throwing form with the caller context', () => {
    expect(() =>
      assertProviderRuntimeConsistent('codex', 'claude-sdk', 'WorkflowRegistry.createRun'),
    ).toThrow(
      'WorkflowRegistry.createRun: agentProvider codex conflicts with agentRuntime claude-sdk',
    );
  });

  it('throws an unprefixed sentence when no context is supplied', () => {
    expect(() => assertProviderRuntimeConsistent('claude', 'codex-sdk')).toThrow(
      'agentProvider claude conflicts with agentRuntime codex-sdk',
    );
  });
});

describe('storable vs launchable runtime sets', () => {
  it('agree on membership today — the split is about MEANING, not current contents', () => {
    expect([...WORKFLOW_RUN_STORABLE_RUNTIMES].sort()).toEqual(
      [...WORKFLOW_LAUNCHABLE_RUNTIMES].sort(),
    );
  });

  it('both exclude the runtimes a workflow run cannot use', () => {
    for (const set of [WORKFLOW_RUN_STORABLE_RUNTIMES, WORKFLOW_LAUNCHABLE_RUNTIMES]) {
      expect(set).not.toContain('codex-pty');
      expect(set).not.toContain('codex-exec');
    }
  });

  it('every storable runtime is also a legal session runtime (the quick sentinel path)', () => {
    for (const runtime of WORKFLOW_RUN_STORABLE_RUNTIMES) {
      expect(SESSION_AGENT_RUNTIMES).toContain(runtime);
    }
  });

  it.each([
    ['claude-sdk', true],
    ['claude-interactive', true],
    ['codex-sdk', true],
    ['codex-pty', false],
    ['codex-exec', false],
    [UNREGISTERED_RUNTIME, false],
    ['', false],
    [null, false],
    [undefined, false],
    [42, false],
  ])('guards agree on %j', (value, expected) => {
    expect(isWorkflowRunStorableRuntime(value)).toBe(expected);
    expect(isWorkflowLaunchableRuntime(value)).toBe(expected);
  });
});

describe('normalizeAgentModelSelection', () => {
  it('declares one family predicate per provider', () => {
    expect(Object.keys(AGENT_MODEL_FAMILY_PREDICATES).sort()).toEqual([...AGENT_PROVIDERS].sort());
  });

  it.each([
    ['claude', 'opus', 'opus'],
    ['claude', 'claude-opus-5', 'claude-opus-5'],
    ['claude', '  sonnet  ', 'sonnet'],
    ['codex', 'gpt-5.4', 'gpt-5.4'],
    ['codex', 'auto', 'auto'],
    ['codex', 'o3', 'o3'],
  ] as const)('keeps %s selection %j', (provider, model, expected) => {
    expect(normalizeAgentModelSelection(provider, model)).toBe(expected);
  });

  it.each([
    ['claude', 'gpt-5.4'],
    ['claude', 'codex-mini'],
    ['claude', 'o3'],
    ['codex', 'opus'],
    ['codex', 'claude-opus-5'],
    ['claude', 'default'],
    ['codex', 'default'],
    ['claude', ''],
    ['codex', null],
  ] as const)('drops the cross-provider / empty %s value %j', (provider, model) => {
    expect(normalizeAgentModelSelection(provider, model)).toBeUndefined();
  });

  it('preserves an id no family claims — it belongs to whoever asked', () => {
    expect(normalizeAgentModelSelection('codex', 'some-vendor/some-model')).toBe(
      'some-vendor/some-model',
    );
    expect(normalizeAgentModelSelection('claude', 'some-vendor/some-model')).toBe(
      'some-vendor/some-model',
    );
  });
});
