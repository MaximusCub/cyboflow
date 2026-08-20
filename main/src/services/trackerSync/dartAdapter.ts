/**
 * DartAdapter — tracker-sync provider adapter for Dart (dartai.com). Design:
 * docs/proposals/tracker-sync-integration.md ("Provider adapter seam").
 *
 * Pure REST client: constructor-injected `FetchLike`, no sqlite, no retry
 * loops, no timers — durability (outbox, cursor, sweep) lives in the sync core,
 * not here. Every method that crosses the network throws only
 * `TrackerApiError`/`TrackerAuthError` (see errors.ts).
 *
 * Verified against Dart's published OpenAPI 3.1 spec
 * (https://app.dartai.com/api/v0/public/schema/, retrieved 2026-08-16) and, for
 * the behaviours the spec leaves open, against a LIVE Dart space on 2026-08-18.
 * Comments below say "measured" where the fact came from that live run rather
 * than from the spec — the two are not equally strong, and one of the spec's
 * silences (sub-issue placement) turned out to contradict the obvious reading.
 *
 * Three properties of that API shape almost every decision below, and none of
 * them has a Linear or Plane analogue:
 *
 * 1. DART ADDRESSES BY DISPLAY TITLE, NOT ID. `GET /config` — the ONLY
 *    discovery endpoint — returns `dartboards` and `statuses` as flat arrays of
 *    STRINGS, and `TaskCreate.dartboard`/`.status` take those same strings.
 *    Dartboard ids exist (`GET /dartboards/{id}`) but no endpoint ENUMERATES
 *    them, and a Task never carries one. So `TrackerSourceContainer.id` and
 *    `TrackerState.id` ARE the titles. A dartboard or status rename therefore
 *    invalidates a connection's persisted `source_json` selection and its
 *    `state_mapping_json` keys; nothing here can prevent that, so the failure is
 *    made loud rather than silent — see
 *    {@link DartAdapter.assertContainerExists}.
 * 2. LIST RESPONSES OMIT THE DESCRIPTION. `GET /tasks/list` returns
 *    `ConciseTask`, which drops exactly `description`, `attachments` and
 *    `taskRelationships`. The sync core three-way-merges on description and
 *    recovers lost creates through a marker embedded in it, so `listIssues`
 *    HYDRATES each row via `GET /tasks/{id}` — see {@link DartAdapter.hydrate}.
 *    `listIssueIds` (the deletion sweep) deliberately does not, since ids are
 *    on the concise shape already.
 * 3. STATUSES CARRY NO GROUPING. Dart exposes no state type/category, so
 *    {@link inferStateGroup} guesses from the name. That is a low-stakes guess
 *    BY CONSTRUCTION: `group` only SEEDS the wizard's mapping-table defaults
 *    (stateMapping.seedDefaultMapping), which the user then overrides; it never
 *    gates the sync itself.
 *
 * externalId is the bare 12-character Dart task id. Unlike Plane, no
 * compositing is needed: `/tasks/{id}` is not dartboard-scoped, so the id alone
 * addresses a task.
 */

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerSourceTree,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerState,
  TrackerStateGroup,
  TrackerIssue,
  TrackerUserRef,
} from '../../../../shared/types/trackerSync';
import type {
  TrackerAdapter,
  TrackerAdapterCapabilities,
  FetchLike,
  IssueDraft,
} from './adapterTypes';
import {
  TrackerApiError,
  TrackerAuthError,
  TRACKER_REQUEST_TIMEOUT_MS,
  describeTransportFailure,
} from './errors';

const PROVIDER: TrackerProvider = 'dart';
const API_BASE_URL = 'https://app.dartai.com/api/v0/public';
/** Dart's web UI origin — `Task.htmlUrl` is absolute, so this is only a fallback. */
const APP_ORIGIN = 'https://app.dartai.com';

const CAPABILITIES: TrackerAdapterCapabilities = {
  // Dart does not auto-close a parent when its subtasks complete, so the sync
  // core's close-parent write is the only path (same as Plane).
  nativeParentAutoClose: false,
  // Dart is cloud-only; there is no self-hosted origin to configure.
  selfHostedBaseUrl: false,
  // `TaskCreate` accepts no client-supplied id (`TaskId` is readOnly and server-
  // minted), so creates are not idempotent. Authorship is recovered from the
  // marker every create stamps into the description — see SYNC_MARKER_PREFIX
  // and {@link DartAdapter.findIssueByClientKey}.
  idempotentCreate: false,
};

