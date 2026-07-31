/**
 * snapshotProvisioner tests — run against a REAL throwaway git repo fixture
 * (no DB, no Electron). Covers captureSnapshotSha, provisionSnapshot's
 * exact-sha checkout + node_modules symlinking, the §7.2 prepared-dependency
 * mirror seam (link at the mirror when a set exists, at the live worktree when
 * it does not) and its kill switch, the typed bad-sha error, and dispose's
 * unconditional/idempotent teardown.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import {
  captureSnapshotSha,
  provisionSnapshot,
  findDependencyDirs,
  resolveDefaultDepPreparer,
  SnapshotProvisionError,
} from '../snapshotProvisioner';
import { VerifyDepPreparer, type DepExec } from '../depPreparer';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * An exec seam for VerifyDepPreparer that performs `cp` in-process and treats
 * the Electron rebuild as a recorded no-op — the preparer's own suite proves its
 * mechanics; here it only has to produce a REAL mirror on disk for the link to
 * point at.
 */
function fakeDepExec(): DepExec {
  return async (cmd, args) => {
    if (cmd === 'cp') {
      await fsPromises.cp(args[1], args[2], { recursive: true });
      return { code: 0, out: '' };
    }
    return { code: 0, out: '' };
  };
}

/** Adds the lockfile + package.json the preparer keys on (uncommitted is fine — it reads the live worktree). */
async function addPreparerInputs(dir: string): Promise<void> {
  await fsPromises.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fsPromises.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));
}

