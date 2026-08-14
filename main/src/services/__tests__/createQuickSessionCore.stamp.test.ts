/**
 * Unit tests for stampQuickSessionRuntimeConfig — the SHARED per-session
 * runtime-config stamp chokepoint behind BOTH quick-session callers (the
 * `sessions:create-quick` IPC handler and the experiment quick-arm path,
 * index.ts createArmSession). The helper owns:
 *   - sessions.agent_permission_mode (migration 021): stamped ONLY when
 *     explicitly chosen (undefined keeps NULL = global default);
 *   - sessions.substrate + sessions.agent_runtime (migrations 027 + 059-064):
 *     ALWAYS stamped with the RESOLVED values (an explicit non-Claude runtime
 *     wins over the substrate-derived Claude one; a PTY-transport runtime
 *     forces substrate 'interactive').
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createQuickSessionCore,
  resolveNonClaudeSessionRuntime,
  stampQuickSessionRuntimeConfig,
  _resetClaimedQuickSessionIdsForTesting,
  type CreateQuickSessionCoreDeps,
  type CreateQuickSessionCoreOptions,
  type QuickSessionRow,
} from '../createQuickSessionCore';
import type { CliSubstrate } from '../../../../shared/types/substrate';
import type { PermissionMode } from '../../../../shared/types/workflows';
import type {
  AgentProvider,
  WorkflowRunStorableRuntime,
} from '../../../../shared/types/agentRuntime';

const SESSION_ID = 'sess-stamp-001';

describe('stampQuickSessionRuntimeConfig', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_permission_mode TEXT,
      substrate TEXT,
      agent_runtime TEXT
    )`);
    db.prepare('INSERT INTO sessions (id) VALUES (?)').run(SESSION_ID);
  });

  afterEach(() => {
    db.close();
  });

  function readSession(): {
    agent_permission_mode: string | null;
    substrate: string | null;
    agent_runtime: string | null;
  } {
    return db
      .prepare('SELECT agent_permission_mode, substrate, agent_runtime FROM sessions WHERE id = ?')
      .get(SESSION_ID) as {
      agent_permission_mode: string | null;
      substrate: string | null;
      agent_runtime: string | null;
    };
  }

  it("stamps a resolved 'sdk' substrate as claude-sdk and leaves the permission mode NULL when unchosen", () => {
    stampQuickSessionRuntimeConfig(db, SESSION_ID, {
      resolvedSubstrate: 'sdk',
    });

    expect(readSession()).toEqual({
      agent_permission_mode: null,
      substrate: 'sdk',
      agent_runtime: 'claude-sdk',
    });
  });

  it("stamps a resolved 'interactive' substrate as claude-interactive", () => {
    stampQuickSessionRuntimeConfig(db, SESSION_ID, {
      resolvedSubstrate: 'interactive',
    });

    expect(readSession()).toEqual({
      agent_permission_mode: null,
      substrate: 'interactive',
      agent_runtime: 'claude-interactive',
    });
  });

  it('codex-sdk wins over the substrate-derived Claude runtime', () => {
    stampQuickSessionRuntimeConfig(db, SESSION_ID, {
      resolvedSubstrate: 'sdk',
      sessionAgentRuntime: 'codex-sdk',
    });

    expect(readSession()).toEqual({
      agent_permission_mode: null,
      substrate: 'sdk',
      agent_runtime: 'codex-sdk',
    });
  });

  it("codex-pty forces substrate 'interactive' regardless of the resolved value", () => {
    stampQuickSessionRuntimeConfig(db, SESSION_ID, {
      resolvedSubstrate: 'sdk',
      sessionAgentRuntime: 'codex-pty',
    });

    expect(readSession()).toEqual({
      agent_permission_mode: null,
      substrate: 'interactive',
      agent_runtime: 'codex-pty',
    });
  });

  it('omp-sdk wins over the substrate-derived Claude runtime', () => {
    stampQuickSessionRuntimeConfig(db, SESSION_ID, {
      resolvedSubstrate: 'sdk',
      sessionAgentRuntime: 'omp-sdk',
    });

    expect(readSession()).toEqual({
      agent_permission_mode: null,
      substrate: 'sdk',
      agent_runtime: 'omp-sdk',
    });
  });

  // The sentinel run cannot carry omp-pty (it is not a STORABLE runtime), so the
  // SESSION row is the only place an OMP terminal's identity lands — and the
  // substrate force is what keeps resolvePanelLane from resolving its panels
  // into the SDK lane and losing the terminal.
  it("omp-pty forces substrate 'interactive' regardless of the resolved value", () => {
    stampQuickSessionRuntimeConfig(db, SESSION_ID, {
      resolvedSubstrate: 'sdk',
      sessionAgentRuntime: 'omp-pty',
    });

    expect(readSession()).toEqual({
      agent_permission_mode: null,
      substrate: 'interactive',
      agent_runtime: 'omp-pty',
    });
  });

  it('stamps an explicitly chosen permission mode', () => {
    stampQuickSessionRuntimeConfig(db, SESSION_ID, {
      resolvedSubstrate: 'sdk',
      requestedAgentMode: 'acceptEdits',
    });

    expect(readSession()).toEqual({
      agent_permission_mode: 'acceptEdits',
      substrate: 'sdk',
      agent_runtime: 'claude-sdk',
    });
  });
});

/**
 * The half-created-session compensation: the worktree + session row are
 * provisioned (taskQueue.createSession) BEFORE the sentinel createRun validates
 * the substrate/runtime combo, so a rejected combo throws AFTER provisioning.
 * The core is the only layer holding the session id at that point (the throw
 * pre-empts the return), so it must sweep the orphan via
 * dismissHalfCreatedSession and rethrow.
 */
