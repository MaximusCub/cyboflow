/**
 * Behavioral tests for `getCurrentBranch` in main/src/ipc/gitOps.ts — the ops
 * implementation behind `cyboflow.sessionGit.getCurrentBranch`, which feeds the
 * sidebar's session-name hover tooltip.
 *
 * The case that motivated the guard: every git read walks UP to the nearest
 * enclosing repo, so a session whose worktree was removed (or never finished
 * being created) leaves a husk directory inside the project checkout, and an
 * unguarded read there answers with the PROJECT's branch — "main" reported
 * confidently for a session that is not on main. These use a REAL temp repo
 * with REAL `git worktree` plumbing (no git mocking), matching
 * gitCombinedDiff.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withTempDir } from '../../__test_fixtures__/tmp';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock'), getName: vi.fn(() => 'Cyboflow'), getVersion: vi.fn(() => '0.1.0') },
}));

vi.mock('../../index', () => ({ mainWindow: null }));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    createPanel: vi.fn(async () => ({ id: 'panel-git-1', state: { customState: {} } })),
    getPanelsForSession: vi.fn(() => []),
  },
}));

vi.mock('../claudePanel', () => ({
  claudePanelManager: { registerPanel: vi.fn(), startPanel: vi.fn(async () => {}) },
}));

import { createGitOps } from '../gitOps';
import type { AppServices } from '../types';

function inertDb() {
  const stmt = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
  return { prepare: () => stmt, transaction: <T>(fn: (...a: unknown[]) => T) => fn };
}

/** Init a repo whose default branch is deterministically `main`, with one commit. */
function initRepoMain(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git checkout -b main', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  execSync('git add base.txt', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m base', { cwd: dir, stdio: 'pipe' });
}

function makeServices(session: { worktreePath: string; archived?: boolean }): AppServices {
  return {
    sessionManager: {
      getSession: vi.fn(() => ({
        id: 's1',
        worktreePath: session.worktreePath,
        isMainRepo: false,
        archived: session.archived ?? false,
      })),
      getProjectForSession: vi.fn(() => ({ id: 7, name: 'Proj', path: session.worktreePath })),
    },
    gitDiffManager: {},
    worktreeManager: {},
    claudeCodeManager: {},
    gitStatusManager: {},
    databaseService: { getDb: () => inertDb() },
    configManager: { isDemoMode: () => false, getConfig: () => ({}) },
    endLiveSession: vi.fn(async () => {}),
  } as unknown as AppServices;
}

type BranchResult = { success: boolean; data?: { branch: string | null }; error?: string };

describe('sessionGit ops getCurrentBranch (real repo + real worktrees)', () => {
  it('reports a real worktree\'s own branch', async () => {
    await withTempDir('branch-worktree-', async (repo) => {
      initRepoMain(repo);
      const wt = path.join(repo, 'wt', 'feature-session');
      execSync(`git worktree add -b feature-session "${wt}"`, { cwd: repo, stdio: 'pipe' });

      const ops = createGitOps(makeServices({ worktreePath: wt }));
      const result = (await ops.getCurrentBranch({ sessionId: 's1' })) as BranchResult;

      expect(result.success).toBe(true);
      expect(result.data?.branch).toBe('feature-session');
    });
  });

  it('reports the project branch for an in-place session (worktreePath IS the checkout)', async () => {
    await withTempDir('branch-inplace-', async (repo) => {
      initRepoMain(repo);

      const ops = createGitOps(makeServices({ worktreePath: repo }));
      const result = (await ops.getCurrentBranch({ sessionId: 's1' })) as BranchResult;

      expect(result.success).toBe(true);
      expect(result.data?.branch).toBe('main');
    });
  });

  it('returns null — NOT the project branch — for a husk directory whose worktree is gone', async () => {
    await withTempDir('branch-husk-', async (repo) => {
      initRepoMain(repo);
      const wt = path.join(repo, 'worktrees', 'agent-ship-687a55b0');
      execSync(`git worktree add -b ship-branch "${wt}"`, { cwd: repo, stdio: 'pipe' });
      // Remove the registration but leave a directory behind, exactly as the
      // stale session in the field did (it still held a .claude/ subdirectory).
      execSync(`git worktree remove --force "${wt}"`, { cwd: repo, stdio: 'pipe' });
      fs.mkdirSync(path.join(wt, '.claude'), { recursive: true });

      // Precondition: a bare read here WOULD answer "main" (the enclosing repo).
      expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: wt, encoding: 'utf8' }).trim()).toBe('main');

      const ops = createGitOps(makeServices({ worktreePath: wt }));
      const result = (await ops.getCurrentBranch({ sessionId: 's1' })) as BranchResult;

      expect(result.success).toBe(true);
      expect(result.data?.branch).toBeNull();
    });
  });

  it('returns null for a directory that is not in a repo at all', async () => {
    await withTempDir('branch-norepo-', async (dir) => {
      const ops = createGitOps(makeServices({ worktreePath: dir }));
      const result = (await ops.getCurrentBranch({ sessionId: 's1' })) as BranchResult;

      expect(result.success).toBe(true);
      expect(result.data?.branch).toBeNull();
    });
  });

  it('returns null for an archived session without touching git', async () => {
    await withTempDir('branch-archived-', async (repo) => {
      initRepoMain(repo);

      const ops = createGitOps(makeServices({ worktreePath: repo, archived: true }));
      const result = (await ops.getCurrentBranch({ sessionId: 's1' })) as BranchResult;

      expect(result.success).toBe(true);
      expect(result.data?.branch).toBeNull();
    });
  });

  it('fails cleanly when the session has no worktree path', async () => {
    const ops = createGitOps(makeServices({ worktreePath: '' }));
    const result = (await ops.getCurrentBranch({ sessionId: 's1' })) as BranchResult;

    expect(result.success).toBe(false);
    expect(result.error).toContain('worktree path not found');
  });
});
