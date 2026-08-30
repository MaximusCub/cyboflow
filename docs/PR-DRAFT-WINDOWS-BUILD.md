# PR draft — Windows compatibility

**Status: prepared locally, NOT raised.** Push `windows-build` and open against the
official repo when ready. Independent (non-Windows) work lives on separate branches
for separate PRs — see "Related PRs" at the bottom.

- Branch: `windows-build`
- Base: `59421148` (`chore: release 0.2.9`)
- Stack (11 commits, oldest → newest):
  1. `733112aa` — land native modules on Electron ABI (better-sqlite3 12.11.1, node-pty 0.14.1)
  2. `210a8414→b2990db4-era` — win packaging pipeline (build.win, build:win, configure-build win branch, portable copy:assets, .exe floor)
  3. `dfda8dba` — win32 runtime substrate (MCP named pipe, PowerShell shell substrate, PTY, process ops)
  4. `00ef6d3d` — docs: WINDOWS-BUILD.md + this draft
  5. `3a904ea6` — process-management parity, dev mode, capture fallback, green DB suite
  6. `c7825de0` — separator-agnostic quick-session wait matcher (cherry-picked from fix/quick-session-win-path-match)
  7. `e41cae1c` — process-ops parity: stop-script ladder, PTY-manager kills, PowerShell command construction
  8. `b29cc448` — shell-less CLI probes survive .cmd shims; git discovery for GUI launches
  9. `3f0113ef` — packaging ABI guard, per-kind pipe names, dev-signal + shell-probe hardening
  10. `cda9badb` — separator-agnostic path helpers, platform-aware kbd hints and placeholders
  11. `15cc8bdb` — windowsHide sweep (no conhost flicker from any main-process spawn)

(Exact hashes via `git log --oneline 59421148..windows-build`.)

---

## Title

```
feat: Windows support — installer, packaging pipeline, and platform parity for the main process
```

## Body (paste-ready summary)

### What

First-class Windows builds of cyboflow, additive to macOS (every shared-script change
is a guarded branch, a portability fix, or a platform seam; the macOS build paths are
byte-identical — verified per-file in an adversarial review):

1. **Packaging**: `build.win` (NSIS, icon, `Cyboflow-<version>-Windows-<arch>.exe`),
   `build:win`/`build:win:dev` scripts, a `BUILD_PLATFORM=win` branch in
   `configure-build.js` (win lean-packaging plan, `npmRebuild:false` + an
   Electron-ABI probe that fails the build before electron-builder if the
   hand-placed prebuilds are not what will ship), portable `copy:assets`, and a
   50 MB NSIS artifact floor in `verifyArtifact`.
2. **Native modules without a toolchain**: better-sqlite3 11.10.0 → 12.11.1
   (electron-v136 win32-x64 prebuild) and node-pty ^0.12.0 → ^0.14.1
   (N-API-stable node-v137 win32 build loads under Electron 37). Both
   probe-verified under the real Electron binary; `scripts/ensure-sqlite-abi.mjs`
   works on Windows and banks both ABIs.
3. **Runtime parity**: MCP orch IPC over a per-user named pipe (per-data-dir hash —
   parallel app kinds cannot cross-talk); PowerShell-first shell substrate
   (pwsh → powershell.exe → cmd, `-NoProfile -NonInteractive` command args);
   separator-safe PATH joins and executable probing (`.exe`/`.cmd`);
   `taskkill /T /F` kill ladders for every process-tree teardown (run scripts,
   terminals, PTY CLIs, codex/omp/dev-server clients, the verify driver); a
   PowerShell `Win32_Process` stand-in feeding all five former `ps`-parsing
   sweeps; separator-agnostic quick-session completion matching; shell-less CLI
   probes that survive npm `.cmd` shims (EINVAL); git discovery for GUI launches
   (`gitExeFinder`); `windowsHide: true` on every main-process child spawn; a
   `verify-driver.cmd` wrapper; PowerShell screen capture for the driver's
   `native-screenshot`; a cross-platform `pnpm dev` launcher.
4. **Renderer**: separator-agnostic path helpers (FileEditor delete-refresh and a
   12-site basename/dirname sweep), platform-aware keyboard hints and Settings
   placeholders.

### Verification (measured on a real Windows 11 x64 host, no MSVC)

- `pnpm typecheck` clean; `pnpm lint` 0 errors; `pnpm test:build` green.
- Full main vitest suite on the assembled stack: **676 passed**, with every
  failing file byte-identical to the pre-sweep baseline (pre-existing
  Windows-host test-environment failures — POSIX-shell fixtures and symlink
  semantics — documented per file).
- `main/src/database`: **625/625** on Windows (host-ABI better-sqlite3).
- End-to-end: NSIS installer + unpacked build launch; CDP answers; the UI fully
  renders; DB migrations run on the packaged Electron-ABI sqlite; bundled
  `claude.exe` resolves and spawns; quick-session creation completes and
  navigates; failed update checks are platform-gated off (no feed yet), not
  erroring; zero console-window flashes from any main-process spawn.

### Refactor notes (for reviewers)

The work was organized by a two-round process (implementation → adversarial
review → fixes). Ad-hoc `process.platform === 'win32'` branches were allowed
where they extend a visible POSIX ladder; duplicated logic was consolidated onto
shared seams instead: `processTable.ts`/`winProcessTable.ts` (one process-table
query + descendant walk + `killWindowsTree` consumed by five former copy-paste
sites), `win32ShimProbe`/`gitExeFinder` (mirroring `nodeFinder`),
`orchSocketEndpoint`, and platform test seams (`platform` option) where tests
must stay deterministic cross-host. Known deferred follow-ups (tracked, not
slipped in): a full `platformProcess.ts` strategy extraction, PowerShell
`-EncodedCommand` for user-command quoting, ARM64 packaging, verify
dep-preparer `cp`/npx resolution, verify serve-binding probes, workflow-name
charset validation.

### Known degradations (documented in docs/WINDOWS-BUILD.md)

- `@steipete/peekaboo-mcp` is darwin-only: `attest window` has no Windows
  equivalent (fails loudly); `--app`-scoped captures fall back to full-screen
  with an explicit note.
- No Windows update feed yet — updater reports `supported: false`.
- `afterSign` bundle arch/ABI checks remain mac-only (NSIS `.exe` has its own
  size floor); test-infra cleanup (open-handle `rmSync`) was fixed in-repo.

## Related PRs (separate branches, independent)

- `fix/first-run-window-layout` — display-aware first-run window size, persistent
  window bounds, wider first-run rail defaults (cross-platform UX).
- `fix/nux-step10-accent` — /ship chip tour accent fires on step 10, not the
  stale step 8.
- `fix/nux-park-and-resume` — visible "tour paused" state, anchor-aware resume,
  "Skip tour" relabel + per-step escape on advance-by-doing steps.