describe('createQuickSessionCore — half-created session sweep', () => {
  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
  });

  function makeDeps(opts: {
    sessionId: string;
    dismissed: string[];
    dismissThrows?: boolean;
  }): CreateQuickSessionCoreDeps {
    return {
      taskQueue: { createSession: async () => ({ id: 'job-1' }) },
      sessionManager: {
        // Deliver the matching session synchronously on subscribe — the core
        // registers its listener after the createSession await, so an immediate
        // emit models the session-created event without timers.
        on: (_event, listener: (s: QuickSessionRow) => void) => {
          listener({ id: opts.sessionId, worktreePath: '/wt/arm-a' });
        },
        removeListener: () => {},
      },
      workflowRegistry: {
        ensureQuickWorkflow: () => 'wf-quick',
        createRun: () => {
          throw new Error('invalid substrate/runtime combo');
        },
      },
      getDb: () => {
        throw new Error('unreachable — createRun rejects before any db use');
      },
      dismissHalfCreatedSession: async (sessionId) => {
        if (opts.dismissThrows) throw new Error('dismiss boom');
        opts.dismissed.push(sessionId);
      },
    };
  }

  it('dismisses the provisioned session when the sentinel createRun rejects, then rethrows', async () => {
    const dismissed: string[] = [];
    const deps = makeDeps({ sessionId: 'sess-half-1', dismissed });

    await expect(
      createQuickSessionCore(deps, { projectId: 1, nameHint: 'arm-a' }),
    ).rejects.toThrow('invalid substrate/runtime combo');

    expect(dismissed).toEqual(['sess-half-1']);
  });

  it('a dismiss failure is swallowed — the ORIGINAL error still propagates', async () => {
    const deps = makeDeps({ sessionId: 'sess-half-2', dismissed: [], dismissThrows: true });

    await expect(
      createQuickSessionCore(deps, { projectId: 1, nameHint: 'arm-a' }),
    ).rejects.toThrow('invalid substrate/runtime combo');
  });
});

