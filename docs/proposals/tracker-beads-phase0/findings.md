# Beads tracker provider — Phase 0 findings

Executed 2026-08-26 against `bd 1.2.2 (Homebrew)` on macOS (arm64), per the Phase 0 probe matrix
in `docs/proposals/tracker-beads-provider.md`. Seven probe groups ran in isolated scratch
workspaces (7 parallel agents, ~59 probes total, every filter probe with a negative control — the
Dart lesson). Raw command transcripts live in `./transcripts/<group>/` and double as Phase 2 test
fixtures. This document is the verdict summary plus every design-changing fact; the proposal has
been revised in place where a probe refuted it.

## Headline verdicts (what changed the design)

| # | Proposal assumption | Verdict | Design consequence |
|---|---|---|---|
| 1 | Beads exposes a per-issue `revision` token ("always present") | **REFUTED** — no revision/version/etag field anywhere in `bd list`/`bd show` JSON at any verbosity; the only per-write token is the Dolt `CommitHash` via `bd history --json` | Guarded writes redesigned: detect-after-write via history CommitHash (below), not conditional writes |
| 2 | Cheap (id, revision) sweep via `bd list --format <go-template>` | **REFUTED** — the Go-template branch of `--format` iterates dependency EDGES, not issues; on a dependency-free workspace it emits **0 bytes, exit 0, empty stderr** (silent no-op) | Sweep = full `--all --limit 0 --json` listing + client-side content fingerprint |
| 3 | `updated_at` is a usable optimistic-concurrency guard | **REFUTED** — 1-second DATETIME resolution; a stale guard silently PASSES inside a same-second window (lost update reproduced live in 3 attempts); display ROUNDS to nearest second while the `--updated-after` comparator FLOORS, so the displayed value can exceed the comparator's by 1s | Never guard on `updated_at`; cursor arithmetic must subtract ≥1s (the engine's 10-min overlap already covers this) |
| 4 | Native or SQL conditional update exists | **REFUTED** — zero CAS/if-match flags across all 109 subcommands (`--claim` is an advisory CAS on assignee+status only, protects no other field); `bd sql` is refused in embedded mode; direct `dolt sql` works mechanically but stamps `updated_at` in LOCAL time serialized with a lying `Z` suffix, bypasses Dolt commit history, and still loses updates in the same-second window | v1 outbound = write via `bd update`, then verify via `bd history` diff (detect-and-recover, see below) |
| 5 | Pull preserves origin `updated_at` → cursor evasion (Codex round 4, "must be tested") | **CONFIRMED end-to-end** — two real clones over a `file://` Dolt remote: pulled issues keep origin stamps; an issue created before a cursor snapshot but pushed after is invisible to `bd list --updated-after <cursor>` forever. Second proven vector: `bd import --allow-stale` applies content changes while preserving a fabricated old `updated_at` verbatim | Reconciliation ledger justified and REQUIRED, with fingerprints instead of revisions |
| 6 | Reads don't take the write lock (unspecified, probed) | **RESOLVED: they do** — `bd list` takes the same whole-database exclusive flock as writes; one workspace caps at ~2.7 ops/sec regardless of fan-out (negative control: 4 workspaces scale linearly) | Per-project serialized spawn queue is mandatory, not prudent |
| 7 | Lock contention surfaces as a retryable error | **REFUTED in the important half** — bd waits on the flock **forever** (proven to 200.9s, rc=0; no client-side timeout knob exists). The contention error string is only reachable when the CALLER kills a blocked bd (SIGTERM/SIGINT/SIGHUP → exit 1 + the string; SIGKILL → 137, empty stderr). In ~800 contended invocations bd never emitted it spontaneously | The adapter's own `execFile` timeout is what CREATES the classifiable retry signal; without it the retry path is dead code and a wedged holder hangs sync forever |
| 8 | Worktrees share the main repo's workspace (load-bearing premise) | **CONFIRMED** — `env -i` from a worktree resolves to the main repo's `.beads`; the worktree's checked-out `.beads/` has no `embeddeddolt/` and structurally cannot serve queries | Premise stands |
| 9 | Client-key recovery via `--metadata-field` | **CONFIRMED, all negative controls pass** — exact-match (uuid prefix → 0 rows), bogus key → 0 rows (not everything), wrong value → 0 rows; recovery-after-close finds the closed issue with `--all` and correctly not without; 10KB values round-trip byte-exact | Design stands as written |
| 10 | Identity anchor for `workspace_id` (probe: best candidate) | **RESOLVED**: `.beads/metadata.json` → `project_id` (UUID) — survives `bd rename-prefix`, changes on `rm -rf .beads && bd init`. Exposed by NO bd command (read the file directly). The init banner's "Repository ID"/"Clone ID" are deterministically derived (identical after a same-path reinit) and not persisted — unusable | `workspace_id` = metadata.json `project_id`, read from disk |
| 11 | `BEADS_DIR` pinning defends workspace targeting | **SUPERSEDED by a stronger lever** — precedence proven with sentinel-exclusion controls: `--db` > `-C` > `BEADS_DIR` > cwd walk-up. Argv flags beat the env var | Pin via `-C <project.path>` argv (immune to inherited env); env scrubbing stays as defense-in-depth |
| 12 | maxBuffer overflow shape (probe) | **PINNED** — 80 issues × 150KB descriptions = 12.3MB listing; Node `execFile` maxBuffer 10MiB → `err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`, child NOT killed (`killed`/`signal` undefined), partial stdout delivered truncated at exactly 10,485,760 bytes (invalid JSON), stderr `undefined`. Output is fully buffered (TTFB = 91.5% of wall time), so partial output is never parseable progress | Raised cap + terminal classification, exactly as proposed |

