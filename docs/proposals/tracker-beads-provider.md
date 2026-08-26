# Beads as the 4th tracker-sync provider

Status: PROPOSAL (investigation complete 2026-08-26; Codex adversarial rounds 1-9 absorbed (13 high + 3 medium) —
see "Review findings absorbed" at the end; not started)

Beads (`bd`, github.com/gastownhall/beads, MIT, Go, single static binary) is a git-adjacent,
agent-first issue tracker a user has asked us to support. This proposal's core finding: **the
"git-native = separate machinery" premise is outdated.** Beads pivoted at v1.0.0 (2026-04-02) from
JSONL-files-in-git to an embedded [Dolt](https://www.dolthub.com/) database, and the integration
that falls out is *closer to our existing adapter seam than Plane or Dart were* — an API
integration whose transport is a local CLI instead of HTTPS.

All beads facts below were fetched from the repo docs at v1.2.2 (2026-08-15, latest release as of
writing) and spot-verified by a second independent pass with verbatim quotes. Citations are doc
paths in that repo.

---

## Why the feared complications don't exist

1. **Issue data does not ride code branches.** The Dolt database lives in
   `.beads/embeddeddolt/` (or `.beads/dolt/` in server mode) and is **gitignored — `bd init`
   writes `.beads/.gitignore` itself**. Dolt keeps its own version history under the git ref
   `refs/dolt/data`, never on `refs/heads/*`: "Beads commands do not commit issue updates to your
   current code branch" [`docs/reference/git-integration.md`, `docs/reference/protected-branches.md`].
   Only `.beads/config.yaml` + `metadata.json` (+ optional `formulas/`) are committed.
2. **All worktrees share one database.** "All worktrees in the same repository use the same beads
   workspace unless you override discovery with `BEADS_DIR`" — discovery walks up from linked
   worktrees to the main repo's `.beads/` [`docs/reference/worktrees.md`]. Cyboflow's parallel
   session worktrees therefore all see one store: no per-branch divergence, no JSONL merge
   conflicts between lanes, no merge-back or post-merge reconciliation problem. A lane agent
   running `bd` in its worktree and our sync engine running `bd` at the project root hit the same
   database.
3. **Cross-machine sync is the user's job.** `bd dolt push/pull` (or the `bd sync` wrapper)
   against the same git remote, explicitly invoked or cron'd by the user. v1 does not touch it.
4. **JSONL is dead as a storage format.** `.beads/issues.jsonl` is export/interchange only,
   opt-in, "not the canonical cross-machine sync channel" [`docs/core-concepts/sync-concepts.md`].
   The SQLite backend that preceded Dolt was fully deleted ("Dolt is the only backend",
   CHANGELOG 0.58.0 → completed at v1.0.0).

What *is* genuinely new for us: the transport is a spawned binary, the provider has no
credentials, and the embedded database is **single-writer** ("'database is locked' errors.
Embedded mode is single-writer (enforced via file lock)" [`docs/architecture/dolt.md` → Lock
Contention]). Those three drive everything below.

## Decision: 4th `TrackerAdapter`, transport = `bd` CLI

Build `beadsAdapter` inside the existing seam (`main/src/services/trackerSync/`), reusing the sync
core — outbox, cursor, 3-way merge, conflicts, deletion sweep, direction modes, field write-back,
`entity_external_links` — unchanged. The adapter contract (`adapterTypes.ts:166-293`) is already
transport-agnostic: "pure API clients: no sqlite access, no TaskChangeRouter calls, no retry loops
of their own." `writeBack.ts` makes zero network calls by design and needs nothing.

**Rejected alternatives:**

- **JSONL import/export bridge** (`bd export`/`bd import` diffing): beads' own docs demote JSONL;
  loses incremental cursors, atomic writes, and the post-write echo stamp.
- **`bd serve` HTTP transport**: would slot into our fetch-shaped adapters perfectly, but it is
  self-labeled experimental v0, loopback-only, with write endpoints only starting to land, and we
  would own the serve-process lifecycle. Revisit later as a drop-in transport swap — the adapter
  boundary makes that swap invisible to the engine.
- **No sync engine at all — agents just use `bd`**: beads is agent-first (`bd init` writes
  `AGENTS.md`; CLI-direct is its recommended agent surface) and nothing stops session agents from
  doing this *today*. But it leaves the cyboflow backlog/planner/sprint UI blind to beads issues,
  which is the thing being asked for. Note it as a complementary zero-work capability, not the
  integration.

### Method-by-method mapping

