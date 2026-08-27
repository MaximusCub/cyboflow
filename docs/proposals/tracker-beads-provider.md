# Beads as the 4th tracker-sync provider

Status: PROPOSAL, Phase 0 EXECUTED (investigation complete 2026-08-26; Codex adversarial rounds
1-18 absorbed (25 high + 3 medium) — see "Review findings absorbed" at the end. Phase 0 live
probes ran 2026-08-26 against `bd 1.2.2`: 7 groups, ~59 probes, all with negative controls —
verdicts and evidence in `tracker-beads-phase0/findings.md`, raw transcripts alongside as Phase 2
fixtures. Probe-refuted sections below are revised in place and marked "[Phase 0]".
Implementation not started)

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
3. **Cross-machine sync is the user's job.** `bd dolt remote` + `bd dolt push/pull`, explicitly
   invoked or cron'd by the user. v1 does not touch it. [Phase 0: there is NO `bd sync` command —
   an earlier doc-derived reference here was wrong; the second, separate mechanism is
   `bd federation` (named peers, per-peer `ours|theirs` strategy), also untouched by v1.]
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
| `listIssues(sel, sinceIso)` | `bd list --all --json --limit 0 --updated-after <iso>` | `--all` is load-bearing: default `bd list` **excludes closed AND pinned issues** [Phase 0: the hidden set is exactly `{closed, pinned}`, hardcoded]. [Phase 0 resolved gt-vs-gte: the comparator is INCLUSIVE after FLOORING the stored value to whole seconds, while every read path ROUNDS `updated_at` to the NEAREST second for display — a displayed cursor can exceed the comparator's floor by 1s and silently skip rows. The engine's existing 10-minute overlap window swallows this; additionally never emit date-only cursors (LOCAL midnight) and always emit strict RFC3339 UTC: a date-shaped-but-invalid cursor (`2026-13-45`) silently DROPS the filter, exit 0, full unfiltered result] |
| `listIssueIds(sel)` | — (superseded for beads) | beads implements the OPTIONAL `listIssueRevisions(sel)` instead (see "Pull reconciliation"); the engine's sweep uses `listIssueRevisions` when the adapter provides it, else `listIssueIds` (HTTP providers unchanged). Ground-truth rules are identical: `--all --limit 0`, closed issues MUST be included; `bd delete` is a HARD delete [Phase 0] and `bd prune`/`bd gc`-decayed issues drop out — the sweep archiving the local twin is the correct reading of both |
| `listIssueRevisions(sel)` *(new, optional)* | `bd list --all --json --limit 0` + client-side fingerprint | `Promise<Array<{id: string; revision: string}>>`; declared alongside `capabilities.requiresIdReconciliation`. [Phase 0 REFUTED the cheap `--format` projection: the Go-template branch iterates dependency EDGES, not issues, and silently emits 0 bytes/exit 0 on a dependency-free workspace; no `revision` field exists in any CLI output. So the adapter takes the FULL `--json` listing (measured: 12.3MB/0.6s at 80 issues × 150KB descriptions; bounded-listing policy applies) and derives `revision` itself: a stable content fingerprint (sha256 over the sync-relevant fields of the listed row, sorted keys). This is STRONGER than a revision: it also catches label/comment-count/dependency changes, which — Phase 0 headline — do NOT bump `updated_at` and are invisible to the incremental cursor] |
| `getIssue(id)` | `bd show <id> --json` | local + fast; sweep's N point-lookups are fine |
| `createIssue` / `createSubIssue` | `bd create --json` (+ `--parent <id>`) | client key via `--metadata` (below) |
| `updateIssueState(id, stateId)` | `bd update <id> --status … --json` | |
| `updateIssueContent(id, patch)` | `bd update <id> … --json` | the returned post-write issue is the echo-suppression stamp source, same as HTTP providers |
| `archiveIssue(id)` | — | capability `archive: 'none'` (Plane precedent): engine falls back to the cancelled-state write (`bd close --reason`), and the removal dialog's `removalWriteBackAction` disclosure already handles the copy |

Spawn every command with `BD_JSON_ENVELOPE=1` (envelope `{"schema_version":1,"data":…}` becomes
the default in v2.0 — opting in now pins us to the stable shape across that break)
[`docs/reference/json-schema.md`]. [Phase 0 — the JSON contract has holes the parser must own:
the envelope shape differs by VERB (`create` → bare object; `update`/`close`/`show`/`list` →
array under `data`); errors are NEVER JSON-enveloped and `bd update <missing-id>` emits NOTHING
on stdout (plain text on stderr only) while `show`/`close` emit differently-worded JSON error
objects; no-op/preview paths (`close` on closed, `reopen` on open, `delete` sans `--force`)
print plain human text to stdout with exit 0 DESPITE `--json` — and double-close's success line
echoes the new reason while persisting nothing. Rules: classify from stderr on exit≠0; tolerate
non-JSON stdout on the known no-op paths; confirm state changes by re-fetch, never by success
text.]

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
the non-idempotent retry duplicates it). [Phase 0 VALIDATED this design wholesale: the
`--metadata-field` filter passed every negative control — wrong value → 0 rows, bogus key →
0 rows (not everything), uuid-prefix substring → 0 rows (exact match) — and the
recovery-after-close control passed: create with client key, close, `--all --metadata-field`
still finds it, correctly not without `--all`; 10KB metadata values round-trip byte-exact.]
Cleaner than the
Plane/Dart description-marker hack, and the marker never pollutes descriptions a user reads in
`bd show`. Caveat carried into implementation: the caller-side body-write marker re-append
(field-writeback invariant 4) exists *because* the key lives in the description for Plane/Dart;
with a metadata key, beads description writes need **no** marker composition at all. If the
caller-side marker plumbing turns out to be provider-keyed in a way that fights this, fall back to
Dart's markdown marker line verbatim — a cyboflow-code question, decided at Phase 2 by reading
the marker plumbing's provider-keying, not a bd probe.
Reserved-namespace note: beads reserves `bd:`/`_`-prefixed metadata keys; `cyboflow_client_key`
is safe.

### Data-model fit (unusually good)

- **Priority**: beads 0–4 (0 = highest) → `CANONICAL_TOKENS` seed P0→`0` … P4→`4`, P5/P6→`4`
  (lossy tail-compression like every provider; comparisons stay in provider space per invariant 2
  of the field-writeback plan). [Phase 0: create defaults are `priority: 2`, `status: open`,
  `issue_type: task`; unset fields are OMITTED from JSON, never null; there is no `assignee` key
  when unset, but an unrequested `owner` auto-populates from git identity.]
