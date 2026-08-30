# docs/

Index of the documentation tree.

**Agent entry points:** shared guidance for all agents lives in
[`AGENT-GUIDE.md`](AGENT-GUIDE.md). Root-level `CLAUDE.md` (Claude runtimes) imports it;
root-level `AGENTS.md` (Codex, OMP, pi, other runtimes) points to it. Each of those two files
carries only runtime-specific notes.

## Current reference docs

| Doc | What it covers |
| --- | --- |
| [`AGENT-GUIDE.md`](AGENT-GUIDE.md) | Shared agent guidance: two-layers rule, gotchas, commands, test tiers |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Components, data model, IPC contract, dual-substrate seam, build/test mechanics |
| [`CODE-PATTERNS.md`](CODE-PATTERNS.md) | Canonical code patterns: write chokepoints, type parity, test conventions |
| [`RELEASE-RUNBOOK.md`](RELEASE-RUNBOOK.md) | The release procedure: gate → 4 signed per-arch DMGs → R2 feeds → GitHub |
| [`UPDATES.md`](UPDATES.md) | R2 update channel, feed mechanics, per-variant data-dir resolution |
| [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md) | sessions.db snapshots, raw_events shard archive, restore procedure |
| [`VISUAL-VERIFICATION-SETUP.md`](VISUAL-VERIFICATION-SETUP.md) | Seeing/driving the UI: CDP on :9223, Peekaboo fallback |
| [`SHELL-LAYOUT.md`](SHELL-LAYOUT.md) | Renderer shell geometry and navigation state |
| [`PERFORMANCE.md`](PERFORMANCE.md) | CPU/memory harness, baselines, measurement traps |
| [`PROVENANCE.md`](PROVENANCE.md) | Fork lineage (Crystal 0.3.5); never merge from Nimbalyst |
| [`cyboflow_system_design.md`](cyboflow_system_design.md) | Original product spec and scope decisions (predates several shipped flows) |
| [`ARCHITECTURE-diagram.md`](ARCHITECTURE-diagram.md) | Companion diagram to ARCHITECTURE.md — currently stale (2026-08 audit); trust the prose doc |
| `signing/`, `packaging/` | Apple signing setup + Gatekeeper checklist; root-deps policy |

## Design-time docs

`proposals/`, `plans/`, `design/`, `ideas/` hold point-in-time design documents. Many
describe work that has **since shipped** while still carrying a stale "PROPOSED"/"not
started" status banner (2026-08 audit; a status/relocation sweep is pending) — trust
`git log` and the code over a file's Status line.

## Historical

- `archive/` — shipped/superseded docs, moved here per the policy in `archive/README.md`.
- `crystal-legacy/` — Crystal-era guides; historical reference, not current truth.
- `initial_research/` — pre-fork stack/architecture research (conclusions absorbed into
  PROVENANCE.md and ARCHITECTURE.md).
- `workflows-future/`, `probes/`, `prototypes/`, `screenshots/`, `protoflow-design/` —
  flow-prose ideas, finished probe records, design mockups and capture assets.
  `protoflow-design/` is the source of the live design tokens.
