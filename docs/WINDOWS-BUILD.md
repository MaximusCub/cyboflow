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

### Portability fixes

- `main/package.json` `copy:assets` used `mkdirp` + `cp` with shell globs —
  POSIX-only, killed `pnpm build:main` on Windows. Replaced with
  `main/scripts/copy-assets.js` (fs.cpSync/readdirSync, CommonJS like the
  sibling build helpers). `copy-workflow-assets.js` and
  `mark-hooks-executable.js` were already portable.
- The other build-chain scripts (`inject-build-info.js` = git only;
  `bundle-mcp-server.mjs` / `bundle-preload.mjs` = pure node) verified portable.

### Win packaging config

- `package.json` gains a `build.win` section: `icon: main/assets/icon.ico`
  (verified to contain a 256×256 layer — no regeneration needed), NSIS target,
  `artifactName: ${productName}-${version}-Windows-${arch}.${ext}`.
- `asarUnpack` gains `node_modules/@anthropic-ai/claude-agent-sdk-win32-*/**`
  — without it `claude.exe` stays inside the asar and cannot execute
  (`claudeExecutablePath.ts` already picks `claude.exe` on win32).
- `scripts/configure-build.js` gains a Windows branch, selected by
  `BUILD_PLATFORM=win` (normally via new CLI flags `--platform/--arch/--variant`
  so package.json scripts never need POSIX `VAR=x cmd` env syntax, which cmd
  cannot run):
  - validates `build.win` instead of `build.mac`; mac signing posture skipped;
  - **`npmRebuild: false`** — packages the hand-placed Electron-ABI prebuilds
    as-is (a rebuild would need MSVC and would clobber the verified
    binaries). Opt back in with `CYBOFLOW_WIN_NPM_REBUILD=1`;
  - Windows lean-packaging plan (`getWinPackagingPlan`): keeps only
    `win32-<arch>` agent packages, excludes darwin/linux ones, preflight
    requires `claude-agent-sdk-win32-<arch>/claude.exe` and
    `codex-win32-<arch>/vendor/<triple>/bin/codex.exe` on disk
    (`x86_64-pc-windows-msvc` for x64);
  - dev variant overrides mirror the mac ones (`Cyboflow-Dev-${version}-Windows-...`).
- `build/afterSign.js` already no-ops off-mac — unchanged. (Consequence:
  no arch/ABI/size verification of the .app-equivalent on Windows; see
  `verifyArtifact` below for the distributable-level check.)
- `build/verifyArtifact.js`: `.exe` (NSIS) artifacts now get a size floor of
  **50 MB** — lower than the 100 MB mac floor because NSIS compresses much
  harder; still orders of magnitude above a stub. The floor follows the
  platform, not the extension.
- `scripts/configure-build.test.js`: new pure Case D2 (win lean plans) and
  conditional Case F (full win configureBuild on hosts with the win32 agent
  binaries installed). `build/afterSign.test.js`: cases F–V (mac-only
  codesign/lipo/plutil fixtures, which also symlink node.exe — a privilege
  Windows denies without admin/Developer Mode) are now gated to darwin like
  they always had to be for Linux CI; cases A–E still run everywhere.
- Scripts: `build:win` and `build:win:dev` mirror `build:mac:*` except they
  **skip `pnpm run electron:rebuild`** (compiles better-sqlite3 — unavailable
  without MSVC; the prebuilds are already in place from M0) and pass
  `--win --x64 --publish never`.

### Gate results (measured, on the Windows host)

- `pnpm run test:build` — all green (afterSign 23 passed, verifyArtifact 26
  passed, configure-build all cases incl. D2 + F).
- `pnpm run typecheck` — clean.
- `pnpm run lint` — 0 errors (200 pre-existing warnings).

## M2 — launch verification (measured)

Launched `dist-electron/win-unpacked/Cyboflow.exe --remote-debugging-port=9223`
on the Windows host and verified from both sides:

- 4 `Cyboflow.exe` processes (main + GPU + renderer + utility) — normal
  Electron tree; still running after the full M2 window.
- CDP answers on the Windows-side `localhost:9223`
  (`cyboflow/0.2.9 … Electron/37.6.0`). **From WSL2, CDP is NOT reachable** —
  Chromium binds the debug port to Windows loopback only, and WSL2's NAT has
  no localhost forward in that direction. Verify via Windows-side `curl`
  (`cmd.exe /c "curl -s http://localhost:9223/json"`) or run the eval helpers
  under Windows node.
- Main window target exists and the DOM fully renders
  (`document.body.innerText` shows the real boards: Human review, Task
  backlog, Workflows, PROJECTS & SESSIONS …, footer v0.2.9).
- Data dir `C:\Users\<user>\.cyboflow` created; `sessions.db` + migrations ran
  cleanly — the packaged Electron-ABI better-sqlite3 loads and works.