## Facts the proposal did not anticipate (now folded in)

**`updated_at` misses whole change classes.** `bd label add`, `bd comment`, and `bd dep/link add`
do NOT bump the issue's `updated_at` (proven per-op; `comment_count`/`dependency_count`/`labels[]`
visibly change). An `--updated-after` incremental pass will never surface them. The fingerprint
sweep (below) is the covering mechanism.

**Cursor formats.** `--updated-after` parses RFC3339+Z and honors real offsets (proven by
inclusion-flip); **date-only `YYYY-MM-DD` resolves to LOCAL midnight** (never emit date-only);
cursor fractional seconds are silently DISCARDED (truncated); non-date garbage errors cleanly
(exit 1), **but a date-SHAPED invalid value (`2026-13-45`, `2026-02-30`) silently drops the
filter entirely** — exit 0, output byte-identical to no filter at all. A corrupted cursor
degrades to a silent full fetch; the engine must emit strictly-formatted UTC RFC3339 and treat
cursor strings as validated data.

**The JSON contract has holes; parse stderr on failure.** With `--json` + `BD_JSON_ENVELOPE=1`:
errors are NEVER enveloped; `bd update <missing-id>` puts NOTHING on stdout (error only as plain
stderr text) while `bd show`/`bd close` put a JSON error object on stdout with different wording;
no-op/preview paths (`bd close` on closed, `bd reopen` on open, `bd delete` without `--force`)
print plain human text to stdout **with exit 0** despite `--json`; the double-close success line
echoes the NEW reason while persisting nothing (silent no-op at the data layer); `bd create`
returns a bare object while `update`/`close`/`show` return arrays, and un-enveloped `create`
splices `schema_version` in as a sibling of the issue fields. `bd info --json` and
`bd context --json` ignore `--json` entirely. Adapter rule: on exit≠0 classify from stderr; on
exit=0 tolerate non-JSON stdout on known no-op paths; always re-fetch to confirm state changes.

**Exit codes cannot classify failures.** Contention (caller-cancelled), corrupt store, missing
database, unknown id, readonly-violation are ALL exit 1, plain stderr, empty stdout. The
retryable string and the corrupt-store string share a byte-identical 68-char prefix
(`Error: failed to open database: embeddeddolt: init schema: embeddeddolt: open db: `).
Classify on the SUFFIX:

