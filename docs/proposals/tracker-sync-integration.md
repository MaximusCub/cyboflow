# Tracker sync integration — Linear + Plane (v1 design)

Status: **proposal, decisions settled** (design conversation 2026-07-30). Rev 2 folds in the Codex adversarial-review hardening: outbox-backed idempotent remote writes, crash-safe cursor semantics, and a deletion-detection sweep.
Source design: `~/Downloads/Linear integration prototype.zip` — high-fidelity HTML prototype + handoff README (Settings → Integrations modal: catalog → 6-step wizard → connected view). The prototype's visual language matches the live Protoflow paper theme exactly; recreate it with the real design tokens and Tailwind utilities, not the prototype's `<x-dc>` runtime.

## Intent

Two-way sync between cyboflow's backlog and external issue trackers. Issues import into cyboflow's normal planning pipeline; cyboflow's progress writes back to the tracker. **Linear and Plane both ship first-class in v1** behind a single provider-adapter seam.

## Decisions log

| Decision | Ruling |
|---|---|
| Imported issues become | **Ideas** (orphaned items, i.e. no existing cyboflow counterpart). V2 adds an agent-driven "smart import" that decides entity type/nesting. |
| Decomposition write-back | **Sub-issue mirroring, per-connection toggle (default on)**: planner-minted tasks are created as sub-issues under the origin issue; each task then writes back to its own sub-issue. |
| Parent completion | Shared "close parent when all mirrored children done" write in the provider-agnostic sync core. Idempotent no-op where Linear's native auto-close automation already fired; primary mechanism for Plane (no native equivalent). |
| Auth (v1) | **Personal API keys**, no OAuth: Linear personal API key; Plane personal access token (`X-API-Key`) + instance base URL for self-hosted. OAuth can slot behind the same wizard step later. |
| Plane scope | **First-class in v1** — two live adapters day one. |
| Catalog rows | **Linear + Plane only.** Drop the prototype's GitHub/Jira/Slack rows. Existing Claude/Codex provider rows in the Integrations tab stay as they are. |
| Conflict resolution | Per-connection mode: **Auto** or **Manual** (see below). |
| Local delete of a linked entity | **Prompt the user** for what happens to the tracker issue. |
| Remote delete of a linked issue | Routed through conflict resolution: Auto → archive the cyboflow idea/task; Manual → per-item decision. |
| Sync cadence | Fixed 5-minute poll while the app runs, plus a manual "Sync now". |

## UX

Follow the prototype's three views and six wizard steps (Connect · Source · Tasks · States · Reconcile · Review), with these deviations:

- **Step 0 (Connect)** — replace the OAuth authorize animation with a paste-your-key card (Linear: API key; Plane: API key + base URL, defaulting to `https://api.plane.so`). Keep the scopes card as documentation of what we read/write. Key is validated with a live `viewer`/workspace probe before Continue enables.
- **Step 2 (Tasks)** — ship the **Toggle** layout only; drop the prototype's layout switch.
- **Step 3 (States)** — ship the **Table** layout only; drop the switch. Below the two-way toggle, add the **sub-issue mirroring toggle** (visible only when two-way is on) and the **conflict mode** selector (Auto / Manual).
- **Step 1 (Source)** — hierarchy comes from the adapter: Linear = team → whole team / project / view / cycle; Plane = project → whole project / cycle / module.
- **Catalog** — two rows (Linear, Plane). Drop the `preview connected state →` prototype affordance.
- **Connected view** — as designed; Sync-settings card gains rows for conflict mode and mirroring; the log gains conflict/mirror lines.

## Data model

- **Entity-scoped external links.** `task_external_links` (mig 014, dormant, task-only) generalizes to link **ideas and tasks**: `entity_type`, `entity_id`, `provider` (`linear` | `plane`), `external_id`, `external_url`, `external_parent_id`, `synced_cursor`, `baseline_json`, plus connection id. `baseline_json` stores the last-synced field snapshot for three-way merge.
- **Connections table.** One row per provider connection: provider, workspace/instance identity, base URL (Plane), selected source, selection mode, state mapping, two-way + mirroring + conflict-mode flags, cursor/timestamps. **Secrets are not stored in this table** — see Auth.
- **Migration numbering**: several in-flight worktrees claim 090–092; take the next free number at implementation time (≈093).
- All entity writes go through `TaskChangeRouter.applyChange` with a provider actor. `'linear'` is already reserved in the `TaskActor` union; add `'plane'` (or generalize to `tracker:<provider>`), and remove the defensive `actor === 'linear'` → `agent:unknown` fallback in `mcpQueryHandler`.

## Import & state mapping