- **Updater failure is non-fatal** (code + measured): `AppUpdater.check()`
  catches feed errors and returns a verdict; the packaged build logs
  `[AppUpdater] check failed: app-update.yml ENOENT` and continues running
  (the `--dir` build carries no app-update.yml, and even the NSIS artifact has
  no Windows feed to check).

### M2 degradation notes (measured, from the app log)

- **Orch IPC / MCP server**: the packaged build logged
  `listen EACCES …sockets\orch.sock` — binding a Unix-domain socket fails on
  stock Windows. Fixed in M3 (named pipe, see below).
- `McpOrphanTripwire` logs `spawn ps ENOENT` and skips its scan — the
  pre-existing guard degrades correctly; ps does not exist on Windows.
- `ClaudeCodeManager` SDK query reached the bundled `claude.exe` and failed
  with `Failed to authenticate: OAuth session expired` — the spawn path works;
  this Windows host simply is not logged in to Claude. Run `claude` once on
  Windows to log in for session runs.

## M3 — runtime basics

### Fixes shipped (win32 branches, POSIX paths untouched)

- **Orch IPC endpoint** (`orchSocketEndpoint.ts`, new): on Windows the
  `~/.cyboflow/sockets/orch.sock` path is replaced by a per-user named pipe
  `\\.\pipe\cyboflow-<user>-orch` at the single wiring call site in
  `index.ts`. Node's `net` module treats pipe paths transparently, so
  `OrchSocketServer` (bind/probe/close) and the subprocess clients are
  source-unchanged; the POSIX-mode security model degrades to per-user pipe
  name + the run-scoped bearer tokens.
- **shellDetector.ts**: win32 branch — `pwsh.exe` (PATH probe) else the
  always-present system `powershell.exe`, else cmd.exe as last resort;
  `-NoLogo` for interactive PTYs; `getShellCommandArgs` emits
  `-NoLogo -NoProfile -NonInteractive -Command` instead of `-c`.
- **shellPath.ts**: separator is `path.delimiter`; win32 skips login-shell
  PATH discovery entirely (GUI apps inherit the registry PATH) and appends
  the npm global shim dir (`%APPDATA%\npm`) + user-configured paths;
  `findExecutableInPath` also probes `name.exe`/`name.cmd` on Windows.
- **nodeFinder.ts**: win32 common locations (Program Files nodejs,
  nvm-windows, fnm, volta, scoop); the glob branch is suffix-general instead
  of hardcoding `/bin/node`; `where` instead of `which`.
- **AbstractCliManager.getSystemEnvironment**: PATH join via
  `path.delimiter` (was hardcoded `:`).
- **driverCore.ts** (verify driver): negative-pid group kills become
  `taskkill /pid <n> /T /F` on Windows (Node rejects negative pids there);
  detached serve spawns through `cmd.exe /d /s /c` (`detached: true` still
  isolates the child into its own process group).
- **verificationAgentRunner.ts**: the `$VERIFY_DRIVER` wrapper is a
  `verify-driver.cmd` on Windows (`set ELECTRON_RUN_AS_NODE=1` + forward
  args); `defaultStopDriver` routes through `cmd.exe /d /s /c` because Node
  refuses to spawn `.cmd` files directly (EINVAL).
- **sessionManager.ts / logPanel/logsManager.ts** `getAllDescendantPids`:
  on Windows one PowerShell call fetches the whole `Win32_Process`
  (pid, ppid) table (CSV) and it is walked breadth-first locally — same
  best-effort contract as the POSIX `ps` recursion.
- **interactiveSettingsWriter.ts**: hook commands register as
  `node "<path>"` on Windows (a bare `.js` path under cmd.exe resolves via
  file association, which may not be node); exported `hookCommand` so the
  unit tests pin the platform behavior.

### Runtime evidence (measured)

- `pnpm typecheck` clean; `pnpm lint` 0 errors; the covering vitest files
  (`interactiveSettingsWriter.test.ts`, `driverCore.test.ts`) pass 114/114 on
  Windows.
- better-sqlite3 bump verification: the full `main/src/database` suite ran
  under host node with the **host-ABI (node-v137 win32) prebuild** of
  better-sqlite3 12.11.1 (placed manually via prebuild-install —
  `pnpm rebuild better-sqlite3` itself fails on this host for unrelated
  spawn reasons; the artifact it produces is the same file). Result:
  **586/625 assertions pass; every one of the 39 failures is the same
  Windows-only afterEach EPERM** — `rmSync` on a temp dir whose SQLite
  files are still open (POSIX allows unlinking open files, Windows does
  not). No assertion, ABI or SQL failures. Fixing that cleanup pattern in
  19 test files is test-infra work, deliberately out of scope here.
- The ABI flip machinery (`scripts/ensure-sqlite-abi.mjs`) works on Windows:
  both artifacts banked under `.abi-cache/`
  (`electron-win32-x64-bsq12.11.1-el37.6.0`,
  `host-win32-x64-bsq12.11.1-nmv137`) and swaps are cache copies.

## M4 — wrap-up

(pending)
