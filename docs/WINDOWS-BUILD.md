# Windows build of cyboflow

How to build cyboflow for Windows, and the platform decisions behind the
Windows support. macOS build behavior is unchanged by everything described
here; each platform-specific change lives behind a platform check or in a
Windows-only file.

## Prerequisites

- Windows 10/11 x64 with node ≥ 22.14 and pnpm (the `packageManager` pin).
- **No Visual Studio / MSVC required.** Both native modules ship prebuilt
  Windows binaries; nothing compiles from source.

## Building

A plain `pnpm install` does not work on Windows: the native modules'
install scripts try to fetch prebuilds for the *host* Node ABI and then
fall back to node-gyp compilation. The working sequence:

```bash
set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"&& pnpm install --ignore-scripts
cd node_modules/electron && node install.js
```

`--ignore-scripts` skips all package install scripts; the Electron
postinstall is run manually because it is not covered by the prebuild
placement below.

Place the two native modules on the **Electron ABI** (Electron 37 →
`NODE_MODULE_VERSION` 136; current Node 24 is 137 — the mismatch matters):

```bash
cd node_modules/.pnpm/better-sqlite3@<version>/node_modules/better-sqlite3
npx prebuild-install --runtime=electron --target=<electron-version> --platform=win32 --arch=x64
cd ..\..\@homebridge+node-pty-prebuilt-multiarch@<version>\node_modules\@homebridge\node-pty-prebuilt-multiarch
npx prebuild-install --runtime=node --target=24.13.0 --platform=win32 --arch=x64
```

The node-pty build is N-API-stable: its node-ABI binary loads under
Electron (probe-verified). The first command can also be run implicitly by
`node scripts/ensure-sqlite-abi.mjs electron`, which swaps between the
host and Electron artifacts via a local cache.

Then build and package:

```bash
pnpm build:win        # NSIS installer + unpacked build in dist-electron/
```

`build:win` re-checks the better-sqlite3 ABI before packaging and fails
the build if a host-ABI artifact would be shipped (running the host test
suite flips it — the guard exists because that flip is easy to forget).

## Native module versions

| Module | Version | Why |
|---|---|---|
| better-sqlite3 | 12.11.1 | publishes `electron-v136` win32-x64 prebuilds; 11.x stopped at `electron-v132` |
| node-pty-prebuilt-multiarch | 0.14.1 | ships a win32-x64 node-ABI build that is N-API-stable and loads under Electron 37 (0.12.x stopped near `electron-v110`) |

better-sqlite3 is load-probed twice per build — pre-packaging
(`configure-build.js` → `ensure-sqlite-abi.mjs --check electron`) and
post-packaging (the Windows `afterSign` arm). node-pty's Electron loading
was verified once by hand (its build is N-API-stable) and is not re-probed
per build.

## Packaging decisions

- **`npmRebuild: false` on Windows.** The prebuilt `.node` files are
  packaged as-is; a rebuild would require MSVC and would clobber the
  verified prebuilds. `CYBOFLOW_WIN_NPM_REBUILD=1` restores the rebuild
  step for hosts with a toolchain.
- **Lean packaging.** A Windows installer bundles only the win32 agent
  binaries (`claude.exe`, `codex.exe`); the darwin/linux packages are
  excluded, mirroring how the macOS installer excludes everything else.
- **Installer size floor.** The produced `.exe` is held to a 50 MB floor
  (NSIS compresses harder than a DMG; the bar is still far above any
  stub). The unpacked build is also verified post-packaging
  (`build/afterSign.js` runs a Windows arm: PE machine check on
  `Cyboflow.exe`, a load probe of the packaged better-sqlite3 under the
  packaged Electron, and a size floor on `win-unpacked`).
- **First run downloads electron-builder's NSIS/winCodeSign tooling.** On
  hosts without Windows Developer Mode, the winCodeSign archive's two
  darwin symlinks fail to extract and NSIS builds loop on the error; see
  the workaround in the "Troubleshooting" section below.