- An issue with no matching cyboflow entity imports as an **idea** whose body carries title/description and a provenance footer (issue ref + URL). Stage comes from the mapping table.
- Cyboflow's four writable stages are the mapping targets: `Idea`, `Ready for development`, `Done`, `Won't do`, plus `— Don't import`. (The derived `In development` stage is orchestrator-owned and never a mapping target.)
- Default inbound mapping, Linear: Triage → Don't import; Backlog → Idea; Todo / In Progress / In Review → Ready for development; Done → Done; Canceled → Won't do. Custom states seed by their state type.
- Default inbound mapping, Plane (seeded from the canonical state `group`): backlog → Idea; unstarted / started → Ready for development; completed → Done; cancelled → Won't do.
- **Reconcile step** covers pre-existing backlog items (ideas and tasks): Keep / Link / Discard per row, with suggested matches. Link writes an external-link row; linking a pre-existing *task* to an issue is supported even though fresh imports are ideas.

## Write-back & sub-issue mirroring

Pre-decomposition, the idea itself writes back: `Done → Done`, `Won't do → Canceled/cancelled`. (`Ready for development` intentionally writes nothing — readiness isn't started.)

When the planner decomposes a linked idea (mirroring toggle on):

1. Each minted task is created as a **sub-issue** of the origin issue (Linear `parentId` / Plane `parent`), and gets its own external-link row.
2. Per-task write-back from then on: task enters derived `In development` → sub-issue "In Progress"/started-group state; task `Done` → done-state; `Won't do` → canceled-state.
3. When all mirrored children are done, the sync core closes the parent (idempotent vs. Linear's native auto-close; sole path for Plane).

With mirroring off, decomposition writes "In Progress" to the origin issue and the all-children-done rollup closes it — same seams, no sub-issue fan-out.

**Echo suppression is a correctness requirement**: mirrored sub-issues must never re-import as new ideas, and our own status writes must never bounce back as remote changes. Both are guaranteed by the outbox (see *Durability & failure semantics*): every remote write has a durable local record **before** the API call is attempted, so the poller can always recognize our own artifacts — even mid-create, even across a crash — and inbound changes diff against `baseline_json` so our own writes are ignored. The inbound cursor never advances past an item whose outbox record is still unresolved.

## Conflict resolution

Per-connection mode, set in the wizard and editable from the connected view:

- **Auto**: three-way merge per field against `baseline_json`. Only-one-side-changed → that side wins. Both-changed → tracker wins content fields (title/description); cyboflow wins stage/status. Every auto-resolution that overrode a change files a non-blocking review-queue finding for spot-checking.
- **Manual**: conflicting items queue for the user, who decides **per item** which side to accept (side-by-side diff, Accept-theirs / Accept-ours per row — reuse the reconcile table treatment). Sync of *that item* pauses until resolved; everything else keeps flowing.

Remote deletions route through the same machinery: Auto → archive the linked idea/task (in-place archive, never hard delete) and mark the link orphaned; Manual → the deletion appears as a conflict row (keep local copy vs. archive).

Local deletion/discard of a linked entity prompts immediately: leave the tracker issue untouched (unlink), or cancel it in the tracker. We never hard-delete on the remote side.

## Sync engine

- Runs in the Electron main process; 5-minute interval while the app is running (desktop app — no sync when closed), immediate pass on connect and on "Sync now".
- Inbound: incremental fetch per connection with the cursor semantics below; changes apply via `TaskChangeRouter` with the provider actor.
- Outbound: entity-event driven (stage changes on linked entities), debounced, executed through the outbox below; failures retry with backoff and surface in the connected view's log.
- Rate limits: Linear GraphQL complexity budget and Plane REST limits both comfortably fit a 5-minute incremental poll; batch writes where the API allows.

### Durability & failure semantics (adversarial-review hardening)

1. **Outbox for every remote write.** No API call without a durable `tracker_outbox` row written first (kind: create-sub-issue / update-state / close-parent; state: `pending → in-flight → done | failed | ambiguous`). Each create carries a **client-generated key**: Linear's `issueCreate` accepts a client-supplied issue id, making creates natively idempotent — recovery is a lookup by that id; Plane has no idempotency key, so an ambiguous create (response lost, crash mid-flight) is reconciled by listing the parent's sub-issues and matching against the pending record before any retry. The external-link row is finalized from the completed outbox record, and the inbound cursor cannot advance past an item with an unresolved outbox entry — so a half-created sub-issue can never be double-created or re-imported.
2. **Crash-safe cursor.** The inbound high-water mark is compound — `(updatedAt, externalId)` — not a bare timestamp, fetched with an overlap window and deduplicated by external id, so same-timestamp neighbors are never skipped. A fetched page is applied in one sqlite transaction **together with** the cursor update; a crash mid-page rewinds to the last durable cursor and the overlap window makes the replay idempotent.
3. **Deletion sweep.** Polling only sees issues that still exist, so remote hard-deletes are invisible to the incremental path. Every Nth poll (and on every "Sync now"), a reconciliation sweep compares the remote ID set for the connection's source scope against active external links; IDs that have vanished become deletion events feeding the conflict machinery (Auto → archive local + orphan the link; Manual → conflict row). Where the provider distinguishes archived from deleted (Linear `archivedAt`/trash), archived issues are treated as remote archives rather than deletions.

## Auth & secrets

No existing pattern for app-owned third-party secrets exists (no keytar/safeStorage usage today). Introduce one: **Electron `safeStorage`-encrypted blobs** stored in sqlite alongside the connection row, decrypted only in the main process. Keys never cross the IPC boundary; the renderer sees connection status only.

## Provider adapter seam

```ts
interface TrackerAdapter {
  provider: 'linear' | 'plane';
  validateCredentials(creds): Promise<WorkspaceIdentity>;
  listHierarchy(): Promise<SourceTree>;            // teams/projects → narrows (views, cycles, modules)
  listStates(source): Promise<TrackerState[]>;     // id, name, color, canonical group
  listIssues(source, since?): Promise<TrackerIssue[]>;      // incremental, overlap-windowed
  listIssueIds(source): Promise<string[]>;         // full ID set — deletion sweep
  getIssue(externalId): Promise<TrackerIssue | null>;       // point lookup — outbox recovery
  createSubIssue(parentExternalId, draft, clientKey): Promise<TrackerIssue>;
  updateIssueState(externalId, stateId): Promise<void>;
  capabilities: {
    nativeParentAutoClose: boolean;   // Linear true, Plane false
    selfHostedBaseUrl: boolean;       // Plane true
    idempotentCreate: boolean;        // Linear true (client-supplied issue id); Plane false → reconcile-by-lookup
  };
}
```

Linear = GraphQL client; Plane = REST client (`X-API-Key`, configurable base URL). The wizard, sync engine, mapping table, conflict machinery, and mirroring logic are all provider-agnostic above this seam.

## Implementation notes (v1 as landed)

Where the build refined the design above — the spec stands, these are the deltas:

- **Cursor advance is per-item, not per-page.** `TaskChangeRouter.applyChange` is async and queue-serialized, so a page cannot share one sqlite transaction with the cursor write. Inbound applies items in ascending `(updatedAt, externalId)` order and advances the compound cursor after each; the overlap window + idempotent re-apply give the same crash guarantee.
- **The tRPC router reaches the engine through a facade bridge** (`main/src/orchestrator/trackerSyncBridge.ts`): router files must standalone-typecheck (no `electron`/`better-sqlite3`/`services/*` imports), so `TrackerSyncService` registers itself as a `TrackerSyncFacade` at boot.
- **Linear custom views are not a v1 narrow** (team → whole / project / cycle only): the customViews issue-filter API is too awkward for the payoff. Plane narrows: project → whole / cycle / module.
- **Outbox failure policy gained a third branch**: non-retryable 4xx (not 408/429) settles terminally instead of retrying every 32 minutes forever. Auth errors pause the connection; 5xx/network use capped exponential backoff.
- **An unresolved outbox row halts inbound cursor advance at that issue** (not just echo-skips it) — the batch resumes once the row settles.
- **Mirroring semantics**: sibling terminality for the close-parent rollup counts Won't do as settled (a cancelled story must not strand the parent open); decomposition never writes 'started' over an already-terminal idea's state.
- **Deletion sweep cadence**: the first pass after every boot sweeps (deletes are most likely to have been missed while the app was closed), then every 12th pass (~hourly) and on every "Sync now".
- **Reconcile links** are created with a null baseline — the first inbound pass adopts the issue's current snapshot without applying anything; the wizard carries the issue's identifier + URL so the ref chip lands at connect time.
- **Connected-view edit shortcuts are v1-read-only** for source/selection/mapping (changing them means re-running the wizard); direction, mirroring, and conflict mode toggle live via `updateSettings`. Deep-links would require a credential re-prompt since keys never return to the renderer.
- **Plane flags for the live smoke**: docs are mid-rename `/issues/` → `/work-items/` (adapter uses `/issues/`; one-line segment swap if a real instance disagrees); assignees need `expand=assignees`; the workspace slug is part of credentials.
- **Open TODO**: the local-delete prompt (what happens to the tracker issue when a linked entity is deleted locally) is not yet wired into the backlog's delete path; `linkForEntity` exists on the router for exactly that affordance.

## V2 (explicitly out of v1 scope)

- **Smart import**: an agent classifies incoming issues (idea vs. task, nesting, epic assignment) instead of ideas-by-default.
- OAuth flows (hosted token exchange), additional providers (Jira, GitHub), assignee/estimate/priority mapping (v1 imports them as display metadata only), configurable cadence, real-time webhooks.
