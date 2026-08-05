/**
 * peekabooExecutablePath — where the `peekaboo` capture binary lives.
 *
 * The binary SHIPS INSIDE the app (an `optionalDependencies` entry, unpacked
 * out of the asar) rather than being resolved off the user's PATH. Two reasons,
 * the second the load-bearing one:
 *
 *  1. It is a hard prerequisite for the native-screen modality, and a
 *     prerequisite the user has to go and install by hand is one most users
 *     never satisfy.
 *  2. macOS TCC grants attach to a BINARY, and an `npx`-resolved peekaboo lives
 *     under a content-hashed cache path that changes on every version bump.
 *     Every bump silently revoked the grants and reported them as declined. A
 *     path inside the app bundle is stable, and the grant survives.
 *
 * Deliberately NO electron import, so this is unit-testable: `index.ts` passes
 * `app.isPackaged` and `process.resourcesPath` in. It mirrors
 * `codexExecutablePath.ts`, which does the same job for the Codex binary — the
 * precedent for vendoring a third-party native executable here.
 *
 * The PATH fallback is kept as a last resort. A user who already had peekaboo
 * installed keeps working exactly as before, and a broken bundle degrades to
 * the old behaviour instead of to nothing.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Package + entry the binary ships in. See the deprecation note in {@link resolvePeekabooExecutable}. */
export const PEEKABOO_PACKAGE = '@steipete/peekaboo-mcp';
const PEEKABOO_ENTRYPOINT = 'peekaboo';

/** The bare command name, used when nothing better resolves. */
export const PEEKABOO_PATH_FALLBACK = 'peekaboo';

export interface PeekabooExecutableDeps {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.resourcesPath` — absent outside a packaged app. */
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  existsSync?: (p: string) => boolean;
  /** Resolve the package's own package.json, as `require.resolve` would. */
  resolvePackageJson?: (name: string) => string;
}

function defaultResolvePackageJson(name: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require.resolve(`${name}/package.json`);
}

/**
 * The absolute path to the bundled binary, or the bare command name when no
 * bundled copy is present.
 *
 * NEVER returns a path that does not exist: a non-existent absolute path would
 * make the grant probe report "binary missing" while a perfectly good peekaboo
 * sat on PATH.
 *
 * Off macOS this is always the bare name. The binary is darwin-only (the
 * package declares `os: ["darwin"]`, which is why it is an OPTIONAL dependency
 * — a required one would fail `pnpm install` on the Linux CI runners), so on
 * any other platform there is nothing bundled to find and the caller's probe
 * will simply report it absent.
 *
 * VERSION NOTE: the package is deprecated upstream in favour of
 * `@steipete/peekaboo` v3, which we do not use yet — v3 ships a 52 MB binary
 * plus a sidecar dylib against this one's 2.2 MB, for a capture-only fallback
 * path. `parsePermissionsJson` already reads v3's output shape, so the bump is
 * a one-line change here when the size is worth paying.
 */
export function resolvePeekabooExecutable(deps: PeekabooExecutableDeps): string {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return PEEKABOO_PATH_FALLBACK;

  const exists = deps.existsSync ?? fs.existsSync;
  for (const candidate of bundledCandidates(deps)) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // An unreadable candidate is not the one; keep looking.
    }
  }
  return PEEKABOO_PATH_FALLBACK;
}

/**
 * Where a bundled copy could be, most-specific first.
 *
 * Packaged builds look under `app.asar.unpacked` — the binary CANNOT be read
 * from inside the asar archive, and `asarUnpack` in package.json is what puts
 * it there. Dev builds resolve through the node_modules graph, which pnpm's
 * symlinked layout makes non-obvious enough that guessing a relative path would
 * be wrong.
 */
function bundledCandidates(deps: PeekabooExecutableDeps): string[] {
  const candidates: string[] = [];
  if (deps.isPackaged && deps.resourcesPath) {
    candidates.push(
      path.join(
        deps.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        PEEKABOO_PACKAGE,
        PEEKABOO_ENTRYPOINT,
      ),
    );
  }
  try {
    const packageJson = (deps.resolvePackageJson ?? defaultResolvePackageJson)(PEEKABOO_PACKAGE);
    candidates.push(path.join(path.dirname(packageJson), PEEKABOO_ENTRYPOINT));
  } catch {
    // Not installed (a non-darwin install, or the optional dependency skipped)
    // — the PATH fallback covers it.
  }
  return candidates;
}