/**
 * The `__quick__` sentinel run carries the session's provider/runtime, and the
 * dispatch facade reads that ROW back to pick the owning manager
 * (`resolveManager(runId)`). So the gate on what gets forwarded is the
 * run-STORABLE set, not the workflow-LAUNCHABLE one: gating on "may a workflow
 * launch on this?" would silently drop the identity of a runtime that is
 * session-legal but not yet offered as a flow target, and the session would
 * misroute to Claude.
 *
 * Reuses the reject-on-createRun harness: the opts are captured before the
 * throw, so the assertion needs no DB.
 */
describe('createQuickSessionCore — sentinel runtime uses the STORABLE set', () => {
  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
  });

  type SentinelOpts = {
    requestedModel?: string;
    requestedAgentProvider?: string;
    requestedAgentRuntime?: string;
  };

  async function captureSentinelOpts(agentRuntime: string): Promise<SentinelOpts> {
    let captured: SentinelOpts = {};
    const deps: CreateQuickSessionCoreDeps = {
      taskQueue: { createSession: async () => ({ id: 'job-1' }) },
      sessionManager: {
        on: (_event, listener: (s: QuickSessionRow) => void) => {
          listener({ id: 'sess-storable', worktreePath: '/wt/arm-a' });
        },
        removeListener: () => {},
      },
      workflowRegistry: {
        ensureQuickWorkflow: () => 'wf-quick',
        createRun: (_workflowId, _substrate, _sessionId, _mode, opts) => {
          captured = { ...opts };
          throw new Error('stop after capture');
        },
      },
      getDb: () => {
        throw new Error('unreachable');
      },
      dismissHalfCreatedSession: async () => {},
    };

    await expect(
      createQuickSessionCore(deps, {
        projectId: 1,
        nameHint: 'arm-a',
        // Cast at the seam: the point of the test is what happens to a runtime
        // string the STORABLE guard has to judge, including one it rejects.
        agentRuntime: agentRuntime as CreateQuickSessionCoreOptions['agentRuntime'],
        agentProvider: 'codex',
        agentModel: 'gpt-5.4',
      }),
    ).rejects.toThrow('stop after capture');

    return captured;
  }

  it('forwards runtime, provider, and model for a storable runtime', async () => {
    expect(await captureSentinelOpts('codex-sdk')).toEqual({
      requestedAgentRuntime: 'codex-sdk',
      requestedAgentProvider: 'codex',
      requestedModel: 'gpt-5.4',
    });
  });

  it('drops the whole triple for a runtime a run row may not carry', async () => {
    expect(await captureSentinelOpts('codex-pty')).toEqual({});
  });
});

/**
 * The A/B quick-arm path (index.ts `createArmSession`), whose two halves must
 * agree: the `__quick__` SENTINEL run row carries the arm's provider/runtime
 * (the dispatch facade reads it back to pick a manager) and the SESSION row is
 * stamped separately, right after the core returns.
 *
 * The arm stamp used to test `agentRuntime === 'codex-sdk'`, so an `omp-sdk` arm
 * passed no runtime at all and stampQuickSessionRuntimeConfig derived
 * `claude-sdk` from the SDK substrate: the two rows DISAGREED, and every chat
 * turn in that arm dispatched to Claude while the run row claimed OMP. The
 * derivation is now the shared, provider-generic
 * {@link resolveNonClaudeSessionRuntime}, which is what these cases pin.
 */