/**
 * Recovery marker: the outbox row's client key, written as the final line of
 * every task this adapter creates. Dart accepts no idempotency key on create,
 * so this is the ONLY provider-visible proof that a given task is the one a
 * lost create produced — matching on parent + title cannot tell our child apart
 * from a sibling that happens to share the title.
 *
 * The marker is stripped from every description the adapter returns (see
 * {@link mapDescription}) so it never reaches a local body or a merge baseline —
 * but the key it carries is surfaced first, on `TrackerIssue.recoveryClientKey`
 * ({@link readRecoveryClientKey}), because the inbound pass needs it to
 * recognize a lost create's child before importing anything.
 *
 * Dart descriptions are markdown (not Plane's rich html), so the marker is
 * written and matched as plain text with no escaping in between.
 */
const SYNC_MARKER_PREFIX = 'cyboflow-sync:';

/**
 * `cyboflow-sync: <uuid>` — the shape the create paths emit, matched loosely on
 * the WHITESPACE between the prefix and the key.
 *
 * `\s*` rather than `[ \t]*` deliberately. Dart normalizes the markdown it
 * stores (MEASURED: it re-emits emphasis runs, reflows lists, and rewrites
 * dotted tokens as links), so the body that comes back is not always the body
 * that went out. A marker whose line got reflowed is still OUR marker, and the
 * UUID that follows makes a false positive vanishingly unlikely — whereas a
 * false NEGATIVE is expensive: {@link DartAdapter.findIssueByClientKey} reads
 * "no candidate carries it" as proof a create never landed, and duplicates it.
 */
const SYNC_MARKER_RE =
  /cyboflow-sync:\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * {@link SYNC_MARKER_RE} with the key captured. A SEPARATE, NON-GLOBAL copy on
 * purpose: `exec` on a /g regex carries `lastIndex` between calls, which would
 * make the read stateful across tasks.
 *
 * Kept in lockstep with SYNC_MARKER_RE: read and STRIP must agree on what a
 * marker is, or a marker loose enough to be recognized but too loose to be
 * removed would leak into a local idea body.
 */
const SYNC_MARKER_KEY_RE =
  /cyboflow-sync:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Dart's list endpoints cap out well above this; 100 keeps pages small and predictable. */
const PAGE_SIZE = 100;

/**
 * How many `GET /tasks/{id}` hydration fetches may be in flight at once.
 * Bounded because a full first import of a large dartboard issues one per task
 * (see the file header, point 2) and Dart publishes no rate-limit headers to
 * pace against — so the ceiling is ours to choose rather than to discover.
 */
const HYDRATION_CONCURRENCY = 6;

/**
 * Runaway guard for the offset pager. `count` bounds every real listing, so
 * hitting this means the endpoint kept reporting more pages than it has —
 * better a named error than an unbounded loop inside the sync engine's lock.
 */
const MAX_PAGES = 500;

