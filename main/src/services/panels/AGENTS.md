# Panel substrates — read before editing under this directory

Shared guidance for every agent runtime (the `CLAUDE.md` beside this file just imports it).

- Changes under `claude/` must ALSO pass `pnpm test:integration` (the mocked-SDK
  `*.itest.ts` suite — a blocking CI job, structurally excluded from `test:unit`). Run it
  from the repo root.
- `AbstractCliManager` (`cli/`) is an intentional extension surface with several live
  subclasses (Claude SDK + interactive, Codex, OMP, pi) — do not collapse it. Its base PTY
  methods are live for the interactive substrate even though the SDK manager bypasses
  them; see `docs/ARCHITECTURE.md` → "Dual-substrate seam".