| Adapter method | bd invocation | Notes |
|---|---|---|
| `validateCredentials()` | `bd version` + workspace probe (`bd where` / config read) in `project.path` | returns identity; see "Keyless connect" |
| `listGroups()` / `listContainers()` / `listNarrows()` | — | one degenerate "workspace" group (Dart-space precedent); narrows = `['all']` |
| `listStates(selection)` | status vocabulary from config/`bd` | built-ins `open, in_progress, blocked, deferred, closed` + custom statuses; each custom status carries a behavior category (`active/wip/done/frozen`) that seeds `TrackerStateGroup` like Plane's `group` field |
| `listFieldOptions()` | static + config | priorities 0–4; types `bug/feature/task/epic/chore` (+ customs) |
| `listIssues(sel, sinceIso)` | `bd list --all --json --limit 0 --updated-after <iso>` | `--all` is load-bearing: default `bd list` **excludes closed issues**, so without it a remote close never syncs as a state transition. Keep the Dart hedge on the bound: send it widened, re-apply the exact inclusive bound client-side (gt-vs-gte undocumented) |
| `listIssueIds(sel)` | `bd list --all --json --limit 0` (ids only) | sweep ground truth — MUST include closed issues, or the sweep misreads every closed linked issue as deleted and orphans its link. Closed-then-`bd prune`/`bd gc`-decayed issues (default: closed >90d) *do* drop out of `--all` — the sweep then archives the local twin, which is the correct reading of a remote GC |
| `getIssue(id)` | `bd show <id> --json` | local + fast; sweep's N point-lookups are fine |
| `createIssue` / `createSubIssue` | `bd create --json` (+ `--parent <id>`) | client key via `--metadata` (below) |
| `updateIssueState(id, stateId)` | `bd update <id> --status … --json` | |
| `updateIssueContent(id, patch)` | `bd update <id> … --json` | the returned post-write issue is the echo-suppression stamp source, same as HTTP providers |
| `archiveIssue(id)` | — | capability `archive: 'none'` (Plane precedent): engine falls back to the cancelled-state write (`bd close --reason`), and the removal dialog's `removalWriteBackAction` disclosure already handles the copy |

Spawn every command with `BD_JSON_ENVELOPE=1` (envelope `{"schema_version":1,"data":…}` becomes
the default in v2.0 — opting in now pins us to the stable shape across that break)
[`docs/reference/json-schema.md`].

### Capabilities row

```
beads: {
  nativeParentAutoClose: false,
  selfHostedBaseUrl: false,
  idempotentCreate: false,        // bd mints the id; see client-key note
  contentWrite: { title: true, description: true, priority: true, category: true },
  archive: 'none',
}
```

**Client key via `metadata`, not a description marker.** Beads has a first-class arbitrary-JSON
`metadata` field with a `--metadata-field key=value` list filter. Recovery for a create whose
response was lost = `bd list --all --json --limit 0 --metadata-field cyboflow_client_key=<uuid>`
(`--all` here too — Codex round-2 finding 2: a create that lands, loses its response, and is
closed before recovery runs — e.g. across an app restart — would otherwise report "no match" and
the non-idempotent retry duplicates it; Phase 0 gets the matching negative control) — cleaner
than the
Plane/Dart description-marker hack, and the marker never pollutes descriptions a user reads in
`bd show`. Caveat carried into implementation: the caller-side body-write marker re-append
(field-writeback invariant 4) exists *because* the key lives in the description for Plane/Dart;
with a metadata key, beads description writes need **no** marker composition at all. If the
caller-side marker plumbing turns out to be provider-keyed in a way that fights this, fall back to
Dart's markdown marker line verbatim — decide at Phase 0 with a probe, not by reading harder.
Reserved-namespace note: beads reserves `bd:`/`_`-prefixed metadata keys; `cyboflow_client_key`
is safe.

### Data-model fit (unusually good)

- **Priority**: beads 0–4 (0 = highest) → `CANONICAL_TOKENS` seed P0→`0` … P4→`4`, P5/P6→`4`
  (lossy tail-compression like every provider; comparisons stay in provider space per invariant 2
  of the field-writeback plan). Unset/default semantics probed at Phase 0.
- **Category**: `CATEGORY_SYNC_SUPPORTED: true`. Seed `bug→bug`, `feature→feature`, `chore→chore`;
  `task` and the exotic types (`epic`, `decision`, `molecule`, `gate`, …) map inbound to `feature`
  by default, overridable by the existing category overlay.
- **Hierarchy**: parent-child (`--parent`, dotted hierarchical ids) covers sub-issue mirroring.
  `nativeParentAutoClose: false` → our shared close-parent-when-children-done write applies, as
  with Plane.
- **Statuses**: the 5 built-ins + customs feed the ordinary state-mapping wizard step;
  `deferred`/`blocked` land wherever the user maps them.
- **Identifier**: beads ids (`bd-a1b2`, hash-based, collision-safe across clones) are both
  `externalId` and `external_identifier` — human-readable enough, like Dart.

## The five genuinely new pieces

### 1. Keyless connect