/** Initializes a fixture repo with an initial commit, config'd for CI commits. */
async function initFixtureRepo(dir: string): Promise<void> {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@cyboflow.dev']);
  git(dir, ['config', 'user.name', 'Cyboflow Test']);
  await fsPromises.writeFile(path.join(dir, 'README.md'), 'v1\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

/**
 * HERMETICITY: with no explicit `depPreparer`, provisionSnapshot resolves the
 * DEFAULT preparer, whose cache lives under `CYBOFLOW_DIR|~/.cyboflow`. A unit
 * test must never build a prepared set in the user's real data dir, so the §7.2
 * kill switch is on for every test in this file. The cases that DO exercise the
 * preparer inject their own (an explicit `depPreparer` bypasses the switch), and
 * the kill-switch test manages the variable itself.
 */
beforeEach(() => {
  process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER = '1';
});
afterEach(() => {
  delete process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER;
});

describe('snapshotProvisioner', () => {
  describe('captureSnapshotSha', () => {
    it('returns HEAD of the run worktree', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const expected = git(dir, ['rev-parse', 'HEAD']).trim();

        const sha = await captureSnapshotSha(dir);

        expect(sha).toBe(expected);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
      });
    });
  });

  describe('provisionSnapshot', () => {
    it('checks out the exact recorded sha, not a later commit', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const snapshotSha = await captureSnapshotSha(dir);

        // A later commit changes the file's content in the run worktree.
        await fsPromises.writeFile(path.join(dir, 'README.md'), 'v2 (later commit)\n');
        git(dir, ['add', '.']);
        git(dir, ['commit', '-q', '-m', 'later commit']);

        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });
        try {
          expect(provision.sha).toBe(snapshotSha);
          const content = await fsPromises.readFile(path.join(provision.worktreePath, 'README.md'), 'utf8');
          expect(content).toBe('v1\n');
        } finally {
          await provision.dispose();
        }
      });
    });

    it('a dirty run worktree (concurrent-lane edits) still snapshots the recorded sha cleanly', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const snapshotSha = await captureSnapshotSha(dir);

        // Simulate sibling lanes mid-edit in the shared worktree: an uncommitted
        // tracked change AND an untracked file. Neither may leak into the snapshot.
        await fsPromises.writeFile(path.join(dir, 'README.md'), 'sibling lane mid-edit\n');
        await fsPromises.writeFile(path.join(dir, 'sibling-untracked.ts'), 'wip\n');

        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });
        try {
          expect(provision.sha).toBe(snapshotSha);
          const content = await fsPromises.readFile(path.join(provision.worktreePath, 'README.md'), 'utf8');
          expect(content).toBe('v1\n');
          await expect(
            fsPromises.access(path.join(provision.worktreePath, 'sibling-untracked.ts')),
          ).rejects.toThrow();
        } finally {
          await provision.dispose();
        }
      });
    });

    it('symlinks node_modules dirs (root + nested) and skips scanning inside node_modules', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);

        // Root-level node_modules with a marker file.
        await fsPromises.mkdir(path.join(dir, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'node_modules', 'marker.txt'), 'root-marker\n');

        // A nested workspace node_modules.
        await fsPromises.mkdir(path.join(dir, 'sub', 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'sub', 'node_modules', 'marker.txt'), 'sub-marker\n');
        // `sub` itself must exist in the snapshot's checked-out tree for the
        // link to land — track it via a placeholder file and commit.
        await fsPromises.writeFile(path.join(dir, 'sub', 'keep.txt'), 'keep\n');
        git(dir, ['add', 'sub/keep.txt']);
        git(dir, ['commit', '-q', '-m', 'add sub dir']);

        // node_modules-inside-node_modules: must never be scanned as an
        // independent top-level dependency dir.
        await fsPromises.mkdir(path.join(dir, 'node_modules', 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(dir, 'node_modules', 'node_modules', 'inner.txt'), 'inner\n');

        const found = await findDependencyDirs(dir);
        const relFound = found.map((f) => path.relative(dir, f)).sort();
        expect(relFound).toEqual(['node_modules', 'sub/node_modules'].sort());
        expect(relFound).not.toContain(path.join('node_modules', 'node_modules'));

        const snapshotSha = await captureSnapshotSha(dir);
        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });
        try {
          const rootMarker = await fsPromises.readFile(
            path.join(provision.worktreePath, 'node_modules', 'marker.txt'),
            'utf8',
          );
          expect(rootMarker).toBe('root-marker\n');

          const subMarker = await fsPromises.readFile(
            path.join(provision.worktreePath, 'sub', 'node_modules', 'marker.txt'),
            'utf8',
          );
          expect(subMarker).toBe('sub-marker\n');

          const rootLinkStat = await fsPromises.lstat(path.join(provision.worktreePath, 'node_modules'));
          expect(rootLinkStat.isSymbolicLink()).toBe(true);
          const subLinkStat = await fsPromises.lstat(path.join(provision.worktreePath, 'sub', 'node_modules'));
          expect(subLinkStat.isSymbolicLink()).toBe(true);
        } finally {
          await provision.dispose();
        }
      });
    });

    it('links dependency dirs at the PREPARED MIRROR when a prepared set exists (§7.2)', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        const worktree = path.join(dir, 'worktree');
        await fsPromises.mkdir(worktree, { recursive: true });
        await initFixtureRepo(worktree);
        await addPreparerInputs(worktree);
        await fsPromises.mkdir(path.join(worktree, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(worktree, 'node_modules', 'marker.txt'), 'live-marker\n');

        const baseDir = path.join(dir, 'verify-deps');
        const depPreparer = new VerifyDepPreparer({ baseDir, exec: fakeDepExec() });
        const snapshotSha = await captureSnapshotSha(worktree);

        const provision = await provisionSnapshot({ runWorktreePath: worktree, snapshotSha, depPreparer });
        try {
          const linkPath = path.join(provision.worktreePath, 'node_modules');
          const target = await fsPromises.readlink(linkPath);

          // The link points INTO the disposable prepared-set cache, not at the
          // shared worktree — so a write-through cannot flip a sibling lane's ABI.
          expect(target.startsWith(baseDir + path.sep)).toBe(true);
          expect(path.basename(target)).toBe('node_modules');
          expect(target).not.toBe(path.join(worktree, 'node_modules'));
          // …and it is a usable mirror of the live tree.
          expect(await fsPromises.readFile(path.join(linkPath, 'marker.txt'), 'utf8')).toBe('live-marker\n');
        } finally {
          await provision.dispose();
        }
      });
    });

    it('links at the LIVE worktree dirs when the preparer declines (no prepared set)', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        const worktree = path.join(dir, 'worktree');
        await fsPromises.mkdir(worktree, { recursive: true });
        await initFixtureRepo(worktree);
        // No lockfile ⇒ the preparer has no stable key and returns null.
        await fsPromises.mkdir(path.join(worktree, 'node_modules'), { recursive: true });
        await fsPromises.writeFile(path.join(worktree, 'node_modules', 'marker.txt'), 'live-marker\n');

        const depPreparer = new VerifyDepPreparer({ baseDir: path.join(dir, 'verify-deps'), exec: fakeDepExec() });
        const snapshotSha = await captureSnapshotSha(worktree);

        const provision = await provisionSnapshot({ runWorktreePath: worktree, snapshotSha, depPreparer });
        try {
          const target = await fsPromises.readlink(path.join(provision.worktreePath, 'node_modules'));
          expect(target).toBe(path.join(worktree, 'node_modules'));
        } finally {
          await provision.dispose();
        }
      });
    });

    it('depPreparer: null is the pre-§7.2 behavior verbatim (live-worktree symlinks, no cache built)', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        const worktree = path.join(dir, 'worktree');
        await fsPromises.mkdir(worktree, { recursive: true });
        await initFixtureRepo(worktree);
        await addPreparerInputs(worktree);
        await fsPromises.mkdir(path.join(worktree, 'node_modules'), { recursive: true });

        const snapshotSha = await captureSnapshotSha(worktree);
        const provision = await provisionSnapshot({ runWorktreePath: worktree, snapshotSha, depPreparer: null });
        try {
          const target = await fsPromises.readlink(path.join(provision.worktreePath, 'node_modules'));
          expect(target).toBe(path.join(worktree, 'node_modules'));
        } finally {
          await provision.dispose();
        }
      });
    });

    it('throws a typed SnapshotProvisionError for a sha that does not resolve', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);

        await expect(
          provisionSnapshot({ runWorktreePath: dir, snapshotSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
        ).rejects.toMatchObject({ name: 'SnapshotProvisionError', code: 'bad_sha' });

        try {
          await provisionSnapshot({ runWorktreePath: dir, snapshotSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' });
        } catch (err) {
          expect(err).toBeInstanceOf(SnapshotProvisionError);
        }
      });
    });

    it('dispose removes the worktree and is idempotent', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const snapshotSha = await captureSnapshotSha(dir);
        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });

        await provision.dispose();

        await expect(fsPromises.access(provision.worktreePath)).rejects.toThrow();
        const worktreeList = git(dir, ['worktree', 'list', '--porcelain']);
        expect(worktreeList).not.toContain(provision.worktreePath);

        // Idempotent: a second dispose() must not throw.
        await expect(provision.dispose()).resolves.toBeUndefined();
      });
    });

    it('dispose after manual deletion of the worktree dir does not throw', async () => {
      await withTempDir('snapshot-provisioner-', async (dir) => {
        await initFixtureRepo(dir);
        const snapshotSha = await captureSnapshotSha(dir);
        const provision = await provisionSnapshot({ runWorktreePath: dir, snapshotSha });

        await fsPromises.rm(provision.worktreePath, { recursive: true, force: true });

        await expect(provision.dispose()).resolves.toBeUndefined();
      });
    });
  });

  describe('resolveDefaultDepPreparer', () => {
    it('CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER=1 disables the default preparer (rollback lever)', () => {
      // Set by the file-wide beforeEach — this is the assertion that it bites.
      expect(resolveDefaultDepPreparer()).toBeNull();
    });

    it('resolves (and memoizes) a preparer rooted at <CYBOFLOW_DIR>/verify-deps when enabled', async () => {
      await withTempDir('snapshot-provisioner-cyboflow-dir-', async (dir) => {
        const previousDir = process.env.CYBOFLOW_DIR;
        delete process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER;
        process.env.CYBOFLOW_DIR = dir;
        try {
          const first = resolveDefaultDepPreparer();
          expect(first).toBeInstanceOf(VerifyDepPreparer);
          // Memoized per base dir — the same instance, not a new one per call.
          expect(resolveDefaultDepPreparer()).toBe(first);
          // Resolution is lazy AND inert: nothing is created until a real
          // prepare() actually builds a set.
          await expect(fsPromises.access(path.join(dir, 'verify-deps'))).rejects.toThrow();
        } finally {
          if (previousDir === undefined) delete process.env.CYBOFLOW_DIR;
          else process.env.CYBOFLOW_DIR = previousDir;
        }
      });
    });
  });
});