export interface DartAdapterOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  /**
   * Per-request abort budget; defaults to {@link TRACKER_REQUEST_TIMEOUT_MS}.
   * Injectable so a test can prove the abort path in milliseconds instead of
   * waiting out the real budget.
   */
  requestTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Wire shapes (only the fields this adapter reads/writes; Dart's objects carry
// more). Names are Dart's own camelCase.
// ---------------------------------------------------------------------------

interface DartPage<T> {
  count: number;
  next: string | null;
  results: T[];
}

interface DartUserWire {
  id?: string;
  name?: string | null;
  email?: string | null;
}

interface DartMeWire {
  isLoggedIn: boolean;
  user: DartUserWire;
}

/** `GET /config` — the whole discovery surface. */
interface DartConfigWire {
  dartboards: string[];
  statuses: string[];
  assignees?: DartUserWire[];
}

/** `ConciseTask` (list) — the same shape as `Task` minus description/attachments/relationships. */
interface DartConciseTaskWire {
  id: string;
  htmlUrl?: string | null;
  title: string;
  parentId?: string | null;
  dartboard?: string | null;
  status?: string | null;
  assignee?: string | null;
  assignees?: string[] | null;
  size?: string | number | null;
  updatedAt: string;
}

/** `Task` (detail/create/update) — adds the description the list shape omits. */
interface DartTaskWire extends DartConciseTaskWire {
  description?: string | null;
}

/** Every write and single-item read is enveloped as `{ item: ... }`. */
interface DartWrapped<T> {
  item: T;
}

// ---------------------------------------------------------------------------

export class DartAdapter implements TrackerAdapter {
  readonly provider: TrackerProvider = PROVIDER;
  readonly capabilities: TrackerAdapterCapabilities = CAPABILITIES;

  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  /** `GET /config` is one call serving containers, states and validation; cached per pass. */
  private configCache: DartConfigWire | null = null;

  constructor(options: DartAdapterOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? TRACKER_REQUEST_TIMEOUT_MS;
  }

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    const me = await this.request<DartMeWire>('GET', '/me');
    // A 200 with isLoggedIn:false is Dart answering "this token resolves to no
    // session" without using a 401. Treated as an AUTH failure rather than a
    // generic one so it takes the re-connect path and pauses the connection,
    // instead of retrying a token that will never work.
    if (me.isLoggedIn !== true) {
      throw new TrackerAuthError(PROVIDER, 'token did not resolve to a logged-in Dart user', null);
    }
    const user = me.user ?? {};
    // DOCUMENTED COMPROMISE. Dart's API exposes NO workspace identity: neither
    // /me nor /config names the space a token belongs to. The account is the
    // best stable proxy available, so `workspaceId` is the user id — which
    // makes the credential-rotation guard (TrackerIdentityMismatchError) mean
    // "the replacement token must belong to the same Dart ACCOUNT". That is
    // strictly weaker than Linear's/Plane's workspace binding, and worth
    // knowing: it catches a token pasted from a different account, but cannot
    // catch the same user's token for a different space.
    const identity = user.id ?? user.email ?? null;
    if (identity === null) {
      throw new TrackerApiError(PROVIDER, '/me returned no user id or email to bind to', null);
    }
    return {
      workspaceId: identity,
      // No workspace name exists to show, so the account the token authorizes
      // stands in — it is the thing a user can actually recognize.
      workspaceName: user.email ?? user.name ?? identity,
      actorLabel: deriveActorLabel(user),
    };
  }

  async listContainers(): Promise<TrackerSourceTree> {
    const config = await this.getConfig();
    return {
      containerLabel: 'Dartboard',
      containers: config.dartboards.map((title) => ({
        // Header point 1: Dart enumerates dartboards by title only, so the
        // title is the id.
        id: title,
        name: title,
        // Dart has no short key chip and no per-dartboard open count.
        key: null,
        openIssueCount: null,
      })),
    };
  }

  async listNarrows(_containerId: string): Promise<TrackerSourceNarrow[]> {
    // Dart models views (`GET /views/{id}`) but enumerates none of them, and has
    // no cycle/module concept at all — so the whole dartboard is the only source
    // scope that can be OFFERED. The contract requires 'all' to be present, and
    // here it is the entire list.
    return [{ id: 'all', kind: 'all', name: 'Whole dartboard · all tasks', issueCount: null }];
  }

  async listStates(_selection: TrackerSourceSelection): Promise<TrackerState[]> {
    // Dart statuses are workspace-wide, not per-dartboard, so the selection is
    // not a filter here — /config is the whole list either way.
    const config = await this.getConfig();
    return config.statuses.map((title) => ({
      // Header point 1: the status title IS the write value `TaskUpdate.status`
      // takes, so it doubles as the id.
      id: title,
      name: title,
      // Dart exposes no status color.
      color: null,
      group: inferStateGroup(title),
    }));
  }

  async listIssues(selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]> {
    await this.assertContainerExists(selection.containerId);
    const params: Record<string, string> = { dartboard: selection.containerId };
    if (sinceIso !== undefined) {
      // MEASURED: `updated_at_after` is INCLUSIVE (a task queried at exactly its
      // own updatedAt comes back; one second later it does not), which is what
      // the adapter contract requires. The one-second widening and the exact
      // client-side re-filter below are kept anyway: they cost at most a second
      // of overlap the sync core already tolerates, and they keep the contract
      // satisfied if Dart ever tightens the bound to exclusive.
      params.updated_at_after = shiftIsoBySeconds(sinceIso, -1);
    }
    const concise = await this.paginate<DartConciseTaskWire>('/tasks/list', params);
    const scoped =
      sinceIso === undefined
        ? concise
        : concise.filter((task) => Date.parse(task.updatedAt) >= Date.parse(sinceIso));
    // Hydration, not decoration: the list shape has no description, and the sync
    // core merges on it (file header, point 2).
    const hydrated = await this.hydrate(scoped);
    return hydrated.map((task) => this.mapIssue(task));
  }

  async listIssueIds(selection: TrackerSourceSelection): Promise<string[]> {
    await this.assertContainerExists(selection.containerId);
    const concise = await this.paginate<{ id: string }>('/tasks/list', {
      dartboard: selection.containerId,
    });
    // Deliberately un-hydrated: the deletion sweep only needs ids, and those are
    // on the concise shape.
    return concise.map((task) => task.id);
  }

  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    const raw = await this.fetchTaskWire(externalId);
    return raw === null ? null : this.mapIssue(raw);
  }

  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    // Dart has no idempotency key on create (capabilities.idempotentCreate =
    // false), so the key is carried in the description instead: EVERY create
    // ends with the SYNC_MARKER_PREFIX line, which is what makes
    // findIssueByClientKey's "no child carries it" answer conclusive.
    clientKey: string
  ): Promise<TrackerIssue> {
    // PLACEMENT IS NOT INHERITED — MEASURED, not assumed. Dart's POST /tasks
    // documents the dartboard default as "the default dartboard", and a
    // `parentId`-only create was observed against a live space (2026-08-18) to
    // land the child on the API USER'S DEFAULT dartboard, NOT the parent's.
    // That placement is invisible to this connection: `listIssues` and
    // `listIssueIds` are both dartboard-scoped, so a mirror filed there would
    // sync outbound once and then never be seen again — remote edits would
    // never come back, and the deletion sweep would read it as out-of-scope on
    // every pass. The same measurement confirmed that naming the board
    // explicitly DOES honour the placement and still preserves `parentId`.
    const parent = await this.fetchTaskWire(parentExternalId);
    if (parent === null) {
      // Terminal (4xx): the parent is gone for good, so retrying this mirror
      // forever would just pin an outbox row that can never succeed.
      throw new TrackerApiError(
        PROVIDER,
        `parent task ${parentExternalId} no longer exists — cannot mirror a sub-issue under it`,
        404
      );
    }
    return this.postTask(
      { parentId: parentExternalId, dartboard: parent.dartboard ?? undefined },
      draft,
      clientKey
    );
  }

  /**
   * Top-level create (the PUSH direction): a task on the selection's DARTBOARD
   * with no parent. Carries the same unconditional recovery marker as
   * {@link DartAdapter.createSubIssue} — Dart still has no idempotency key, so a
   * top-level create that commits and loses its response is recovered by exactly
   * the same marker lookup ({@link DartAdapter.findIssueByClientKey}), which is
   * only conclusive because EVERY create writes the marker.
   */
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue> {
    // Same guard the read paths carry, for the same measured reason: a renamed
    // dartboard is not an error to Dart, so an unguarded create would either be
    // filed somewhere unintended or fail with an opaque 4xx that the outbox
    // treats as terminal and DROPS the push. Failing here keeps the row
    // retryable until the source selection is repaired.
    await this.assertContainerExists(selection.containerId);
    return this.postTask({ dartboard: selection.containerId }, draft, clientKey);
  }

  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    // `TaskUpdate` requires the id INSIDE the item as well as on the path.
    await this.request<DartWrapped<DartTaskWire>>('PUT', `/tasks/${encodeURIComponent(externalId)}`, {
      item: { id: externalId, status: stateId },
    });
  }

  /**
   * Ambiguous-create recovery (see the outbox worker): the task in scope that
   * carries `clientKey` in its {@link SYNC_MARKER_PREFIX} line, or null when
   * none carries it — which, because every create sends the marker, PROVES the
   * create never landed and a retry is safe.
   *
   * `scope.parentExternalId` narrows the search to one parent's children (a
   * mirrored `create_sub_issue`) via Dart's server-side `parent_id` filter;
   * otherwise the search is the selection's dartboard (a top-level
   * `create_issue`). BOTH forms match on the client key alone — title is
   * deliberately NOT a criterion, because a dartboard routinely holds two tasks
   * with the same title and adopting the wrong one would silently redirect every
   * later write-back onto an unrelated task.
   *
   * COST, and why it is shaped this way. The marker lives in the description,
   * which list responses omit, so a candidate can only be judged after a detail
   * fetch. Dart does expose a `description` list filter, used FIRST as a fast
   * path; it was MEASURED to be a CONTAINS match (a bare substring of the marker
   * line matches, and a string present in no task returns zero rows), so the
   * fast path does hit in practice. The full-scan fallback is kept regardless,
   * because the cost of being wrong here is asymmetric: a miss that falls
   * through only costs time, whereas trusting an unexpectedly-narrow filter as
   * proof of absence would duplicate a create that actually landed.
   *
   * Not part of `TrackerAdapter`: the marker is stripped from every description
   * this adapter returns, so the match cannot be performed by the sync core over
   * a mapped `TrackerIssue` — it has to read the raw payload here.
   */
  async findIssueByClientKey(
    scope: { containerId: string | null; parentExternalId: string | null },
    clientKey: string
  ): Promise<TrackerIssue | null> {
    const marker = `${SYNC_MARKER_PREFIX} ${clientKey}`;
    const scopeParams: Record<string, string> =
      scope.parentExternalId !== null
        ? { parent_id: scope.parentExternalId }
        : scope.containerId !== null
          ? { dartboard: scope.containerId }
          : {};
    if (Object.keys(scopeParams).length === 0) {
      throw new TrackerApiError(
        PROVIDER,
        'client-key recovery needs either a parent task or a source dartboard'
      );
    }
    // THE DARTBOARD-SCOPED ARM MUST FAIL LOUD, NOT EMPTY. A renamed dartboard
    // makes `/tasks/list` answer 200 with zero rows (measured), and in THIS
    // method an empty result is not "no match" — it is read by the outbox as
    // PROOF the create never landed, which requeues a create that may already
    // have committed and duplicates it. Throwing leaves the row `ambiguous`,
    // which is the correct unresolved state. The parent_id arm needs no such
    // guard: it is addressed by id, which renames cannot invalidate.
    if (scope.parentExternalId === null && scope.containerId !== null) {
      await this.assertContainerExists(scope.containerId);
    }

    // Fast path: let Dart do the filtering if it can.
    const filtered = await this.paginate<DartConciseTaskWire>('/tasks/list', {
      ...scopeParams,
      description: marker,
    });
    const viaFilter = await this.firstMarkedTask(filtered, clientKey);
    if (viaFilter !== null) return this.mapIssue(viaFilter);

    // Fall back to the full scoped scan — see the COST note above.
    const all = await this.paginate<DartConciseTaskWire>('/tasks/list', scopeParams);
    const viaScan = await this.firstMarkedTask(all, clientKey);
    return viaScan === null ? null : this.mapIssue(viaScan);
  }

  // ---- internals -----------------------------------------------------

  /**
   * The first candidate whose hydrated description carries `clientKey`, or null.
   *
   * Judged by PARSING the marker ({@link readRecoveryClientKey}) rather than by
   * a literal `description.includes(marker)`. The two differ exactly when Dart's
   * normalizer has touched the marker line, and this is the one place where
   * being too strict is costly: a miss here is read by the outbox as proof the
   * create never landed, so it POSTs again and duplicates a task that already
   * exists. Parsing also keeps this in step with the recovery key the adapter
   * surfaces on every mapped issue, so the two paths cannot disagree about what
   * counts as ours.
   */
  private async firstMarkedTask(
    candidates: DartConciseTaskWire[],
    clientKey: string
  ): Promise<DartTaskWire | null> {
    for (const candidate of candidates) {
      const full = await this.fetchTaskWire(candidate.id);
      if (full === null) continue;
      if (readRecoveryClientKey(full) === clientKey.toLowerCase()) return full;
    }
    return null;
  }

  /** Raw detail fetch; null on 404 (the task does not exist / was hard-deleted). */
  private async fetchTaskWire(taskId: string): Promise<DartTaskWire | null> {
    const response = await this.send('GET', `/tasks/${encodeURIComponent(taskId)}`);
    if (response.status === 404) return null;
    this.assertOk(response);
    const wrapped = (await response.json()) as DartWrapped<DartTaskWire>;
    return wrapped.item;
  }

  /** The shared create POST behind both create paths. */
  private async postTask(
    placement: { dartboard?: string; parentId?: string },
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue> {
    const item: Record<string, unknown> = {
      ...placement,
      title: draft.title,
      description: toCreateDescription(draft.description, clientKey),
    };
    if (draft.stateId !== undefined) {
      item.status = draft.stateId;
    }
    const wrapped = await this.request<DartWrapped<DartTaskWire>>('POST', '/tasks', { item });
    return this.mapIssue(wrapped.item);
  }

  /**
   * Turns concise list rows into full tasks, at most
   * {@link HYDRATION_CONCURRENCY} fetches in flight. A row whose detail fetch
   * 404s (deleted between the list and the hydrate) is DROPPED rather than
   * surfaced half-populated — a TrackerIssue with a null description that only
   * looks null because we failed to read it would merge as "the remote body was
   * cleared" and wipe the local one.
   */
  private async hydrate(concise: DartConciseTaskWire[]): Promise<DartTaskWire[]> {
    const out: DartTaskWire[] = new Array<DartTaskWire>(concise.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= concise.length) return;
        const full = await this.fetchTaskWire(concise[index].id);
        if (full !== null) out[index] = full;
      }
    };
    const lanes = Math.min(HYDRATION_CONCURRENCY, concise.length);
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    // Order-preserving compaction of the 404 holes.
    return out.filter((task): task is DartTaskWire => task !== undefined);
  }

  /**
   * `GET /config` is Dart's entire discovery surface — dartboards, statuses and
   * the assignee roster in one call — so it is fetched once per adapter instance
   * and reused. Instance-scoped, exactly like PlaneAdapter's project-identifier
   * cache: the sync core builds a fresh adapter per pass, so nothing here can go
   * stale across passes.
   */
  private async getConfig(): Promise<DartConfigWire> {
    if (this.configCache !== null) return this.configCache;
    const config = await this.request<DartConfigWire>('GET', '/config');
    this.configCache = {
      dartboards: Array.isArray(config.dartboards) ? config.dartboards : [],
      statuses: Array.isArray(config.statuses) ? config.statuses : [],
      assignees: config.assignees,
    };
    return this.configCache;
  }

  /**
   * Fails loudly when the connection's dartboard is no longer in `/config`.
   *
   * This is the guard behind header point 1. Because the container id IS the
   * dartboard title, a rename in Dart leaves the connection
   * pointing at a name nothing answers to — and `GET /tasks/list?dartboard=<gone>`
   * returns an EMPTY PAGE rather than an error. Unguarded, that empty page reads
   * to `listIssueIds` as "every task in this dartboard was deleted remotely",
   * and the deletion sweep would act on it. A named error instead surfaces on
   * the connection and stops the pass with the links intact.
   */
  private async assertContainerExists(containerId: string): Promise<void> {
    const config = await this.getConfig();
    if (config.dartboards.includes(containerId)) return;
    throw new TrackerApiError(
      PROVIDER,
      `dartboard "${containerId}" no longer exists in this Dart space — it was renamed or ` +
        'deleted. Re-pick the source dartboard in Settings → Integrations.',
      null
    );
  }

  /**
   * Walks Dart's limit/offset pager to exhaustion.
   *
   * `count` is the AUTHORITY and is consulted first; `next` is only a fallback
   * for a response that omits `count` entirely. That ordering is load-bearing,
   * not stylistic: in `PaginatedConciseTaskList` the spec marks `count` and
   * `results` REQUIRED but `next` optional AND nullable, so a page carrying
   * `count: 250`, a hundred rows, and no `next` at all is schema-valid. Letting
   * a missing `next` win there would stop the walk two thirds short — which
   * `listIssueIds` would hand the deletion sweep as a shrunken id set, and
   * which `findIssueByClientKey` would read as a marker that is not there,
   * duplicating a create that already landed.
   */
  private async paginate<T>(
    path: string,
    extraParams: Record<string, string> = {}
  ): Promise<T[]> {
    const results: T[] = [];
    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES) {
        throw new TrackerApiError(
          PROVIDER,
          `pagination exceeded ${MAX_PAGES} pages on ${path} — refusing to loop further`,
          null
        );
      }
      const params = new URLSearchParams({
        ...extraParams,
        limit: String(PAGE_SIZE),
        offset: String(results.length),
      });
      const body = await this.request<DartPage<T>>('GET', `${path}?${params.toString()}`);
      const batch = Array.isArray(body.results) ? body.results : [];
      results.push(...batch);
      // An empty page terminates regardless of what `count` claims, so a
      // miscounted endpoint cannot spin here.
      if (batch.length === 0) break;
      if (typeof body.count === 'number') {
        if (results.length >= body.count) break;
        // `count` says there is more; an absent or null `next` does not get to
        // override it (see the doc comment). The empty-page guard above still
        // terminates a server that over-reports.
        continue;
      }
      if (body.next === null || body.next === undefined) break;
    }
    return results;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    this.assertOk(response);
    if (response.status === 204) return undefined as unknown as T;
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  /**
   * The single fetch every path in this adapter goes through.
   *
   * EVERY call carries an abort timeout (see TRACKER_REQUEST_TIMEOUT_MS): a
   * request that never settles would pin the sync engine's per-connection lock
   * for the life of the process. The abort — and any other transport-level
   * failure — surfaces as a TrackerApiError with a NULL status, which is what
   * puts it on the outbox's RETRY path rather than its terminal one: a timeout
   * says nothing about whether the write is valid.
   */
  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new TrackerApiError(PROVIDER, describeTransportFailure(err, this.requestTimeoutMs), null);
    }
  }

  private assertOk(response: Response): void {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new TrackerAuthError(PROVIDER, `request failed (${response.status})`, response.status);
    }
    throw new TrackerApiError(PROVIDER, `request failed (${response.status})`, response.status);
  }

  private mapIssue(raw: DartTaskWire): TrackerIssue {
    return {
      externalId: raw.id,
      // Dart mints no human-readable ref (no "CORE-142" analogue anywhere in the
      // API), so the task id stands in — it is at least stable and clickable.
      identifier: raw.id,
      title: raw.title,
      description: mapDescription(raw),
      url: raw.htmlUrl ?? `${APP_ORIGIN}/t/${raw.id}`,
      // Header point 1: the status title is the state id.
      stateId: raw.status ?? '',
      assignee: mapAssignee(raw),
      estimate: mapEstimate(raw.size),
      parentExternalId: raw.parentId ?? null,
      updatedAt: raw.updatedAt,
      // Dart exposes no archive marker on a task, and needs none: trashing is
      // MEASURED to be indistinguishable from deletion over this API — a trashed
      // task 404s on `GET /tasks/{id}` and is absent from listings (including
      // under `no_defaults=true`; only an explicit `in_trash=true` reveals it).
      // So the sweep's own getIssue confirmation already classifies it as gone,
      // and there is no archived-but-present state for this field to carry.
      archivedAt: null,
      // Read BEFORE mapDescription strips it — every path that maps a wire task
      // (hydrated list, detail, create response, client-key recovery) goes
      // through here, so a marker-bearing task surfaces its key no matter how it
      // was fetched.
      recoveryClientKey: readRecoveryClientKey(raw),
    };
  }
}