## Platform decisions (runtime)

- **MCP IPC over a named pipe.** Windows cannot bind Unix sockets
  (`EACCES`); the orch endpoint becomes
  `\\.\pipe\cyboflow-<user>-<hash>-orch` (hash of the per-instance data
  dir, so parallel app variants cannot cross-talk). Node's `net` module
  treats pipe paths transparently, so server and clients are unchanged.
- **PowerShell is the default shell** (`pwsh` if installed, else the
  system `powershell.exe`, then cmd.exe). Run/build commands are
  constructed per platform — `$env:K = 'v'` + `;` joins on Windows,
  `export K=v` + `&&` on POSIX.
- **Process teardown uses `taskkill /T`.** Windows has no process groups;
  `taskkill /PID <pid> /T /F` kills the whole tree and is the Windows arm
  of every teardown path (run scripts, terminals, PTY CLIs, agent-server
  clients, the verify driver). Process enumeration uses one PowerShell
  `Win32_Process` query rendered as `ps`-compatible text lines, so the
  former `ps`-parsing sweeps work with their parsers unchanged.
- **Agent-server spawns are not `detached` on Windows.** `DETACHED_PROCESS`
  leaves codex.exe console-less, which makes it allocate its own *visible*
  console — with the "Let Windows decide" default-terminal setting that is
  a black window flash. Windows teardown uses `taskkill /T`, which does
  not need the detached process group; POSIX keeps `detached` + group
  kills.
- **Every child-process spawn hides its console** (`windowsHide: true`).
  Without it, a packaged GUI app opens a visible console window per spawn;
  with the Windows-Terminal default-terminal setting, each one renders as
  a dark terminal flash.
- **CLI probes survive npm `.cmd` shims.** Node ≥18.20 refuses to spawn
  `.cmd` files without a shell; version probes prefer a sibling native
  `.exe` and otherwise route through `cmd.exe /d /s /c` with verbatim
  quoting.
- **Git is discovered**, not assumed: PATH first, then the standard
  Windows install locations, then `where git` — a "Git Bash only" install
  works from a Start-Menu launch.
- **Hook commands run through `node`** (`node "<script>"`) — a bare `.js`
  path under cmd.exe resolves via file association, which may not be node.
- **Updater**: no Windows update feed exists, so the auto-updater reports
  "not supported" instead of erroring on every check.

## Known degradations and follow-ups

- **Native-screen attestation** (proving which window was captured) has no
  Windows implementation; it fails loudly. Real-screen *screenshots* do
  work (PowerShell capture, always full-screen — per-app scoping is a
  peekaboo/macOS feature). Native-screen verification is scheduler-gated
  to hosts with a capability probe.
- **No Windows update feed** (see updater above).
- **x64 only**; ARM64 needs its own packaging path and prebuild
  verification.

## Troubleshooting

- **NSIS build loops on winCodeSign extraction**: the winCodeSign archive
  contains darwin symlinks that need admin/Developer Mode. Pre-extract it
  once into the final cache directory:
  `7za x %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0.7z -owinCodeSign-2.6.0`
  (the two darwin symlink errors are harmless; the Windows tools extract
  fine).
- **`NODE_MODULE_VERSION` mismatch at app boot**: the packaged artifact is
  on the wrong ABI — run
  `node scripts/ensure-sqlite-abi.mjs electron` and rebuild. Always run
  that script with *Windows* node; running it from WSL node wedges the
  swap lock.
- **Diagnosing console-window flashes**: a console window exists only when
  its process has a nonzero MainWindowHandle — `CREATE_NO_WINDOW`
  children still get a windowless conhost, so process presence alone
  proves nothing. Poll
  `Get-Process conhost,cmd,powershell,OpenConsole | ? { $_.MainWindowHandle -ne 0 }`
  and resolve the reported parent PID to find the offending spawn site.
