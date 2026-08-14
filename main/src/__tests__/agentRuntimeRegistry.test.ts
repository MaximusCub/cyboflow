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
 *      offers) are separate sets — and now genuinely diverge, which is the case
 *      the split was made for: `omp-sdk` must survive on a quick sentinel row
 *      while no picker may offer it.
 *   6. A provider declared ahead of its managers is UNREACHABLE: absent access
 *      key ⇒ disabled, and no picker-facing set contains its runtimes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AGENT_PROVIDERS,
  AGENT_PROVIDER_LABELS,
  AGENT_PROVIDER_REGISTRY,
  AGENT_PROVIDER_TABLE,
  ALL_AGENT_RUNTIMES,
  SESSION_AGENT_RUNTIMES,
  WORKFLOW_LAUNCHABLE_RUNTIMES,
  WORKFLOW_RUN_STORABLE_RUNTIMES,
  assertProviderRuntimeConsistent,
  enabledAgentProviders,
  failUnresolvable,
  formatProviderRuntimeConflict,
  isAgentProviderEnabled,
  isRuntimeProviderEnabled,
  isWorkflowLaunchableRuntime,
  isWorkflowRunStorableRuntime,
  providerForRuntime,
  providerForRuntimeIn,
  providerForRuntimeValue,
  providerRuntimeConflict,
  type AgentRuntime,
} from '../../../shared/types/agentRuntime';
import { isRuntimeSelectableInPickers } from '../../../shared/types/agentCapabilities';
import {
  AGENT_MODEL_FAMILY_PREDICATES,
  isOmpModelFamily,
  normalizeAgentModelSelection,
} from '../../../shared/types/agentModels';

/** An id no shipped provider claims — the misrouting case, spelled once. */
const UNREGISTERED_RUNTIME = 'someprovider-sdk';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  // Assigning `undefined` would stringify to "undefined"; these tests delete the
  // var outright, so the restore has to handle an originally-unset value too.
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
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
    ['omp-sdk', 'omp'],
    ['omp-pty', 'omp'],
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

/**
 * Pinned directly, not only through providerForRuntime: the dispatch facade
 * reuses this for an unregistered PanelLane → manager lookup, so the two arms
 * are now a shared contract rather than one caller's internal detail.
 */