// ---------------------------------------------------------------------------
// Free helpers (no adapter state needed).
// ---------------------------------------------------------------------------

/**
 * Best-effort canonical group for a Dart status NAME. Dart publishes no state
 * type or category (file header, point 3), so this reads the name.
 *
 * Order is load-bearing: the cancelled probe runs before the completed one so a
 * "Won't do"/"Cancelled — done investigating" style name is not claimed by the
 * completed matcher first. An unrecognized name falls back to 'backlog' rather
 * than throwing, matching PlaneAdapter's handling of an unknown group — groups
 * only seed mapping defaults, they never gate the sync.
 */
export function inferStateGroup(name: string): TrackerStateGroup {
  const n = name.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((needle) => n.includes(needle));
  if (has('triage')) return 'triage';
  if (has('cancel', "won't", 'wont', 'reject', 'abandon', 'duplicate', 'obsolete')) {
    return 'cancelled';
  }
  if (has('done', 'complete', 'finished', 'shipped', 'closed', 'resolved')) return 'completed';
  if (has('progress', 'doing', 'started', 'active', 'review', 'blocked', 'testing')) {
    return 'started';
  }
  if (has('to-do', 'to do', 'todo', 'ready', 'open', 'new', 'up next', 'planned')) {
    return 'unstarted';
  }
  if (has('backlog', 'someday', 'icebox')) return 'backlog';
  return 'backlog';
}

