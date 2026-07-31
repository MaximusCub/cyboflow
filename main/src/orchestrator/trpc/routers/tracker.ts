/**
 * cyboflow.tracker sub-router — the Settings > Integrations surface for the
 * Linear/Plane sync feature. Design: docs/proposals/tracker-sync-integration.md.
 *
 *   wizardValidate / wizardContainers / wizardNarrows / wizardStates /
 *   wizardIssues                  : mutations    -> stateless provider probes (persist nothing)
 *   reconcilePreview              : mutation     -> TrackerReconcileItem[] (wizard Step 4)
 *   connect                       : mutation     -> { connectionId } (row + encrypted key + reconcile + first pass)
 *   connections                   : query        -> TrackerConnectionSummary[]
 *   updateSettings / disconnect   : mutations    -> void
 *   syncNow                       : mutation     -> TrackerSyncPassSummary ("Sync now")
 *   conflicts                     : query        -> TrackerConflictSummary[]
 *   resolveConflict               : mutation     -> void
 *   linkForEntity                 : query        -> TrackerEntityLinkRef | null
 *   onTrackerChanged              : subscription -> TrackerChangedEvent
 *
 * Every procedure is a THIN 1:1 wrapper over the TrackerSyncFacade wired at boot
 * (main/src/index.ts -> setTrackerSyncFacade). All behaviour — secret handling,
 * the entity-write chokepoint, conflict semantics, the poll loop — lives in the
 * service; this file validates input and maps failures onto TRPCError codes.
 *
 * SECRETS: `credentials` travels renderer -> main on the wizard/connect calls
 * and stops there (the service encrypts before sqlite). NOTHING this router
 * RETURNS carries key material — see shared/types/trackerSync.ts.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. That is exactly why the facade + its emitter live in
 * orchestrator/trackerSyncBridge.ts rather than being imported from the service,
 * and why the two service-side error classes are recognized BY NAME below
 * instead of by `instanceof`.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TaskChangeError } from '../../taskChangeRouter';
import {
  getTrackerSyncFacade,
  trackerProjectChannel,
  trackerSyncEvents,
  TrackerSyncNotInitializedError,
  type TrackerChangedEvent,
} from '../../trackerSyncBridge';
import type {
  TrackerConflictSummary,
  TrackerConnectionSummary,
  TrackerEntityLinkRef,
  TrackerIssue,
  TrackerReconcileItem,
  TrackerSourceNarrow,
  TrackerSourceTree,
  TrackerState,
  TrackerSyncPassSummary,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import { eventToAsyncIterable } from './events';

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Error-class recognition by NAME. The two classes that matter here
 * (TrackerAuthError, TrackerSecretsUnavailableError) live under
 * main/src/services/trackerSync/, which this file must not import — and both set
 * `this.name` in their constructor precisely so a consumer across a boundary can
 * branch on class without importing it.
 */
function isErrorNamed(err: unknown, name: string): boolean {
  return err instanceof Error && err.name === name;
}

/**
 * Map a tracker/chokepoint failure onto a TRPCError the renderer can branch on:
 *
 *   TrackerAuthError               -> UNAUTHORIZED       (the key is bad — re-connect)
 *   TrackerSecretsUnavailableError -> PRECONDITION_FAILED (no OS keychain on this host)
 *   TrackerSyncNotInitializedError -> PRECONDITION_FAILED (called before boot wired the facade)
 *   TaskChangeError                -> the chokepoint's own code map (mirrors tasks.ts)
 *
 * Anything else re-throws unchanged.
 */
function rethrowAsTRPCError(err: unknown): never {
  if (isErrorNamed(err, 'TrackerAuthError')) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      // Deliberately generic: the provider's own 401 body is not something to
      // paste into the wizard, and the actionable part is always the same.
      message: 'The tracker rejected these credentials. Check the API key and try again.',
      cause: err,
    });
  }
  if (isErrorNamed(err, 'TrackerSecretsUnavailableError')) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'This machine has no OS-level secret storage available, so the API key cannot be stored securely.',
      cause: err,
    });
  }
  if (err instanceof TrackerSyncNotInitializedError) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
  }
  if (err instanceof TaskChangeError) {
    const codeMap: Record<TaskChangeError['code'], TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_parent: 'BAD_REQUEST',
      invalid_lineage: 'BAD_REQUEST',
      forbidden_stage: 'FORBIDDEN',
      active_runs: 'CONFLICT',
      concurrency: 'CONFLICT',
      invalid_dependency: 'BAD_REQUEST',
      dependency_cycle: 'CONFLICT',
      idea_needs_epic: 'CONFLICT',
      experiment_sandboxed: 'CONFLICT',
      experiment_sweep_failed: 'INTERNAL_SERVER_ERROR',
    };
    throw new TRPCError({
      code: codeMap[err.code],
      message: `${err.code}: ${err.message}`,
      cause: err,
    });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Zod input schemas — the exact shapes in shared/types/trackerSync.ts
