/**
 * Git discovery for GUI launches — the git twin of {@link ./nodeFinder}.
 *
 * A Start-Menu / .app launch of a GUI app does not always carry a PATH that
 * reaches git (per-user installs under %LocalAppData%, scoop shims, a trimmed
 * system PATH), and every bare `execFile('git')` then fails with ENOENT even
 * though git is installed and works fine in the user's terminal. Callers route
 * through {@link resolveGitCommand} instead, which resolves ONCE:
 *
 *   1. a probe of the resolved shell PATH (`getShellPath()`, degrading to the
 *      inherited PATH) — `git.exe` on Windows (a suffix-less `git` there is a
 *      sh script, and a `.cmd` shim would hit Node's shell-less EINVAL
 *      hardening), the bare name on POSIX;
 *   2. the standard Windows install locations (MSI, per-user, scoop);
 *   3. a last-ditch `where git` / `which git` (NodeFinder parity);
 *   4. the bare `'git'` fallback — a genuine failure is deliberately NOT
 *      cached, so a later call can retry (e.g. after the user installs git
 *      without restarting the app).
 *
 * Returning the resolved ABSOLUTE path is what fixes the GUI-launch scenario:
 * the spawn no longer depends on the child env's PATH at all. On POSIX a
 * resolved absolute path behaves identically to the bare name (same binary,
 * same argv/env/cwd), so existing POSIX behavior is unchanged.
 *
 * Memoized at module scope like nodeFinder: git call sites run on dashboard
 * refreshes, so re-running the PATH/candidate sweep per spawn would be pure
 * overhead. `clearGitExecutableCache()` and
 * {@link setGitFinderDependenciesForTest} are the test seams — all IO goes
 * through {@link GitFinderDependencies} so tests never depend on the host.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { getShellPath } from './shellPath';

/** Returned when nothing resolvable is found — the spawn will ENOENT as before. */
const GIT_FALLBACK = 'git';

export interface GitFinderDependencies {
  /** Host platform the resolution runs against (process.platform in production). */
  platform: NodeJS.Platform;
  existsSync(path: string): boolean;
  accessSync(path: string, mode: number): void;
  /**
   * The PATH to search, already resolved for the launch context (the enriched
   * shell PATH on macOS GUI launches; null when resolution fails).
   */
  shellPath(): string | null;
  /** Last-ditch `where git`/`which git`; null when it fails. */
  whereGit(): string | null;
  homeDir(): string;
  env(name: string): string | undefined;
}

let cachedGitCommand: string | null = null;
let testDependencies: Partial<GitFinderDependencies> | null = null;

/**
 * Clear the cached resolved git command (for tests, or after a git install
 * that a long-lived process should pick up).
 */
export function clearGitExecutableCache(): void {
  cachedGitCommand = null;
}

/**
 * Test seam: override individual IO dependencies (merged over the real ones)
 * so resolution can be driven without touching the host. Null restores
 * production behavior. Clears the memoized cache.
 */
export function setGitFinderDependenciesForTest(deps: Partial<GitFinderDependencies> | null): void {
  testDependencies = deps;
  cachedGitCommand = null;
}

function defaultDependencies(): GitFinderDependencies {
  return {
    platform: process.platform,
    existsSync: (p) => fs.existsSync(p),
    accessSync: (p, mode) => {
      fs.accessSync(p, mode);
    },
    shellPath: () => {
      try {
        return getShellPath();
      } catch (error) {
        console.warn('[GitExeFinder] shell PATH resolution failed; using the inherited PATH:', error);
        return null;
      }
    },
    whereGit: () => {
      try {
        const command = process.platform === 'win32' ? 'where git' : 'which git';
        const firstLine = execSync(command, { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
        return firstLine || null;
      } catch {
        return null;
      }
    },
    homeDir: () => os.homedir(),
    env: (name) => process.env[name],
  };
}

function currentDependencies(): GitFinderDependencies {
  if (!testDependencies) return defaultDependencies();
  return { ...defaultDependencies(), ...testDependencies };
}

/**
 * Resolve the command to spawn for git: an absolute path when one is found,
 * the bare `'git'` fallback otherwise. Memoized for successful resolutions.
 */
export function resolveGitCommand(): string {
  if (cachedGitCommand) {
    return cachedGitCommand;
  }
  const resolved = resolveGitCommandUncached(currentDependencies());
  if (resolved !== GIT_FALLBACK) {
    cachedGitCommand = resolved;
  }
  return resolved;
}

function resolveGitCommandUncached(deps: GitFinderDependencies): string {
  const fromPath = probePathForGit(deps);
  if (fromPath) {
    return fromPath;
  }

  if (deps.platform === 'win32') {
    for (const candidate of windowsGitCandidates(deps)) {
      if (!deps.existsSync(candidate)) continue;
      try {
        deps.accessSync(candidate, fs.constants.X_OK);
        console.log(`[GitExeFinder] Found git at: ${candidate}`);
        return candidate;
      } catch {
        // Exists but not executable — keep searching.
      }
    }

    const viaWhere = deps.whereGit();
    if (viaWhere && deps.existsSync(viaWhere)) {
      console.log(`[GitExeFinder] Found git using where: ${viaWhere}`);
      return viaWhere;
    }
  }

  console.warn(`[GitExeFinder] Could not find git executable, falling back to "${GIT_FALLBACK}"`);
  return GIT_FALLBACK;
}

/**
 * Walk the resolved PATH looking for a spawnable git. Windows: `git.exe` only
 * (a suffix-less `git` is a sh script Node cannot exec, and a `.cmd` shim is
 * refused shell-less); POSIX: the bare name.
 */
function probePathForGit(deps: GitFinderDependencies): string | null {
  const searchPath = deps.shellPath() ?? deps.env('PATH') ?? '';
  const directories = searchPath.split(path.delimiter).filter((dir) => dir.length > 0);
  const names = deps.platform === 'win32' ? ['git.exe'] : ['git'];

  for (const dir of directories) {
    for (const name of names) {
      const fullPath = path.join(dir, name);
      if (!deps.existsSync(fullPath)) continue;
      try {
        deps.accessSync(fullPath, fs.constants.X_OK);
        console.log(`[GitExeFinder] Found git in PATH: ${fullPath}`);
        return fullPath;
      } catch {
        // Not executable — keep searching.
      }
    }
  }
  return null;
}

/**
 * Standard Windows install locations, in probe order. `cmd\git.exe` (not
 * `bin\git.exe`) is the copy that runs without its bin/ shims on PATH.
 */
function windowsGitCandidates(deps: GitFinderDependencies): string[] {
  const programFiles = deps.env('ProgramFiles') ?? 'C:\\Program Files';
  const programFilesX86 = deps.env('ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
  const localAppData = deps.env('LocalAppData') ?? path.join(deps.homeDir(), 'AppData', 'Local');
  const userProfile = deps.env('USERPROFILE') ?? deps.homeDir();
  return [
    path.join(programFiles, 'Git', 'cmd', 'git.exe'),
    path.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
  ];
}

/**
 * Quote a resolved command for interpolation into a SHELL command string
 * (execSync/exec — argv is not available there). Double quotes are understood
 * by both POSIX sh and cmd.exe. Quotes only when needed, so the POSIX bare
 * `'git'` fallback interpolates byte-identically to a literal `git`.
 */
export function quoteForShellString(command: string): string {
  return /\s/.test(command) ? `"${command}"` : command;
}
