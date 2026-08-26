/**
 * agentProviderGuard's two most load-bearing installations, exercised against
 * the real main-side modules they guard.
 *
 * The guard exists because gating only the CREATE seams left every already-open
 * session able to keep issuing turns: a follow-up turn never re-enters a launch
 * path, so switching a provider off did nothing to a live chat. These tests lock
 * the call-level behavior:
 *   - loadSdkQuery — the single chokepoint every Claude `query()` resolves
 *     through, on EVERY call — refuses while Claude is off, and recovers the
 *     moment it is switched back on (no restart);
 *   - AbstractCliManager.spawnCliProcess refuses a cold spawn for a
 *     switched-off provider before probing CLI availability;
 *   - relayOrSpawnPtyPanel refuses a keystroke into an ALREADY-LIVE PTY, the
 *     path that never respawns and so is invisible to the spawn guard.
 *
 * The guard module's own pure behavior (default resolver, fail-open on a
 * throwing resolver, the IPC message helper) is tested independently of any
 * main-side consumer at shared/agents/__tests__/agentProviderGuard.test.ts —
 * this file covers only the main-side integrations, which is why it stays
 * here rather than moving with the guard itself.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  AgentProviderDisabledError,
  setAgentProviderAccessResolver,
} from '../../../../shared/agents/agentProviderGuard';
import { loadSdkQuery } from '../../utils/lazyAgentSdk';
import { relayOrSpawnPtyPanel } from '../../ipc/ptyPanelDispatch';
import { AbstractCliManager } from '../panels/cli/AbstractCliManager';

afterEach(() => {
  // Never leak an installed resolver across files.
  setAgentProviderAccessResolver(null);
});

describe('loadSdkQuery — the Claude SDK call-level guard', () => {
  it('rejects every Claude SDK call while Claude is switched off', async () => {
    setAgentProviderAccessResolver((p) => p !== 'claude');

    // Synchronous throw (not a rejected promise) is fine for callers, which all
    // `await loadSdkQuery()` inside a try/catch or an async function.
    expect(() => loadSdkQuery()).toThrow(AgentProviderDisabledError);
  });

  it('resolves the query fn again as soon as Claude is switched back on', async () => {
    setAgentProviderAccessResolver((p) => p !== 'claude');
    expect(() => loadSdkQuery()).toThrow(AgentProviderDisabledError);

    // The assert runs per call — the cached module promise must not have latched
    // the refusal, so flipping the toggle back on works without a restart.
    setAgentProviderAccessResolver(null);
    await expect(loadSdkQuery()).resolves.toBeTypeOf('function');
  });

  it('leaves the Claude SDK reachable while only Codex is off', async () => {
    setAgentProviderAccessResolver((p) => p !== 'codex');
    await expect(loadSdkQuery()).resolves.toBeTypeOf('function');
  });
});

describe('AbstractCliManager.spawnCliProcess — the spawn guard', () => {
  /**
   * Minimal concrete subclass. `testCliAvailability` records whether it ran: the
   * guard must refuse BEFORE the availability probe, so a switched-off provider
   * reads as "turned off" rather than "CLI unavailable".
   */
  function makeManager(provider: 'claude' | 'codex', availabilityProbe: () => void) {
    class TestManager extends AbstractCliManager {
      constructor() {
        super({} as never, undefined, undefined);
      }
      protected getCliToolName(): string {
        return 'testcli';
      }
      protected getAgentProvider(): 'claude' | 'codex' {
        return provider;
      }
      protected async testCliAvailability(): Promise<{ available: boolean }> {
        availabilityProbe();
        return { available: true };
      }
      // The remaining abstract surface is never reached: the guard refuses ahead
      // of every one of them.
      protected buildCommandArgs(): string[] {
        return [];
      }
      protected async getCliExecutablePath(): Promise<string> {
        return 'true';
      }
      protected parseCliOutput(): never[] {
        return [];
      }
      protected async initializeCliEnvironment(): Promise<Record<string, string>> {
        return {};
      }
      protected async cleanupCliResources(): Promise<void> {}
      protected async getCliEnvironment(): Promise<Record<string, string>> {
        return {};
      }
      async startPanel(): Promise<void> {}
      async continuePanel(): Promise<void> {}
      async stopPanel(): Promise<void> {}
      async restartPanelWithHistory(): Promise<void> {}
    }
    return new TestManager();
  }

  it('refuses a spawn for a switched-off provider before probing availability', async () => {
    const probe = vi.fn();
    const manager = makeManager('codex', probe);
    setAgentProviderAccessResolver((p) => p !== 'codex');

    await expect(
      manager.spawnCliProcess({
        panelId: 'p1',
        sessionId: 's1',
        worktreePath: '/repo',
        prompt: 'hi',
      } as never),
    ).rejects.toThrow(AgentProviderDisabledError);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('relayOrSpawnPtyPanel — the live-PTY relay guard', () => {
  /** Minimal deps for a codex-pty panel whose REPL is already running. */
  function makeDeps(relayUserTurn: ReturnType<typeof vi.fn>) {
    const ptyManager = { isPanelRunning: () => true, relayUserTurn };
    return {
      deps: {
        sessionManager: {
          getDbSession: () => ({ agent_runtime: 'codex-pty', substrate: 'interactive' }),
          getSession: async () => ({ worktreePath: '/repo' }),
          updateSession: vi.fn(),
        },
        databaseService: { getPanelSettings: () => ({}) },
        configManager: { isDemoMode: () => false },
        codexPtyManager: ptyManager,
        interactiveCliManager: ptyManager,
      },
      panel: { id: 'panel-1', sessionId: 'sess-1' },
    };
  }

  it('refuses a turn relayed into a live REPL when its provider is off', async () => {
    const relayUserTurn = vi.fn();
    const { deps, panel } = makeDeps(relayUserTurn);
    setAgentProviderAccessResolver((p) => p !== 'codex');

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double for the deps bag
      relayOrSpawnPtyPanel(deps as any, panel, 'another turn'),
    ).rejects.toThrow(AgentProviderDisabledError);
    // The whole point: an open terminal chat must not keep working.
    expect(relayUserTurn).not.toHaveBeenCalled();
  });

  it('relays normally while the provider is on', async () => {
    const relayUserTurn = vi.fn();
    const { deps, panel } = makeDeps(relayUserTurn);

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double for the deps bag
      relayOrSpawnPtyPanel(deps as any, panel, 'another turn'),
    ).resolves.toBe(true);
    expect(relayUserTurn).toHaveBeenCalledWith('panel-1', 'another turn');
  });
});
