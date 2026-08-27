/**
 * TrackerAdapter — the provider seam for the issue-tracker sync feature.
 * Design: docs/proposals/tracker-sync-integration.md ("Provider adapter seam"
 * + "Durability & failure semantics").
 *
 * Everything above this interface (wizard data flow, sync engine, mapping,
 * conflict machinery, sub-issue mirroring) is provider-agnostic. Adapters are
 * pure API clients: no sqlite access, no TaskChangeRouter calls, no retry
 * loops of their own — durability (outbox, cursor, sweep) is the sync core's
 * job, and it depends on these methods behaving as documented here.
 */

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerState,
  TrackerIssue,
  TrackerFieldOptions,
} from '../../../../shared/types/trackerSync';

/** Injected at construction so adapter tests never touch the network. */
export type FetchLike = typeof fetch;

/**
 * What an ADAPTER's {@link TrackerAdapter.listFieldOptions} returns — the live
 * `priorities`/`categories` vocabularies only. The two seeded-mapping fields on
 * the IPC-facing {@link TrackerFieldOptions} (`defaultPriorityMapping` /
 * `defaultCategoryMapping`) are computed one layer up, in
 * `TrackerSyncService.wizardFieldOptions` — an adapter is a pure API client and
 * has no business seeding a mapping, so its contract stays the narrower shape.
 */
export type TrackerFieldOptionsRaw = Pick<TrackerFieldOptions, 'priorities' | 'categories'>;

export interface TrackerAdapterCapabilities {
  /**
   * Provider auto-closes a parent when all sub-issues complete (Linear, since
   * 2024-09). The sync core's close-parent write is an idempotent no-op when
   * this already fired; where false (Plane) that write is the only path.
   */
  nativeParentAutoClose: boolean;
  /** Accepts a non-default API origin (Plane self-hosted). */
  selfHostedBaseUrl: boolean;
  /**
   * `createSubIssue` / `createIssue` can pass `clientKey` as the provider-side
   * id (Linear's issueCreate accepts a client-supplied issue id), making creates
   * natively idempotent: outbox recovery is `getIssue(clientKey)`. Where false
   * (Plane) the outbox reconciles ambiguous creates by listing the candidate
   * issues and matching the pending record's marker before any retry.
   */
  idempotentCreate: boolean;
  /**
   * Which fields an `updateIssueContent` write can actually carry on this
   * provider. `category` is Dart-only (feature/bug/chore syncs to its native
   * task TYPE; Linear/Plane have no type field, per the locked scope decision
   * — no label emulation in v1); `title`/`description`/`priority` are
   * universal. NOT enforced by the adapter itself — a `false` half here is a
   * declaration for the caller to gate on, not a guard this seam checks: the
   * outbound trigger (docs/proposals/tracker-field-writeback.md Phase 5) is
   * what must never populate a field its connection's provider cannot carry.
   */
  contentWrite: {
    title: boolean;
    description: boolean;
    priority: boolean;
    category: boolean;
  };
  /**
   * What `archiveIssue` actually does remotely, per the locked scope decision
   * that outbound archive is ALWAYS trash/archive and never a hard delete:
   * `'trash'` (Linear `issueArchive`, Dart `DELETE` — both are soft/reversible
   * or at least not the provider's permanent-delete path), `'archive'`
   * (reserved for a provider whose own vocabulary distinguishes the two and
   * prefers the milder term; none of today's three needs it), or `'none'`
   * where no verified endpoint exists (Plane — Phase 0 probe P1 could not run
   * against a live workspace) and `archiveIssue` throws rather than silently
   * no-op-ing. Phase 5 gates on this before enqueuing an `archive_issue` row.
   */
  archive: 'trash' | 'archive' | 'none';
  /**
   * Can this provider surface a remote change to the sync engine's
   * incremental `--updated-after`-style cursor at all? False for every HTTP
   * provider today (Linear/Plane/Dart's timestamp always advances on a real
   * change). True only for beads (docs/proposals/tracker-beads-provider.md
   * "4. Pull reconciliation"): a `bd dolt pull` preserves each issue's
   * original `updated_at`, and label/comment/dependency edits never bump it
   * at all, so a cursor-only sweep can miss real changes permanently. When
   * true, the deletion sweep calls {@link TrackerAdapter.listIssueRevisions}
   * (which the adapter MUST then implement) instead of
   * {@link TrackerAdapter.listIssueIds}, diffing the returned
   * `(id, revision)` pairs against known links and the durable
   * `tracker_reconciliation_ledger` rather than trusting the cursor alone.
   */
  requiresIdReconciliation: boolean;
  /**
   * Does this adapter guard an existing-issue mutation (state or content)
   * with a detect-after-write concurrency check? False for every HTTP
   * provider today — their writes are unguarded, as before. True only for
   * beads (docs/proposals/tracker-beads-provider.md, "Dual writers on one
   * issue"): its embedded single-writer database has no CAS/if-match
   * primitive, so the adapter instead captures a `concurrencyToken` before
   * the write and verifies after, throwing {@link
   * import('./errors').TrackerRevisionMismatchError} on an interleaved
   * same-field write. When a provider requires this (see
   * `PROVIDER_REQUIRES_GUARDED_UPDATES` in providerCapabilities.ts) but its
   * adapter cannot provide it, every existing-issue mutation must be gated at
   * the enqueue chokepoint rather than sent unguarded — see that table's doc
   * comment.
   */
  guardedUpdates: boolean;
}