// ---------------------------------------------------------------------------

const providerSchema = z.enum(['linear', 'plane']);

/** Renderer -> main, wizard/connect only. This is the ONLY inbound key path. */
const credentialsSchema = z.object({
  provider: providerSchema,
  apiKey: z.string().min(1),
  /** Plane self-hosted origin; omitted = the provider's cloud default. */
  baseUrl: z.string().min(1).optional(),
  /** Plane only: the workspace slug all API paths are scoped under. */
  workspaceSlug: z.string().min(1).optional(),
});

const narrowKindSchema = z.enum(['all', 'project', 'view', 'cycle', 'module']);

const sourceSelectionSchema = z.object({
  containerId: z.string().min(1),
  narrowId: z.string().min(1),
  narrowKind: narrowKindSchema,
});

const mappingTargetSchema = z.enum(['dont', 'idea', 'ready', 'done', 'wontdo']);
/** Keyed by TRACKER state id, so the keys are provider-defined and unconstrained. */
const stateMappingSchema = z.record(z.string(), mappingTargetSchema);

const selectionModeSchema = z.enum(['all', 'assignee', 'manual']);
const conflictModeSchema = z.enum(['auto', 'manual']);

const selectionJsonSchema = z.object({
  assigneeIds: z.array(z.string()).optional(),
  issueIds: z.array(z.string()).optional(),
});

const userRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  initials: z.string(),
});

/**
 * A TrackerIssue coming back IN from the renderer (reconcilePreview replays the
 * set `wizardIssues` handed it). Validated in full rather than trusted: it is
 * renderer-supplied input like any other, even though main produced it.
 */