describe('A/B quick-arm runtime stamp — sentinel run and session row agree', () => {
  const ARM_SESSION_ID = 'sess-arm-001';

  /** The subset of ExperimentArmQuickConfig this derivation reads. */
  interface ArmQuickConfig {
    substrate?: CliSubstrate;
    agentProvider?: AgentProvider;
    agentRuntime?: WorkflowRunStorableRuntime;
    model?: string;
    permissionMode?: PermissionMode;
  }

  interface SentinelOpts {
    requestedAgentProvider?: string;
    requestedAgentRuntime?: string;
  }

  beforeEach(() => {
    _resetClaimedQuickSessionIdsForTesting();
  });

  /**
   * What the SENTINEL run would be stamped with for this arm — captured off the
   * core with the same opts index.ts's createArmSession builds from quickConfig.
   */
  async function sentinelOptsForArm(quickConfig: ArmQuickConfig): Promise<SentinelOpts> {
    let captured: SentinelOpts = {};
    const deps: CreateQuickSessionCoreDeps = {
      taskQueue: { createSession: async () => ({ id: 'job-arm' }) },
      sessionManager: {
        on: (_event, listener: (s: QuickSessionRow) => void) => {
          listener({ id: ARM_SESSION_ID, worktreePath: '/wt/arm-a' });
        },
        removeListener: () => {},
      },
      workflowRegistry: {
        ensureQuickWorkflow: () => 'wf-quick',
        createRun: (_workflowId, _substrate, _sessionId, _mode, opts) => {
          captured = {
            ...(opts?.requestedAgentProvider !== undefined
              ? { requestedAgentProvider: opts.requestedAgentProvider }
              : {}),
            ...(opts?.requestedAgentRuntime !== undefined
              ? { requestedAgentRuntime: opts.requestedAgentRuntime }
              : {}),
          };
          throw new Error('stop after capture');
        },
      },
      getDb: () => {
        throw new Error('unreachable');
      },
      dismissHalfCreatedSession: async () => {},
    };

    await expect(
      // Mirrors index.ts createArmSession's quickConfig → core-options mapping.
      createQuickSessionCore(deps, {
        projectId: 1,
        baseCommittish: 'deadbeef',
        nameHint: 'arm-a',
        ...(quickConfig.substrate !== undefined ? { requestedSubstrate: quickConfig.substrate } : {}),
        ...(quickConfig.agentProvider !== undefined ? { agentProvider: quickConfig.agentProvider } : {}),
        ...(quickConfig.agentRuntime !== undefined ? { agentRuntime: quickConfig.agentRuntime } : {}),
        agentModel: quickConfig.model ?? null,
        ...(quickConfig.permissionMode !== undefined
          ? { requestedAgentMode: quickConfig.permissionMode }
          : {}),
      }),
    ).rejects.toThrow('stop after capture');

    return captured;
  }

  /** The SESSION row index.ts stamps for this arm, through the real helper. */
  function stampedSessionRowForArm(
    quickConfig: ArmQuickConfig,
    resolvedSubstrate: CliSubstrate = 'sdk',
  ): { substrate: string | null; agent_runtime: string | null } {
    const db = new Database(':memory:');
    try {
      db.exec(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_permission_mode TEXT,
        substrate TEXT,
        agent_runtime TEXT
      )`);
      db.prepare('INSERT INTO sessions (id) VALUES (?)').run(ARM_SESSION_ID);

      // The exact shape index.ts createArmSession now uses.
      const armSessionRuntime = resolveNonClaudeSessionRuntime(quickConfig);
      stampQuickSessionRuntimeConfig(db, ARM_SESSION_ID, {
        resolvedSubstrate,
        ...(armSessionRuntime !== undefined ? { sessionAgentRuntime: armSessionRuntime } : {}),
        ...(quickConfig.permissionMode !== undefined
          ? { requestedAgentMode: quickConfig.permissionMode }
          : {}),
      });

      return db
        .prepare('SELECT substrate, agent_runtime FROM sessions WHERE id = ?')
        .get(ARM_SESSION_ID) as { substrate: string | null; agent_runtime: string | null };
    } finally {
      db.close();
    }
  }

  it('an omp-sdk arm stamps omp/omp-sdk on the session AND the sentinel run', async () => {
    const quickConfig: ArmQuickConfig = {
      substrate: 'sdk',
      agentProvider: 'omp',
      agentRuntime: 'omp-sdk',
      model: 'anthropic/claude-haiku-4-5',
    };

    expect(await sentinelOptsForArm(quickConfig)).toEqual({
      requestedAgentProvider: 'omp',
      requestedAgentRuntime: 'omp-sdk',
    });
    // The regression: this used to come back claude-sdk while the run row above
    // said omp-sdk.
    expect(stampedSessionRowForArm(quickConfig)).toEqual({
      substrate: 'sdk',
      agent_runtime: 'omp-sdk',
    });
  });

  it('a codex-sdk arm is unchanged', async () => {
    const quickConfig: ArmQuickConfig = {
      substrate: 'sdk',
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      model: 'gpt-5.4',
    };

    expect(await sentinelOptsForArm(quickConfig)).toEqual({
      requestedAgentProvider: 'codex',
      requestedAgentRuntime: 'codex-sdk',
    });
    expect(stampedSessionRowForArm(quickConfig)).toEqual({
      substrate: 'sdk',
      agent_runtime: 'codex-sdk',
    });
  });

  it('a claude arm still derives its runtime from the RESOLVED substrate', async () => {
    const sdkArm: ArmQuickConfig = { substrate: 'sdk', agentProvider: 'claude', agentRuntime: 'claude-sdk' };
    expect(await sentinelOptsForArm(sdkArm)).toEqual({
      requestedAgentProvider: 'claude',
      requestedAgentRuntime: 'claude-sdk',
    });
    expect(stampedSessionRowForArm(sdkArm)).toEqual({ substrate: 'sdk', agent_runtime: 'claude-sdk' });

    // An explicit claude-interactive arm must NOT be treated as a non-Claude
    // runtime: it keeps flowing through the substrate derivation.
    const ptyArm: ArmQuickConfig = { substrate: 'interactive', agentRuntime: 'claude-interactive' };
    expect(stampedSessionRowForArm(ptyArm, 'interactive')).toEqual({
      substrate: 'interactive',
      agent_runtime: 'claude-interactive',
    });
  });

  it('an infra arm (no quickConfig fields at all) keeps the Claude substrate derivation', () => {
    expect(stampedSessionRowForArm({})).toEqual({ substrate: 'sdk', agent_runtime: 'claude-sdk' });
  });
});

describe('resolveNonClaudeSessionRuntime', () => {
  it('passes a non-Claude runtime through verbatim', () => {
    expect(resolveNonClaudeSessionRuntime({ agentRuntime: 'omp-sdk' })).toBe('omp-sdk');
    expect(resolveNonClaudeSessionRuntime({ agentRuntime: 'codex-sdk' })).toBe('codex-sdk');
    expect(resolveNonClaudeSessionRuntime({ agentRuntime: 'omp-pty' })).toBe('omp-pty');
  });

  it('answers undefined for Claude, whose runtime comes from the substrate', () => {
    expect(resolveNonClaudeSessionRuntime({ agentRuntime: 'claude-sdk' })).toBeUndefined();
    expect(resolveNonClaudeSessionRuntime({ agentRuntime: 'claude-interactive' })).toBeUndefined();
    expect(resolveNonClaudeSessionRuntime({ agentProvider: 'claude' })).toBeUndefined();
    expect(resolveNonClaudeSessionRuntime({})).toBeUndefined();
  });

  it('projects a bare non-Claude PROVIDER onto its structured lane', () => {
    expect(resolveNonClaudeSessionRuntime({ agentProvider: 'omp' })).toBe('omp-sdk');
    expect(resolveNonClaudeSessionRuntime({ agentProvider: 'codex' })).toBe('codex-sdk');
  });

  it('an explicit runtime OUTRANKS the provider projection', () => {
    expect(resolveNonClaudeSessionRuntime({ agentProvider: 'omp', agentRuntime: 'omp-pty' })).toBe(
      'omp-pty',
    );
  });
});
