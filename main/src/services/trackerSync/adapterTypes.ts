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
  TrackerSourceTree,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerState,
  TrackerIssue,
} from '../../../../shared/types/trackerSync';

/** Injected at construction so adapter tests never touch the network. */
export type FetchLike = typeof fetch;

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
   * `createSubIssue` can pass `clientKey` as the provider-side id (Linear's
   * issueCreate accepts a client-supplied issue id), making creates natively
   * idempotent: outbox recovery is `getIssue(clientKey)`. Where false (Plane)
   * the outbox reconciles ambiguous creates by listing the parent's
   * sub-issues and matching the pending record before any retry.
   */
  idempotentCreate: boolean;
}

export interface SubIssueDraft {
  title: string;
  /** Markdown; adapters convert to the provider-native rich format. */
  description?: string;
  /** Provider state id for the initial state; omitted = provider default. */
  stateId?: string;
}

export interface TrackerAdapter {
  readonly provider: TrackerProvider;
  readonly capabilities: TrackerAdapterCapabilities;

  /** Live probe of the stored key. Rejects with a typed error on 401/403. */
  validateCredentials(): Promise<TrackerWorkspaceIdentity>;

  /** Wizard Step 1, top level (Linear teams / Plane projects). */
  listContainers(): Promise<TrackerSourceTree>;
  /** Wizard Step 1, second level for one container. Always includes 'all'. */
  listNarrows(containerId: string): Promise<TrackerSourceNarrow[]>;

  /** States for the mapping table, with canonical groups. */
  listStates(selection: TrackerSourceSelection): Promise<TrackerState[]>;

  /**
   * Issues in the selection, updated at/after `sinceIso` (the caller widens
   * the window for overlap; adapters must treat the bound as INCLUSIVE and
   * handle provider pagination internally). Omitted = full fetch.
   */
  listIssues(selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]>;

  /** Full external-id set for the selection — the deletion sweep's ground truth. */
  listIssueIds(selection: TrackerSourceSelection): Promise<string[]>;

  /** Point lookup; null when the issue does not exist (or is hard-deleted). */
  getIssue(externalId: string): Promise<TrackerIssue | null>;

  /**
   * Create a sub-issue under `parentExternalId`. `clientKey` is the outbox
   * row's idempotency key (a UUID minted before the API call) — see
   * `capabilities.idempotentCreate` for how each provider uses it.
   */
  createSubIssue(
    parentExternalId: string,
    draft: SubIssueDraft,
    clientKey: string
  ): Promise<TrackerIssue>;

  /** Move an issue to a provider state (write-back). */
  updateIssueState(externalId: string, stateId: string): Promise<void>;
}