function deriveActorLabel(user: DartUserWire): string {
  if (user.name && user.name.trim().length > 0) return user.name.trim();
  if (user.email && user.email.trim().length > 0) return user.email.trim();
  return 'Dart user';
}

/**
 * The description the sync core sees: Dart's markdown body with our recovery
 * marker removed. A body that is NOTHING BUT the marker is an empty description
 * — the marker is sync plumbing and must never reach a local idea body.
 */
function mapDescription(raw: DartTaskWire): string | null {
  if (typeof raw.description !== 'string') return null;
  const cleaned = stripSyncMarker(raw.description);
  return cleaned.length > 0 ? cleaned : null;
}

/** Drop the recovery marker (and the whitespace it leaves behind) from a description. */
function stripSyncMarker(text: string): string {
  return text.replace(SYNC_MARKER_RE, '').trim();
}

/**
 * The client key this task's description carries, or null when it carries none.
 * Reads the RAW payload — every description this adapter RETURNS has already had
 * the marker stripped.
 *
 * Lower-cased because the match is case-insensitive while the outbox column
 * holds a `randomUUID()` key, which is always lower-case: the sync core compares
 * the two for exact equality.
 */
function readRecoveryClientKey(raw: DartTaskWire): string | null {
  if (typeof raw.description !== 'string') return null;
  const match = SYNC_MARKER_KEY_RE.exec(raw.description);
  return match === null ? null : match[1].toLowerCase();
}