The single largest structural mismatch. `TrackerCredentialsInput.apiKey` is a required wire field
(`shared/types/trackerSync.ts:19-26`), `connect()` unconditionally runs
`encryptTrackerSecret(credentials.apiKey)` (`trackerSyncService.ts:1588`), and the wizard's
Authorize button gates on a non-empty key (`TrackerWizardModal.tsx:1316`). The
`secret_ciphertext` column is already nullable, so the change is code-path only:

- `TrackerProviderMeta` gains `needsApiKey: boolean` (true for the existing three). For beads the
  Connect step renders no key input; Authorize becomes **Detect**: probe the `bd` binary (reuse
  `probeCliVersion` + `getShellPath` — the macOS-GUI-minimal-PATH problem is already solved) and
  confirm `project.path` is `bd init`ed. Failure copy distinguishes "bd not installed" from
  "repo has no beads workspace" with the init hint.
- **Every NULL-secret consumer becomes provider-aware, not just `connect()`** (Codex round-2
  finding 1: a connect-only branch produces a connection that pauses on its first sync).
  Introduce a single `providerNeedsSecret(provider)` predicate (a
  `Record<TrackerProvider, boolean>` beside the capabilities tables) and consult it at every
  guard that currently treats an absent ciphertext as fatal:
  - `buildAdapter()` (`trackerSyncService.ts:1229-1243`) — throws `TrackerCredentialsError` on
    null/empty cipher before the factory runs; every inbound pass and outbox drain routes through
    it. Keyless providers skip decryption and hand the factory an empty secret.
  - `credentialsForConnection()` (`:1352`) — throws `TrackerAuthError` on missing cipher, which
    would dead-end mapping management (add-mapping wizard re-entry). Keyless providers return a
    credentials value with no key.
  - `connect()` skips `encryptTrackerSecret` and stores `secret_ciphertext = NULL`; the
    disconnect-clears-the-key / credential-carrier machinery degrades to a no-op for keyless rows.
  - `updateCredentials`/reconnect surfaces render as **re-detect** (probe again, no paste field).
  NULL stays invalid for the three keyed providers — the predicate makes that explicit rather
  than loosening the guards globally. Tests must cover: initial sync, Sync now, mapping
  management re-entry, pause + re-detect resume, and app restart with a NULL secret.
- **Identity**: `workspace_id = null` matches nothing in `connectionMatchesIdentity`/revival
  (store.ts: "an identity we never learned cannot be claimed BY identity"), so stamp
  `workspace_id` with the **immutable database instance identifier** (NOT the issue prefix —
  committed config survives a same-path reinit, an instance id does not; see "Workspace identity
  must survive same-path replacement" under CLI transport). `workspace_name` = the issue prefix;
  `actor_label` = local git `user.name`. `base_url` stays `NULL`
  (`PROVIDER_DEFAULT_BASE_URL.beads = null` — the wizard's instance-URL field already hides
  itself). A reinit or `bd rename-prefix` therefore pauses the connection for re-detect rather
  than silently continuing; revival misses are the accepted cost.

### 2. CLI transport

First non-fetch adapter. Build on `runToolCapture` (`main/src/utils/runGit.ts` — argv-only
`execFile`, never a shell, login-shell PATH via `buildCommandEnv`), with a constructor-injected
`execImpl` mirroring the existing adapters' injected `fetchImpl` for tests. `cwd = project.path`
(stable; any worktree would resolve to the same workspace, but root doesn't disappear when a
session is dismissed). `defaultAdapterFactory` needs the project path — thread it through the
factory (it already receives the connection row, which carries `project_id`).

**Workspace pinning — never trust inherited env** (Codex round-3 finding 2). `buildCommandEnv`
copies `process.env`, and beads honors a `BEADS_DIR` override ahead of discovery — an app
launched with `BEADS_DIR` set (a documented beads usage pattern) would silently probe, import,
close, and update issues in that one workspace for *every* project while each connection looks
valid. Fix is deterministic pinning, not just scrubbing: the Detect step resolves the workspace
(`bd where`) with `BEADS_DIR` **deleted** from the child env, persists the resolved `.beads`
path on the connection, and every subsequent spawn passes that stored path back explicitly as
`BEADS_DIR` — discovery can never drift, and a stored path that stops resolving throws
`TrackerAuthError` (re-detect). Negative test: an inherited `BEADS_DIR` in the parent env must
not redirect detection, reads, recovery, or writes. External-shared-workspace setups (deliberate
`BEADS_DIR` decoupling) are out of v1 scope — Detect fails honestly on a repo with no
discoverable workspace.

**Workspace identity must survive same-path replacement** (Codex round-5 finding 1). A pinned
path is a location, not an identity: `rm -rf .beads && bd init` (same committed prefix) resolves
cleanly at the same path, `listIssueIds` returns none of the old ids, and the deletion sweep
would archive every linked local entity. So the connection stores TWO things, with explicit
homes: the canonical workspace path (in `source_json`, alongside the existing opaque selection
payload — no new column) and an **immutable database instance identifier as `workspace_id`**
(replacing the prefix, which moves to `workspace_name` — committed config survives a reinit, an
instance id does not). Phase 0 probes the best anchor: a `metadata.json` identifier if beads
exposes one, else the Dolt database's root-commit hash via SQL (deterministic and immutable per
init). **Validation is a sandwich, not a preflight** (Codex rounds 6-7: a top-of-pass check
leaves TOCTOU windows), applied per direction:

