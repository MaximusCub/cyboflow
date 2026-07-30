/**
 * Exit-telemetry filtering in AbstractCliManager.setupProcessHandlers.
 *
 * Stopping a session, interrupting a turn, or quitting the app all SIGTERM the
 * interactive CLI, which exits 143. Capturing those to Sentry produced a
 * permanently-recurring "process exited (code 143)" issue (CYBOFLOW-APP-G) with
 * no defect behind it, which also buried the genuine non-zero exits.
 *
 * Coverage:
 *  - isDeliberateTermination: signal and 128+N exit-code forms; SIGKILL/OOM and
 *    ordinary failure codes still report.
 *  - the seam is suppressed for signal-terminated exits and for app-initiated
 *    killProcess teardown, but still fires for a genuine crash.
 *  - suppression does NOT change the UI failure handling (the error message is
 *    still emitted) — only telemetry is filtered.
 *  - the deliberate-kill flag cannot leak onto a later process that reuses the
 *    same panel id.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AbstractCliManager, isDeliberateTermination } from '../AbstractCliManager';
import type { SessionManager } from '../../../sessionManager';
import type { ConversationMessage } from '../../../../database/models';
import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

const captureSeamError = vi.hoisted(() => vi.fn());
vi.mock('../../../telemetry', () => ({ captureSeamError }));

class FakePty {
  readonly pid = 0;
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  onData = (cb: (d: string) => void): { dispose(): void } => {
    this.dataListeners.push(cb);
    return { dispose: () => undefined };
  };
  onExit = (cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } => {
    this.exitListeners.push(cb);
    return { dispose: () => undefined };
  };
  write(): void {}
  resize(): void {}
  kill(): void {}

  fireData(chunk: string): void {
    for (const cb of this.dataListeners) cb(chunk);
  }
  async fireExit(exitCode: number, signal?: number): Promise<void> {
    for (const cb of this.exitListeners) cb({ exitCode, signal });
    // The onExit handler is async; let its microtasks drain before asserting.
    await new Promise((r) => setImmediate(r));
  }
}

class TestCliManager extends AbstractCliManager {
  constructor() {
    super({} as unknown as SessionManager, undefined, undefined);
  }

  protected getCliToolName(): string {
    return 'testcli';
  }

  protected getAgentProvider(): 'claude' | 'codex' {
    return 'claude';
  }
  protected async testCliAvailability(): Promise<{ available: boolean }> {
    return { available: true };
  }
  protected buildCommandArgs(): string[] {
    return [];
  }
  protected async getCliExecutablePath(): Promise<string> {
    return 'sh';
  }
  protected parseCliOutput(): [] {
    return [];
  }
  protected async initializeCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }
  protected async cleanupCliResources(): Promise<void> {
    return;
  }
  protected async getCliEnvironment(): Promise<{ [key: string]: string }> {
    return {};
  }
  async startPanel(): Promise<void> {
    return;
  }
  async continuePanel(
    _panelId: string,
    _sessionId: string,
    _worktreePath: string,
    _prompt: string,
    _conversationHistory: ConversationMessage[]
  ): Promise<void> {
    return;
  }
  async stopPanel(): Promise<void> {
    return;
  }
  async restartPanelWithHistory(): Promise<void> {
    return;
  }

  driveHandlers(pty: FakePty, panelId = 'panel-1', sessionId = 'session-1'): void {
    this.setupProcessHandlers(pty as unknown as IPty, panelId, sessionId);
  }

  /** Register a fake process so killProcess() has something to tear down. */
  registerProcess(pty: FakePty, panelId = 'panel-1', sessionId = 'session-1'): void {
    this.processes.set(panelId, {
      process: pty as unknown as IPty,
      panelId,
      sessionId,
      worktreePath: '/tmp/wt',
    });
  }
}

describe('isDeliberateTermination', () => {
  it.each([
    ['SIGHUP', 1],
    ['SIGINT', 2],
    ['SIGTERM', 15],
  ])('treats a %s signal as deliberate', (_name, signal) => {
    expect(isDeliberateTermination(0, signal)).toBe(true);
  });

  it.each([
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('treats the 128+N exit code for %s as deliberate', (_name, code) => {
    expect(isDeliberateTermination(code, undefined)).toBe(true);
  });

  it('does NOT treat SIGKILL as deliberate (could be the OOM killer)', () => {
    expect(isDeliberateTermination(137, undefined)).toBe(false);
    expect(isDeliberateTermination(null, 9)).toBe(false);
  });

  it('does NOT treat ordinary failure exits as deliberate', () => {
    expect(isDeliberateTermination(1, undefined)).toBe(false);
    expect(isDeliberateTermination(127, undefined)).toBe(false);
  });
});

describe('exit seam filtering', () => {
  beforeEach(() => captureSeamError.mockClear());

  it('suppresses the seam for a SIGTERM exit', async () => {
    const mgr = new TestCliManager();
    const pty = new FakePty();
    mgr.driveHandlers(pty);
    pty.fireData('working...\n');

    await pty.fireExit(143);

    expect(captureSeamError).not.toHaveBeenCalled();
  });

  it('still reports a genuine non-zero crash', async () => {
    const mgr = new TestCliManager();
    const pty = new FakePty();
    mgr.driveHandlers(pty);
    pty.fireData('working...\n');

    await pty.fireExit(1);

    expect(captureSeamError).toHaveBeenCalledTimes(1);
    expect(captureSeamError.mock.calls[0][0]).toBe('interactive-process-exit-failed');
  });

  it('still reports a SIGKILL exit (possible OOM)', async () => {
    const mgr = new TestCliManager();
    const pty = new FakePty();
    mgr.driveHandlers(pty);

    await pty.fireExit(137);

    expect(captureSeamError).toHaveBeenCalledTimes(1);
  });

  it('suppresses the seam when the app initiated the kill, whatever the exit code', async () => {
    // An app-initiated teardown that happens to surface as a plain non-zero
    // exit rather than 143 — the intent flag is what makes this non-reportable.
    const mgr = new TestCliManager();
    const pty = new FakePty();
    mgr.driveHandlers(pty);
    mgr.registerProcess(pty);

    await mgr.killProcess('panel-1');
    await pty.fireExit(1);

    expect(captureSeamError).not.toHaveBeenCalled();
  });

  it('does not let a deliberate-kill flag leak onto the next process for that panel', async () => {
    const mgr = new TestCliManager();
    const first = new FakePty();
    mgr.driveHandlers(first);
    mgr.registerProcess(first);

    // Kill the first process; it never emits an exit, so the flag would persist
    // without the setupProcessHandlers reset.
    await mgr.killProcess('panel-1');

    const second = new FakePty();
    mgr.driveHandlers(second);
    await second.fireExit(1);

    expect(captureSeamError).toHaveBeenCalledTimes(1);
  });

  it('leaves the user-facing failure message intact when telemetry is suppressed', async () => {
    // Only Sentry reporting is filtered — the UI must still be told the process
    // died, otherwise a stopped session would look like it is still running.
    const mgr = new TestCliManager();
    const pty = new FakePty();
    const outputs: unknown[] = [];
    mgr.on('output', (e) => outputs.push(e));
    mgr.driveHandlers(pty);
    pty.fireData('working...\n');

    await pty.fireExit(143);

    expect(captureSeamError).not.toHaveBeenCalled();
    expect(outputs.length).toBeGreaterThan(0);
  });
});
