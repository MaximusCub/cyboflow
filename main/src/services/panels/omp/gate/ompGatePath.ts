/**
 * ompGatePath — resolve the on-disk path of the OMP gating extension so the
 * spawner can pass it as `omp -e <path>`.
 *
 * ===========================================================================
 * THE ASSET IS THE TYPESCRIPT SOURCE, NOT THE COMPILED .js — MEASURED
 * ===========================================================================
 * Every other cyboflow script handed to a foreign process (the MCP server, the
 * shell hooks) ships as compiled CommonJS, and the obvious move here was to do
 * the same. It does not work. Probed against the real `omp` v17.3.2 binary
 * (`omp --mode rpc ... -e <file>`, watching for the load sentinel):
 *
 *   -e <tsc CommonJS output>                    → "Extension does not export a
 *                                                  valid factory function"
 *   -e <same, plus `module.exports = fn`>       → same failure
 *   -e <the .ts source>                         → loads, sentinel written
 *
 * OMP's loader reads `module.default` off the imported module
 * (`extensibility/extensions/loader.ts:55-59`) and Bun's dynamic import of a
 * TypeScript-emitted CJS file does not surface `exports.default` there, despite
 * the `__esModule` marker. OMP's own contract is a TS/JS module with a real
 * ESM default export (`docs/extensions.md:17-27`), and Bun compiles TypeScript
 * natively — so the source file IS the shippable artifact.
 *
 * A second probe (loading the source from a directory containing nothing else)
 * confirmed Bun erases the `import type { ... } from './ompGateTypes'`
 * declaration, so `ompGateExtension.ts` ships ALONE — no sibling types file, no
 * bundler step.
 *
 * Deps are INJECTED rather than importing `electron`, following
 * `peekabooExecutablePath.ts` / `codexExecutablePath.ts`, so this stays
 * unit-testable without a module mock.
 *
 * ===========================================================================
 * PACKAGING — the asset is an extraResource, not an asar member
 * ===========================================================================
 * `package.json` `build.files` ships `main/dist/**`, which is compiled output;
 * the gate's `.ts` source under `main/src/` is not in it, and a file inside
 * `app.asar` would be unreadable by the `omp` child process anyway. The
 * `asarUnpack` route used for the MCP server and shell hooks does not apply
 * either — it only reroutes files already inside the archive.
 *
 * So the packaged copy comes from an electron-builder `extraResources` entry
 * (`package.json` → `build.extraResources`) that copies the source file to
 * `<resources>/omp-gate/ompGateExtension.ts`, which is what
 * {@link PACKAGED_GATE_EXTENSION_REL} names. The entry and this resolver are
 * two halves of one contract, so `__tests__/ompGatePath.test.ts` reads
 * `package.json` and asserts the pair — neither side can move alone.
 *
 * The resolved path is existence-checked. A missing extension does NOT stop
 * OMP: its loader records the failure and starts the session anyway
 * (`loader.ts:437-443`, reproduced in the probe above), so returning a path
 * that does not exist would silently produce an UNGATED session — the one
 * outcome the design refuses. Callers must treat the throw as "cannot spawn
 * OMP".
 */
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Filename of the gating extension (TypeScript source — see the header). */
export const OMP_GATE_EXTENSION_FILENAME = 'ompGateExtension.ts';

/**
 * Where a packaged build keeps the extension, relative to
 * `process.resourcesPath` — i.e. the `to` of the `build.extraResources` entry in
 * `package.json`. Exported so the test can assert the two agree.
 */
export const PACKAGED_GATE_EXTENSION_DIR = 'omp-gate';
export const PACKAGED_GATE_EXTENSION_REL = path.posix.join(
  PACKAGED_GATE_EXTENSION_DIR,
  OMP_GATE_EXTENSION_FILENAME,
);

/**
 * The `from` of that same entry — the in-repo source the packager copies.
 * POSIX-separated because electron-builder config paths always are.
 */
export const PACKAGED_GATE_EXTENSION_SOURCE =
  'main/src/services/panels/omp/gate/ompGateExtension.ts';

/**
 * Path segment tsc emits into: `main/src/...` compiles to
 * `main/dist/main/src/...`, so this module's runtime `__dirname` in dev points
 * at the compiled tree while the asset we need lives in the source tree.
 */
const DIST_SEGMENT = path.join('main', 'dist', 'main', 'src');
const SRC_SEGMENT = path.join('main', 'src');

/**
 * Map a compiled directory back to its source directory, leaving a path that is
 * already in the source tree untouched.
 *
 * Both cases are real: in `pnpm dev` this module runs from `main/dist/...`,
 * while under vitest it runs from `main/src/...` directly. Rewriting the
 * segment handles both without a hardcoded number of `..` hops.
 */
export function toSourceDir(dir: string): string {
  const idx = dir.lastIndexOf(DIST_SEGMENT);
  if (idx === -1) return dir;
  return dir.slice(0, idx) + SRC_SEGMENT + dir.slice(idx + DIST_SEGMENT.length);
}

export interface OmpGatePathDeps {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.resourcesPath` — absent outside a packaged app. */
  resourcesPath?: string;
  /**
   * Directory this module is running from. Defaults to `__dirname`; the dev
   * branch maps it back to the source tree via {@link toSourceDir}.
   */
  dirname?: string;
  /** Injected for tests, exactly as `peekabooExecutablePath.ts` does. */
  existsSync?: (p: string) => boolean;
}

/**
 * Absolute path to the gating extension for `omp -e <path>`.
 *
 * @throws when the packaged build did not ship the extension (a missing
 *   `extraResources` entry, or `process.resourcesPath` unavailable). A throw
 *   means "cannot spawn OMP", never "spawn ungated" — see the header.
 */
export function resolveOmpGateExtensionPath(deps: OmpGatePathDeps): string {
  if (!deps.isPackaged) {
    return path.join(toSourceDir(deps.dirname ?? __dirname), OMP_GATE_EXTENSION_FILENAME);
  }

  const refuse = (why: string): never => {
    throw new Error(
      `Cannot resolve the OMP gating extension in this packaged build: ${why}. It ships via the ` +
        `electron-builder extraResources entry { from: "${PACKAGED_GATE_EXTENSION_SOURCE}", ` +
        `to: "${PACKAGED_GATE_EXTENSION_REL}" } in package.json's build config. Refusing to spawn ` +
        'OMP without its policy gate.',
    );
  };

  if (!deps.resourcesPath) return refuse('process.resourcesPath is unavailable');

  const resolved = path.join(deps.resourcesPath, PACKAGED_GATE_EXTENSION_DIR, OMP_GATE_EXTENSION_FILENAME);
  const exists = deps.existsSync ?? fs.existsSync;
  let present = false;
  try {
    present = exists(resolved);
  } catch {
    // An unreadable path is indistinguishable from an absent one here, and both
    // mean the same thing: do not spawn.
    present = false;
  }
  if (!present) return refuse(`${resolved} does not exist`);

  return resolved;
}
