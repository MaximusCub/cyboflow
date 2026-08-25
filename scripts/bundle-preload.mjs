/**
 * bundle-preload — make preload.js loadable by the SANDBOXED preload loader.
 *
 * The main window runs with `sandbox: true` (main/src/index.ts → createWindow).
 * A sandboxed preload does NOT get node's module resolver: its polyfilled
 * `require` resolves ONLY 'electron' plus a few builtins (events, timers, url).
 * The tsc-emitted preload.js requires two npm packages — '@sentry/electron/preload'
 * and 'trpc-electron/main' — plus sibling '../../shared/types/*' modules, and every
 * one of those would throw at load time, leaving the renderer with no
 * `window.electronAPI` and no tRPC bridge at all.
 *
 * Bundling inlines all of them into a single file, leaving 'electron' external so
 * it still goes through the sandbox's own polyfill. Both inlined packages are
 * themselves sandbox-clean: each requires nothing but 'electron' (verified in
 * node_modules; @sentry/electron/preload/default.js even documents the case).
 *
 * Runs after `tsc` in build:main; rewrites the compiled file in place (via a temp
 * file to avoid esbuild's overwrite-input guard). NOTE: because the sibling
 * '../../shared/types/*' imports are inlined rather than resolved at runtime, the
 * shipped preload is correct only if this bundle step ran — a bare `tsc` (e.g.
 * `pnpm --filter main dev`, which watch-compiles) leaves an unbundled preload.js
 * behind and the window boots with a dead bridge until build:main is re-run.
 *
 * The require-scan below is a build-time tripwire on the same contract: if a
 * future import drags in a node builtin or an unbundlable dependency, the build
 * fails here instead of the app silently losing its preload at runtime.
 */
import { build } from 'esbuild';
import { readFileSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'main', 'dist', 'main', 'src');
const entry = join(dir, 'preload.js');
const tmp = join(dir, 'preload.bundle.js');

// Everything a sandboxed preload's polyfilled `require` can actually resolve.
// See Electron's "Preload scripts" docs → sandboxing.
const SANDBOX_RESOLVABLE = new Set(['electron', 'events', 'timers', 'url']);

await build({
  entryPoints: [entry],
  outfile: tmp,
  bundle: true,
  platform: 'node', // CJS output + node resolution for the inlined packages
  format: 'cjs',
  target: 'node18',
  external: ['electron'], // resolved by the sandbox polyfill, never bundled
  logLevel: 'warning',
});

const bundled = readFileSync(tmp, 'utf8');
const required = new Set(
  [...bundled.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
);
const unresolvable = [...required].filter((id) => !SANDBOX_RESOLVABLE.has(id));
if (unresolvable.length > 0) {
  rmSync(tmp, { force: true });
  throw new Error(
    `[bundle-preload] the bundled preload still requires ${unresolvable
      .map((id) => `"${id}"`)
      .join(', ')} at runtime, which the sandboxed preload loader cannot resolve. ` +
      `Either keep the dependency out of main/src/preload.ts, or drop 'sandbox: true' ` +
      `in main/src/index.ts (createWindow) — a preload that fails to load takes the ` +
      `whole electronAPI/tRPC bridge down with it.`,
  );
}

// The tsc map no longer describes the bundled file; drop it so nothing loads a
// map whose mappings point at the pre-bundle source.
rmSync(join(dir, 'preload.js.map'), { force: true });
renameSync(tmp, entry);
console.log(
  `[bundle-preload] preload.js bundled for sandbox: true (external: ${[...required].join(', ')}).`,
);