| stderr contains | class |
|---|---|
| `the database is locked by another dolt process` | transient — retry (only appears when we SIGTERM our own timed-out child) |
| exit 137, empty stderr | transient — our SIGKILL escalation |
| suffix `open db: EOF` (or `strconv.ParseUint` garbage — corrupt manifest leaks raw Go errors) | terminal — corrupt store |
| `Error 1049: database not found` | terminal — store gutted |
| `no beads database found` | terminal — workspace unresolved (identical text for: no `.beads` up-tree, `BEADS_DIR` nonexistent, `BEADS_DIR` empty, `.beads` renamed — bd cannot distinguish them) |
| `no issue found matching` | terminal — unknown id |
| `is not allowed in read-only mode` | terminal — config bug |

**Listing semantics.** The documented default `--limit 50` is DEAD — no `--limit` returns
everything (pass `--limit 0` explicitly anyway; upstream could "fix" the default at any release).
Default-hidden statuses are exactly `{closed, pinned}` (hardcoded; NOT derived from the
`bd statuses` category taxonomy — `deferred` shares `pinned`'s "frozen" category yet is visible).
An explicit `--status` filter overrides the default exclusion even without `--all`. Gates are
hidden even from `--all` (need `--include-gates`); ephemeral/wisp beads (including
`--type message`, which auto-sets ephemeral and injects a literal `-wisp-` id infix) are hidden
even from `--all` (need `--include-infra`, whose real effect is "anything ephemeral", broader
than its doc string); `molecule`-typed beads are visible by default; `--include-templates` never
revealed anything constructible. `bd types` and `bd create --type` disagree in both directions
(gate/molecule/message creatable but unlisted; convoy/merge-request listed in `bd list --help`
but rejected by create). `--tree`/`--flat` do not change JSON shape.

**Create/update/close/delete.** Create defaults: `priority: 2`, `status: open`,
`issue_type: task`; unset fields are OMITTED from JSON (never null); there is no `assignee` key
when unset — but an unrequested `owner` field auto-populates from git identity. `bd close` sets
`status/closed_at/close_reason`, no `--session` required; `bd reopen` clears `closed_at`/
`close_reason` (keys vanish). `bd delete --force` is a HARD delete — gone from `--all`, id
cleanly reusable via `bd create --id`. `bd create --json` is the ONLY place the true microsecond
timestamp ever appears; every later read rounds to whole seconds.

**Concurrency (all contention shapes measured).** Zero spontaneous failures in ~800 contended
invocations — bd blocks and always succeeds (single write waited 9.8s; 16 waiters behind a 200s
hold all succeeded, fair, no starvation). Read latency under write load: 0.35–5.4s for the same
query. Same-row vs different-row contention indistinguishable (whole-DB mutex). SIGKILL mid-write
10×: fully automatic recovery (kernel releases the flock), data intact, but leaks
`nbs_manifest_*` temp files. **`rm -f` of `.dolt/noms/LOCK` while held silently defeats the mutex
(flock is inode-bound)** — a `git clean -xfd` or `rm -rf .beads` racing an in-flight bd yields
two concurrent writers with no error on either side. The lock file is
`.beads/embeddeddolt/<db>/.dolt/noms/LOCK` (`.beads/embeddeddolt/.lock` is a decoy bd never
takes); the process image is named `beads`, not `bd` (supervisors/reapers must match accordingly).
`--readonly` is NOT a read-parallelism lever (still takes the exclusive lock; only an app-level
write guard). Fixed cost ~0.4s per invocation (fresh process boots the embedded Dolt engine).

**Guarded-writes verdict (probe group D, gates v1).** DETECT-AFTER-WRITE is the only sound
mechanism: (1) no native CAS; (2) `bd sql` blocked in embedded mode, and the direct-`dolt` SQL
guard both corrupts (local-TZ stamps serialized with a `Z` suffix — a touched row reads ~7h old
and breaks every newer-than comparison; no Dolt commit, so the edit is later absorbed into an
unrelated issue's auto-commit) and still silently loses updates in the same-second window;
(3) what DOES work: every bd write is a Dolt commit; `bd history <id> --json` returns
`{CommitHash, CommitDate, Issue: <full snapshot>}` per commit, so an engine can token = newest
CommitHash at pre-send read, write via `bd update`, then re-read history and diff adjacent
snapshots back to its token to attribute exactly which fields changed in between —
unrelated-churn vs same-field-divergence, per field. `bd show <id> --as-of <CommitHash>` resolves
a stored token to its exact historical snapshot (a true 3-way merge base). Costs/caveats:
`bd history` is UNFILTERED — entries ≈ all DB commits since the issue's creation (33 entries for
1 real change), so diff back to the token only, and treat `bd compact`/`bd flatten`/`bd gc` as
token invalidators (re-baseline); `Committer` is always `root` (attribution is what-changed only,
never who); `content_hash` (varchar(64), a real SHA-256 on the `issues` table) is a TRAP — set at
creation, never recomputed. `--as-of <unresolvable-hash>` is bd's only exit-0 error (empty
stdout, error on stderr only).