- **Inbound (imports, merges, cursor, sweep archival)**: every adapter read returns its complete
  batch before the engine's apply loop begins (adapters paginate internally; `bd` is a single
  process reading one opened database, so a batch is wholly from one instance). Re-check the
  instance id **after ALL of a phase's adapter reads, before its first local mutation** —
  `listIssues` → re-check → apply loop, and for the sweep: `listIssueIds` **plus every
  absent-id `getIssue` disambiguation lookup** → re-check → archival (Codex round-8: the point
  lookups are adapter reads that influence archival — a re-check placed after the listing but
  before them would leave lookups running against a replaced database and a moved issue's null
  answer would archive its live twin). A mismatch or failed re-check discards
  the collected batch and pauses via `TrackerAuthError`. No local write (entity, link, conflict,
  or cursor) ever derives from an unrevalidated batch. This closes every destructive local case,
  including replacement *during* a listing.
- **Outbound (creates, updates)**: re-check identity immediately before **each** mutation, inside
  the same per-project mutex window as the spawn. The residual window — a replacement landing in
  the sub-second gap between that preflight and the child process opening the database — is
  **explicitly accepted**: it requires a deliberate same-path reinit mid-write, its worst case is
  one stray issue in the brand-new (empty) replacement workspace, no local data is touched, and
  the row then settles through recovery, whose own listing re-checks identity first (wrong
  instance ⇒ pause, never a blind retry). Atomically binding a CLI spawn to an instance id is
  not possible from outside the process; this residual is the floor, and it is non-destructive.

Negative tests: same-path reinit (a) before a pass, (b) between the initial check and
`listIssueIds`, (c) between `listIssues` and the apply loop, (d) between `listIssueIds` and an
absent-id `getIssue` lookup — zero local mutations in all four — and (e) before an outbound
drain, proving the preflight pauses the row. Note: keyless identity
matching must skip `normalizeBaseUrl` URL parsing (`base_url` stays NULL for beads; the path is
not a URL).

**Error taxonomy: retry only the recognized-transient** (Codex round-5 finding 2). The
retryable-by-default mapping would let a deterministic failure — unknown flag after a `bd`
downgrade, incompatible output after an upgrade, permission failure, corrupt workspace — churn
forever at the release velocity this proposal itself documents. Inverted classification:
- recognized transient (embedded-lock contention, timeout) → `TrackerApiError{status: null}`,
  the retry path;
- deterministic configuration/compat failures (`bd` missing from PATH, repo not a beads
  workspace, unrecognized-flag usage errors, envelope/schema parse mismatch,
  `schema_version` ≠ 1, permission errors, workspace-integrity failures, version-below-minimum)
  → `TrackerAuthError` — paused with the actionable stderr in the banner; re-detect resumes;
- unclassified non-zero exits → retryable, but with a consecutive-failure threshold per
  connection (N failed passes → escalate to the paused state with the last stderr) so unknown
  deterministic failures cannot loop silently.
Phase 0 pins the failure shapes for: downgraded/upgraded `bd`, malformed JSON, permission
denial, and the reinit case above.

**Bounded listings — overflow is terminal, not transient** (Codex round-3 finding 3).
`runToolCapture`'s default `maxBuffer` is 10MB (`runGit.ts:38`); a large workspace's
`bd list --all --json --limit 0` can exceed it, and a buffer overflow classified as retryable
would stall initial import or every sweep in an infinite retry loop. Design: (a) the sweep never
captures full JSON — project ids only via `bd list`'s `--format` go-template (one id per line;
bounded at ~20 bytes/issue, fine far past beads' own 100k-issue guidance); (b) incremental
`listIssues` windows are naturally small; the full backfill (no cursor) pages by
`--created-after`/`--created-before` time windows if Phase 0 shows single-shot output can be
large, else runs single-shot under an explicit raised cap (64MB); (c) a `maxBuffer` overflow maps
to a TERMINAL, actionable failure (pause + "workspace too large — see docs"), never the
transient-retry path. Phase 0 includes a probe whose listing output exceeds the default 10MB.

Error taxonomy: ONE authoritative classification — see "Error taxonomy: retry only the
recognized-transient" below (Codex round-6 finding 2 caught an earlier retryable-by-default
mapping left standing here in contradiction; it is deleted, the inverted table below governs).

Timeout: per-adapter constant, not the HTTP 30s verbatim — `bd` is local and usually ms-fast, but
Dolt maintenance ops can take seconds; use `execFile`'s `timeout` (start at 30s, revisit at
Phase 0 with measurements).