/** The fields a create carries, for BOTH `createSubIssue` and `createIssue`. */
export interface IssueDraft {
  title: string;
  /** Markdown; adapters convert to the provider-native rich format. */
  description?: string;
  /** Provider state id for the initial state; omitted = provider default. */
  stateId?: string;
  /**
   * Provider-raw priority token, ALREADY mapped by the caller (see
   * `TrackerIssue.priority` for what "provider-raw" means per provider) —
   * omitted means "let the provider default apply", not "unset". Every
   * adapter sends it verbatim when present; Dart also accepts `null` (its
   * spelling of "no priority").
   */
  priority?: string | null;
  /**
   * Dart's task-type title, carrying cyboflow's entity category
   * (feature/bug/chore) mapped to the workspace's own type vocabulary.
   * Linear/Plane have no type field to write to, so they ignore this
   * entirely rather than erroring — same "unsupported by this provider"
   * shape as `TrackerIssue.category`.
   */
  category?: string | null;
}

/**
 * A write-back patch for `updateIssueContent`. Every field is OPTIONAL
 * independently of the others: `undefined` means "leave this field alone",
 * a present value (including `null` where the type allows it) means "set
 * it to exactly this". This is the ONLY seam through which a partial update
 * is expressed — there is no separate "clear this field" flag — so an
 * adapter must branch on `!== undefined`, never on truthiness.
 */
export interface IssueContentPatch {
  /** New title. Titles have no "cleared" state, hence no `null` half. */
  title?: string;
  /**
   * New description, as MARKDOWN; `null` clears it.
   *
   * THE CALLER OWNS MARKER RE-APPENDING. For a provider whose creates are
   * not natively idempotent (Dart, Plane — `capabilities.idempotentCreate
   * === false`), every issue this adapter created carries a `cyboflow-sync:
   * <clientKey>` recovery marker in its description (see each adapter's
   * `SYNC_MARKER_PREFIX`), and losing that marker on a content write would
   * break `findIssueByClientKey`'s "no candidate carries it ⇒ create never
   * landed" proof for that link, going forward. But the marker's KEY is
   * link-specific, and this seam is handed only the new body — it has no way
   * to know which link's marker belongs here. So an `updateIssueContent`
   * implementation NEVER composes or re-appends a marker of its own: this
   * field is expected to already be the full body the caller wants written,
   * marker included where one is needed, and every adapter below sends it
   * through its normal markdown conversion UNCHANGED otherwise (Dart:
   * verbatim; Plane: through the same markdown→html conversion `createIssue`
   * uses, with no separate marker-wrapping step). The composing caller is
   * docs/proposals/tracker-field-writeback.md Phase 5, which has the link
   * record and therefore the key; see `IssueContentPatch`'s home file header
   * for why this is documented here rather than assumed.
   */
  description?: string | null;
  /**
   * Provider-raw priority token, ALREADY mapped by the caller — never a
   * local `Priority` value (see `TrackerIssue.priority` for the full
   * rationale: provider scales are lossy relative to the 7-level local one,
   * so mapping happens once, at the write edge, not inside the adapter).
   * `null` clears it where the provider models an absence (Dart only —
   * Linear's `'0'` and Plane's `'none'` are real rungs of their enums, not
   * an absence, so the caller is expected to send one of those tokens
   * rather than `null` for those two providers).
   */
  priority?: string | null;
  /**
   * Dart's task-type title. `null` clears it. Always rejected via
   * `capabilities.contentWrite.category === false` on Linear/Plane — see
   * `TrackerAdapterCapabilities.contentWrite`. Adapters do not themselves
   * refuse a populated `category` on a provider that cannot write one; they
   * simply have nothing to map it onto, so the field is ignored. The gate
   * is the caller's job.
   */
  category?: string | null;
}

