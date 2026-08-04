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
import { stampQuickSessionRuntimeConfig } from '../createQuickSessionCore';

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