### 3. Concurrency and the single-writer lock

Three writer populations contend for the embedded lock: our tick/outbox, session agents running
`bd` in worktrees, and the human's own `bd`. Mitigations, in order:

- Serialize **our own** spawns per project with the existing in-process `withLock` mutex — never
  let the inbound pass and the outbox drain race each other into the lock.
- Treat external contention as transient retryable (above). The outbox already retries with
  backoff; a failed inbound pass retries on the next 5-minute tick. This matches beads' own
  multi-agent guidance, where embedded-lock errors are expected transients.
- Whether **reads** also take the lock is undocumented (verified UNSPECIFIED) — probe at Phase 0.
  If reads lock too, keep passes short (they already are: one `bd list` + point lookups) and
  document `bd init --server` (dolt sql-server, concurrent writers) as the recommended setup for
  heavy multi-agent use. Do not auto-migrate the user's storage mode — respect their init choice.
- The detached visual-verify snapshot worktree is read-only territory: a `bd` write there mutates
  the *shared* database from a throwaway checkout — worth one sentence in the verify agent docs,
  not machinery.

### 4. Pull reconciliation — timestamp-independent discovery

Codex round-4 finding: `bd dolt pull` merges Dolt history while (expectedly — Phase 0 must
confirm) **preserving each issue's original `updated_at`**. An issue authored on another machine
and pulled in later can therefore carry a timestamp older than our persisted cursor minus the
overlap window — `--updated-after` will never return it, and the deletion sweep can't recover it
because it only compares the remote id set against *already-linked* entities. Permanently
invisible, with no error.

Fix rides the pass structure that already exists: the every-12th-pass (and every manual
"Sync now") sweep already fetches the **full remote id set**. Extend that pass, gated by a new
`capabilities.requiresIdReconciliation` flag (true only for beads), to diff the id set against
known links plus a **durable reconciliation ledger** — any unseen id gets a `getIssue` point
fetch and runs through the ordinary import path. Bounded (point lookups only for the delta),
timestamp-independent, and "the user just pulled" has an immediate manual remedy since Sync now
always sweeps. The incremental `--updated-after` cursor stays the fast path; reconciliation is
the periodic backstop.

**The ledger is new, durable state — the engine has none to reuse** (Codex round-9 finding 2:
inbound "permanent skips" today are cursor-advances plus in-memory report counters; no external
id or reason is persisted anywhere, so a subtract-the-skipped design would re-point-fetch every
non-imported id on every sweep — thousands of CLI spawns per hour on a workspace dominated by
skipped classes). Design: a `tracker_reconciliation_ledger` table in the same migration —
`(connection_id, external_id, reason, config_generation, seen_at)`, `UNIQUE(connection_id,
external_id)` — written whenever reconciliation resolves an unseen id WITHOUT minting a link
(imported ids need no row; their link is the record). `config_generation` is a counter stamped
on the connection and bumped by any mapping/state-mapping/selection change; ledger rows from an
older generation are treated as absent, so a config change re-evaluates previously skipped ids
exactly once. Rows for ids that vanish from the remote set are deleted opportunistically during
the same sweep. Tests: a repeat sweep over unchanged skips performs ZERO point lookups; a
mapping change re-considers exactly the eligible skipped ids. Sizing note: the first
reconciliation over a legacy workspace point-fetches every unlinked id once (closed issues
included) — a bounded one-time cost, after which each id is linked or ledgered.

Phase 0 negative control: advance the cursor, introduce an issue with an older `updated_at`
(via `bd import` of a backdated record, simulating a pull), prove the reconciliation pass
discovers and imports it — and confirm the pull-preserves-`updated_at` assumption directly.

### 5. Migration + mechanical widenings

Standard CHECK-widening at the next free prefix (≥123): full recreate of `tracker_connections` +
`entity_external_links` per the `105_tracker_provider_dart.sql` pattern (NOT NULL provider, no
default — `ADD COLUMN` is structurally unavailable and `DEFAULT 'linear'` is the silent-fallback
bug the widening exists to prevent). Then the known provider-keyed sites, catalogued during the
Dart addition — the `never` guard in `defaultAdapterFactory` only catches the factory; the
`Record<TrackerProvider,…>` sites are found by tsc fallout:

`shared/types/trackerSync.ts` (union) · `models.ts` (row unions) · `defaultAdapterFactory` switch ·
`providerCapabilities.ts` · `categoryMapping.ts` · `priorityMapping.ts` · `inboundSync.ts`
`PROVIDER_LABEL` · `store.ts` `PROVIDER_DEFAULT_BASE_URL` · `adapterCapabilities.test.ts` fixture ·
`reviewItemRouter.ts` `ReviewActor` · `tracker.ts` zod `providerSchema` · frontend
`TRACKER_PROVIDERS` entry (+ the new `needsApiKey` meta field and its wizard consumers).

