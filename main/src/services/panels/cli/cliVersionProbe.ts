import { execFileSync } from 'child_process';
import { findCliNodeScript, findNodeExecutable } from '../../../utils/nodeFinder';

const VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * `#!/usr/bin/env <interpreter>` failing because <interpreter> is not on the
 * child's PATH. The canonical case: a CLI installed via `npm i -g` leaves a
 * `#!/usr/bin/env node` shim in ~/.local/bin (or ~/.npm-global/bin), the user's
 * `node` comes from a version manager (nvm/fnm/volta/asdf) that only exports
 * itself from an interactive rc file, and a GUI-launched Electron app inherits
 * launchd's PATH — so the shim resolves but its interpreter does not.
 *
 * Kept as a message-shape match on purpose: execve's ENOENT for a missing
 * shebang interpreter surfaces only as `env`'s stderr text, with no distinct
 * errno on the parent side.
 */
const MISSING_INTERPRETER_PATTERN = /\benv:\s*([\w.\-+/]+):\s*No such file or directory/;

/**
 * Extract the missing shebang interpreter (e.g. `node`) from a failed spawn's
 * message, or null when the failure is anything else. Callers use this both to
 * decide whether the Node fallback is worth attempting and to render a
 * diagnosis instead of a misleading "please install it" instruction.
 */
export function describeMissingInterpreter(message: string | undefined): string | null {
  if (!message) return null;
  const match = MISSING_INTERPRETER_PATTERN.exec(message);
  return match ? match[1] : null;
}

export interface CliVersionProbeDependencies {
  runCommand?: (command: string, args: string[], env: NodeJS.ProcessEnv) => string;
  resolveNodeScript?: (executablePath: string) => string | null;
  resolveNodeExecutable?: () => Promise<string>;
  execPath?: string;
}

export interface CliVersionProbeResult {
  version: string;
  /**
   * True when the direct invocation failed on a missing shebang interpreter and
   * the version only came back through an explicit Node invocation. The caller
   * MUST propagate this to the spawn path: node-pty forks before it execs, so a
   * shebang failure inside the child never throws on the parent side — the PTY
   * would just print `env: node: No such file or directory` and exit.
   */
  usedNodeFallback: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultRunCommand(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: VERSION_PROBE_TIMEOUT_MS,
    env,
  });
}

/**
 * Probe a CLI's `--version` using the SAME environment the real spawn will use,
 * falling back to an explicit Node invocation when the executable is a script
 * whose interpreter is missing.
 *
 * Probing with the bare Electron `process.env` (what this replaced) made the
 * availability gate strictly harsher than the spawn it guards:
 * AbstractCliManager.getSystemEnvironment prepends findNodeExecutable()'s
 * directory to the enriched shell PATH, so an npm-shim CLI that fails a bare
 * probe would have run fine — but the gate rejected it before the spawn was
 * ever attempted.
 */
export async function probeCliVersion(
  executablePath: string,
  env: NodeJS.ProcessEnv,
  dependencies: CliVersionProbeDependencies = {},
): Promise<CliVersionProbeResult> {
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const resolveNodeScript = dependencies.resolveNodeScript ?? findCliNodeScript;
  const resolveNodeExecutable = dependencies.resolveNodeExecutable ?? findNodeExecutable;
  const execPath = dependencies.execPath ?? process.execPath;

  let directError: unknown;
  try {
    return {
      version: runCommand(executablePath, ['--version'], env).trim(),
      usedNodeFallback: false,
    };
  } catch (error) {
    directError = error;
  }

  const message = errorMessage(directError);
  if (!describeMissingInterpreter(message)) {
    throw directError;
  }

  const scriptPath = resolveNodeScript(executablePath) ?? executablePath;
  const nodePath = await resolveNodeExecutable();
  // Fork-bomb guard, mirroring AbstractCliManager.spawnPtyProcess: when
  // findNodeExecutable falls back to the packaged Electron binary, it must run
  // as plain Node instead of re-booting the whole app.
  const nodeEnv = nodePath === execPath ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env;
  const nodeArgs =
    scriptPath === executablePath
      ? [executablePath, '--version']
      : ['--no-warnings', '--enable-source-maps', scriptPath, '--version'];

  try {
    return {
      version: runCommand(nodePath, nodeArgs, nodeEnv).trim(),
      usedNodeFallback: true,
    };
  } catch (fallbackError) {
    throw new Error(
      `${message} (Node fallback via ${nodePath} also failed: ${errorMessage(fallbackError)})`,
    );
  }
}
