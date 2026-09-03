# cyboflow — non-Claude agent entry point (Codex, OMP, pi, …)

cyboflow is an Electron desktop app for running AI coding flows in parallel against one
project, isolated via git worktrees (a fork of Crystal 0.3.5).

**Before any non-trivial work, read `docs/AGENT-GUIDE.md`.** It is the canonical shared
guidance for every agent runtime — the two-layers rule (working ON the codebase vs. touching
the live app's backlog via `cyboflow_*` MCP tools), the codebase gotchas, common commands,
which tests to run when, and the reference-doc index (`docs/README.md`). This file never
restates or overrides it; it only adds what is specific to non-Claude runtimes.

## Non-Claude specifics

- `CLAUDE.md` and `.claude/` are Claude-runtime entry points that import the same shared
  guide — you do not need to read them, and they carry no extra authority over it.
- When you run as a cyboflow flow subagent, your step prompt outranks repo-wide guidance on
  scope — see "Precedence" in the guide.