export interface TrackerAdapter {
  readonly provider: TrackerProvider;
  readonly capabilities: TrackerAdapterCapabilities;

  /** Live probe of the stored key. Rejects with a typed error on 401/403. */
  validateCredentials(): Promise<TrackerWorkspaceIdentity>;

  /**
   * The Map step's unit: every tracker GROUPING that can be mapped onto a
   * cyboflow project, in labelled sections. A group is the level a team
   * organizes work at, which differs per provider — Linear offers one group per
   * (project × team) pair plus a "Whole teams" fallback (many workspaces do not
   * use projects); Plane offers its projects; Dart offers the spaces implied by
   * the '/' prefix on dartboard titles, falling back to per-board groups.
   *
   * Each group carries a READY-MADE {@link TrackerSourceSelection}, so the
   * wizard and the engine consume the tree without knowing which provider built
   * it, and a mapping is minted by handing that selection straight to `connect`.
   */
  listGroups(): Promise<TrackerGroupTree>;

  /** Wizard Step 1, top level (Linear teams / Plane projects). */
  listContainers(): Promise<TrackerSourceTree>;
  /** Wizard Step 1, second level for one container. Always includes 'all'. */
  listNarrows(containerId: string): Promise<TrackerSourceNarrow[]>;

  /** States for the mapping table, with canonical groups. */
  listStates(selection: TrackerSourceSelection): Promise<TrackerState[]>;

  /**
   * The provider's own vocabulary for the two MAPPED fields — priority and
   * type/category — seeding `priorityMapping` / `categoryMapping` and, from
   * Phase 6, the wizard's value pickers.
   *
   * WHY THIS IS ON THE SEAM rather than a private wire-shape detail: two
   * separate consumers need the live list, and neither can reach into an
   * adapter's internals. The wizard needs it to render pickers whose options are
   * the workspace's ACTUAL values, and the sync pass needs it to notice that a
   * value a persisted mapping names has been renamed away (Dart addresses
   * priorities and types BY TITLE, so a rename silently invalidates a mapping
   * and Dart drops the write rather than failing it).
   *
   * Selection-free by design: none of the three providers scopes these lists to
   * a container. Dart's are workspace-wide `/config` lists; Linear's and Plane's
   * are fixed scales the adapter states rather than fetches. See
   * {@link TrackerFieldOptions} for what a `null` half means.
   */
  listFieldOptions(): Promise<TrackerFieldOptionsRaw>;

  /**
   * Issues in the selection, updated at/after `sinceIso` (the caller widens
   * the window for overlap; adapters must treat the bound as INCLUSIVE and
   * handle provider pagination internally). Omitted = full fetch.
   */
  listIssues(selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]>;

  /** Full external-id set for the selection — the deletion sweep's ground truth. */
  listIssueIds(selection: TrackerSourceSelection): Promise<string[]>;

  /**
   * OPTIONAL. Full external-id set for the selection, each paired with an
   * OPAQUE compare-for-equality revision token — the timestamp-independent
   * reconciliation sweep's ground truth (docs/proposals/
   * tracker-beads-provider.md "4. Pull reconciliation"). Implemented only by
   * adapters whose `capabilities.requiresIdReconciliation` is true (beads);
   * the deletion sweep calls this when the adapter provides it and falls
   * back to {@link listIssueIds} otherwise, so the three HTTP providers are
   * unaffected. `revision` need not be a server-issued token — a stable
   * content fingerprint the adapter derives itself (e.g. a hash over the
   * sync-relevant listed fields) satisfies the same contract, since callers
   * only ever compare it for equality, never parse or order it.
   */
  listIssueRevisions?(
    selection: TrackerSourceSelection,
  ): Promise<Array<{ id: string; revision: string }>>;