**Cross-machine surface.** There is no `bd sync` command — the proposal's reference was wrong.
Two independent mechanisms: `bd dolt remote add` + `bd dolt push/pull` (git-style, `file://`
supported — used for the two-clone proof) and `bd federation add-peer`/`sync` (named peers,
per-peer `--strategy ours|theirs`; NOT live-tested). A no-op pull changes nothing (full
(id, updated_at) projection diff empty). `bd init --remote <url>` clones+bootstraps in one step.

**`bd init` side effects (connect-UX facts).** Vanilla `bd init` in non-interactive mode
auto-COMMITS 18 files to the user's repo with no prompt — including `.claude/settings.json`
registering a SessionStart hook (`bd prime --hook-json`) that fires for every collaborator, plus
AGENTS.md/CLAUDE.md; `--skip-agents --skip-hooks` still auto-commits; only `--stealth` avoids the
commit (writes `.git/info/exclude`, chmods `.beads` to 0700) — and `--stealth`'s two help texts
contradict each other (flag text says global gitattributes/gitignore; long help says per-repo
exclude only). Telemetry is ON by default (`metrics.disabled = false`, endpoint
`https://gastownhall-eventsapi.com/mp/collect`, global `~/.config/bd/config.yaml`; a detached
`bd send-metrics` process was observed; bd touches `~/.beads/eventsData/` on every invocation
regardless of workspace). Detect must NEVER run `bd init` for the user; docs must disclose both
behaviors.

**Misc.** `bd context` unconditionally refuses any workspace under `/private/tmp`
("BEADS_DIR points to unsafe location", even with the var unset) — use `bd where` + read
`metadata.json`; test fixtures beware. `bd doctor` is a no-op in embedded mode (exit 0 while the
store is corrupt). Write amplification: ~18KB on-disk growth per `bd update` (9.6MB for 5
issues); `compaction_enabled = false` by default. `bd import` of 12.3MB JSONL: 0.73s. Upward
walk-up means a wrong-cwd call silently operates on an ancestor's database with exit 0.
`bd label add <missing-id>` exits 0 despite printing an error (the one not-found path that
doesn't exit 1). bd's dolt-auto-commit default is documented "off" yet every write observably
produced a Dolt commit — verify the effective policy at Phase 2 before relying on history.

## Full per-probe verdicts

The seven structured probe reports (59 probes: id, question, verdict, verbatim evidence,
surprises, per-group landmine lists) are preserved verbatim in the session transcripts under
`./transcripts/`. Groups: `a-list-semantics` (7 probes), `b-cursor-timestamps` (7),
`c-crud-metadata` (7), `d-revision-guard` (8, opus), `e-concurrency-locks` (15, opus),
`f-workspace-scale` (11), `g-dolt-pull` (4).

Not exercised (explicitly): `bd federation sync` conflict strategies; `bd serve`; server-mode
(`bd init --server`) behavior; out-of-process wall-clock skew (the import path proves the
cursor-evasion mechanism regardless); whether `bd history` supports a bound/limit flag
(Phase 2 checks `bd history --help`).
