/**
 * ELECTRON_RUN_AS_NODE fork-bomb guard (electronNodeGuard.ts) on the INTERACTIVE
 * (PTY) substrate's writeInteractiveMcpConfig — Phase 2 of the fork-bomb guard
 * rollout (composeMcpServers on the SDK substrate got its coverage in
 * claudeCodeManager.composeMcpServers.test.ts).
 *
 * findNodeExecutable() may resolve to process.execPath in a packaged app with no
 * standalone `node` on PATH — that path is the Cyboflow app binary, NOT a node
 * binary, so spawning it plainly boots a whole new Cyboflow app instance in an
 * unkillable loop. writeInteractiveMcpConfig folds
 * electronRunAsNodeGuardEnv(nodeCmd) into the on-disk `interactive-mcp.json`
 * config's cyboflow entry env; a real node path must leave the file
 * byte-identical to before (no ELECTRON_RUN_AS_NODE key at all).
 *
 * Design mirrors claudeCodeManager.composeMcpServers.test.ts: vi.mock stubs out
 * nodeFinder and scriptPath (no real subprocess or FS resolution beyond the
 * config write itself); a TestableInteractiveClaudeManager subclass exposes the
 * protected writeInteractiveMcpConfig() so the test can call it directly and then
 * read back the JSON it wrote to disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type Database from 'better-sqlite3';
import { makeRawEventsDb } from '../../../../orchestrator/__test_fixtures__/rawEvents';
import { InteractiveClaudeManager } from '../interactiveClaudeManager';
import type { SessionManager } from '../../../sessionManager';
import type { ConfigManager } from '../../../configManager';
import type { Logger } from '../../../../utils/logger';

// ---------------------------------------------------------------------------
// Hoisted mock controls — must be declared before vi.mock() calls
// ---------------------------------------------------------------------------

const { findNodeExecutableMock } = vi.hoisted(() => {
  const findNodeExecutableMock = vi.fn<() => Promise<string>>(async () => '/mock/path/node');
  return { findNodeExecutableMock };
});

vi.mock('../../../../utils/nodeFinder', () => ({
  findNodeExecutable: findNodeExecutableMock,
}));

vi.mock('../../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));

// ---------------------------------------------------------------------------
// Testable subclass — exposes the protected writeInteractiveMcpConfig for
// direct calls, without a real PTY / claude spawn.
// ---------------------------------------------------------------------------

class TestableInteractiveClaudeManager extends InteractiveClaudeManager {
  callWriteInteractiveMcpConfig(worktreePath: string, runId: string, sessionId: string): Promise<void> {
    return (this as unknown as {
      writeInteractiveMcpConfig(w: string, r: string, s: string): Promise<void>;
    }).writeInteractiveMcpConfig(worktreePath, runId, sessionId);
  }
}

// ---------------------------------------------------------------------------
// Minimal SessionManager stub — getDbSession returns undefined (no in_place
// flag) so interactiveMcpConfigPath always takes the worktree branch.
// ---------------------------------------------------------------------------

function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => undefined),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
    db: { updateSession: vi.fn() },
  } as unknown as SessionManager;
}

function createMockConfigManager(): ConfigManager {
  return {
    getConfig: vi.fn(() => ({})),
    getDefaultAgentPermissionMode: vi.fn(() => undefined),
  } as unknown as ConfigManager;
}

function createLoggerSpy(): { verbose: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { verbose: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface CyboflowMcpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

describe('InteractiveClaudeManager.writeInteractiveMcpConfig — ELECTRON_RUN_AS_NODE fork-bomb guard', () => {
  let db: Database.Database;
  let mgr: TestableInteractiveClaudeManager;
  let worktreePath: string;

  beforeEach(() => {
    db = makeRawEventsDb();
    findNodeExecutableMock.mockReset();
    findNodeExecutableMock.mockResolvedValue('/mock/path/node');
    worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-interactive-mcp-'));
    mgr = new TestableInteractiveClaudeManager(
      createMockSessionManager(),
      createLoggerSpy() as unknown as Logger,
      createMockConfigManager(),
      db,
    );
    mgr.setOrchSocketPath('/tmp/test.sock');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(worktreePath, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function readCyboflowEntry(): CyboflowMcpEntry {
    const configPath = path.join(worktreePath, '.cyboflow', 'interactive-mcp.json');
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { mcpServers: { cyboflow: CyboflowMcpEntry } };
    return parsed.mcpServers.cyboflow;
  }

  it("stamps ELECTRON_RUN_AS_NODE='1' into the written config's cyboflow env when findNodeExecutable resolves to process.execPath", async () => {
    findNodeExecutableMock.mockResolvedValue(process.execPath);

    await mgr.callWriteInteractiveMcpConfig(worktreePath, 'run-1', 'sess-execpath');

    const cyboflow = readCyboflowEntry();
    expect(cyboflow.command).toBe(process.execPath);
    expect(cyboflow.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('omits ELECTRON_RUN_AS_NODE entirely from the written config when findNodeExecutable resolves to a real node path', async () => {
    findNodeExecutableMock.mockResolvedValue('/usr/bin/node');

    await mgr.callWriteInteractiveMcpConfig(worktreePath, 'run-1', 'sess-realnode');

    const cyboflow = readCyboflowEntry();
    expect(cyboflow.command).toBe('/usr/bin/node');
    expect(cyboflow.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });
});