## Phases

- **Phase 0 — live probes with negative controls** (the Dart lesson: probes that only assert the
  wanted row came back "confirm" filters that never ran). Install `bd`, init a scratch repo, and
  measure: `--updated-after` gt-vs-gte and timezone handling; whether reads hit the embedded lock
  (two concurrent `bd list`); `--metadata-field` filtering with a garbage-value control; create
  defaults (priority/status when omitted); `bd update --json` response shape (envelope on);
  `bd close` semantics for the archive fallback; behavior when the workspace is missing/renamed;
  concurrent write contention (two `bd update` racing) and the exact lock-error stderr text;
  `bd list` output cap (default limit 50 — pass `--limit 0` and verify it means unlimited);
  **negative controls for the list filters** (Codex round-1 finding): prove a closed issue stays
  present in both `bd list --all` incremental results and the id sweep, and audit which issue
  types/statuses the default AND `--all` listings exclude (gates, templates, wisps/ephemeral,
  `deferred`/`frozen`-category customs) — decide explicitly per excluded class whether the adapter
  needs additional include flags or documents the class as out of sync scope;
  **guarded-update semantics**: whether `bd update` can condition on `revision` (expected-revision
  arg? SQL fallback?) and what a mismatch returns — this gates the v1 lost-update design;
  **recovery-after-close control**: create with a metadata client key, close the issue, prove
  `--all --metadata-field` recovery still finds it;
  **workspace pinning**: `bd where` output shape; that an explicit `BEADS_DIR` wins over
  discovery and a deleted one falls back to walk-up; the failure shape when the pinned dir is
  gone;
  **scale**: `--format` go-template id-only projection works with `--all`; a listing whose JSON
  exceeds 10MB (synthetic bulk import) to pin the overflow failure shape.
- **Phase 1 — migration + type widenings** (compile-green with a stub adapter).
- **Phase 2 — `beadsAdapter.ts` + tests** (injected `execImpl`; fixture transcripts from Phase 0).
- **Phase 3 — keyless connect**: `needsApiKey` meta, wizard Detect step, the
  `providerNeedsSecret` predicate threaded through every NULL-secret consumer
  (`buildAdapter`/`credentialsForConnection`/`connect`/reconnect), re-detect reconnect surface,
  plus the five keyless lifecycle tests listed above.
- **Phase 4 — factory/service wiring** (project path into the factory, per-project spawn mutex,
  lock-error recognition).
- **Phase 5 — full gate + live smoke** against a real beads repo: connect wizard end-to-end,
  import, edit both directions, conflict, sweep (close + prune an issue remotely), field
  write-back, lock-contention behavior with a parallel `bd` writer.

Effort calibration: Dart was a 756-line adapter + ~8 mechanical widenings + migration; beads adds
the keyless-connect and CLI-transport work Dart never needed. Estimate Dart + 30–40%.

## Risks / open questions

- **Upstream velocity**: ~100 releases in ~10.5 months, two completed architecture rewrites
  (daemon removed; SQLite→Dolt). Pin a minimum supported `bd` version at detect time and probe
  `bd version` per pass start is overkill — per connect/reconnect is enough. `BD_JSON_ENVELOPE=1`
  hedges the announced v2.0 output-shape break.
- **Read-lock semantics UNSPECIFIED** (docs never distinguish read vs write contention) — Phase 0
  gate; worst case is more frequent transient retries, not corruption.
- **Live upstream footgun**: beads currently pins Dolt 2.2.0 because Dolt 2.3.x breaks
  `DOLT_RESET('--hard')` paths (`bd flatten`, `bd admin compact`, pull rollback). Embedded-mode
  users are unaffected by our integration; add a docs note for server-mode users.
- **`bd rename-prefix`** breaks connection identity (workspace_id) → reconnect required; sweep is
  guarded by detect-first (a missing workspace throws `TrackerAuthError` before `listIssueIds`
  could read as "everything was deleted" — the Dart `assertContainerExists` lesson, enforced in
  the adapter).
