# Beads as the 4th tracker-sync provider

Status: PROPOSAL (investigation complete 2026-08-26; Codex adversarial round 1 finding absorbed —
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
response was lost = `bd list --metadata-field cyboflow_client_key=<uuid>` — cleaner than the
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

## The four genuinely new pieces

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
- `connect()` grows a keyless branch that skips encryption and stores `secret_ciphertext = NULL`.
  `updateCredentials`/reconnect surfaces render as re-detect for a keyless provider.
- **Identity**: `workspace_id = null` matches nothing in `connectionMatchesIdentity`/revival
  (store.ts: "an identity we never learned cannot be claimed BY identity"), so stamp
  `workspace_id` with the beads **`issue_prefix`** (committed in `.beads/config.yaml`, stable,
  per-repo; identity is already project-scoped so cross-project prefix collisions don't matter).
  `workspace_name` = prefix or repo dir name; `actor_label` = local git `user.name`. `base_url`
  stays `NULL` (`PROVIDER_DEFAULT_BASE_URL.beads = null` — the wizard's instance-URL field already
  hides itself). Risk: `bd rename-prefix` breaks identity → reconnect re-detects and revival
  misses; acceptable, document it.

### 2. CLI transport

First non-fetch adapter. Build on `runToolCapture` (`main/src/utils/runGit.ts` — argv-only
`execFile`, never a shell, login-shell PATH via `buildCommandEnv`), with a constructor-injected
`execImpl` mirroring the existing adapters' injected `fetchImpl` for tests. `cwd = project.path`
(stable; any worktree would resolve to the same workspace, but root doesn't disappear when a
session is dismissed). `defaultAdapterFactory` needs the project path — thread it through the
factory (it already receives the connection row, which carries `project_id`).

Error taxonomy mapping:

- non-zero exit / JSON parse failure / timeout → `TrackerApiError{status: null}` — the existing
  retryable path (backoff, never terminal).
- "bd not found on PATH" and "not a beads workspace" → `TrackerAuthError` — buys the
  pause-connection + reconnect-banner machinery for free; the paused copy reads "beads
  unavailable", and re-detect resumes.
- Embedded-lock contention ("database is locked" on stderr) → `TrackerApiError{status: null}`,
  explicitly recognized so the message can say "beads database busy — will retry".

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

### 4. Migration + mechanical widenings

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
  needs additional include flags or documents the class as out of sync scope.
- **Phase 1 — migration + type widenings** (compile-green with a stub adapter).
- **Phase 2 — `beadsAdapter.ts` + tests** (injected `execImpl`; fixture transcripts from Phase 0).
- **Phase 3 — keyless connect**: `needsApiKey` meta, wizard Detect step, `connect()` keyless
  branch, re-detect reconnect surface.
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
  work) is what keeps this convergent — same machinery, the "remote" is just very local. Beads'
  `revision` optimistic-concurrency token is available as a future strengthening (send-if-unchanged),
  not needed for v1.
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