const issueSchema = z.object({
  externalId: z.string().min(1),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  stateId: z.string(),
  assignee: userRefSchema.nullable(),
  estimate: z.number().nullable(),
  parentExternalId: z.string().nullable(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

const reconcileDecisionSchema = z.object({
  entityType: z.enum(['idea', 'task']),
  entityId: z.string().min(1),
  action: z.enum(['keep', 'link', 'discard']),
  /** Required in practice for action 'link'; the service skips a link without it. */
  linkExternalId: z.string().min(1).optional(),
  linkIdentifier: z.string().min(1).optional(),
  linkUrl: z.string().min(1).optional(),
});

const entityTypeSchema = z.enum(['idea', 'epic', 'task']);

export const trackerRouter = router({
  // -------------------------------------------------------------------------
  // Wizard probes
  //
  // MUTATIONS, not queries, deliberately: each one carries an API key in its
  // input and performs a live network call, so it must never be cached, keyed,
  // or transparently re-fetched by the client.
  // -------------------------------------------------------------------------

  /** Step 0 — live credential probe backing the "Authorized as …" card. */
  wizardValidate: protectedProcedure
    .input(z.object({ credentials: credentialsSchema }))
    .mutation(async ({ input }): Promise<TrackerWorkspaceIdentity> => {
      try {
        return await getTrackerSyncFacade().wizardValidate(input.credentials);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Step 1, top level — Linear teams / Plane projects. */
  wizardContainers: protectedProcedure
    .input(z.object({ credentials: credentialsSchema }))
    .mutation(async ({ input }): Promise<TrackerSourceTree> => {
      try {
        return await getTrackerSyncFacade().wizardContainers(input.credentials);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Step 1, second level — the narrows under one container (always includes 'all'). */
  wizardNarrows: protectedProcedure
    .input(z.object({ credentials: credentialsSchema, containerId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<TrackerSourceNarrow[]> => {
      try {
        return await getTrackerSyncFacade().wizardNarrows(input.credentials, input.containerId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Step 3 — the source's states (with canonical groups) for the mapping table. */
  wizardStates: protectedProcedure
    .input(z.object({ credentials: credentialsSchema, selection: sourceSelectionSchema }))
    .mutation(async ({ input }): Promise<TrackerState[]> => {
      try {
        return await getTrackerSyncFacade().wizardStates(input.credentials, input.selection);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Step 2 — every issue in the chosen source (assignee/manual pickers + Reconcile). */
  wizardIssues: protectedProcedure
    .input(z.object({ credentials: credentialsSchema, selection: sourceSelectionSchema }))
    .mutation(async ({ input }): Promise<TrackerIssue[]> => {
      try {
        return await getTrackerSyncFacade().wizardIssues(input.credentials, input.selection);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Reconcile + connect
  // -------------------------------------------------------------------------

  /**
   * Step 4 — the project's pre-existing backlog items with a suggested issue
   * match each. A mutation rather than a query: the issue set is wizard-local
   * state (not a cache key), and re-running it on a client-side refetch would
   * be pure waste.
   */
  reconcilePreview: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        issues: z.array(issueSchema),
      }),
    )
    .mutation(async ({ input }): Promise<TrackerReconcileItem[]> => {
      try {
        return await getTrackerSyncFacade().reconcilePreview(input.projectId, input.issues);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Step 5 — persist the connection: the row + the encrypted key, the reconcile
   * decisions (link / discard), and a fire-and-forget first sync pass. Returns
   * as soon as the row is durable; the first pass reports through the
   * `onTrackerChanged` subscription.
   */
  connect: protectedProcedure
    .input(
      z.object({
        projectId: z.number().int().positive(),
        credentials: credentialsSchema,
        source: sourceSelectionSchema,
        sourceLabel: z.string(),
        selectionMode: selectionModeSchema,
        selectionJson: selectionJsonSchema.nullable(),
        stateMapping: stateMappingSchema,
        twoWay: z.boolean(),
        mirrorSubissues: z.boolean(),
        conflictMode: conflictModeSchema,
        reconcile: z.array(reconcileDecisionSchema),
      }),
    )
    .mutation(async ({ input }): Promise<{ connectionId: string }> => {
      try {
        return await getTrackerSyncFacade().connect(input);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Connected view
  // -------------------------------------------------------------------------

  /** The project's connections (disconnected ones are not listed). */
  connections: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .query(async ({ input }): Promise<TrackerConnectionSummary[]> => {
      try {
        return await getTrackerSyncFacade().connections(input.projectId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Patch the sync-settings card. Only the keys present are written; an unknown
   * connection id is an idempotent no-op.
   */
  updateSettings: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().min(1),
        twoWay: z.boolean().optional(),
        mirrorSubissues: z.boolean().optional(),
        conflictMode: conflictModeSchema.optional(),
        stateMapping: stateMappingSchema.optional(),
        selectionMode: selectionModeSchema.optional(),
        selectionJson: selectionJsonSchema.nullable().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      const { connectionId, ...patch } = input;
      try {
        await getTrackerSyncFacade().updateSettings(connectionId, patch);
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Retire a connection (status 'disconnected' + the stored key cleared). Links stay. */
  disconnect: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      try {
        await getTrackerSyncFacade().disconnect(input.connectionId);
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** The manual "Sync now" — a forced pass, which also sweeps for remote deletions. */
  syncNow: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .mutation(async ({ input }): Promise<TrackerSyncPassSummary> => {
      try {
        return await getTrackerSyncFacade().syncNow(input.connectionId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  /** The connection's OPEN conflicts (Manual mode's per-item queue). */
  conflicts: protectedProcedure
    .input(z.object({ connectionId: z.string().min(1) }))
    .query(async ({ input }): Promise<TrackerConflictSummary[]> => {
      try {
        return await getTrackerSyncFacade().conflicts(input.connectionId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /**
   * Resolve one conflict: 'remote' accepts the tracker's value (applied through
   * the entity chokepoint), 'local' keeps ours (and, for a stage conflict,
   * queues the write-back that converges the tracker onto it).
   */
  resolveConflict: protectedProcedure
    .input(
      z.object({
        conflictId: z.number().int().positive(),
        choice: z.enum(['local', 'remote']),
      }),
    )
    .mutation(async ({ input }): Promise<{ ok: true }> => {
      try {
        await getTrackerSyncFacade().resolveConflictChoice(input.conflictId, input.choice);
        return { ok: true };
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Entity link lookup
  // -------------------------------------------------------------------------

  /** An entity's live tracker link, or null when it is not synced (or orphaned). */
  linkForEntity: protectedProcedure
    .input(z.object({ entityType: entityTypeSchema, entityId: z.string().min(1) }))
    .query(async ({ input }): Promise<TrackerEntityLinkRef | null> => {
      try {
        return await getTrackerSyncFacade().linkForEntity(input.entityType, input.entityId);
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  // -------------------------------------------------------------------------
  // Subscription
  // -------------------------------------------------------------------------

  /**
   * Subscribe to this project's tracker changes.
   *
   * Bridges the module-level `trackerSyncEvents` emitter (exported from
   * trackerSyncBridge.ts, NOT from this file) on the project channel
   * `tracker-project-<projectId>`. The payload is a NOTIFICATION — the client
   * re-reads `connections` / `conflicts` off the `kind` rather than patching a
   * card from the event.
   *
   * No throttle: connection/sync/conflict changes are minutes apart at the
   * feature's fixed 5-minute cadence.
   */
  onTrackerChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<TrackerChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<TrackerChangedEvent>(
        trackerSyncEvents,
        trackerProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