- **Dual writers on one issue** (session agent's `bd` + our write-back): the existing echo
  suppression + pre-send `contentDivergence` guard (Codex round-3 fix from the field-writeback
  work) is the baseline — but for beads the pre-send read is not atomic with the write, and
  unlike the HTTP providers, concurrent local writers are *expected* (sprint lanes), not rare.
  Beads ships a `revision` guarded-write optimistic-concurrency token ("always present"), so
  **revision-conditional writes are a HARD v1 requirement for every outbound mutation of an
  existing issue** — state and content alike (Codex round-2 finding 3, hardened by round-3
  finding 1: an unguarded fallback knowingly loses user data in a race the design itself calls
  expected). Carry `revision` from the pre-send read into every update; a revision mismatch
  settles the row unsent as a held conflict for the next inbound merge, exactly like the
  divergence guard. **If Phase 0 finds no guard mechanism** — probe both `bd update`'s flag
  surface and a conditional-`UPDATE … WHERE revision = N` via Dolt SQL as the escape hatch (the
  SQL path is only a valid guard if the probe ALSO proves it preserves beads' `revision`
  increment, `updated_at` stamping, validation, and event semantics — a raw write bypassing
  those is not an escape hatch, it is corruption) —
  **v1 ships import + create-push only**: `contentWrite` all-false and status write-back
  disabled for beads (creates race nothing — a fresh issue has no concurrent editor), with
  outbound edits deferred until a guarded transport exists (`bd serve`, SQL, or upstream flag).
  No unguarded fallback ships.

  **The guard is an adapter-contract change, not adapter-internal** (Codex round-9 finding 1:
  the current interface cannot express it — `TrackerIssue` exposes no revision and
  `updateIssueState`/`updateIssueContent` accept no expected-revision, so an implementer
  "following the plan" would either write unguarded or hide a second read inside the adapter,
  reopening the race). Contract changes, enumerated:
  - `TrackerIssue` gains an optional opaque `concurrencyToken?: string` — populated only by
    adapters that support guarded writes (beads: the `revision`); HTTP adapters leave it
    undefined.
  - `updateIssueState`/`updateIssueContent` gain an optional `expectedToken?: string` final
    parameter; existing adapters ignore it (unguarded, their status quo).
  - A distinct typed outcome, `TrackerRevisionMismatchError`, which the outbox drain consumes
    exactly like the `contentDivergence` hold: settle the row unsent, no baseline stamp, the
    inbound conflict machinery owns it.
  - Callers enumerated: `drainContentWrite` already does the pre-send `getIssue` — it forwards
    that read's token; the state-write drain path gains the same pre-send read + token when
    (and only when) the adapter populates `concurrencyToken`. No other mutation callers exist
    (creates and archive are not existing-issue updates).
- **Scale**: beads self-reports fast at thousands of issues; our full-fetch sweep every 12th pass
  is a `bd list` of ids — fine at that scale.

## Non-goals (v1)

`bd serve` transport · automating `bd dolt push/pull`/`bd sync` (the user's cron/manual job; at
most a docs pointer) · events-journal cursor (`bd events tail --since <seq>` — off by default;
a future upgrade over `--updated-after`) · routing/federation/multi-repo · wisps, molecules,
formulas, gates (exotic types just map through category) · bundling the `bd` binary · JSONL
anything.

## Review findings absorbed

Codex adversarial round 1 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED and absorbed:

1. [high] `bd list` without `--all` excludes closed issues → remote closures would never sync and
   the deletion sweep would misclassify every closed linked issue as deleted and orphan its link.
   Fix folded into the mapping table (`--all --limit 0` on both list paths) and Phase 0 (negative
   controls proving closed issues survive both listings; per-class audit of default-excluded
   types with an explicit include-or-out-of-scope ruling each).

Codex adversarial round 2 (2026-08-26), verdict needs-attention, 3 high — all CONFIRMED (finding
1 verified against `trackerSyncService.ts` guards) and absorbed:

1. [high] Keyless connections failed every operational path, not just connect: `buildAdapter()`
   and `credentialsForConnection()` both reject a NULL ciphertext before any provider code runs,
   so a detected beads connection would pause on first sync and mapping management would dead-end.
   Absorbed as the `providerNeedsSecret` predicate consulted at every guard + the five lifecycle
   tests (see "Keyless connect").
2. [high] Client-key recovery reused the default (closed-excluding) listing → a create whose
   response was lost and whose issue was closed before recovery would be retried as a duplicate.
   Absorbed: `--all --limit 0` on `findIssueByClientKey` + a recovery-after-close negative
   control in Phase 0.
3. [high] The pre-send divergence guard is not atomic with the write, and beads' expected
   concurrent local writers make the window real while a `revision` token sits unused. Absorbed:
   revision-conditional writes promoted to a v1 requirement contingent on the Phase 0
   guarded-update probe, with divergence-guard parity as the documented fallback.

Codex adversarial round 3 (2026-08-26), verdict needs-attention, 2 high + 1 medium — all
CONFIRMED (the 10MB `DEFAULT_MAX_BUFFER` verified at `runGit.ts:38`) and absorbed:

1. [high] Round 2's "documented fallback" still knowingly lost updates. Hardened: guarded writes
   are a hard gate for ALL outbound edits; no guard found ⇒ v1 ships import + create-push only,
   outbound edits disabled (see "Dual writers"). The Dolt-SQL conditional UPDATE added as a
   probe avenue.
2. [high] Inherited `BEADS_DIR` would silently redirect every project's sync to one override
   workspace. Absorbed as deterministic workspace pinning: detect with the var scrubbed, persist
   the resolved path, pass it back explicitly on every spawn; negative test required (see
   "CLI transport").
3. [medium] `bd list --limit 0` vs `runToolCapture`'s 10MB `maxBuffer` → overflow classified
   transient = infinite retry stall. Absorbed: id-only `--format` projection for the sweep,
   windowed backfill or explicit 64MB cap, overflow mapped to a terminal actionable pause (see
   "Bounded listings").

Codex adversarial round 4 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED and
absorbed:

1. [high] A `bd dolt pull` can merge in issues whose preserved `updated_at` predates the cursor
   minus the overlap window → never returned by `--updated-after`, unrecoverable by the
   linked-only sweep, permanently invisible with no error. Absorbed as the
   `requiresIdReconciliation` sweep extension (unseen-id import on the full-id-set pass) + the
   backdated-import negative control (see "Pull reconciliation").

Codex adversarial round 5 (2026-08-26), verdict needs-attention, 1 high + 1 medium — both
CONFIRMED and absorbed:

1. [high] A pinned path is a location, not an identity: same-path `.beads` reinit (prefix
   unchanged — it's committed config) would resolve cleanly and the sweep would archive every
   linked entity; the persisted-path storage was also unspecified. Absorbed: `workspace_id`
   becomes an immutable database instance id (prefix → `workspace_name`), path persisted in
   `source_json`, both validated at the top of every pass, mismatch = paused; reinit negative
   test (see "Workspace identity").
2. [medium] Every non-zero exit was classified retryable → deterministic failures (downgrade
   flags, schema mismatch, permissions, corrupt workspace) would churn forever. Absorbed:
   inverted taxonomy — recognized-transient retries only, deterministic failures pause via
   `TrackerAuthError`, unclassified failures get a consecutive-failure escalation threshold
   (see "Error taxonomy").

Codex adversarial round 6 (2026-08-26), verdict needs-attention, 2 high — both CONFIRMED and
absorbed:

1. [high] Top-of-pass identity validation left a TOCTOU window: `.beads` replaced mid-pass
   poisons the collected sweep id set and the apply step archives every link. Absorbed as
   sandwich validation — re-check the instance id after collection, before any local archival
   or outbound mutation; mismatch discards results and pauses. Mid-pass replacement negative
   test added.
2. [high] The round-3 retryable-by-default error mapping was left standing in contradiction to
   round-5's inverted taxonomy. Absorbed: stale block deleted; the inverted classification is
   the single authoritative table, with `bd`-missing/workspace-missing folded into the
   deterministic-pause row.

Codex adversarial round 7 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED (the
round-6 "harmless by construction" claim was wrong for outbound) and absorbed:

1. [high] The sandwich did not enclose all mutations: inbound applies + per-item cursor advance
   ran before the re-check, and an outbound replacement after the re-check redirects the next
   `bd` write — one replacement suffices, no restore needed. Absorbed: per-direction sandwich —
   inbound re-checks between every collected batch and the first local mutation (closing all
   destructive local cases); outbound re-checks per mutation inside the spawn's mutex window,
   with the sub-second preflight-to-spawn residual EXPLICITLY ACCEPTED as non-destructive
   (worst case: one stray issue in the user's own just-reinitialized empty workspace; recovery
   re-checks identity before settling). Four negative tests enumerated. This closes the
   workspace-replacement thread: the accepted residual is the floor reachable without an atomic
   identity-bound CLI transport, which does not exist.

Codex adversarial round 8 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED and
absorbed:

1. [high] The sweep's absent-id `getIssue` disambiguation lookups are adapter reads that
   influence archival but sat outside the round-7 sandwich — a replacement after the
   post-listing re-check would let a moved issue's null lookup archive its live twin. Absorbed:
   the inbound re-check moves after ALL of a phase's adapter reads (listing + point lookups),
   immediately before archival; negative test (d) added.

Codex adversarial round 9 (2026-08-26), verdict needs-attention, 1 high + 1 medium — both
CONFIRMED and absorbed:

1. [high] The revision guard was required but inexpressible: `TrackerIssue` has no revision
   field and the update methods take no expected-revision, so a compliant implementer would
   write unguarded or hide a second read in the adapter. Absorbed as an explicit contract
   change: optional `concurrencyToken` on `TrackerIssue`, optional `expectedToken` on both
   update methods, a typed `TrackerRevisionMismatchError` consumed as a held conflict, callers
   enumerated; the Dolt-SQL escape hatch now requires proving revision/timestamp/event
   preservation (see "Dual writers").
2. [medium] Reconciliation subtracted a permanent-skip set the engine never persists → every
   sweep would re-point-fetch all skipped ids indefinitely. Absorbed as the
   `tracker_reconciliation_ledger` table (same migration) with `config_generation`
   invalidation, opportunistic cleanup, zero-lookup repeat-sweep + mapping-change tests, and a
   sizing note for the one-time first reconciliation (see "Pull reconciliation").
