/**
 * Unit tests for stampQuickSessionRuntimeConfig — the SHARED per-session
 * runtime-config stamp chokepoint behind BOTH quick-session callers (the
 * `sessions:create-quick` IPC handler and the experiment quick-arm path,
 * index.ts createArmSession). The helper owns:
 *   - sessions.agent_permission_mode (migration 021): stamped ONLY when
 *     explicitly chosen (undefined keeps NULL = global default);
 *   - sessions.substrate + sessions.agent_runtime (migrations 027 + 059-064):
 *     ALWAYS stamped with the RESOLVED values (codex flags win over the
 *     substrate-derived Claude runtime; codex-pty forces substrate
 *     'interactive').
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createQuickSessionCore,
  stampQuickSessionRuntimeConfig,
  _resetClaimedQuickSessionIdsForTesting,
  type CreateQuickSessionCoreDeps,
  type CreateQuickSessionCoreOptions,
  type QuickSessionRow,
} from '../createQuickSessionCore';

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
      useCodexSdk: false,
      useCodexPty: false,
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
      useCodexSdk: false,
      useCodexPty: false,
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
      useCodexSdk: true,
      useCodexPty: false,
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
      useCodexSdk: false,
      useCodexPty: true,
    });

    expect(readSession()).toEqual({
      agent_permission_mode: null,
      substrate: 'interactive',
      agent_runtime: 'codex-pty',
    });
  });

  it('stamps an explicitly chosen permission mode', () => {
    stampQuickSessionRuntimeConfig(db, SESSION_ID, {
      resolvedSubstrate: 'sdk',
      useCodexSdk: false,
      useCodexPty: false,
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
