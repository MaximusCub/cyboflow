/**
 * GitDiffManager.getDiffStatsAgainstRef — the stats-only source behind the
 * session card's "files seen" / "+N −M" meter.
 *
 * The behavior that matters: diffing the WORKING TREE against a base ref counts
 * committed work too. The old source (execution_diffs, each row a diff against
 * that turn's HEAD) reported 0 for a session that commits — which is exactly
 * what a session following an atomic-commit workflow does every turn.
 *
 * Exercised against a real git repo (no mocking), mirroring the temp-repo
 * style of gitDiffManagerCumulativeStats.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GitDiffManager } from '../gitDiffManager';
import { withTempDir } from '../../__test_fixtures__/tmp';

function initRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: 'pipe' });
}

function commitAll(dir: string, message: string): void {
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
}

function headSha(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

function lines(count: number, prefix = 'line'): string {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';
}

describe('GitDiffManager.getDiffStatsAgainstRef', () => {
  it('counts COMMITTED work since the base ref — the case a HEAD-relative diff reports as zero', async () => {
    await withTempDir('gitdiff-vs-ref-', async (tmpDir) => {
      const manager = new GitDiffManager();
      initRepo(tmpDir);
      const baseSha = headSha(tmpDir);

      // A session that commits every turn: three files landed across two commits.
      fs.writeFileSync(path.join(tmpDir, 'a.ts'), lines(5));
      commitAll(tmpDir, 'turn one');
      fs.writeFileSync(path.join(tmpDir, 'b.ts'), lines(3));
      fs.writeFileSync(path.join(tmpDir, 'c.ts'), lines(2));
      commitAll(tmpDir, 'turn two');

      // The working tree is clean, so a HEAD-relative diff sees nothing at all.
      const vsHead = await manager.getDiffStatsAgainstRef(tmpDir, 'HEAD');
      expect(vsHead.stats).toEqual({ additions: 0, deletions: 0, filesChanged: 0 });

      // Against the session's branch point, every committed line is visible.
      const vsBase = await manager.getDiffStatsAgainstRef(tmpDir, baseSha);
      expect(vsBase.stats.filesChanged).toBe(3);
      expect(vsBase.stats.additions).toBe(10);
      expect(vsBase.stats.deletions).toBe(0);
      expect(vsBase.changedFiles.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });
  });

  it('sums committed, uncommitted, and untracked changes into one total', async () => {
    await withTempDir('gitdiff-vs-ref-mixed-', async (tmpDir) => {
      const manager = new GitDiffManager();
      initRepo(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'tracked.ts'), lines(4));
      commitAll(tmpDir, 'seed');
      const baseSha = headSha(tmpDir);

      // Committed: a new 6-line file.
      fs.writeFileSync(path.join(tmpDir, 'committed.ts'), lines(6));
      commitAll(tmpDir, 'committed work');

      // Uncommitted: drop 2 of the seed file's 4 lines, add 1.
      fs.writeFileSync(path.join(tmpDir, 'tracked.ts'), 'line 0\nline 1\nnew line\n');

      // Untracked: never added to the index.
      fs.writeFileSync(path.join(tmpDir, 'scratch.ts'), lines(3));

      const result = await manager.getDiffStatsAgainstRef(tmpDir, baseSha);

      expect(result.changedFiles.sort()).toEqual(['committed.ts', 'scratch.ts', 'tracked.ts']);
      expect(result.stats.filesChanged).toBe(3);
      // 6 (committed file) + 1 (rewritten line) + 3 (untracked file's lines).
      expect(result.stats.additions).toBe(10);
      expect(result.stats.deletions).toBe(2);
    });
  });

  it('counts a binary file as changed without inventing line counts', async () => {
    await withTempDir('gitdiff-vs-ref-binary-', async (tmpDir) => {
      const manager = new GitDiffManager();
      initRepo(tmpDir);
      const baseSha = headSha(tmpDir);

      // `--numstat` prints "-\t-\tpath" for binary content.
      fs.writeFileSync(path.join(tmpDir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0]));
      commitAll(tmpDir, 'add binary');

      const result = await manager.getDiffStatsAgainstRef(tmpDir, baseSha);

      expect(result.changedFiles).toEqual(['blob.bin']);
      expect(result.stats).toEqual({ additions: 0, deletions: 0, filesChanged: 1 });
    });
  });

  it('reports a clean worktree at its own branch point as zero, not as noise', async () => {
    await withTempDir('gitdiff-vs-ref-clean-', async (tmpDir) => {
      const manager = new GitDiffManager();
      initRepo(tmpDir);
      const baseSha = headSha(tmpDir);

      const result = await manager.getDiffStatsAgainstRef(tmpDir, baseSha);

      expect(result.stats).toEqual({ additions: 0, deletions: 0, filesChanged: 0 });
      expect(result.changedFiles).toEqual([]);
    });
  });
});
