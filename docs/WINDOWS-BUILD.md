# Windows build of cyboflow

This document records the Windows build effort: environment, decisions made
along the way, artifacts produced, and what degrades compared to the macOS
build. It is written as the work proceeds (M0-M4 below), so later sections may
reference earlier decisions.

## Environment (measured)

- Build host: Windows 11 x64 (AMD64), reached from a WSL2 session over
  `\\wsl` interop; the repo is `/mnt/c/Dev/cyboflow` == `C:\Dev\cyboflow`.
- node v24.13.0 (host ABI 137), npm 11.6.2, pnpm 10.11.1 (matches the
  `packageManager` pin), Python 3.14.3, Git for Windows.
- **No MSVC / VS Build Tools** — native compilation from source is unavailable
  on this host. Every native module decision below therefore lands on
  prebuilt binaries only. Do not attempt UAC-requiring installs.
- Electron 37.6.0 → `NODE_MODULE_VERSION` **136** (via `node-abi`);
  host node 24.13.0 → **137**.
- WSL side has no pnpm and no wine; all build commands run on the Windows host
  via `cmd.exe /c` from WSL with cwd inside the repo.

## M0 — toolchain

### `pnpm install` strategy (measured, important)

A plain `pnpm install` on this host **fails**: better-sqlite3 and
node-pty-prebuilt-multiarch have no prebuilds for host node ABI 137 (well,
node-pty 0.12.x didn't; see below), their install scripts fall back to
node-gyp, which needs MSVC, and node-pty's install script additionally dies
with Node 24's `spawn EINVAL` (spawning a `.cmd` shim without `shell: true`).

The working sequence:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --ignore-scripts
cd node_modules/electron && node install.js   # fetch the Electron binary
```

`--ignore-scripts` skips every package install script (nothing compiles), and
the Electron postinstall is run manually afterwards. The root postinstall
(`electron-builder install-app-deps`) is deliberately NOT run on this host —
it would attempt an Electron rebuild of the native modules and fail without
MSVC; the prebuilds are placed by hand instead (below).

### Native modules (the #1 risk — resolved via version bumps + prebuilds)

Both modules are imported eagerly in the main process (`index.ts`,
`database.ts`), so a non-loading `.node` would crash the app at startup. Both
were probed under the real Electron 37.6.0 binary
(`ELECTRON_RUN_AS_NODE=1`, real `:memory:` DB open / `pty.spawn` presence).

1. **better-sqlite3: 11.10.0 → 12.11.1** (root + main `package.json`).
   11.10.0 ships win32-x64 prebuilds only up to `electron-v132`; **12.11.1
   publishes `better-sqlite3-v12.11.1-electron-v136-win32-x64.tar.gz`**
   (HTTP 200, verified). Placed by:
   ```bash
   cd node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3
   npx prebuild-install --runtime=electron --target=37.6.0 --platform=win32 --arch=x64
   ```
2. **node-pty-prebuilt-multiarch: ^0.12.0 → ^0.14.1** (root + main).
   0.12.0 has win32-x64 prebuilds only up to ~`electron-v110`; 0.14.1 has no
   `electron-v136` prebuild (404) but **does ship
   `node-v137-win32-x64`**, and that build is N-API-stable — it **loads under
   Electron 37.6.0 (ABI 136)**, verified by probe. Same
   `prebuild-install --runtime=node --target=24.13.0 ...` recipe as above.
3. **Host-ABI side** (for vitest): `node scripts/ensure-sqlite-abi.mjs host`
   flips better-sqlite3 back to ABI 137 via `pnpm rebuild better-sqlite3`
   (prebuild-install, node runtime) and banks both artifacts in
   `.abi-cache/`. `electron` target would fall through to
   `electron:rebuild` (compile → unavailable); on this host always restore
   the electron artifact from the cache before packaging rather than letting
   it rebuild.

Packaging consequence: the generated win config sets `npmRebuild: false` so
electron-builder packages the hand-placed prebuilt `.node` files instead of
trying to rebuild them (see M1).

### Platform packages (measured after install)

- `@anthropic-ai/claude-agent-sdk-win32-x64` — present (bundles `claude.exe`).
- `@openai/codex-win32-x64` — present.
- `@steipete/peekaboo-mcp` — **absent** (`os: ["darwin"]` optional dep, pnpm
  skips it on Windows). Known degradation: native-screen verification falls
  back to PATH resolution; on Windows there is no peekaboo at all.

## M1 — build pipeline

(see sections below, appended as completed)

## M2 — launch verification

(pending)

## M3 — runtime basics

(pending)

## M4 — wrap-up

(pending)
