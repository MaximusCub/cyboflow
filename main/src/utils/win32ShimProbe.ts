/**
 * Windows shell-shim spawn planning.
 *
 * Node ≥ 18.20 — and therefore every Electron build this app ships on — REFUSES
 * to spawn `.cmd`/`.bat` files without a shell: spawn/execFile of a batch shim
 * throws EINVAL (CVE-2024-27980 command-injection hardening). npm-shim installs
 * of the CLIs this app probes (`claude`, `codex`, `omp`, `pi`, …) leave exactly
 * such `.cmd` shims, so every shell-less `--version` probe of one dies with
 * EINVAL — which callers misread as a broken install. Two escape hatches,
 * tried best-first:
 *
 *   1. a sibling native `<name>.exe` (the Claude agent SDK and native
 *      installers bundle one) — a plain `.exe` spawns shell-less;
 *
 *   2. the shim itself, through `cmd.exe /d /s /c` — the interpreter npm shims
 *      are written for. The whole command line is passed as ONE argument and
 *      spawned with `windowsVerbatimArguments`, so Node's argv quoting (which
 *      backslash-escapes inner quotes — cmd.exe does not understand those)
 *      never touches it, and `/s` makes cmd strip our outer quote pair. Same
 *      quoting shape cross-spawn uses; survives paths with spaces.
 *
 * Everything here is inert on POSIX: helpers either branch on an injected
 * `platform` or are only called from win32 branches.
 */
import * as fs from 'fs';

export interface ShellShimProbeInvocation {
  /** Executable to spawn (argv[0]). */
  command: string;
  /** argv for the spawn, including the version flag. */
  args: string[];
  /**
   * Pass through to the spawn's `windowsVerbatimArguments`. Set only on the
   * cmd.exe plan (see module header); direct/`.exe` plans want Node's normal
   * argv quoting.
   */
  windowsVerbatimArguments?: boolean;
}

/**
 * cmd.exe metacharacters that make a token unsafe to interpolate unquoted into
 * a `/c` command line. (`%` is absent: double-quoting does not suppress cmd's
 * %VAR% expansion, so quoting it would add nothing.)
 */
const CMD_METACHARS = /[ \t&()^<>|"]/;

const SHELL_SHIM_SUFFIX = /\.(cmd|bat)$/i;

/** True when `executablePath` is a Windows batch shim Node cannot spawn shell-less. Always false off win32. */
export function isWindowsShellShim(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && SHELL_SHIM_SUFFIX.test(executablePath);
}

/**
 * The native `<name>.exe` sitting next to a `.cmd`/`.bat` shim, or null when
 * the path is not a shim. Presence on disk is the caller's check.
 */
export function siblingNativeExecutable(executablePath: string): string | null {
  if (!SHELL_SHIM_SUFFIX.test(executablePath)) return null;
  return executablePath.replace(SHELL_SHIM_SUFFIX, '.exe');
}

/**
 * The spawn plans for a `--version` probe of `executablePath`, best-first:
 * the sibling native `.exe` when it exists, then the shim itself through
 * cmd.exe. On a path that is not a Windows shell shim this returns the direct
 * single plan, byte-identical to a plain `execFile(path, ['--version'])`.
 * `fileExists` is a test seam (defaults to fs.existsSync).
 */
export function planWindowsShimVersionProbes(
  executablePath: string,
  fileExists: (path: string) => boolean = (p) => fs.existsSync(p),
  platform: NodeJS.Platform = process.platform,
): ShellShimProbeInvocation[] {
  if (!isWindowsShellShim(executablePath, platform)) {
    return [{ command: executablePath, args: ['--version'] }];
  }

  const plans: ShellShimProbeInvocation[] = [];

  const sibling = siblingNativeExecutable(executablePath);
  if (sibling && fileExists(sibling)) {
    plans.push({ command: sibling, args: ['--version'] });
  }

  // Wrap the whole line in one extra quote pair: with /s, cmd strips the FIRST
  // and LAST quote of the /c string, leaving a correctly quoted executable plus
  // argv — even when the path has spaces.
  const needsQuotes = CMD_METACHARS.test(executablePath);
  const quoted = needsQuotes ? `"${executablePath}"` : executablePath;
  plans.push({
    command: process.env.comspec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${quoted} --version"`],
    windowsVerbatimArguments: true,
  });

  return plans;
}