describe('failUnresolvable (the shared throw-here / floor-there policy)', () => {
  it.each([['development'], ['test']])('throws under NODE_ENV=%s', (env) => {
    process.env.NODE_ENV = env;
    expect(() => failUnresolvable('no manager for lane', 'fallback')).toThrow(
      'no manager for lane',
    );
  });

  it.each([['production'], [undefined]])(
    'logs and returns the fallback under NODE_ENV=%s',
    (env) => {
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(failUnresolvable('no manager for lane', 'fallback')).toBe('fallback');
      expect(spy).toHaveBeenCalledWith('no manager for lane');
    },
  );
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
    ['omp', 'omp-sdk'],
    ['omp', 'omp-pty'],
  ] as const)('accepts the agreeing pair %s / %s', (provider, runtime) => {
    expect(providerRuntimeConflict(provider, runtime)).toBeNull();
    expect(() => assertProviderRuntimeConsistent(provider, runtime)).not.toThrow();
  });

  it.each([
    ['codex', 'claude-sdk', 'claude'],
    ['codex', 'claude-interactive', 'claude'],
    ['claude', 'codex-sdk', 'codex'],
    ['claude', 'codex-pty', 'codex'],
    ['claude', 'omp-sdk', 'omp'],
    ['omp', 'claude-sdk', 'claude'],
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
  // The two used to agree on membership and the split was about MEANING alone.
  // They diverge now that a provider ships quick-session support ahead of
  // programmatic per-step support, which is the case the split was made for.
  it('storable is a strict superset of launchable', () => {
    for (const runtime of WORKFLOW_LAUNCHABLE_RUNTIMES) {
      expect(WORKFLOW_RUN_STORABLE_RUNTIMES).toContain(runtime);
    }
    expect(WORKFLOW_RUN_STORABLE_RUNTIMES.length).toBeGreaterThan(
      WORKFLOW_LAUNCHABLE_RUNTIMES.length,
    );
  });

  // The quick sentinel row must keep an omp-sdk session's identity (the dispatch
  // facade reads the row back to pick a manager), while nothing may OFFER it as
  // a workflow launch target until its programmatic support lands.
  it('carries omp-sdk on a run row without offering it as a launch target', () => {
    expect(isWorkflowRunStorableRuntime('omp-sdk')).toBe(true);
    expect(isWorkflowLaunchableRuntime('omp-sdk')).toBe(false);
  });

  it('both exclude the runtimes a workflow run cannot use', () => {
    for (const set of [WORKFLOW_RUN_STORABLE_RUNTIMES, WORKFLOW_LAUNCHABLE_RUNTIMES]) {
      expect(set).not.toContain('codex-pty');
      expect(set).not.toContain('codex-exec');
      // Every PTY runtime is excluded for the same reason: a workflow needs
      // structured events/usage/MCP, which a terminal transport cannot give it.
      expect(set).not.toContain('omp-pty');
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
    // NOT a slashed id: `provider/model` is OMP's family, so a slash is now a
    // claim rather than the absence of one (see the OMP cases below).
    expect(normalizeAgentModelSelection('codex', 'some-vendor-model')).toBe('some-vendor-model');
    expect(normalizeAgentModelSelection('claude', 'some-vendor-model')).toBe('some-vendor-model');
  });

  it("treats a `provider/model` id as OMP's and drops it from the other two", () => {
    expect(normalizeAgentModelSelection('omp', 'anthropic/claude-opus-5')).toBe(
      'anthropic/claude-opus-5',
    );
    expect(normalizeAgentModelSelection('claude', 'anthropic/claude-opus-5')).toBeUndefined();
    expect(normalizeAgentModelSelection('codex', 'openai/gpt-5.4')).toBeUndefined();
  });

  // The load-bearing consequence of persisting OMP selections in canonical
  // `<provider>/<id>` form. OMP's catalog rows carry a BARE id — the same string
  // Claude's own catalog uses — so if a projection ever wrote the bare form, the
  // two selections would be identical and neither provider's normalization could
  // tell a stale carry-over from a legitimate value. Composed, they separate.
  it('separates an OMP row from the first-party id it wraps', () => {
    const bare = 'claude-3-5-sonnet-20240620';
    const canonical = `anthropic/${bare}`;

    expect(isOmpModelFamily(bare)).toBe(false);
    expect(normalizeAgentModelSelection('claude', bare)).toBe(bare);
    expect(normalizeAgentModelSelection('omp', bare)).toBeUndefined();

    expect(isOmpModelFamily(canonical)).toBe(true);
    expect(normalizeAgentModelSelection('omp', canonical)).toBe(canonical);
    expect(normalizeAgentModelSelection('claude', canonical)).toBeUndefined();
  });

  it("keeps the other providers' own ids off an OMP agent", () => {
    expect(normalizeAgentModelSelection('omp', 'opus')).toBeUndefined();
    expect(normalizeAgentModelSelection('omp', 'gpt-5.4')).toBeUndefined();
  });

  it('does not mistake a bare slash for a model id', () => {
    // Both halves must be non-empty: `provider/` and `/model` name nothing, so
    // they stay unclaimed rather than being routed to OMP.
    expect(isOmpModelFamily('anthropic/')).toBe(false);
    expect(isOmpModelFamily('/claude-opus-5')).toBe(false);
    expect(isOmpModelFamily('anthropic/claude-opus-5')).toBe(true);
  });
});

/**
 * OMP is DECLARED but not yet REACHABLE — its managers land in a later step.
 *
 * "Declared" is easy to verify (the registries above already do). What this
 * block pins is the second half: that a claude/codex user who never opts in
 * sees no behavior change. Since the Phase-1 visibility flip the picker
 * capability offers both OMP lanes, so the remaining guards are the access
 * default (an absent key resolves to DISABLED, so every launch seam refuses
 * OMP until the user switches it on) and the workflow gate (omp-sdk is
 * storable but not launchable until its per-step phase lands).
 */
describe('omp is opt-in and workflow-gated', () => {
  it('resolves to DISABLED from an absent access key, unlike the two legacy providers', () => {
    expect(isAgentProviderEnabled(undefined, 'omp')).toBe(false);
    expect(isAgentProviderEnabled({ claude: true, codex: true }, 'omp')).toBe(false);
    expect(enabledAgentProviders(undefined)).not.toContain('omp');
    // The registry entry is the reason, not a special case somewhere downstream.
    expect(AGENT_PROVIDER_REGISTRY.omp.defaultEnabled).toBe(false);
  });

  it('is picker-selectable for quick sessions but still guarded by provider access', () => {
    for (const runtime of ['omp-sdk', 'omp-pty'] as const) {
      // Since the Phase-1 visibility flip, the capability offers both lanes…
      expect(isRuntimeSelectableInPickers(runtime)).toBe(true);
      // …but workflows still refuse them (T1 lands in a later phase)…
      expect(WORKFLOW_LAUNCHABLE_RUNTIMES).not.toContain(runtime);
      // …and a never-touched install refuses them at every launch seam,
      // because the absent access key resolves to disabled.
      expect(isRuntimeProviderEnabled(undefined, runtime)).toBe(false);
    }
  });

  it('is still a first-class provider everywhere identity matters', () => {
    // Unreachable must not mean unrecognized: a runtime that resolved to the
    // Claude floor instead of its own provider is the misroute this registry
    // exists to prevent, and the quick sentinel row depends on it.
    expect(providerForRuntime('omp-sdk')).toBe('omp');
    expect(providerForRuntime('omp-pty')).toBe('omp');
    expect(isWorkflowRunStorableRuntime('omp-sdk')).toBe(true);
    expect(isWorkflowLaunchableRuntime('omp-sdk')).toBe(false);
    expect(SESSION_AGENT_RUNTIMES).toContain('omp-sdk');
    expect(SESSION_AGENT_RUNTIMES).toContain('omp-pty');
  });

  it('names itself in user-facing copy rather than borrowing another vendor label', () => {
    expect(AGENT_PROVIDER_LABELS.omp).toBe('OMP');
    // Exhaustive: the label map is what six UI sites now read instead of a
    // `=== 'codex' ? 'Codex' : 'Claude'` ternary that would have said "Claude".
    for (const provider of AGENT_PROVIDERS) {
      expect(AGENT_PROVIDER_LABELS[provider]).toBeTruthy();
    }
  });
});
