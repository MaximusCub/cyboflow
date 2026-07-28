# cyboflow

cyboflow is a self-contained Electron desktop app for running AI coding flows in parallel against the same project, isolated via git worktrees. It ships four built-in flows — **Planner**, **Sprint**, **Compound**, and **Ship** — whose prompt bodies live in `main/src/orchestrator/workflows/*.md`. It is a fork of [Crystal](https://github.com/stravu/crystal) (tag `0.3.5`), heavily narrowed and rebuilt; `docs/ARCHITECTURE.md` describes what exists today.

## Two layers: running INSIDE cyboflow vs. working ON cyboflow

Agents in this repo usually run *inside* a cyboflow session while editing cyboflow's *source code* (dogfooding). Keep the layers separate:

- **Default stance: you are working ON the codebase.** Words like "task", "idea", "run", "sprint", "finding" refer to product concepts (code, schema, features) unless the user clearly means their live backlog.
- **The `cyboflow_*` MCP tools operate the LIVE app instance hosting you** — they write real rows to the user's actual backlog/review-queue database; there is no test fixture behind them. Call them only when the user explicitly asks to touch the backlog. NEVER call them to test or debug entity-model / MCP / router code — use `pnpm test:unit` and the fake-SDK harness instead.
- Env vars like `CYBOFLOW_RUN_ID` just mean you are hosted by the app; they don't change how you treat the repo. If a request is genuinely ambiguous between layers ("create a task for X"), ask instead of guessing.

## Reference docs (load on demand)

- `docs/ARCHITECTURE.md` — components, data model, IPC contract, dual-substrate seam + warm SDK sessions, build/test mechanics.
- `docs/CODE-PATTERNS.md` — canonical patterns: entity-write chokepoints, IPC type-parity rules, `@cyboflow-hidden`, localStorage key migrations, test conventions.
- `docs/cyboflow_system_design.md` — product spec and scope decisions.
- `docs/RELEASE-RUNBOOK.md` + `docs/signing/APPLE_DEVELOPER_SETUP.md` — load before any build, packaging, or release task.
- `docs/VISUAL-VERIFICATION-SETUP.md` — how to see/drive the UI (CDP attach on :9223 is the primary path; Peekaboo is the fallback, with TCC diagnostics).
- `docs/PROVENANCE.md` — fork lineage; standing rule: never merge or cherry-pick from Nimbalyst.
- `docs/crystal-legacy/` and `docs/workflows-future/` — historical reference, not current truth.

## Gotchas

- ALL backlog-entity writes go through the router chokepoints (`TaskChangeRouter.applyChange`, `ReviewItemRouter`) — nothing UPDATEs `ideas`/`epics`/`tasks`/`review_items` directly; the one sanctioned exception is the synchronous folded-gate co-write in `reviewItemListing.ts` (see `docs/CODE-PATTERNS.md`). The product's flow agents write entities via the `cyboflow_*` MCP tools, never markdown state files — that describes the built-in flows, not you (see "Two layers").
- `any` is forbidden (`@typescript-eslint/no-explicit-any` = `error`, CI-enforced). Type declarations that drift across an IPC/tRPC boundary silently drop fields instead of failing the build — read `docs/CODE-PATTERNS.md` → "IPC / type-parity rules" before touching any IPC surface.
- `@cyboflow-hidden` marks intentionally unreachable code: do NOT delete it, and do NOT add the marker to actively-called code (template and examples in `docs/CODE-PATTERNS.md`).
- `AbstractCliManager` (`main/src/services/panels/cli/`) is an intentional extension surface with several live subclasses (Claude SDK + interactive, Codex) — do not collapse it. Its base PTY methods are live for the interactive substrate even though the SDK manager bypasses them; see `docs/ARCHITECTURE.md` → "Dual-substrate seam".
- Changes under `main/src/services/panels/claude/` must also pass `pnpm test:integration` (mocked-SDK `*.itest.ts` suite; blocking CI job; structurally excluded from `test:unit`).
- localStorage key renames go through `frontend/src/utils/migrateLocalStorageKey.ts` — never ad-hoc `getItem`/`setItem` logic.

## Common commands

```bash
pnpm dev               # Electron dev (run `pnpm build:main` at least once first)
pnpm typecheck && pnpm lint
pnpm test:unit         # THE headless AC gate — for a SETTLED tree, not per-change (see below)
pnpm test:integration  # Mocked-SDK itest suite (required for panels/claude changes)
pnpm test:e2e          # Built-bundle Playwright; needs a real display — NOT an AC gate
pnpm electron:rebuild  # better-sqlite3 host-Node ABI (NMV 127) → Electron ABI (NMV 136)
pnpm rebuild better-sqlite3  # reverse fix: back to host-Node ABI after e2e/packaging, before vitest
pnpm test:gate         # Day-gate integration; needs `claude` on PATH — manual only
```

**Which tests to run when.** `pnpm test:unit` is the *final* gate, not the per-change gate. **Inside a sprint/ship lane** (an implement / write-tests / task-verify subagent) run only the tests covering your files — `cd main && npx vitest run <paths>` — never the full suite: lanes share ONE worktree, so a full-suite run there also executes siblings' half-finished uncommitted edits, making failures noise and a green result meaningless. The full suite is `sprint-verify`'s job, once, over the settled tree. Detail: `docs/ARCHITECTURE.md` → "Build & Run".

Full test-tier and ABI mechanics: `docs/ARCHITECTURE.md` → "Build & Run". Packaging/releases: `docs/RELEASE-RUNBOOK.md` (per-arch DMGs — `build:mac:universal` currently fails).

## Seeing the UI + debug logs

Frontend verification requires `pnpm dev` (full Electron) — the Vite renderer at `:4521` cannot bootstrap standalone (it needs preload-injected `electronTRPC`); see `docs/VISUAL-VERIFICATION-SETUP.md`. In dev mode the app writes `cyboflow-frontend-debug.log` and `cyboflow-backend-debug.log` at the project root (truncated on each launch) — read those instead of asking the user to paste console output.
