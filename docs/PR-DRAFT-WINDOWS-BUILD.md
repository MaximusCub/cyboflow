# PR draft — Windows build support

**Status: prepared locally, NOT raised.** Raise when ready by pushing
`windows-build` and opening the PR against the official repo with the body
below. No fork of the upstream was created; if upstream requires a same-account
fork, fork at raise time.

- Branch: `windows-build`
- Base for the draft: `59421148` (`chore: release 0.2.9`)
- Commits (oldest → newest):
  1. `733112aa` — build(windows): land native modules on Electron ABI via version bumps
  2. `b2990db4` — build(windows): win packaging pipeline — config, scripts, portable assets
  3. `dfda8dba` — feat(windows): win32 runtime substrate — MCP named pipe, shell, PTY, process ops
  4. (round 2) — feat(windows): process-management parity, dev-mode, capture fallback, test suite green

---

## Title

```
feat: Windows build support — NSIS installer, win packaging pipeline, win32 runtime substrate
```

## Body

### What

First-class Windows builds of cyboflow, additive to the macOS pipeline
(no `build:mac*` behavior changes; every shared script change is a guarded
branch or a portability fix):

1. **Native modules land on the Electron ABI without a toolchain.**
   better-sqlite3 11.10.0 → 12.11.1 (publishes `electron-v136-win32-x64`
   prebuilds; 11.x stopped at v132) and node-pty-prebuilt-multiarch
   ^0.12.0 → ^0.14.1 (0.12.x win32 prebuilds stopped at ~electron-v110;
   0.14.1's node-v137 build is N-API-stable and loads under Electron 37).
   Both probe-verified under the real Electron 37.6.0 binary.

2. **Win packaging pipeline.** `build.win` (icon, NSIS target,
   `Cyboflow-<version>-Windows-<arch>.exe`), `build:win` / `build:win:dev`
   scripts (deliberately skip `electron:rebuild` — prebuilds are already in
   place), a `BUILD_PLATFORM=win` branch in `configure-build.js`
   (`--platform/--arch/--variant` CLI flags so package.json scripts never use
   POSIX `VAR=x cmd` syntax), a Windows lean-packaging plan keeping only the
   `win32-<arch>` agent binaries, `npmRebuild: false` for win (ships the
   hand-placed prebuilds; `CYBOFLOW_WIN_NPM_REBUILD=1` opts back in), the
   win32 `claude-agent-sdk` asarUnpack glob, and a portable `copy:assets`
   (node `fs` replaces POSIX `cp`/globs that broke `pnpm build:main` on
   Windows).

3. **win32 runtime substrate.** The MCP orch IPC endpoint becomes a per-user
   **named pipe** on Windows (Unix sockets fail to bind there — Node's net
   module handles pipe paths transparently, so server + clients are
   unchanged); PowerShell as the detected default shell (`pwsh` →
   `powershell.exe` → cmd), `path.delimiter` PATH joins, Windows PATH
   assembly without login-shell discovery, `where`/`.exe`+`.cmd` probing in
   node/PATH resolution, `taskkill /T /F` for process-group kills, a
   `verify-driver.cmd` wrapper for the verification driver, a PowerShell
   `Win32_Process` walk replacing `ps --ppid` recursion, and hook commands
   registered as `node "<path>"` (a bare `.js` under cmd.exe resolves via
   file association).

4. **Process-management parity (round 2).** A shared PowerShell
   `Win32_Process` text-listing stand-in (`winProcessTable.ts`) feeds the five
   `ps`-parsing sweeps (CodexBrokerReaper, terminal orphan detection, the MCP
   orphan tripwire with proper etime, PrototypeServerReaper) with their
   parsers untouched; stop/kill ladders in run/terminal managers gained a
   taskkill fast path (`/T`, bounded poll, unconditional `/F`, zombie
   verification) with a `platform` test seam; PrototypeServerReaper path
   matching normalizes separators so backslash command lines match;
   `OrchSocketServer.isSocketPathIntact` handles pipes (no false "socket
   missing" health alarm); the updater is platform-gated (macOS-only feed —
   reports `supported: false` instead of erroring); `pnpm dev` runs on
   Windows via a cross-platform launcher (`scripts/dev-electron.mjs`);
   `native-screenshot` gains a whole-screen PowerShell capture stand-in
   (peekaboo is macOS-only; the `--app` deviation is stated in its output).

### Verification (measured on a real Windows 11 x64 host, no MSVC)

- `pnpm typecheck` clean; `pnpm lint` 0 errors; `pnpm test:build` green
  (afterSign cases A–E run everywhere, F–V are darwin-gated;
  configure-build gains pure Case D2 + host-conditional Case F;
  verifyArtifact gains the win `.exe` floor case).
- Covering unit tests for every touched runtime module pass on Windows
  (114/114, incl. the platform-aware hook-command expectations).
- better-sqlite3 bump: the full `main/src/database` suite runs green on
  Windows — **625/625**. (The first pass showed 39 Windows-only failures,
  all one pattern: `afterEach` deleting a temp dir whose SQLite handles were
  not yet closed — EPERM on Windows, legal on POSIX. Fixed in-repo: 12
  migration tests close the service before the delete; the rest use a
  Windows-safe `cleanupDbTestDir` helper. POSIX behavior unchanged.)
- PTY verified end-to-end: `pty.spawn` of real cmd.exe and powershell.exe
  under the packaged Electron binary, echo round-trip + kill.
- The PowerShell screen-capture stand-in was exercised live (produces a real
  PNG).
- End-to-end: `electron-builder --win --x64` produces an unsigned NSIS
  installer; the unpacked build launches, CDP answers (`cyboflow/0.2.9 …
  Electron/37.6.0`), the React UI fully renders, DB migrations run on the
  packaged Electron-ABI sqlite, the bundled `claude.exe` resolves and spawns
  (auth is a per-host login matter), and a failed update check is non-fatal
  (fail-soft `AppUpdater`).

### Degradations / known limits (documented in docs/WINDOWS-BUILD.md)

- `@steipete/peekaboo-mcp` is darwin-only — `attest window` has no Windows
  equivalent (fails loudly); `--app`-scoped captures fall back to full-screen
  with an explicit note in the driver output.
- The NSIS floor for `.exe` artifacts is 50 MB (NSIS compresses harder than a
  DMG); `afterSign`'s .app checks remain mac-only.
- The updater has no Windows feed yet — platform-gated off (`supported:
  false`), not erroring.

### Reviewer notes

- The database test failures are NOT regressions — see the EPERM analysis
  above; a later change can close DB handles before `rmSync` or use
  `sqlite3_db_release_memory`-style teardown.
- `orchSocketEndpoint.ts` keeps the standalone-typecheck invariant of its
  neighbors (no electron/better-sqlite3/service imports).
- Node-pty 0.14.1 is N-API-stable — the node-v137 build loads under Electron
  37 (ABI 136), probe included (`ELECTRON_RUN_AS_NODE` + `pty.spawn`
  presence + real open).