  /**
   * OPTIONAL. An opaque token for the workspace's CURRENT state as a whole —
   * beads' Dolt HEAD (docs/proposals/tracker-beads-provider.md, round 16). Only
   * compared for equality, never parsed.
   *
   * The reconciliation sweep captures it at the start and re-reads it before
   * applying ARCHIVAL decisions: identity catches a REPLACED database, but not a
   * concurrent write inside the same one restoring an issue between its
   * absent-id lookup and the local archive. A moved token defers the archival
   * subset for that sweep; imports and merges apply regardless.
   *
   * `anyLinkedExternalId` is a lever, not a filter — the token describes the
   * workspace, and the id only gives the provider something to address the read
   * with. BEST-EFFORT by contract: null means "no token available" (an
   * unresolvable id, no history), and every caller must degrade to running
   * without the guard rather than failing. Implemented only by beads; the three
   * HTTP providers omit it and the guard never engages.
   */
  workspaceHead?(anyLinkedExternalId: string): Promise<string | null>;

  /** Point lookup; null when the issue does not exist (or is hard-deleted). */
  getIssue(externalId: string): Promise<TrackerIssue | null>;

  /**
   * Create a sub-issue under `parentExternalId`. `clientKey` is the outbox
   * row's idempotency key (a UUID minted before the API call) — see
   * `capabilities.idempotentCreate` for how each provider uses it.
   */
  createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue>;

  /**
   * Create a TOP-LEVEL issue in the connection's source container — the PUSH
   * direction: a cyboflow idea filed locally gets its own tracker issue, with
   * no parent to hang it under.
   *
   * Same draft/clientKey/return contract as {@link TrackerAdapter.createSubIssue};
   * only the placement differs, so `selection` (the connection's persisted
   * Step-1 source choice) stands in for the parent. Adapters read `containerId`
   * from it — Linear's team, Plane's project — since that is the level a
   * provider actually files an issue against; the narrow (view/cycle/module) is
   * a READ filter and deliberately not a create target, because membership in
   * one is a separate write both providers model separately.
   */
  createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue>;

  /**
   * Move an issue to a provider state (write-back).
   *
   * `expectedToken` is OPTIONAL and populated by the caller only when the
   * adapter's own {@link TrackerIssue.concurrencyToken} was populated on the
   * pre-send read (i.e. `capabilities.guardedUpdates === true`). Every
   * adapter that does not declare `guardedUpdates` ignores this parameter
   * entirely — its signature needs no change under TS structural typing.
   * A guarded adapter (beads) is expected to verify AFTER the write (its
   * writes are not conditional) and throw {@link
   * import('./errors').TrackerRevisionMismatchError} on an interleaved
   * same-field write; see that class and `guardedUpdates`'s doc comment.
   */
  updateIssueState(externalId: string, stateId: string, expectedToken?: string): Promise<void>;

  /**
   * Write a partial content patch (title/description/priority/category) and
   * return the provider's OWN POST-WRITE issue — the value every adapter's
   * write response already carries (Dart's PUT and Plane's PATCH echo the
   * updated object; Linear's mutation selects the full issue node
   * explicitly). This is the ECHO-SUPPRESSION STAMP SOURCE: the caller
   * merges these exact (post-normalizer) values onto the link's baseline so
   * the next inbound pass diffs our own write to "no change" rather than
   * reopening it as a remote edit.
   *
   * `null` is reserved for a provider that genuinely returns nothing on this
   * write — none of the three adapters here take that path; each documents
   * why on its own `updateIssueContent`.
   *
   * See `IssueContentPatch` for the field-presence contract and the
   * marker-ownership note (this method never re-appends a recovery marker
   * itself).
   *
   * `expectedToken` is the same optional guarded-update parameter documented
   * on {@link updateIssueState} — ignored by every adapter that does not
   * declare `capabilities.guardedUpdates`.
   */
  updateIssueContent(
    externalId: string,
    patch: IssueContentPatch,
    expectedToken?: string,
  ): Promise<TrackerIssue | null>;

  /**
   * Archive (never hard-delete) an issue remotely. A 404 — the twin was
   * already trashed/deleted by some other path — is SUCCESS, not a thrown
   * error (the locked scope decision's idempotency rule; see each adapter's
   * own note on how its provider signals "already gone").
   *
   * Throws when `capabilities.archive === 'none'` (Plane): there is no
   * verified endpoint to call, so this is unreachable by construction — the
   * caller (Phase 5) must gate on the capability before ever enqueuing an
   * `archive_issue` row for such a connection.
   */
  archiveIssue(externalId: string): Promise<void>;
}
