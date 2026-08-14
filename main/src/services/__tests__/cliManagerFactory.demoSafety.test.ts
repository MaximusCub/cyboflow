import { afterAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  CliManagerFactory,
  isCodexPtyManagerLike,
  isCodexSdkManagerLike,
} from '../cliManagerFactory';
import type { ConfigManager } from '../configManager';
import type { SessionManager } from '../sessionManager';
import { DemoCliManager } from '../demo/demoCliManager';
import { CodexPtyManager } from '../panels/codex/codexPtyManager';
import { CodexSdkManager } from '../panels/codex/codexSdkManager';

describe('CliManagerFactory demo safety', () => {
  let demoMode = true;
  const configManager = {
    isDemoMode: () => demoMode,
  } as unknown as ConfigManager;
  const sessionManager = {} as unknown as SessionManager;
  const db = {
    prepare: () => {
      throw new Error('not used by manager construction');
    },
    transaction: () => {
      throw new Error('not used by manager construction');
    },
  } as unknown as Database.Database;
  const factory = CliManagerFactory.getInstance(undefined, configManager);

  afterAll(async () => {
    await factory.shutdown();
  });

  it('satisfies the Codex seam contract in demo mode without becoming a Codex manager', async () => {
    const demoSdkManager = await factory.createManager('codex-sdk', {
      sessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });
    // Mirrors boot: codex-pty omits db and reuses the handle captured above.
    const demoPtyManager = await factory.createManager('codex-pty', {
      sessionManager,
      skipValidation: true,
    });

    // Boot's narrowing is structural, so this — not `instanceof` — is what has to
    // hold. The demo manager stays an honest DemoCliManager rather than an object
    // grafted onto the real Codex prototype (which left every un-stubbed method
    // resolving to the REAL implementation).
    expect(isCodexSdkManagerLike(demoSdkManager)).toBe(true);
    expect(isCodexPtyManagerLike(demoPtyManager)).toBe(true);
    expect(demoSdkManager).toBeInstanceOf(DemoCliManager);
    expect(demoPtyManager).toBeInstanceOf(DemoCliManager);
    expect(demoSdkManager).not.toBeInstanceOf(CodexSdkManager);
    expect(demoPtyManager).not.toBeInstanceOf(CodexPtyManager);
    expect(demoSdkManager.spawnCliProcess).toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(demoPtyManager.spawnCliProcess).toBe(DemoCliManager.prototype.spawnCliProcess);
  });

  it('accepts collaborator injection but REFUSES the seams that need a real Codex runtime', async () => {
    const demoSdkManager = await factory.createManager('codex-sdk', {
      sessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });
    if (!isCodexSdkManagerLike(demoSdkManager)) throw new Error('demo manager lost its seams');

    // Boot injects these unconditionally; they must no-op, not throw.
    expect(() =>
      demoSdkManager.setCyboflowMcpRuntimeConfig({
        orchSocketPath: '/tmp/fake.sock',
        bridgeScriptPath: '/tmp/bridge.js',
        nodeExecutablePath: '/usr/bin/node',
      }),
    ).not.toThrow();
    expect(() => demoSdkManager.setApprovalRouterProvider(() => { throw new Error('unused'); })).not.toThrow();
    expect(() => demoSdkManager.setQuestionRouterProvider(() => { throw new Error('unused'); })).not.toThrow();

    // A probe or catalogue fetch can only be answered by the vendor binary, so
    // demo mode refuses loudly instead of reaching for it.
    await expect(demoSdkManager.getCodexModelCatalog()).rejects.toThrow(/unavailable in demo mode/);
    await expect(demoSdkManager.detectChatGptAccount()).rejects.toThrow(/unavailable in demo mode/);
  });

  it('returns the real Codex managers outside demo mode', async () => {
    demoMode = false;
    const normalSdkManager = await factory.createManager('codex-sdk', {
      sessionManager,
      additionalOptions: { db },
      skipValidation: true,
    });
    const normalPtyManager = await factory.createManager('codex-pty', {
      sessionManager,
      skipValidation: true,
    });

    expect(normalSdkManager).toBeInstanceOf(CodexSdkManager);
    expect(normalPtyManager).toBeInstanceOf(CodexPtyManager);
    // The real managers satisfy the same contract boot narrows against.
    expect(isCodexSdkManagerLike(normalSdkManager)).toBe(true);
    expect(isCodexPtyManagerLike(normalPtyManager)).toBe(true);
    expect(normalSdkManager.spawnCliProcess).not.toBe(DemoCliManager.prototype.spawnCliProcess);
    expect(normalPtyManager.spawnCliProcess).not.toBe(DemoCliManager.prototype.spawnCliProcess);
  });
});
