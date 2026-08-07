# Repository Guidelines

## Project Structure & Module Organization
- Root `pnpm` workspace with packages: `main/` (Electron main process, TypeScript), `frontend/` (React + Vite), `shared/` (shared types), and `tests/` (Playwright E2E).
- Key paths: `main/src/{services,ipc,utils}/`, `frontend/src/{components,hooks,stores,utils}/`, `main/assets/`, `scripts/`.
- Build artifacts: `frontend/dist/`, `main/dist/`, packaged output `dist-electron/`.

## Build, Test, and Development Commands
- Dev app: `pnpm dev` (spawns frontend + Electron).
- Build all: `pnpm build` (frontend, main, then electron package).
- Package (examples): `pnpm build:mac:arm64`, `pnpm build:mac:x64` (macOS-only; per-arch — the universal `build:mac` currently fails on the bundled agent binaries, see `docs/RELEASE-RUNBOOK.md`).
- Lint: `pnpm lint`; Type-check: `pnpm typecheck` (runs per package).
- **Final code-change gate: `pnpm test:unit`** (main + frontend vitest + schema parity + build scripts) — for a *settled* tree. While work is in progress, and always inside a sprint lane, run scoped tests instead: `cd main && npx vitest run <paths>`. See "Testing Guidelines".
- E2E (`pnpm test:e2e`, `pnpm test:ui`): drives the built Electron bundle via Playwright `_electron.launch()`; needs a real display, so it is NOT the headless gate. See `docs/ARCHITECTURE.md` "Build & Run".
- Main unit tests (if added): `pnpm --filter main test`, coverage: `pnpm --filter main run test:coverage`.

## Coding Style & Naming Conventions
- Use TypeScript throughout; follow ESLint configs in `frontend/eslint.config.js` and `main/eslint.config.js`.
- Indentation 2 spaces; prefer explicit types at module boundaries.
- Naming: `camelCase` for variables/functions, `PascalCase` for React components/types, `kebab-case` for filenames (React files may match component name).
- Run `pnpm lint && pnpm typecheck` before sending PRs.

## Testing Guidelines
- **Which tests to run when.** `pnpm test:unit` is the *final* gate, not the per-change gate — it runs two full vitest suites, so several agents running it at once pin every core.
  - **Inside a sprint/ship lane** (you are an implement / write-tests / task-verify subagent): run ONLY the tests covering your files — `cd main && npx vitest run <paths>`. Do **not** run `pnpm test:unit`. Lanes fan out into ONE shared worktree, so a full-suite run there also executes your siblings' half-finished uncommitted edits: unrelated failures are noise and a green result proves nothing about your task. The full suite is `sprint-verify`'s job, once, over the combined state.
  - **Final verification** (`sprint-verify`, or an interactive session finishing a change): `pnpm test:unit` once, over the settled tree. See `CLAUDE.md` for why E2E is not the gate.
  - Prefer `npx vitest run` per workspace over `pnpm --filter` — filter recursion has broken bin PATH resolution in this repo.
- For backend logic in `main/`, use Vitest colocated under `main/src/**/__tests__` or `*.spec.ts`; frontend likewise.
- E2E tests live in `tests/*.spec.ts` (Playwright); they drive the built Electron bundle via `_electron.launch()` and need a real display (the host-Node ABI is restored automatically by the next `pnpm test:unit`; for a direct `npx vitest run`, use `node scripts/ensure-sqlite-abi.mjs host`).

## Commit & Pull Request Guidelines
- Commits: present tense, focused, reference issues (e.g., "Fix session diff flicker, closes #123").
- PRs must include: clear description, linked issues, testing notes; screenshots/GIFs for UI changes.

## Security & Configuration Tips
- Node >= `22.14`; `pnpm` >= `8`. Use `pnpm` only.
- Secrets via `.env` (dotenv) for local dev; never commit secrets.
- To avoid clobbering local data when hacking on Cyboflow with Cyboflow: `CYBOFLOW_DIR=~/.cyboflow_test pnpm dev`.

## Agent Notes (for automation)
- Keep changes minimal and scoped; prefer small patches.
- Update docs alongside code; do not alter build targets without discussion.
- Use repository scripts (pnpm) and keep formatting consistent with existing files.

## Codex Notes
- Treat this file as the automation entrypoint. It points to deeper project practices rather than duplicating the full handbook.
- Always review the root `CLAUDE.md` before beginning non-trivial work.
- Before editing or reasoning about files, scan for every `CLAUDE.md` in the repository.
- Apply `CLAUDE.md` files by directory scope: read the root `CLAUDE.md` first, then any `CLAUDE.md` files on the path from the repository root to the files being changed. The closest `CLAUDE.md` to the changed file provides the most specific local guidance.
- If `AGENTS.md` and `CLAUDE.md` conflict, follow `AGENTS.md` as the automation entrypoint unless the user explicitly says otherwise. If two `CLAUDE.md` files conflict, the lower-level directory-scoped file wins for files under its directory.
- **Exception — your workflow prompt outranks this file on scope.** When you run as a Cyboflow flow subagent, your step's instructions define what YOU are responsible for and win over the general advice here. Concretely: this file names the repo's gate, but if your step says to run only the tests covering your files and never the full suite, obey that. Do not escalate to a repo-wide command just because `AGENTS.md` mentions one.
- Do not use `cyboflow_*` MCP tools unless the user explicitly asks to modify live Cyboflow app data.
- Use `pnpm test:unit` as the FINAL verifier gate for a settled tree, unless the user explicitly asks for a different verification path. While work is in progress — and always inside a sprint lane — run scoped tests instead (see "Testing Guidelines").
