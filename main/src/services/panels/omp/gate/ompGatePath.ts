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
 * PACKAGING FOLLOW-UP — the packaged branch currently THROWS
 * ===========================================================================
 * `package.json` `build.files` ships `main/dist/**`, which is compiled output;
 * the gate's `.ts` source under `main/src/` is not shipped at all, and even if
 * it were, a file inside `app.asar` is unreadable by the `omp` child process.
 * The packaged build therefore needs an electron-builder change this task's
 * file set does not cover — an `extraResources` entry copying
 * `main/src/services/panels/omp/gate/ompGateExtension.ts` next to the app's
 * other unpacked assets (the `asarUnpack` route used for the MCP server and
 * shell hooks does not apply, since it only reroutes files already inside the
 * archive).
 *
 * Until that lands, {@link resolveOmpGateExtensionPath} throws in packaged mode
 * rather than returning a path that does not exist. A missing extension does
 * NOT stop OMP: its loader records the failure and starts the session anyway
 * (`loader.ts:437-443`, reproduced in the probe above), so a bad path here
 * would silently produce an UNGATED session — the one outcome the design
 * refuses. Callers must treat the throw as "cannot spawn OMP".
 */
import * as path from 'node:path';

/** Filename of the gating extension (TypeScript source — see the header). */
export const OMP_GATE_EXTENSION_FILENAME = 'ompGateExtension.ts';

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
}

/**
 * Absolute path to the gating extension for `omp -e <path>`.
 *
 * @throws when the app is packaged — see the packaging follow-up in this
 *   module's header. A throw means "cannot spawn OMP", never "spawn ungated".
 */
export function resolveOmpGateExtensionPath(deps: OmpGatePathDeps): string {
  if (deps.isPackaged) {
    throw new Error(
      'The OMP gating extension is not available in packaged builds yet: ' +
        `${OMP_GATE_EXTENSION_FILENAME} is not copied into the app bundle. Add an electron-builder ` +
        'extraResources entry for main/src/services/panels/omp/gate/ompGateExtension.ts, point this ' +
        'resolver at process.resourcesPath, then remove this guard. Refusing to spawn OMP without ' +
        'its policy gate.',
    );
  }

  return path.join(toSourceDir(deps.dirname ?? __dirname), OMP_GATE_EXTENSION_FILENAME);
}