/**
 * Description markdown for a create: the draft body, then the recovery marker on
 * its own trailing line. The marker is UNCONDITIONAL — findIssueByClientKey
 * reads "no candidate carries it" as proof the create never landed, which only
 * holds if every create carries it, empty-bodied ones included.
 */
function toCreateDescription(markdown: string | undefined, clientKey: string): string {
  const marker = `${SYNC_MARKER_PREFIX} ${clientKey}`;
  const body = (markdown ?? '').trim();
  return body.length === 0 ? marker : `${body}\n\n${marker}`;
}

/**
 * Dart's `size` is `string | integer | null` — an integer is a point value, a
 * string is a t-shirt size ("M") with no numeric meaning. Only the former can
 * become a TrackerIssue estimate; a numeric string is accepted since Dart's own
 * spec allows either encoding for the same value.
 */
function mapEstimate(size: string | number | null | undefined): number | null {
  if (typeof size === 'number') return Number.isFinite(size) ? size : null;
  if (typeof size !== 'string') return null;
  const trimmed = size.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Dart identifies assignees by MONIKER (name or email), not by id — there is no
 * user id on a task anywhere in the API — so the moniker doubles as the ref id.
 * `assignee` and `assignees` are alternates (which one a workspace uses depends
 * on whether multi-assign is enabled), so both are read.
 */
function mapAssignee(raw: DartConciseTaskWire): TrackerUserRef | null {
  const moniker =
    typeof raw.assignee === 'string' && raw.assignee.length > 0
      ? raw.assignee
      : Array.isArray(raw.assignees) && raw.assignees.length > 0
        ? raw.assignees[0]
        : null;
  if (moniker === null || moniker.length === 0) return null;
  return { id: moniker, name: moniker, initials: deriveInitials(moniker) };
}

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** ISO timestamp shifted by whole seconds — see listIssues' inclusive-bound note. */
function shiftIsoBySeconds(iso: string, deltaSeconds: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms + deltaSeconds * 1000).toISOString();
}
