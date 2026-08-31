#!/usr/bin/env node
/**
 * apply-pty-napi-prebuilds — expose node-pty's prebuilt binary where
 * @electron/rebuild and the runtime loader can both find it.
 *
 * Why: @homebridge/node-pty-prebuilt-multiarch 0.14.1 ships and downloads
 * N-API-stable binaries (the same binary loads in Node and Electron), but
 * under names its own consumers do not look for:
 *   - @electron/rebuild accepts only `node.napi.node` inside
 *     `prebuilds/<platform>-<arch>/` (the package declares `prebuildify`, so
 *     the detector applies) — without it, electron-rebuild falls through to a
 *     node-gyp source build that fails on CI runners and compiler-less hosts.
 *   - the package's runtime loader reads `prebuilds/<...>/<runtime>.abi<ABI>.node`
 *     or falls back to `build/Release/pty.node` — and its own postinstall
 *     cleans build/Release on POSIX, leaving nothing under Electron.
 *
 * This hook copies the installed binary to both names. Runs from the root
 * postinstall before `electron-builder install-app-deps`. Fail-soft: if
 * anything here cannot run, electron-rebuild behaves exactly as it would
 * without this script.
 */
const fs = require('fs');
const path = require('path');

const STORE = path.join(__dirname, '..', 'node_modules', '.pnpm');
const PKG_PREFIX = '@homebridge+node-pty-prebuilt-multiarch@';

function storePackageDirs() {
  try {
    return fs
      .readdirSync(STORE)
      .filter((entry) => entry.startsWith(PKG_PREFIX))
      .map((entry) =>
        path.join(STORE, entry, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch'),
      )
      .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
      .sort()
      .reverse(); // newest store entry first when several are present
  } catch {
    return [];
  }
}

// The prebuilt binary, wherever this install put it: the shipped prebuild for
// this exact host ABI first, then any shipped prebuild (N-API is
// runtime-agnostic), then a build/Release artifact from prebuild-install.
function findSourceBinary(pkgDir, prebuildsDir) {
  const exact = path.join(prebuildsDir, `node.abi${process.versions.modules}.node`);
  if (fs.existsSync(exact)) return exact;
  try {
    const abiFiles = fs
      .readdirSync(prebuildsDir)
      .filter((f) => /^node\.abi\d+\.node$/.test(f))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (abiFiles.length > 0) return path.join(prebuildsDir, abiFiles[0]);
  } catch {}
  const buildRelease = path.join(pkgDir, 'build', 'Release', 'pty.node');
  return fs.existsSync(buildRelease) ? buildRelease : null;
}

try {
  for (const pkgDir of storePackageDirs()) {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    // The prebuildify detector only consults modules that declare the tool.
    if (!pkg.devDependencies || !pkg.devDependencies.prebuildify) continue;
    const archDir = process.arch === 'armv7l' ? 'arm' : process.arch;
    const prebuildsDir = path.join(pkgDir, 'prebuilds', `${process.platform}-${archDir}`);
    const source = findSourceBinary(pkgDir, prebuildsDir);
    if (!source) {
      console.warn('[apply-pty-napi-prebuilds] no prebuilt pty binary found — skipping');
      continue;
    }
    fs.mkdirSync(path.dirname(prebuildsDir), { recursive: true });
    // arm64 prebuilds use the `armv8` filename suffix, matching
    // @electron/rebuild's prebuildify extension rule.
    const napiName = process.arch === 'arm64' ? 'node.napi.armv8.node' : 'node.napi.node';
    const napiDest = path.join(prebuildsDir, napiName);
    fs.copyFileSync(source, napiDest);
    // The runtime loader's POSIX fallback: build/Release/pty.node.
    const buildRelease = path.join(pkgDir, 'build', 'Release', 'pty.node');
    if (path.resolve(source) !== path.resolve(buildRelease) && !fs.existsSync(buildRelease)) {
      fs.mkdirSync(path.dirname(buildRelease), { recursive: true });
      fs.copyFileSync(source, buildRelease);
    }
    console.log(`[apply-pty-napi-prebuilds] exposed ${path.relative(pkgDir, napiDest)}`);
  }
} catch (error) {
  console.warn('[apply-pty-napi-prebuilds] skipped:', error && error.message);
}
process.exit(0);