- **Category**: `CATEGORY_SYNC_SUPPORTED: true`. Seed `bug→bug`, `feature→feature`, `chore→chore`;
  `task` and the exotic types (`epic`, `decision`, `molecule`, `gate`, …) map inbound to `feature`
  by default, overridable by the existing category overlay.
- **Hierarchy**: parent-child (`--parent`, dotted hierarchical ids) covers sub-issue mirroring.
  `nativeParentAutoClose: false` → our shared close-parent-when-children-done write applies, as
  with Plane.
- **Statuses**: [Phase 0] SEVEN built-ins (`open, in_progress, blocked, deferred, closed,
  pinned, hooked`; categories active/wip/frozen/done) + customs feed the ordinary state-mapping
  wizard step; `deferred`/`blocked`/`pinned`/`hooked` land wherever the user maps them. Sync
  scope ruling from the excluded-class audit: gates (hidden even from `--all`; need
  `--include-gates`) and ephemeral/wisp beads incl. `--type message` (hidden even from `--all`;
  need `--include-infra`) are OUT of sync scope — the adapter passes neither include flag, on
  both `listIssues` and the sweep listing, so the two views stay consistent by construction.
  `molecule`-typed beads are visible by default and map through category like other exotics.
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
  "repo has no beads workspace" with the init hint. [Phase 0 — Detect must NEVER run `bd init`
  for the user, and the init hint's docs must disclose two probed behaviors: vanilla
  non-interactive `bd init` auto-COMMITS 18 files to the repo unprompted (including a
  `.claude/settings.json` registering a SessionStart hook, `bd prime --hook-json`, that fires
  for every collaborator; `--skip-agents --skip-hooks` still auto-commits; only `--stealth`
  avoids the commit), and beads telemetry is ON by default (external endpoint in the global
  `~/.config/bd/config.yaml`; a detached `bd send-metrics` process spawns) — the user may want
  `bd metrics off`.]
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
  itself). A reinit pauses the connection because the instance id changes. A `bd rename-prefix`
  does NOT change the instance id (same database), so the prefix must be **part of the per-pass
  identity invariant in its own right** (Codex round-15 finding 1: with the prefix persisted
  only as display metadata, the promised rename-pause was unreachable — and if a rename rewrites
  issue identifiers, the sweep would read every old id as deleted and archive its twin): the
  identity probe returns (instance id, prefix); both are compared at every sandwich checkpoint;
  either changing discards results and pauses for re-detect. [Phase 0 resolved the anchor: the
  instance id is `.beads/metadata.json` → `project_id` (UUID) — PROVEN to survive
  `bd rename-prefix` and to change on `rm -rf .beads && bd init`. It is exposed by NO bd command
  (`bd info`/`bd context`/`bd config list` all omit it; `bd info --json` ignores `--json`
  entirely) — the adapter reads the file directly. The init banner's "Repository ID"/"Clone ID"
  are unusable: deterministically derived (identical across a same-path reinit) and persisted
  nowhere.] **[Phase 2 check RESOLVED 2026-08-27: `bd rename-prefix` DOES rewrite existing issue
  ids** — probed on a populated workspace: `chk-2lz` → `newpfx-2lz`, suffix preserved verbatim,
  `project_id` unchanged, and the old id becomes unlookupable (`no issue found matching`). The
  suffix preservation makes link remapping DETERMINISTIC: on rename detection (same instance id,
  changed prefix — the sandwich pauses the pass), the re-detect recovery offers "prefix renamed —
  remap links", rewriting each link's `external_id`/`external_identifier` from
  `<old>-<suffix>` to `<new>-<suffix>` atomically; never a silent continue, and never the sweep
  (which would read every old id as deleted).] Negative test: rename the prefix mid-pass, prove
  zero local mutations; recovery test: remap rewrites every link and the next pass runs clean.

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
valid. [Phase 0 proved the full precedence with sentinel-exclusion controls:
**`--db` > `-C` > `BEADS_DIR` > cwd walk-up** — argv flags BEAT the env var. And walk-up is
silent: a wrong-cwd call operates on an ancestor's database with exit 0, no "not initialized
here" error exists.] So pinning is argv-first: every spawn passes `-C <project.path>` (immune to
inherited env by precedence), with `BEADS_DIR` additionally scrubbed from the child env as
defense-in-depth. The Detect step resolves the workspace (`bd where`, env scrubbed), persists
the resolved `.beads` path on the connection, and every pass re-verifies the `-C` resolution
still lands on that stored path + instance id; a stored path that stops resolving throws
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
instance id does not). [Phase 0 resolved the anchor: `metadata.json` → `project_id`, read from
disk — proven immutable across `rename-prefix`, fresh per reinit; see "Keyless connect". The
SQL fallback is moot (`bd sql` is refused in embedded mode).] **Validation is a sandwich, not a
preflight** (Codex rounds 6-7: a top-of-pass check
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
- **Outbound (creates, updates)**: sandwich each mutation — identity check before the spawn AND
  after the CLI exits, **before its response reaches any local bookkeeping** (Codex round-10:
  without the post-write check, a create that *succeeds* against a replacement database is
  adopted locally — link inserted, baseline stamped, outbox row settled — binding the local
  entity to the wrong workspace with recovery never entered, since no response was lost). On a
  post-write mismatch: discard the response, leave the outbox row unsettled/ambiguous, touch no
  link/baseline/entity/cursor, pause via `TrackerAuthError`. The residual — a replacement landing
  inside the spawn window — then costs at most one stray issue in the user's own just-reinited
  (empty) workspace plus an ambiguous row that recovery resolves after re-detect; recovery's own
  listing identity-checks first (wrong instance ⇒ stay ambiguous + paused, never a blind retry),
  so no duplicate and no local corruption. Atomically binding a CLI spawn to an instance id is
  not possible from outside the process; this residual is the floor, and it is non-corrupting on
  both sides of the link.

**Replacement recovery is an explicit state machine, not a resume** (Codex round-17: re-detect
on a replaced workspace necessarily returns a NEW instance id — resuming the old connection
against it would rebind every retained link to unrelated issues in the new database, while
refusing forever strands the paused connection and any ambiguous outbox row). A beads connection
paused on identity mismatch offers exactly one recovery, **"Adopt new workspace"**, which in
order: (1) retires the old connection and orphans its links (`orphaned_at`, entities never
archived — their remote halves are simply gone); (2) settles every pending outbox row for the
old identity as cancelled, each surfaced as a review finding ("write may exist in the replaced
workspace — verify manually"), so nothing ever replays against the new instance — the ambiguous
create included: it is surfaced for manual adoption, never auto-recovered across identities;
(3) mints a fresh connection scoped to the new instance id, whose first import is preceded by a
**pre-import reconciliation** (Codex round-18: the ordinary import path CANNOT re-link retained
entities — `findAdoptableIdea` rejects an idea that already has a provider link, and orphaned
links are not ignored, so a plain fresh import would mint duplicate locals while the originals
sit orphaned): match new-workspace issues to retained orphaned-link entities by provenance
marker / metadata client key, repoint those links atomically, queue ambiguous matches for user
confirmation, and only then import the remainder as new; outbound-origin entities without
import provenance stay orphaned unless the user confirms a match (no guessed re-links).
Declining leaves the pair paused indefinitely, which is safe. Negative tests: retained links
never resolve against the new instance; pending updates never replay; the ambiguous create
lands as a finding, not a duplicate; an adopted workspace containing a marker-matched issue
re-links it instead of duplicating, for both imported and pushed-origin entities.

**Same-instance mutations need a separate guard for archival** (Codex round-16: identity
catches replacement, not concurrency — a concurrent `bd dolt pull` can RESTORE an issue after
its absent-id lookup but before local archival, same instance id throughout, and Auto mode then
archives a live issue; this race exists for the HTTP providers too and is silently accepted
there, but beads' expected same-workspace concurrency makes it worth closing). The identity
probe additionally returns the workspace's **Dolt HEAD**; the sweep captures it at start and
re-probes before applying decisions. If HEAD moved, ONLY the destructive subset — archival
decisions — is discarded ("deferred — workspace changed mid-sweep"; deletion handling is not
urgent and a quiet window recurs), while imports and merges still apply (each is individually
safe under ordinary merge semantics). Scoping the guard to archival keeps busy workspaces from
starving the whole sweep. [Phase 0 demoted this guard to best-effort: no cheap HEAD anchor
exists — there is no `bd dolt log`, and `bd history <id> --json` (whose newest `CommitHash` IS
effectively the DB head, since history is unfiltered) returns a FULL issue snapshot per DB
commit, so an unbounded call is O(all commits). Implement the guard only if `bd history` proves
boundable (Phase 2 checks for a limit flag); otherwise drop it — the reversible-archival rule
below is the primary defense and was designed to suffice alone. **Phase 2 check RESOLVED
2026-08-27: `bd history <id> --limit int` EXISTS (0 = all) and works** — so the HEAD anchor is
cheap (`bd history <any-linked-id> --limit 1 --json` → newest `CommitHash`, which is the DB head
since history is unfiltered) and the guard is implementable as designed; it remains best-effort,
with reversible archival still the primary defense.] **The guard narrows the
window; resurrection closes the family**
(Codex round-18: a restore can still land between the final HEAD probe and the local archive —
no sequence of probes ends this, because probe and apply can never be atomic over a CLI). So
sweep-archival is defined as REVERSIBLE end-to-end: it is already a soft archive with an
orphaned link, and reconciliation gains the inverse rule — an orphaned-link id that REAPPEARS
in the full sweep under the same instance id un-archives the local twin and un-orphans its link
(a review finding notes the round trip). Every residual TOCTOU slice in this family thereby
degrades from "wrongly archived" to "archived for at most one sweep interval, then
self-healed." Negative tests: restore between lookup and archival AND restore immediately after
the final HEAD probe — both converge to un-archived within one reconciliation pass.

Negative tests: same-path reinit (a) before a pass, (b) between the initial check and
`listIssueIds`, (c) between `listIssues` and the apply loop, (d) between `listIssueIds` and an
absent-id `getIssue` lookup — zero local mutations in all four — (e) before an outbound drain,
proving the preflight pauses the row, and (f) between the outbound pre-check and the child
opening the database, with the create SUCCEEDING against the replacement — proving no local
adoption or settlement occurs and the row lands ambiguous + paused. Note: keyless identity
matching must skip `normalizeBaseUrl` URL parsing (`base_url` stays NULL for beads; the path is
not a URL).

**Error taxonomy: retry only the recognized-transient** (Codex round-5 finding 2). The
retryable-by-default mapping would let a deterministic failure — unknown flag after a `bd`
downgrade, incompatible output after an upgrade, permission failure, corrupt workspace — churn
forever at the release velocity this proposal itself documents. [Phase 0 pinned the shapes, and
two facts reshape the mechanism. (1) **bd NEVER reports contention on its own** — it blocks on
the flock indefinitely (proven to 200.9s, then success; no timeout knob exists anywhere in bd).
The lock-contention error is only produced when the CALLER cancels a blocked child: our own
`execFile` timeout's SIGTERM makes bd exit 1 (not 143 — it traps the signal) with the
classifiable string; SIGKILL escalation yields exit 137, empty stderr. The adapter timeout
CREATES the retry signal — without it the retry path is dead code and a wedged holder hangs
sync forever. (2) **Exit codes cannot classify** — every failure is exit 1, plain stderr, empty
stdout, and the retryable and corrupt-store strings share a byte-identical 68-char prefix.
Classify on stderr CONTENT:]
- recognized transient → `TrackerApiError{status: null}`, the retry path. Exactly two shapes:
  stderr containing `the database is locked by another dolt process` (our timeout fired), and
  exit 137 with empty stderr (our SIGKILL escalation);
- deterministic configuration/compat failures → `TrackerAuthError` — paused with the actionable
  stderr in the banner; re-detect resumes. Pinned strings: `no beads database found` (workspace
  unresolved — identical text whether `.beads` is missing, renamed, or `BEADS_DIR` dangles),
  suffix `open db: EOF` or a leaked `strconv.ParseUint` Go error (corrupt store — `bd doctor`
  is a no-op in embedded mode), `Error 1049: database not found` (store gutted),
  `is not allowed in read-only mode`, plus `bd` missing from PATH, unrecognized-flag usage
  errors, envelope/schema parse mismatch, `schema_version` ≠ 1, version-below-minimum.
  `no issue found matching` is terminal per-item, not per-connection;
- unclassified non-zero exits → retryable, but with a consecutive-failure threshold per
  connection (N failed passes → escalate to the paused state with the last stderr) so unknown
  deterministic failures cannot loop silently.

**Bounded listings — overflow is terminal, not transient** (Codex round-3 finding 3).
`runToolCapture`'s default `maxBuffer` is 10MB (`runGit.ts:38`); a large workspace's
`bd list --all --json --limit 0` can exceed it, and a buffer overflow classified as retryable
would stall initial import or every sweep in an infinite retry loop. [Phase 0 measured the
shape: 80 issues × 150KB descriptions = 12.3MB of listing JSON in 0.6s; against a 10MiB
maxBuffer, Node `execFile` fails with `err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`, the
child is NOT killed, and stdout arrives truncated at exactly 10,485,760 bytes mid-string —
unparseable. Output is fully buffered server-side (TTFB = 91.5% of wall time), so streaming
consumption is not an option. And the cheap projection escape hatch is GONE: `--format`
go-templates iterate dependency edges, not issues (silent 0-byte no-op), and there is no
embedded pagination (`--offset` requires `--proxied-server`; `--limit N` has no offset
companion).] Design, revised: (a) both the sweep listing and the backfill run single-shot under
an explicit raised cap (64MB — beads' own 100k-issue guidance at observed ~1.5KB/issue for
normal descriptions sits far below it; the 12.3MB probe workspace was deliberately pathological);
(b) incremental `listIssues` windows are naturally small; if the backfill overflows even 64MB it
pages by `--created-after`/`--created-before` time windows; (c) a `maxBuffer` overflow
(`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, with the orphaned child reaped explicitly since Node does
not kill it) maps to a TERMINAL, actionable failure (pause + "workspace too large — see docs"),
never the transient-retry path.

Error taxonomy: ONE authoritative classification — see "Error taxonomy: retry only the
recognized-transient" below (Codex round-6 finding 2 caught an earlier retryable-by-default
mapping left standing here in contradiction; it is deleted, the inverted table below governs).

Timeout: per-adapter constant, not the HTTP 30s verbatim. [Phase 0 measurements: ~0.4s fixed
cost per invocation (fresh process boots the embedded Dolt engine); reads under write load
spread 0.35–5.4s; a single contended write waited 9.8s and succeeded; 12.3MB listing 0.6s.
30s via `execFile`'s `timeout` (SIGTERM, then SIGKILL escalation) is comfortably above p99 while
still bounding the no-timeout-in-bd hang — and per the taxonomy above, the timeout is also what
manufactures the retryable contention signal. One more Phase 0 hazard for lifecycle code: the
spawned process image is named `beads`, not `bd` — match reapers/health checks accordingly.]

### 3. Concurrency and the single-writer lock

Three writer populations contend for the embedded lock: our tick/outbox, session agents running
`bd` in worktrees, and the human's own `bd`. Mitigations, in order:

- Serialize **our own** spawns per project with the existing in-process `withLock` mutex — never
  let the inbound pass and the outbox drain race each other into the lock. [Phase 0 upgraded
  this from prudent to mandatory: **reads take the same whole-database exclusive flock as
  writes** — 8 concurrent `bd list` fully serialize, `--readonly` doesn't help (it's only an
  app-level write guard), and one workspace hard-caps at ~2.7 ops/sec regardless of fan-out
  (negative control: 4 separate workspaces scale linearly).]
- Treat external contention as transient retryable (above — noting the taxonomy's Phase 0
  finding that the retry signal only exists because our own timeout fires; bd itself blocks
  forever, fairly, without starvation: 16 waiters behind a 200s hold all succeeded). The outbox
  already retries with backoff; a failed inbound pass retries on the next 5-minute tick. This
  matches beads' own multi-agent guidance.
- Keep passes short (they already are: one `bd list` + point lookups) and document
  `bd init --server` (dolt sql-server, concurrent writers) as the recommended setup for heavy
  multi-agent use. Do not auto-migrate the user's storage mode — respect their init choice.
- The detached visual-verify snapshot worktree is read-only territory: a `bd` write there mutates
  the *shared* database from a throwaway checkout — worth one sentence in the verify agent docs,
  not machinery.
- [Phase 0] **The flock is inode-bound and silently defeatable**: `rm -f` of
  `.beads/embeddeddolt/<db>/.dolt/noms/LOCK` while held lets a second writer proceed
  immediately, no error on either side — so a `git clean -xfd` or `rm -rf` racing an in-flight
  `bd` yields two concurrent writers. Cyboflow's own cleanup paths must never touch `.beads`;
  worth a docs warning for users' cleanup scripts. (SIGKILL mid-write, by contrast, is safe:
  kernel releases the flock, recovery is automatic, data stayed intact across 10 kills — the
  only residue is leaked `nbs_manifest_*` temp files.)

### 4. Pull reconciliation — timestamp-independent discovery

Codex round-4 finding: `bd dolt pull` merges Dolt history while **preserving each issue's
original `updated_at`**. An issue authored on another machine and pulled in later can therefore
carry a timestamp older than our persisted cursor minus the overlap window — `--updated-after`
will never return it, and the deletion sweep can't recover it because it only compares the
remote id set against *already-linked* entities. Permanently invisible, with no error.
[Phase 0 CONFIRMED this end-to-end with two real clones over a `file://` Dolt remote: pulled
issues keep their origin stamps, and an issue created before a cursor snapshot but pushed after
is invisible to `bd list --updated-after <cursor>`, with positive and negative filter controls.
A second proven vector: `bd import --allow-stale` applies content changes while preserving a
fabricated old `updated_at` verbatim. And a third gap the proposal had not predicted:
`bd label add`, `bd comment`, and `bd dep add` do not bump `updated_at` AT ALL — real content
changes structurally invisible to any cursor. Reconciliation is therefore not just a pull
backstop; it is the only detection path for three ordinary local mutation types.]

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
`(connection_id, external_id, reason, last_seen_revision, config_generation, seen_at)`,
`UNIQUE(connection_id, external_id)` — written whenever reconciliation resolves an unseen id
WITHOUT minting a link (imported ids need no row; their link is the record).
`last_seen_revision` closes Codex round-12 finding 2: a ledgered issue can become eligible
through a remote property change (e.g. an excluded type edited into an included one) arriving
backdated — without a stored revision the ledger would suppress it forever. Since the sweep
projection already carries (id, revision), the comparison is free: a ledgered id whose swept
revision differs point-fetches and re-evaluates (import, or re-ledger at the new revision).
[Phase 0: `revision` here is the adapter-derived content fingerprint — see "Linked issues need
the same backstop" below; the ledger column stores it as the same opaque string.]
The zero-lookup guarantee below holds for UNCHANGED ledgered ids. `config_generation` is a
counter stamped
on the connection and bumped by any mapping/state-mapping/selection change; ledger rows from an
older generation are treated as absent, so a config change re-evaluates previously skipped ids
exactly once. Rows for ids that vanish from the remote set are deleted opportunistically during
the same sweep. Tests: a repeat sweep over unchanged skips performs ZERO point lookups; a
mapping change re-considers exactly the eligible skipped ids. Sizing note: the first
reconciliation over a legacy workspace point-fetches every unlinked id once (closed issues
included) — a bounded one-time cost, after which each id is linked or ledgered.

**Linked issues need the same backstop** (Codex round-11: a backdated edit to an
already-linked issue — edited offline before the cursor position, pushed after — evades the
incremental listing, and an unseen-id diff sees the id as known; the change stays invisible and
outbound sync may later overwrite it). So the sweep projection is **(id, revision) pairs**, not
bare ids. [Phase 0 REFUTED the cheap source: no `revision` field exists in any CLI output, and
`--format` go-templates iterate dependency edges (silent 0-byte no-op on a dependency-free
workspace). The revised source: the sweep takes the FULL
`bd list --all --json --limit 0` listing (bounded-listing policy above) and the adapter derives
`revision` as a **content fingerprint** — sha256 over the sync-relevant fields of the listed
row, sorted keys, volatile fields excluded. Strictly stronger than a server revision: it also
catches the label/comment-count/dependency changes that never bump `updated_at`.]
**This is an adapter-contract addition** (Codex round-14:
`listIssueIds(): Promise<string[]>` cannot carry it): a new OPTIONAL method
`listIssueRevisions(selection): Promise<Array<{id: string; revision: string}>>`, implemented
only by adapters declaring `capabilities.requiresIdReconciliation`; the deletion-sweep consumer
calls it when present and falls back to `listIssueIds` otherwise, so the three HTTP providers
change nothing — `revision` is contractually OPAQUE (compare-for-equality only), so a derived
fingerprint satisfies the same contract a server token would. Contract tests: changed linked
and ledgered fingerprints trigger point fetches; unchanged entries trigger none. Each link
persists its last-seen fingerprint inside `baseline_json` (no new column; our own outbound
writes recompute it from the write's response echo, so echoes never false-positive — the
fingerprint function is the adapter's own, applied identically both places). A linked id whose
swept fingerprint differs from the stored one gets a `getIssue` point fetch and runs through
the ordinary inbound merge/conflict path. One derived-token caveat: `getIssue` (`bd show`)
returns fields the listing may lack; the fingerprint is defined over the LISTING field set
only, so both sources compute it identically. This completes the partition: every id in the
full sweep is unseen (point-fetch → import or ledger), ledgered (fingerprint compare → zero
cost when unchanged, re-evaluate on change), or linked (fingerprint compare → merge on change)
— no remote change class is outside a detection path.

Phase 0 negative controls — ALL EXECUTED 2026-08-26 (see `tracker-beads-phase0/findings.md`):
(a) cursor evasion proven live via two-clone `file://` push/pull AND via
`bd import --allow-stale`; (b) covered by the fingerprint design (the mechanism the backdated
edit must defeat is now content-derived, not timestamp-derived); (c) pull-preserves-`updated_at`
CONFIRMED (a no-op pull changes nothing); (d) REFUTED — template cannot render issues at all,
which is why the fingerprint design above replaced it.

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

- **Phase 0 — live probes with negative controls: ✅ EXECUTED 2026-08-26** against `bd 1.2.2`
  (7 groups, ~59 probes, all negative-controlled). Full verdicts + evidence:
  `tracker-beads-phase0/findings.md`; raw transcripts alongside. Every probe listed in the
  original matrix ran; the design-changing verdicts are folded into the sections above (marked
  "[Phase 0]"): no revision field + dead `--format` templates → fingerprint sweep;
  detect-after-write via Dolt CommitHash replaces conditional writes; reads take the write lock
  (~2.7 ops/s per workspace); bd blocks on the lock FOREVER (our timeout manufactures the retry
  signal); cursor evasion via pull confirmed end-to-end; label/comment/dep changes never bump
  `updated_at`; identity anchor = `metadata.json` `project_id`; pinning precedence
  `--db` > `-C` > `BEADS_DIR` > walk-up; `--metadata-field` recovery validated wholesale;
  maxBuffer overflow shape pinned.
- **Phase 1 — migration + type widenings** (compile-green with a stub adapter).
- **Phase 2 — `beadsAdapter.ts` + tests** (injected `execImpl`; fixture transcripts from
  Phase 0 at `tracker-beads-phase0/transcripts/`). The three checks Phase 0 left open were ALL
  RESOLVED by live probes 2026-08-27, each in the design's favor: (1) effective
  `--dolt-auto-commit` default is `on` (help text stale) AND it is a global argv flag, so the
  adapter pins `--dolt-auto-commit on` per spawn — the detect-after-write gate holds by
  construction; (2) `bd history --limit int` exists (0 = all), bounding post-write verification
  and making the best-effort sweep HEAD guard cheap; (3) `bd rename-prefix` DOES rewrite
  existing issue ids, suffix-preserved (`chk-2lz` → `newpfx-2lz`, `project_id` stable, old id
  unlookupable) — so rename recovery is a deterministic link remap. Details at the marked
  sections above.
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
  (daemon removed; SQLite→Dolt). Pin the minimum supported `bd` version at 1.2.2 — the version
  every Phase 0 verdict certifies (several findings are version-specific bugs: the dead
  go-template branch, the dead default `--limit 50`, the display-round vs comparator-floor
  mismatch — an upstream fix to any of them changes behavior under us). Probe `bd version` per
  connect/reconnect; per pass start is overkill. `BD_JSON_ENVELOPE=1` hedges the announced v2.0
  output-shape break.
- ~~Read-lock semantics UNSPECIFIED~~ **[Phase 0 RESOLVED: reads take the same whole-database
  exclusive flock as writes]** — one workspace serializes at ~2.7 ops/s; worst case remains
  latency, not corruption, and the per-project spawn mutex + own-timeout design absorbs it.
- **[Phase 0] Telemetry + init side effects**: bd phones home by default and vanilla `bd init`
  auto-commits agent hooks into the user's repo (see "Keyless connect") — pure docs/UX
  disclosure for us, but reputationally load-bearing for a privacy-conscious user base.
- **[Phase 0] `.beads` deletion races**: the flock is inode-bound; `rm -rf .beads`/
  `git clean -xfd` racing an in-flight `bd` silently yields two concurrent writers (see
  "Concurrency"). Not our machinery's job to fix — docs warning only.
- **Live upstream footgun**: beads currently pins Dolt 2.2.0 because Dolt 2.3.x breaks
  `DOLT_RESET('--hard')` paths (`bd flatten`, `bd admin compact`, pull rollback). Embedded-mode
  users are unaffected by our integration; add a docs note for server-mode users.
- **`bd rename-prefix`** breaks the per-pass identity invariant's PREFIX half (the instance id —
  `workspace_id` — survives; the prefix lives in `workspace_name`) → the sandwich pauses the
  pass, and [Phase 2 check 2026-08-27] because a rename REWRITES existing issue ids
  suffix-preserved, recovery is the deterministic "prefix renamed — remap links" flow (see
  "Keyless connect"), never a silent continue; sweep is guarded by detect-first (a missing
  workspace throws `TrackerAuthError` before `listIssueIds` could read as "everything was
  deleted" — the Dart `assertContainerExists` lesson, enforced in the adapter).
- **Dual writers on one issue** (session agent's `bd` + our write-back): the existing echo
  suppression + pre-send `contentDivergence` guard (Codex round-3 fix from the field-writeback
  work) is the baseline — but for beads the pre-send read is not atomic with the write, and
  unlike the HTTP providers, concurrent local writers are *expected* (sprint lanes), not rare.

  **[Phase 0 executed the guard-mechanism hunt (probe group D, opus). Verdict:
  DETECT-AFTER-WRITE — every prevention-shaped mechanism is refuted live.]** The docs'
  "revision" token does not exist in the 1.2.2 CLI (no revision/version/etag field in any
  `list`/`show` output at any verbosity); zero CAS/if-match flags across all 109 subcommands
  (`--claim` is a genuine CAS but only on (assignee, status), protects no other field —
  advisory lock at best); `bd sql` is refused in embedded mode; the direct-`dolt` SQL guard
  works mechanically but is disqualified exactly as this document predicted — it stamps
  `updated_at` in LOCAL time which bd then serializes with a lying `Z` suffix (the row reads
  ~7h old and breaks every newer-than comparison), makes no Dolt commit (the edit is later
  absorbed into an unrelated issue's auto-commit), and STILL silently loses updates guarding on
  a 1-second-resolution `updated_at` (lost update reproduced live in 3 attempts; the trap
  `content_hash` column is frozen at creation and never recomputed). What DOES hold: **every
  `bd` write is a Dolt commit**, `bd history <id> --json` returns
  `{CommitHash, CommitDate, Issue: <full snapshot>}` per commit, and
  `bd show <id> --as-of <CommitHash>` resolves a stored token to its exact historical snapshot.

  So v1's guarantee is **detect-and-recover, not prevent** — and because `bd update` patches
  only the flags it is given (per-field, unlike an HTTP PUT), the ONLY hazard is a concurrent
  write to the SAME field landing inside the pre-send window; unrelated-field churn is never
  clobbered by our write at all. Per outbound mutation of an existing issue (state and content
  alike): (1) pre-send, alongside the existing `contentDivergence` read, capture
  `concurrencyToken` = the newest `CommitHash` from `bd history`; (2) write via `bd update`
  (never SQL); (3) post-write, re-read history and diff adjacent snapshots from our own write's
  commit back to the token, attributing exactly which fields changed in between. Outcomes,
  preserving the round-12 field-scoped state machine's arms:
  - no interleaved commit touched a patched field (incl. unrelated churn) → settle done;
  - an interleaved commit wrote a patched field a DIFFERENT value → we clobbered it: hold as
    conflict (existing behavior) **with the overwritten value recovered from its snapshot** —
    strictly better than the HTTP providers, where the raced value is unrecoverable;
  - an interleaved commit wrote the same value we sent → settle done (converged).
  Nothing is ever silently lost: the race outcome is always visible in history and the loser's
  value is always recoverable (`--as-of` gives a true 3-way base). Costs/caveats, all probed:
  `bd history` is UNFILTERED (entries ≈ all DB commits since the issue's creation — 33 entries
  for 1 real change), so walk back to the token only — and the bound flag EXISTS
  [Phase 2 check resolved 2026-08-27: `--limit int`, 0 = all, verified live], so post-write
  verification fetches a bounded window (`--limit` a small N, escalating only if the token is
  not inside it; a token absent from full history means squashed → re-baseline);
  `Committer` is always literal `root` (attribution is what-changed, never who);
  `bd compact`/`bd flatten`/`bd gc` squash history and invalidate stored tokens → re-baseline
  on unresolvable-token, which surfaces as bd's ONLY exit-0 error (empty stdout, error on
  stderr only — parse for it explicitly); `--claim` may optionally be taken as an advisory
  lock to shrink the window. Tests: interleaved same-field write → held conflict carrying the
  recovered value; interleaved unrelated-field write → settle done, zero data movement;
  unresolvable token → re-baseline, not error-loop.

  **The remaining hard gate — RESOLVED [Phase 2 check, 2026-08-27]**: this design requires that
  bd writes reliably produce per-write Dolt commits, and they do — the EFFECTIVE default policy
  is `on` (`bd config get dolt.auto-commit` → `on` in a fresh workspace with no config file
  setting it; the flag help's "Default: off" is stale text in 1.2.2; verified live: two writes →
  two `CommitHash` entries). Better still, `--dolt-auto-commit on` is a GLOBAL argv flag on
  every command, so the adapter pins it per spawn exactly as it pins `-C` — the per-write-commit
  invariant then holds by construction regardless of the user's config (a user-set `off`/`batch`
  cannot silently disable detection). **If history proves unusable,
  v1 ships import + create-push only** (creates race nothing — a fresh issue has no concurrent
  editor), with outbound edits deferred until a guarded transport exists (`bd serve`, upstream
  CAS flag, or server-mode SQL). No unguarded-undetected fallback ships. **The disable must be
  expressible** (Codex round-15 finding 2: `contentWrite: false` gates content writes, but
  `updateIssueState` has no capability gate — the state outbox path would either send the
  forbidden unguarded write or strand rows that block the issue's inbound processing). New
  capability `guardedUpdates: boolean`, paired with a provider-level `requiresGuardedUpdates`
  (true only for beads): when a provider requires guards but the adapter cannot provide them,
  **every existing-issue mutation — state, content, and archive-fallback alike — is gated at
  the ENQUEUE chokepoint** (the same gate-at-enqueue pattern the `'off'` content/archive modes
  already use, precisely so no undrainable row ever strands inbound). Test: fallback mode
  enqueues zero update_state/update_content/archive rows while creates still flow.

  **The guard is an adapter-contract change, not adapter-internal** (Codex round-9 finding 1:
  the current interface cannot express it — `TrackerIssue` exposes no revision and
  `updateIssueState`/`updateIssueContent` accept no expected-revision, so an implementer
  "following the plan" would either write unguarded or hide a second read inside the adapter,
  reopening the race). Contract changes, enumerated [Phase 0 re-semantics in brackets — the
  contract SHAPE survives the detect-after-write pivot; only what the token IS and when the
  check runs changed]:
  - `TrackerIssue` gains an optional opaque `concurrencyToken?: string` — populated only by
    adapters that support guarded writes [beads: the newest Dolt `CommitHash` from
    `bd history`, captured with the pre-send read]; HTTP adapters leave it undefined.
  - `updateIssueState`/`updateIssueContent` gain an optional `expectedToken?: string` final
    parameter; existing adapters ignore it (unguarded, their status quo). [beads: the write
    always lands; the adapter then verifies AFTER the write by diffing history snapshots back
    to `expectedToken`, and reports an interleaved same-field write as the mismatch error —
    carrying the clobbered remote value recovered from its snapshot.]
  - A distinct typed outcome, `TrackerRevisionMismatchError`, which the outbox drain consumes
    via the mismatch state machine above — patched-field attribution, then hold-as-conflict
    (with the recovered value) / settle-done (unrelated churn or converged) — NEVER an
    unconditional settle-unsent (Codex round-13 caught this bullet contradicting the round-12
    state machine; the state machine is authoritative for both content AND state writes).
    [The retry-with-fresh-token arm and its exhaustion bound are RETIRED: they were artifacts
    of conditional-write refusal, and detect-after-write has no refusal — the write lands and
    the verdict is final per attempt.] Tests cover content and state writes across the
    outcomes: unrelated churn, already-landed/converged, genuine same-field divergence.
  - Callers enumerated: `drainContentWrite` already does the pre-send `getIssue` — it forwards
    that read's token; the state-write drain path gains the same pre-send read + token when
    (and only when) the adapter populates `concurrencyToken`. No other mutation callers exist
    (creates and archive are not existing-issue updates).
- **Scale**: beads self-reports fast at thousands of issues. [Phase 0: the sweep is now a full
  `--json` listing (no cheap projection exists) — measured 0.6s for a deliberately pathological
  12.3MB workspace, fully buffered; the every-12th-pass cadence and the 64MB terminal cap in
  "Bounded listings" govern it. Also measured: ~18KB on-disk Dolt-journal growth per `bd update`
  with compaction disabled by default — a busy synced workspace grows fast, the user's
  `bd compact` is the remedy, and our stored CommitHash tokens re-baseline after it.]

## Non-goals (v1)

`bd serve` transport · automating `bd dolt push/pull` or `bd federation sync` (the user's
cron/manual job; at most a docs pointer — [Phase 0: these are two distinct mechanisms; there is
no `bd sync`]) · events-journal cursor (`bd events tail --since <seq>` — off by default;
a future upgrade over `--updated-after`) · routing/federation/multi-repo · wisps, gates
(hidden even from `--all` without include flags — out of sync scope per the Phase 0 audit;
molecules are visible and map through category) · bundling the `bd` binary · JSONL anything.

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

Codex adversarial round 10 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED (the
round-7 "no local data touched" claim was false for a SUCCESSFUL write) and absorbed:

1. [high] A create succeeding against a replacement workspace was adopted locally (link,
   baseline stamp, settled outbox row) with recovery never entered — local bookkeeping bound to
   the wrong workspace. Absorbed: the outbound sandwich gains its post-write half — identity
   re-checked after the CLI exits, before the response reaches any local bookkeeping; mismatch
   discards the response, leaves the row ambiguous, pauses. Negative test (f) added. The
   residual is now non-corrupting on both sides of the link.

Codex adversarial round 11 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED and
absorbed:

1. [high] Reconciliation covered only unseen ids: a backdated pull-merged edit to an
   already-LINKED issue evaded both the cursor and the id diff, staying invisible until
   outbound sync overwrote it. Absorbed: sweep projection widened to (id, revision) pairs,
   last-seen revision persisted in `baseline_json`, changed-revision linked ids point-fetch
   into the ordinary merge; full-`listIssues` fallback if the template can't render revision;
   backdated-linked-edit negative test added. The id-space partition (unseen / ledgered /
   linked) now has a detection path for every class (see "Pull reconciliation").

Codex adversarial round 12 (2026-08-26), verdict needs-attention, 2 high — both CONFIRMED and
absorbed:

1. [high] Settle-unsent on ANY revision mismatch permanently dropped non-conflicting writes —
   revision is issue-wide, so unrelated-field churn (assignee, labels) would kill a title write
   inbound then finds no conflict for. Absorbed: mismatch state machine — re-fetch, compare
   PATCHED fields against the pre-send baseline (`contentDivergence` semantics); unrelated
   churn refreshes the token and retries bounded; genuine target-field divergence holds;
   already-landed settles done. Non-overlapping-churn test added (see "Dual writers").
2. [high] Ledgered ids sat outside the revision comparison — a skipped issue turned eligible by
   a backdated remote change would be suppressed forever. Absorbed: `last_seen_revision` column
   on the ledger (the sweep projection already carries it — comparison is free); changed
   revision re-evaluates; zero-lookup guarantee narrowed to UNCHANGED ledgered ids (see "Pull
   reconciliation").

Codex adversarial round 13 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED (stale
text) and absorbed:

1. [high] The round-9 contract bullet still said mismatch is consumed "like `contentDivergence`:
   settle unsent," contradicting round-12's state machine and re-opening the dropped-write path.
   Absorbed: bullet rewritten to defer to the state machine (authoritative for content AND
   state writes); bounded-retry exhaustion specified as degrading to hold-as-conflict; the
   four-outcome test matrix named for both write kinds.

Codex adversarial round 14 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED and
absorbed:

1. [high] The (id, revision) sweep projection had no adapter seam — `listIssueIds()` returns
   `Promise<string[]>` and the contract-change list never widened it, so the engine could not
   receive revisions. Absorbed: new optional `listIssueRevisions(selection)` adapter method,
   paired with `requiresIdReconciliation`; sweep consumer prefers it, falls back to
   `listIssueIds` (HTTP providers untouched); contract tests named (see "Pull reconciliation"
   and the method-mapping table).

Codex adversarial round 15 (2026-08-26), verdict needs-attention, 2 high — both CONFIRMED and
absorbed:

1. [high] The promised `bd rename-prefix` pause was unreachable — validation compared only the
   instance id, which a rename preserves; if a rename rewrites issue ids, the sweep would
   archive every twin. Absorbed: the prefix joins the instance id in the per-pass identity
   invariant at every sandwich checkpoint; mid-pass rename negative test; Phase 0 probes
   whether rename rewrites ids (migration flow if so) (see "Identity").
2. [high] The no-guard fallback promised disabled state writes but no capability could express
   it — `updateIssueState` is unconditionally required and the state outbox path has no gate.
   Absorbed: `guardedUpdates` capability + `requiresGuardedUpdates` provider flag; all
   existing-issue mutations gated at the ENQUEUE chokepoint in fallback mode (the proven
   'off'-mode pattern, no stranded rows); creates-still-flow test (see "Dual writers").

Codex adversarial round 16 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED and
absorbed:

1. [high] Same-INSTANCE concurrency evaded the identity sandwich: a concurrent `bd dolt pull`
   restoring an issue between its absent-id lookup and archival archives a live issue (identity
   unchanged throughout). Absorbed: Dolt HEAD added to the identity probe; HEAD moved across
   the sweep ⇒ discard the archival decisions only (imports/merges still apply — each is
   individually safe), defer to a quiet window; restoration-race negative test. Noted: the same
   race exists and is accepted for HTTP providers; beads gets the stronger guard because
   same-workspace concurrency is its expected mode (see "Same-instance mutations").

Codex adversarial round 17 (2026-08-26), verdict needs-attention, 1 high — CONFIRMED and
absorbed:

1. [high] Replacement had no executable recovery: re-detect returns a new instance id, resuming
   rebinds old links to unrelated issues, refusing strands the connection and the ambiguous
   row. Absorbed: the "Adopt new workspace" state machine — retire old connection + orphan
   links (never archive), settle all pending old-identity outbox rows as cancelled with
   per-row review findings (nothing replays cross-identity, ambiguous create surfaced for
   manual adoption), mint a fresh connection for the new instance; declining stays safely
   paused; three negative tests (see "Replacement recovery").

Codex adversarial round 18 (2026-08-26), verdict needs-attention, 2 high — both CONFIRMED and
absorbed; this round closes the TOCTOU family terminally:

1. [high] A restore landing after the final HEAD probe still archived a live issue — no probe
   sequence can be atomic with apply over a CLI. Absorbed by inversion: sweep-archival is
   defined REVERSIBLE — reconciliation un-archives and un-orphans when an orphaned-link id
   reappears under the same instance, so every residual window in the family degrades to
   "archived for at most one sweep interval, then self-healed" (see "Same-instance
   mutations"). Prevention-only was unreachable; correction-by-design is the closure.
2. [high] Adopt-new-workspace's fresh import would duplicate retained entities —
   `findAdoptableIdea` rejects already-linked ideas and orphaned links are not ignored.
   Absorbed: pre-import reconciliation matches by marker/client key, repoints links atomically,
   user-confirms ambiguity, suppresses fresh import until done; imported and pushed-origin
   entities both tested (see "Replacement recovery").

## Phase 0 execution record (2026-08-26)

Executed against `bd 1.2.2 (Homebrew)` — 7 probe groups (list semantics, cursor/timestamps,
CRUD+metadata+recovery, revision-guard, concurrency/locks, workspace identity+scale,
cross-machine pull), ~59 probes, every filter probe with a negative control, two-clone `file://`
Dolt-remote experiment included. Full verdicts, evidence, and the error-classification table:
`tracker-beads-phase0/findings.md`; raw transcripts (Phase 2 fixtures):
`tracker-beads-phase0/transcripts/`.

Score against the proposal as reviewed through Codex round 18: the sync-engine architecture
(keyless connect, identity sandwich, reconciliation ledger, reversible archival, adopt-new-
workspace, enqueue gating) survived intact; **four load-bearing mechanisms were refuted live
and are redesigned in place** (marked "[Phase 0]" above):

1. The per-issue `revision` token does not exist in the CLI, and `--format` go-templates
   iterate dependency edges (silent 0-byte no-op) → the (id, revision) sweep became a full-
   listing sweep with an adapter-derived content fingerprint — which also covers the newly
   discovered `updated_at` blind spots (label/comment/dependency changes never bump it).
2. Conditional writes are impossible in embedded mode (no CAS flags; `bd sql` refused; direct
   `dolt sql` corrupts timestamps/history and still races within `updated_at`'s 1-second
   resolution) → guarded updates became detect-and-recover via Dolt `CommitHash` history
   diffing, with the clobbered value always recoverable (`--as-of`) — strictly better recovery,
   weaker prevention, gated at Phase 2 on the effective auto-commit policy.
3. `BEADS_DIR` pinning was superseded: proven precedence `--db` > `-C` > `BEADS_DIR` > walk-up
   makes `-C` argv pinning the primary lever (env scrubbing demoted to defense-in-depth).
4. The retryable-contention error is unreachable under pure contention — bd blocks on the flock
   forever with no timeout knob — so the adapter's own timeout+SIGTERM is what CREATES the
   classifiable retry signal, and exit codes classify nothing (stderr-suffix table in the
   findings doc governs).

Confirmed as designed: worktree sharing (`env -i` proof), pull-preserved timestamps and
end-to-end cursor evasion (the reconciliation ledger's justification), metadata client-key
recovery (all negative controls), hard-delete sweep semantics, `metadata.json` `project_id` as
the instance identity anchor, and the terminal maxBuffer overflow shape.
