import { describe, expect, it } from 'vitest';
import { CodexPtyManager, codexPermissionFlagsForMode } from '../codexPtyManager';
import type { SessionManager } from '../../../sessionManager';

class TestableCodexPtyManager extends CodexPtyManager {
  callBuildCommandArgs(options: Record<string, unknown>): string[] {
    return this.buildCommandArgs({
      panelId: 'panel-1',
      sessionId: 'session-1',
      worktreePath: '/tmp/worktree',
      prompt: '',
      ...options,
    });
  }

  captureConcurrentContext(
    context: { panelId: string; sessionId: string; runId: string },
    delayMs: number,
  ): Promise<{ panelId: string; sessionId: string; runId: string } | undefined> {
    return this.runWithPtySpawnContext(context, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      return this.getActivePtySpawnContext();
    });
  }

  // Test accessors for the private per-panel bookkeeping cleanupCliResources
  // touches, so its panel-scoping can be verified without a real PTY spawn.
  private maps(): { panelRunIds: Map<string, string>; ptyBacklog: Map<string, string> } {
    return this as unknown as { panelRunIds: Map<string, string>; ptyBacklog: Map<string, string> };
  }
  seedPanelRunId(panelId: string, runId: string): void {
    this.maps().panelRunIds.set(panelId, runId);
  }
  seedPtyBacklog(runId: string, data: string): void {
    this.maps().ptyBacklog.set(runId, data);
  }
  hasPanelRunId(panelId: string): boolean {
    return this.maps().panelRunIds.has(panelId);
  }
  hasPtyBacklog(runId: string): boolean {
    return this.maps().ptyBacklog.has(runId);
  }
  callCleanupCliResources(panelId: string, sessionId: string): Promise<void> {
    return (this as unknown as { cleanupCliResources(p: string, s: string): Promise<void> }).cleanupCliResources(
      panelId,
      sessionId,
    );
  }
}

function makeSessionManager(mode?: string): SessionManager {
  return {
    getDbSession: () => ({ agent_permission_mode: mode }),
  } as unknown as SessionManager;
}

describe('codexPermissionFlagsForMode', () => {
  it('maps Cyboflow permission modes to Codex sandbox and approval flags', () => {
    expect(codexPermissionFlagsForMode('default')).toEqual({
      sandbox: 'read-only',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('acceptEdits')).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('auto')).toEqual({
      sandbox: 'workspace-write',
      approval: 'on-request',
    });
    expect(codexPermissionFlagsForMode('dontAsk')).toEqual({
      sandbox: 'danger-full-access',
      approval: 'never',
    });
  });
});

describe('CodexPtyManager.buildCommandArgs', () => {
  it('uses the session agent permission mode and passes model plus prompt after --', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager('acceptEdits'));

    expect(manager.callBuildCommandArgs({ model: 'gpt-5.5', prompt: 'implement this' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--model',
      'gpt-5.5',
      '--',
      'implement this',
    ]);
  });

  it('omits a stale Claude model', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager('acceptEdits'));

    expect(manager.callBuildCommandArgs({ model: 'opus', prompt: 'implement this' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
      '--',
      'implement this',
    ]);
  });

  it('omits auto so the Codex runtime selects its advertised default', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager('acceptEdits'));

    expect(manager.callBuildCommandArgs({ model: 'auto' })).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ]);
  });

  it('maps legacy ignore to dontAsk for compatibility with old session rows', () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());

    expect(manager.callBuildCommandArgs({ permissionMode: 'ignore' })).toEqual([
      '--sandbox',
      'danger-full-access',
      '--ask-for-approval',
      'never',
    ]);
  });
});

describe('CodexPtyManager concurrent spawn context', () => {
  it('keeps interleaved PTY spawn provenance isolated', async () => {
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const first = { panelId: 'panel-1', sessionId: 'session-1', runId: 'run-1' };
    const second = { panelId: 'panel-2', sessionId: 'session-2', runId: 'run-2' };

    const [capturedFirst, capturedSecond] = await Promise.all([
      manager.captureConcurrentContext(first, 10),
      manager.captureConcurrentContext(second, 0),
    ]);

    expect(capturedFirst).toEqual(first);
    expect(capturedSecond).toEqual(second);
  });
});

describe('CodexPtyManager.cleanupCliResources', () => {
  it('scopes cleanup to the exiting panel only — a sibling panel sharing the same session keeps its bookkeeping', async () => {
    // Regression: cleanupCliResources used to scan `this.processes` for every
    // panel matching the SESSION id and delete each one's panelRunIds/
    // ptyBacklog entry, so one panel's exit tore down a still-live sibling
    // panel's bookkeeping too (both panels in one session share the id).
    const manager = new TestableCodexPtyManager(makeSessionManager());
    const sharedSessionId = 'session-shared';
    manager.seedPanelRunId('panel-A', 'run-A');
    manager.seedPtyBacklog('run-A', 'A output');
    manager.seedPanelRunId('panel-B', 'run-B');
    manager.seedPtyBacklog('run-B', 'B output');

    await manager.callCleanupCliResources('panel-A', sharedSessionId);

    // Only panel-A's bookkeeping is gone.
    expect(manager.hasPanelRunId('panel-A')).toBe(false);
    expect(manager.hasPtyBacklog('run-A')).toBe(false);
    // panel-B (still live, same session) is untouched.
    expect(manager.hasPanelRunId('panel-B')).toBe(true);
    expect(manager.hasPtyBacklog('run-B')).toBe(true);
  });
});
