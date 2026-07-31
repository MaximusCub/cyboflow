/**
 * trackerSync/trackerSyncService — the ASSEMBLY layer for the tracker-sync
 * engine. Design: docs/proposals/tracker-sync-integration.md ("Sync engine" +
 * "Durability & failure semantics").
 *
 * Everything below this file is a pure, independently-testable piece: store.ts
 * owns the SQL, the adapters own the network, writeBack.ts turns entity events
 * into outbox rows, outboxWorker.ts drains them, inboundSync.ts pulls the
 * tracker's changes in. This file is the only thing that knows about TIME,
 * PROCESS LIFETIME and ORDER — it owns the poll loop, boot crash-recovery, the
 * provider-client construction (and therefore secret decryption), and the
 * per-connection sync log the connected view renders.
 *
 * ONE PASS, in this order (the order is load-bearing):
 *   1. processAmbiguous — reconcile writes whose outcome the last app lifetime
 *      never learned. MUST precede the drain: an un-reconciled create would
 *      otherwise be retried and duplicate a sub-issue.
 *   2. drainOutbox      — perform the queued remote writes. MUST precede
 *      inbound: every unresolved outbox row HALTS the inbound batch (echo
 *      suppression), so draining first is what lets the cursor move at all.
 *   3. runInboundSync   — pull remote changes in.
 *   4. runDeletionSweep — every SWEEP_EVERY_N_PASSES-th pass, and on every
 *      "Sync now". It costs a full remote id listing, so it is deliberately not
 *      per-pass.
 *
 * CADENCE. A 60s tick selects the connections whose `last_sync_at` is at least
 * SYNC_INTERVAL_MS old (or null). The tick is the cheap clock; the 5-minute
 * cadence is the connection's own state, so it survives a restart and a
 * mid-interval "Sync now" correctly re-bases the next poll. `last_sync_at` is
 * stamped even on a FAILED pass — otherwise a permanently-failing connection
 * would be retried every 60s instead of every 5 minutes.
 *
 * FAILURE POLICY. Nothing here throws out of the loop. A TrackerAuthError (or
 * an unusable stored key) pauses the connection — the key is bad, so retrying
 * on a timer is pure noise until the user re-connects. Everything else is
 * logged into the pass log and left active: the next tick retries, and the
 * outbox's own backoff handles per-write retry.
 *
 * WRITE-BACK LATENCY. The entity-event listener only ENQUEUES; without a nudge
 * the row would sit until the next 5-minute poll, which reads as "cyboflow
 * didn't update my tracker". So an event that leaves a pending row arms a 2s
 * debounced drain for that connection — a burst of stage moves collapses into
 * one drain, and the drain shares the per-connection lock with the full pass.
 *
 * THE UI FACADE. This class also implements {@link TrackerSyncFacade} — the
 * whole Settings > Integrations surface (wizard probes, connect, connected-view
 * reads, settings, disconnect, conflict resolution). It lives here rather than
 * in a second service because every one of those calls needs exactly what this
 * file already owns: the adapter factory (and therefore secret handling), the
 * per-connection pass, and the drain timers. Each mutation broadcasts a
 * {@link TrackerChangedEvent} on `trackerSyncEvents` so the connected view
 * re-reads; the emits are placed HERE, at the service seam, not inside the
 * engine halves — inboundSync/outboxWorker stay pure, per-connection functions
 * with no notion of a subscriber.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  EntityExternalLinkRow,
  TrackerConflictRow,
  TrackerConnectionRow,
} from '../../database/models';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';
import type {
  TrackerConflictChoice,
  TrackerConflictSummary,
  TrackerConnectPayload,
  TrackerConnectionSummary,
  TrackerCredentialsInput,
  TrackerEntityLinkRef,
  TrackerEntityType,
  TrackerIssue,
  TrackerProvider,
  TrackerReconcileItem,
  TrackerSettingsPatch,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerSyncLogEntry,
  TrackerSyncPassSummary,
  TrackerWorkspaceIdentity,
} from '../../../../shared/types/trackerSync';
import type { LoggerLike } from '../../orchestrator/types';
import { TASK_ALL_CHANNEL, taskChangeEvents } from '../../orchestrator/taskChangeRouter';
import {
  trackerProjectChannel,
  trackerSyncEvents,
  type TrackerChangedEvent,
  type TrackerSyncFacade,
} from '../../orchestrator/trackerSyncBridge';
import type { TrackerAdapter } from './adapterTypes';
import { TrackerAuthError } from './errors';
import { LinearAdapter } from './linearAdapter';
import { PlaneAdapter } from './planeAdapter';
import { decryptTrackerSecret, encryptTrackerSecret } from './secrets';
import {
  clearSecret,
  enqueueOutbox,
  getConflict,
  getConnection,
  getLinkByEntity,
  getLinkById,
  insertConnection,
  listConnections,
  listLinks,
  listOpenConflicts,
  listUnresolvedOutbox,
  markOrphaned,
  readSecret,
  requeueInFlightAsAmbiguous,
  resolveConflict,
  storeSecret,
  updateBaseline,
  updateConnectionSettings,
  upsertLink,
} from './store';
import {
  joinBody,
  runDeletionSweep,
  runInboundSync,
  splitBody,
  type EntityWriteRouter,
  type InboundSweepReport,
  type InboundSyncReport,
} from './inboundSync';
import { drainOutbox, processAmbiguous, toSqliteUtc, type OutboxDeps, type OutboxReport } from './outboxWorker';
import { resolveEffectiveMapping, resolveStageIds } from './stateMapping';
import {
  createWriteBackListener,
  parseJsonObject,
  readDesiredGroup,
  writeBackGroupForStage,
  type UpdateStatePayload,
  type WriteBackListener,
} from './writeBack';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** The proposal's fixed poll cadence: a connection syncs at most this often. */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** How often the loop LOOKS for due connections (cheap; the cadence above gates the work). */
export const TICK_INTERVAL_MS = 60 * 1000;

/** Collapse a burst of write-back-producing entity events into one drain. */
export const WRITE_BACK_DEBOUNCE_MS = 2 * 1000;

/**
 * Deletion-sweep cadence, in passes. 12 passes x 5 minutes = roughly hourly on
 * a connection polling continuously. The counter is IN-MEMORY (see
 * {@link TrackerSyncService.passCounts}) and starts at 0, so the first pass
 * after a boot always sweeps — the moment a remote hard-delete is most likely
 * to have been missed (the app was closed) — and every 12th pass thereafter.
 */
export const SWEEP_EVERY_N_PASSES = 12;

/** Cap on a connection's stored pass log, so debounced drains cannot grow it unbounded. */
const MAX_LOG_ENTRIES = 60;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One line of the connected view's sync log. PROMOTED to
 * shared/types/trackerSync.ts now that the connected view reads it over tRPC;
 * re-exported here so the engine-side call sites keep their local import.
 */
export type { TrackerSyncLogEntry };

/**
 * What one {@link TrackerSyncService.syncConnection} pass did. An ALIAS of the
 * wire shape rather than a twin declaration: "Sync now" hands this straight to
 * the renderer, and a second copy of the interface is exactly the drift the IPC
 * type-parity rules exist to prevent.
 */
export type TrackerSyncPassResult = TrackerSyncPassSummary;

/**
 * Build the provider client for a connection. `secret` is the DECRYPTED API
 * key — this factory is the only place it exists as a string outside
 * secrets.ts, and it never leaves the main process.
 */
export type TrackerAdapterFactory = (
  connection: TrackerConnectionRow,
  secret: string,
) => TrackerAdapter;

/**
 * The connection's stored credentials cannot produce a working client (no
 * ciphertext, an undecryptable blob, or a provider field the connect flow never
 * filled in). Treated exactly like a TrackerAuthError: pause, do not retry on a
 * timer.
 */
export class TrackerCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerCredentialsError';
  }
}

export interface TrackerSyncServiceDeps {
  /** Real better-sqlite3 handle; all tracker-table access goes through store.ts. */
  db: Database.Database;
  /**
   * The entity write chokepoint. Declared structurally (TaskChangeRouter
   * satisfies it) for the same reason inboundSync does: nothing here should be
   * tempted to reach past applyChange.
   */
  router: EntityWriteRouter;
  /** Injected clock (ISO-8601). Defaults to the real one. */
  nowIso?: () => string;
  /** Injected provider-client construction. Defaults to {@link defaultAdapterFactory}. */
  adapterFactory?: TrackerAdapterFactory;
  /** Optional structured logger for loop-level failures. */
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Default adapter construction
// ---------------------------------------------------------------------------

/**
 * Provider client from a connection row + its decrypted key.
 *
 * PLANE'S WORKSPACE SLUG comes from `workspace_id`, not `source_json`.
 * `source_json` holds the wizard's Step-1 source choice (container/narrow ids)
 * and nothing else; the slug is workspace IDENTITY, and PlaneAdapter's own
 * `validateCredentials` returns `workspaceId: <slug>` — so the connect flow
 * that persists the validated identity necessarily writes the slug into
 * `workspace_id`. A Plane connection without one cannot address any REST path,
 * hence the hard error rather than a guess.
 */
export function defaultAdapterFactory(
  connection: TrackerConnectionRow,
  secret: string,
): TrackerAdapter {
  if (connection.provider === 'linear') {
    return new LinearAdapter({ apiKey: secret });
  }
  const workspaceSlug = (connection.workspace_id ?? '').trim();
  if (workspaceSlug.length === 0) {
    throw new TrackerCredentialsError(
      `connection ${connection.id}: plane connections need a workspace slug in workspace_id`,
    );
  }
  return new PlaneAdapter({
    apiKey: secret,
    workspaceSlug,
    // undefined (not null) so PlaneAdapter's own `?? DEFAULT_BASE_URL` applies.
    baseUrl: connection.base_url ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TrackerSyncService implements TrackerSyncFacade {
  private readonly db: Database.Database;
  private readonly router: EntityWriteRouter;
  private readonly nowIso: () => string;
  private readonly adapterFactory: TrackerAdapterFactory;
  private readonly logger?: LoggerLike;

  private timer: ReturnType<typeof setInterval> | null = null;
  private listener: WriteBackListener | null = null;
  /** The bound emitter subscription, kept so stop() can remove exactly it. */
  private subscription: ((event: TaskChangedEvent) => void) | null = null;

  /**
   * Per-connection mutex. A second syncConnection while one is in flight
   * COALESCES onto the running pass rather than queueing a redundant one — a
   * "Sync now" during a poll should not double-poll, and two ticks can never
   * interleave two drains of the same outbox.
   */
  private readonly passes = new Map<string, Promise<TrackerSyncPassResult>>();

  /** Passes since boot, per connection — the deletion sweep's cadence counter. */
  private readonly passCounts = new Map<string, number>();

  /** Armed write-back debounce timers, per connection. */
  private readonly drainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: TrackerSyncServiceDeps) {
    this.db = deps.db;
    this.router = deps.router;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.adapterFactory = deps.adapterFactory ?? defaultAdapterFactory;
    this.logger = deps.logger;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Boot the loop (idempotent). Order matters: crash recovery runs BEFORE any
   * listener or timer, so no drain can start against a connection whose
   * `in_flight` rows have not yet been demoted to `ambiguous` — that demotion
   * is the only thing standing between a lost create response and a duplicate
   * sub-issue.
   */
  start(): void {
    if (this.timer !== null) return;

    this.recoverInFlightWrites();

    this.listener = createWriteBackListener({ db: this.db, nowIso: this.nowIso });
    this.subscription = (event: TaskChangedEvent): void => this.handleTaskChanged(event);
    taskChangeEvents.on(TASK_ALL_CHANNEL, this.subscription);

    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.logger?.error('[trackerSync] tick failed', { error: describeError(err) });
      });
    }, TICK_INTERVAL_MS);
    // Never keep the app alive for the poll timer.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * Stop the loop (idempotent). In-flight passes are NOT cancelled — each one
   * settles its own outbox rows, and abandoning a pass mid-drain is exactly the
   * crash the ambiguous-recovery path exists to clean up. Quitting mid-pass is
   * therefore safe, just not free.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
    if (this.subscription !== null) {
      taskChangeEvents.off(TASK_ALL_CHANNEL, this.subscription);
      this.subscription = null;
    }
    this.listener?.dispose();
    this.listener = null;
  }

  /**
   * Boot crash recovery: every `in_flight` outbox row belongs to a write whose
   * outcome the last app lifetime never learned, so it becomes `ambiguous` and
   * the next pass reconciles it before retrying anything. Fail-soft per
   * connection — one unreadable connection must not strand the others.
   */
  private recoverInFlightWrites(): void {
    let connections: TrackerConnectionRow[];
    try {
      connections = listConnections(this.db);
    } catch (err) {
      this.logger?.error('[trackerSync] boot recovery: listing connections failed', {
        error: describeError(err),
      });
      return;
    }
    for (const connection of connections) {
      if (connection.status !== 'active') continue;
      try {
        const requeued = requeueInFlightAsAmbiguous(this.db, connection.id);
        if (requeued > 0) {
          this.logger?.warn('[trackerSync] boot recovery: requeued in-flight writes as ambiguous', {
            connectionId: connection.id,
            requeued,
          });
        }
      } catch (err) {
        this.logger?.error('[trackerSync] boot recovery failed for a connection', {
          connectionId: connection.id,
          error: describeError(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  /**
   * Run every DUE connection, one at a time. Exposed (rather than living inside
   * the interval callback) so tests drive the loop directly instead of waiting
   * on wall-clock timers — the interval is a thin caller of this.
   *
   * Sequential by design: two connections syncing at once would double the
   * concurrent API pressure for no latency the user can perceive on a 5-minute
   * cadence.
   */
  async tick(): Promise<void> {
    let connections: TrackerConnectionRow[];
    try {
      connections = listConnections(this.db);
    } catch (err) {
      this.logger?.error('[trackerSync] tick: listing connections failed', {
        error: describeError(err),
      });
      return;
    }
    for (const connection of connections) {
      if (connection.status !== 'active') continue;
      if (!this.isDue(connection)) continue;
      await this.syncConnection(connection.id);
    }
  }

  /** A connection is due when it has never synced, or its last pass is a full interval old. */
  private isDue(connection: TrackerConnectionRow): boolean {
    const last = parseTimestamp(connection.last_sync_at);
    if (last === null) return true;
    const now = parseTimestamp(this.nowIso()) ?? Date.now();
    return now - last >= SYNC_INTERVAL_MS;
  }

  /**
   * Run ONE pass for one connection. See the file header for the phase order
   * and the failure policy. Never rejects: every failure is folded into the
   * returned result and the persisted log.
   */
  syncConnection(connectionId: string, opts: { force?: boolean } = {}): Promise<TrackerSyncPassResult> {
    return this.lock(connectionId, () => this.runPass(connectionId, opts.force === true));
  }

  /** The manual "Sync now" — a forced pass, which also always sweeps for deletions. */
  syncNow(connectionId: string): Promise<TrackerSyncPassResult> {
    return this.syncConnection(connectionId, { force: true });
  }

  /**
   * Per-connection mutex. Returns the IN-FLIGHT pass when one exists so
   * concurrent callers coalesce onto a single run instead of serializing two.
   */
  private lock(
    connectionId: string,
    run: () => Promise<TrackerSyncPassResult>,
  ): Promise<TrackerSyncPassResult> {
    const inFlight = this.passes.get(connectionId);
    if (inFlight !== undefined) return inFlight;
    const started = (async (): Promise<TrackerSyncPassResult> => {
      try {
        return await run();
      } finally {
        this.passes.delete(connectionId);
      }
    })();
    this.passes.set(connectionId, started);
    return started;
  }

  private async runPass(connectionId: string, force: boolean): Promise<TrackerSyncPassResult> {
    const entries: TrackerSyncLogEntry[] = [];
    const connection = getConnection(this.db, connectionId);
    if (connection === null) {
      return {
        connectionId,
        ran: false,
        swept: false,
        paused: false,
        entries,
        error: 'connection not found',
      };
    }

    // Counted BEFORE the work so a failing pass still advances the sweep clock.
    const passIndex = this.passCounts.get(connectionId) ?? 0;
    this.passCounts.set(connectionId, passIndex + 1);
    const sweepDue = force || passIndex % SWEEP_EVERY_N_PASSES === 0;

    let paused = false;
    let swept = false;
    let error: string | null = null;
    /** Conflicts opened/auto-resolved this pass — drives the 'conflicts' broadcast. */
    let conflictsTouched = 0;

    try {
      const adapter = this.buildAdapter(connection);
      paused = await this.runWriteBack(connection, adapter, entries);

      if (!paused) {
        entries.push({ marker: '▸', line: 'GET issues' });
        const inbound = await runInboundSync(
          { db: this.db, adapter, router: this.router, nowIso: this.nowIso },
          connection,
        );
        appendInboundLines(entries, inbound);
        conflictsTouched += inbound.conflictsOpened + inbound.autoResolved;

        if (sweepDue) {
          entries.push({ marker: '▸', line: 'GET issue ids' });
          const sweep = await runDeletionSweep(
            { db: this.db, adapter, router: this.router, nowIso: this.nowIso },
            connection,
          );
          swept = true;
          appendSweepLines(entries, sweep);
          conflictsTouched += sweep.conflictsOpened + sweep.sweepArchived;
        }
      }
    } catch (err) {
      error = describeError(err);
      if (isCredentialFailure(err)) {
        updateConnectionSettings(this.db, connection.id, { status: 'paused' });
        paused = true;
        entries.push({ marker: '⚠', line: `authorization failed · ${error}` });
        // The connection ROW changed (active -> paused), which the connected
        // view renders as a re-connect prompt — a separate signal from the
        // 'sync' broadcast below.
        this.emitTrackerChange(connection.project_id, connection.id, 'connection');
      } else {
        entries.push({ marker: '⚠', line: `sync failed · ${error}` });
        this.logger?.error('[trackerSync] pass failed', { connectionId, error });
      }
    }

    entries.push(
      paused
        ? { marker: '⚠', line: 'connection paused — reconnect to resume' }
        : { marker: '✓', line: `sync complete · next in ${SYNC_INTERVAL_MS / 60_000}m` },
    );

    // `last_sync_at` is stamped on FAILED passes too: it is the poll clock, not
    // a success marker, and leaving it null would retry a broken connection
    // every tick instead of every interval.
    this.persistLog(connection.id, entries, { stampSyncedAt: true });
    this.emitTrackerChange(connection.project_id, connection.id, 'sync');
    if (conflictsTouched > 0) {
      this.emitTrackerChange(connection.project_id, connection.id, 'conflicts');
    }

    return { connectionId, ran: true, swept, paused, entries, error };
  }

  /**
   * Phases 1+2 — reconcile ambiguous writes, then drain the queue. Returns true
   * when the connection ended up paused (the worker pauses it itself on an auth
   * failure; the pass then skips inbound rather than repeating the failure).
   */
  private async runWriteBack(
    connection: TrackerConnectionRow,
    adapter: TrackerAdapter,
    entries: TrackerSyncLogEntry[],
  ): Promise<boolean> {
    const deps: OutboxDeps = { db: this.db, adapterFor: () => adapter, nowIso: this.nowIso };
    const ambiguous = await processAmbiguous(deps, connection);
    const drained = ambiguous.authPaused ? null : await drainOutbox(deps, connection);
    appendWriteBackLines(entries, ambiguous, drained);
    return ambiguous.authPaused || drained?.authPaused === true;
  }

  // -------------------------------------------------------------------------
  // Write-back nudge
  // -------------------------------------------------------------------------

  /**
   * Entity-event handler. The listener does the translation (and never throws —
   * this runs inline on TaskChangeRouter's post-commit emit); we only add the
   * latency nudge on top.
   */
  private handleTaskChanged(event: TaskChangedEvent): void {
    this.listener?.handleTaskChanged(event);
    this.scheduleWriteBackDrain(event.projectId);
  }

  /**
   * Arm the debounced drain for every connection in the event's project that
   * now has a pending outbox row. Checking for a pending row (rather than
   * arming blindly) keeps the common case — an entity that is not linked to any
   * tracker — down to one cheap query and no timer.
   */
  private scheduleWriteBackDrain(projectId: number): void {
    try {
      for (const connection of listConnections(this.db, projectId)) {
        if (connection.status !== 'active' || connection.two_way !== 1) continue;
        const pending = listUnresolvedOutbox(this.db, connection.id).some(
          (row) => row.state === 'pending',
        );
        if (!pending) continue;
        this.armDrainTimer(connection.id);
      }
    } catch (err) {
      // Same reasoning as the listener's own swallow: this runs inline on an
      // entity write, so a sync-side failure must never break the backlog write.
      this.logger?.error('[trackerSync] scheduling write-back drain failed', {
        projectId,
        error: describeError(err),
      });
    }
  }

  private armDrainTimer(connectionId: string): void {
    const existing = this.drainTimers.get(connectionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.drainTimers.delete(connectionId);
      // A full pass is already running. Coalescing onto it would be WRONG here:
      // that pass may have drained before this row was enqueued, which would
      // silently defer the write-back to the next 5-minute tick. Re-arm instead
      // — the row is durable, so waiting another debounce costs nothing.
      if (this.passes.has(connectionId)) {
        this.armDrainTimer(connectionId);
        return;
      }
      void this.drainConnection(connectionId).catch((err: unknown) => {
        this.logger?.error('[trackerSync] debounced write-back drain failed', {
          connectionId,
          error: describeError(err),
        });
      });
    }, WRITE_BACK_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.drainTimers.set(connectionId, timer);
  }

  /**
   * Write-back-only pass: reconcile + drain, no inbound fetch and no sweep.
   * Shares the per-connection lock so it can never interleave with a full pass
   * (the debounce timer re-arms rather than coalescing — see
   * {@link armDrainTimer}), and APPENDS its lines to the stored log without
   * touching `last_sync_at` — the 5-minute inbound cadence is unaffected by how
   * often the user moves cards.
   */
  async drainConnection(connectionId: string): Promise<TrackerSyncPassResult> {
    return this.lock(connectionId, async () => {
      const entries: TrackerSyncLogEntry[] = [];
      const connection = getConnection(this.db, connectionId);
      if (connection === null) {
        return {
          connectionId,
          ran: false,
          swept: false,
          paused: false,
          entries,
          error: 'connection not found',
        };
      }

      let paused = false;
      let error: string | null = null;
      try {
        const adapter = this.buildAdapter(connection);
        paused = await this.runWriteBack(connection, adapter, entries);
      } catch (err) {
        error = describeError(err);
        if (isCredentialFailure(err)) {
          updateConnectionSettings(this.db, connection.id, { status: 'paused' });
          paused = true;
          entries.push({ marker: '⚠', line: `authorization failed · ${error}` });
          this.emitTrackerChange(connection.project_id, connection.id, 'connection');
        } else {
          entries.push({ marker: '⚠', line: `write-back failed · ${error}` });
          this.logger?.error('[trackerSync] write-back drain failed', { connectionId, error });
        }
      }

      // A drain that had nothing to say leaves the last pass's log alone.
      if (entries.length > 0) {
        this.persistLog(connection.id, entries, { stampSyncedAt: false });
        this.emitTrackerChange(connection.project_id, connection.id, 'sync');
      }
      return { connectionId, ran: true, swept: false, paused, entries, error };
    });
  }

  // -------------------------------------------------------------------------
  // Adapters + log persistence
  // -------------------------------------------------------------------------

  /**
   * Build this pass's provider client. ONE per pass, shared by the write-back
   * and inbound halves: the adapters carry per-instance caches (Plane's project
   * identifier lookup) that a per-phase rebuild would throw away, and building
   * fresh each pass keeps a re-connected key from being pinned by a stale
   * instance.
   */
  private buildAdapter(connection: TrackerConnectionRow): TrackerAdapter {
    const cipher = readSecret(this.db, connection.id);
    if (cipher === null || cipher.length === 0) {
      throw new TrackerCredentialsError(`connection ${connection.id} has no stored API key`);
    }
    let secret: string;
    try {
      secret = decryptTrackerSecret(cipher);
    } catch (err) {
      throw new TrackerCredentialsError(
        `connection ${connection.id}: stored API key could not be decrypted · ${describeError(err)}`,
      );
    }
    return this.adapterFactory(connection, secret);
  }

  /**
   * Persist a pass log. A full pass REPLACES the log (it is the narrative of
   * that pass); a debounced drain APPENDS to it, capped at MAX_LOG_ENTRIES so
   * a busy hour of card moves cannot grow the blob without bound.
   */
  private persistLog(
    connectionId: string,
    entries: TrackerSyncLogEntry[],
    opts: { stampSyncedAt: boolean },
  ): void {
    const composed = opts.stampSyncedAt
      ? entries
      : readStoredLog(this.db, connectionId).concat(entries).slice(-MAX_LOG_ENTRIES);
    updateConnectionSettings(this.db, connectionId, {
      ...(opts.stampSyncedAt ? { last_sync_at: toSqliteUtc(this.nowIso()) } : {}),
      last_sync_log_json: JSON.stringify(composed),
    });
  }

  /** Broadcast one connection change on its project channel (see trackerSyncBridge). */
  private emitTrackerChange(
    projectId: number,
    connectionId: string,
    kind: TrackerChangedEvent['kind'],
  ): void {
    const event: TrackerChangedEvent = { projectId, connectionId, kind };
    trackerSyncEvents.emit(trackerProjectChannel(projectId), event);
  }

  // =========================================================================
  // TrackerSyncFacade — the Settings > Integrations surface
  // =========================================================================

  // -------------------------------------------------------------------------
  // Wizard probes (stateless — NOTHING is persisted)
  // -------------------------------------------------------------------------

  /**
   * Build a THROWAWAY provider client from renderer-supplied credentials.
   *
   * The row handed to the factory is a VALUE OBJECT, never inserted: it exists
   * only so the wizard reuses the exact construction path the sync loop uses
   * (including the INJECTED `adapterFactory`, so a test drives the wizard
   * through the same fake adapter). The plaintext key lives for the duration of
   * the call and is written nowhere — `connect` is the only method that
   * persists one, and it encrypts first.
   *
   * `workspace_id` carries Plane's workspace SLUG (what defaultAdapterFactory
   * addresses every REST path with); Linear ignores it.
   */
  private adapterForCredentials(credentials: TrackerCredentialsInput): TrackerAdapter {
    const scratch: TrackerConnectionRow = {
      id: `wizard-${credentials.provider}`,
      project_id: 0,
      provider: credentials.provider,
      status: 'active',
      workspace_id: credentials.workspaceSlug ?? null,
      workspace_name: null,
      actor_label: null,
      base_url: credentials.baseUrl ?? null,
      secret_ciphertext: null,
      source_json: null,
      selection_mode: 'all',
      selection_json: null,
      state_mapping_json: '{}',
      two_way: 0,
      mirror_subissues: 0,
      conflict_mode: 'auto',
      cursor_updated_at: null,
      cursor_external_id: null,
      last_sync_at: null,
      last_sync_log_json: null,
      created_at: '',
      updated_at: '',
    };
    return this.adapterFactory(scratch, credentials.apiKey);
  }

  /** Live credential probe — the wizard's "Authorized as …" card. */
  async wizardValidate(credentials: TrackerCredentialsInput): Promise<TrackerWorkspaceIdentity> {
    return this.adapterForCredentials(credentials).validateCredentials();
  }

  /** Wizard Step 1, top level (Linear teams / Plane projects). */
  async wizardContainers(credentials: TrackerCredentialsInput): Promise<TrackerSourceTree> {
    return this.adapterForCredentials(credentials).listContainers();
  }

  /** Wizard Step 1, second level for one container. */
  async wizardNarrows(
    credentials: TrackerCredentialsInput,
    containerId: string,
  ): Promise<TrackerSourceNarrow[]> {
    return this.adapterForCredentials(credentials).listNarrows(containerId);
  }

  /** Wizard Step 3 — the source's states, with canonical groups for the mapping table. */
  async wizardStates(
    credentials: TrackerCredentialsInput,
    selection: TrackerSourceSelection,
  ): Promise<TrackerState[]> {
    return this.adapterForCredentials(credentials).listStates(selection);
  }

  /**
   * Wizard Step 2 — every issue in the chosen source (no `since` bound: the
   * wizard's pickers and the Reconcile suggestions need the full set, not an
   * incremental slice).
   */
  async wizardIssues(
    credentials: TrackerCredentialsInput,
    selection: TrackerSourceSelection,
  ): Promise<TrackerIssue[]> {
    return this.adapterForCredentials(credentials).listIssues(selection);
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  /**
   * The wizard's Reconcile rows: the project's ACTIVE ideas + tasks, each with
   * a suggested issue match (or null).
   *
   * "Active" = not archived, not on a terminal stage (Done / Won't do), not a
   * retired (decomposed) idea, not an A/B experiment sandbox row, and not
   * already linked to a tracker issue — a row the user has nothing left to
   * decide about is noise in a six-step wizard.
   *
   * MATCH RULE (deliberately simple + deterministic, no fuzzy scoring library):
   * both titles are normalized (lowercased, every non-alphanumeric run collapsed
   * to a single space, trimmed), then a pair matches when EITHER
   *   - one normalized title CONTAINS the other, or
   *   - their word sets overlap by >= 75% (|A n B| / |A u B|).
   * The best-scoring issue wins; ties break on the lower externalId so the same
   * inputs always produce the same suggestion.
   */
  async reconcilePreview(
    projectId: number,
    issues: TrackerIssue[],
  ): Promise<TrackerReconcileItem[]> {
    const candidates = listReconcileCandidates(this.db, projectId);
    const normalizedIssues = issues.map((issue) => ({
      externalId: issue.externalId,
      normalized: normalizeTitle(issue.title),
    }));
    return candidates.map((row) => ({
      entityType: row.type,
      entityId: row.id,
      ref: row.ref,
      title: row.title,
      suggestedExternalId: suggestMatch(row.title, normalizedIssues),
    }));
  }

  // -------------------------------------------------------------------------
  // Connect / settings / disconnect
  // -------------------------------------------------------------------------

  /**
   * Persist a connection from the wizard's Review step and start syncing it.
   *
   * ORDER IS DELIBERATE:
   *   1. Probe the key live. The wizard validated it in Step 0, but the row's
   *      identity columns — and Plane's addressing slug — come from the LIVE
   *      identity, not from anything the renderer typed.
   *   2. Encrypt the key (a safeStorage failure must not leave a half-built
   *      connection behind).
   *   3. Apply the DISCARD decisions, which touch no tracker table: doing them
   *      before anything is persisted means a rejected archive (an active run on
   *      a task) aborts the whole connect with nothing written.
   *   4. Insert the row + secret, then the LINK decisions (fail-soft per link —
   *      one colliding external id must not sink an otherwise-good connection).
   *   5. Kick the first pass fire-and-forget: the wizard closes on the mutation's
   *      return, and the first pass is a full network round-trip.
   */
  async connect(payload: TrackerConnectPayload): Promise<{ connectionId: string }> {
    const identity = await this.adapterForCredentials(payload.credentials).validateCredentials();
    const cipher = encryptTrackerSecret(payload.credentials.apiKey);

    for (const decision of payload.reconcile) {
      if (decision.action !== 'discard') continue;
      await this.router.applyChange(payload.projectId, {
        actor: 'user',
        entityType: decision.entityType,
        taskId: decision.entityId,
        archived: true,
      });
    }

    const connectionId = `trk_${randomUUID()}`;
    insertConnection(this.db, {
      id: connectionId,
      project_id: payload.projectId,
      provider: payload.credentials.provider,
      status: 'active',
      workspace_id: identity.workspaceId,
      workspace_name: identity.workspaceName,
      actor_label: identity.actorLabel,
      base_url: payload.credentials.baseUrl ?? null,
      // Written by storeSecret below, never inline — the plaintext-never-touches
      // -sqlite invariant lives in exactly one call site.
      secret_ciphertext: null,
      // The Step-1 choice PLUS its display label. The label is an extra key on
      // the same blob rather than a column of its own: parseSourceSelection
      // reads containerId/narrowId/narrowKind by name and ignores everything
      // else, so the two coexist without a migration.
      source_json: JSON.stringify({ ...payload.source, label: payload.sourceLabel }),
      selection_mode: payload.selectionMode,
      selection_json:
        payload.selectionJson === null ? null : JSON.stringify(payload.selectionJson),
      state_mapping_json: JSON.stringify(payload.stateMapping),
      two_way: payload.twoWay ? 1 : 0,
      mirror_subissues: payload.mirrorSubissues ? 1 : 0,
      conflict_mode: payload.conflictMode,
      cursor_updated_at: null,
      cursor_external_id: null,
      last_sync_at: null,
      last_sync_log_json: null,
    });
    storeSecret(this.db, connectionId, cipher);

    for (const decision of payload.reconcile) {
      if (decision.action !== 'link') continue;
      const externalId = decision.linkExternalId;
      if (externalId === undefined || externalId.length === 0) continue;
      try {
        upsertLink(this.db, {
          connection_id: connectionId,
          entity_type: decision.entityType,
          entity_id: decision.entityId,
          provider: payload.credentials.provider,
          external_id: externalId,
          // BASELINE LEFT NULL on purpose: we hold no remote snapshot here, and
          // inbound's first pass ADOPTS the issue's current snapshot for a
          // baseline-less link and applies nothing (applyIssue) — the least
          // destructive way to become mergeable from the next change on.
          // The ref chip fields DO land now: the wizard carries the issue's
          // identifier + url on the decision, since nothing back-fills them later.
          external_identifier: decision.linkIdentifier ?? null,
          external_url: decision.linkUrl ?? null,
          baseline_json: null,
        });
      } catch (err) {
        this.logger?.error('[trackerSync] reconcile link failed', {
          connectionId,
          entityId: decision.entityId,
          error: describeError(err),
        });
      }
    }

    this.emitTrackerChange(payload.projectId, connectionId, 'connection');

    void this.syncNow(connectionId).catch((err: unknown) => {
      this.logger?.error('[trackerSync] initial sync after connect failed', {
        connectionId,
        error: describeError(err),
      });
    });

    return { connectionId };
  }

  /** The project's connected-view cards (disconnected connections are not listed). */
  async connections(projectId: number): Promise<TrackerConnectionSummary[]> {
    return listConnections(this.db, projectId).map((row) => this.summarizeConnection(row));
  }

  /** Project one connection row onto its renderer-visible summary (never the key). */
  private summarizeConnection(row: TrackerConnectionRow): TrackerConnectionSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      provider: row.provider,
      status: row.status,
      workspaceName: row.workspace_name ?? '',
      actorLabel: row.actor_label ?? '',
      baseUrl: row.base_url,
      sourceLabel: readSourceLabel(row),
      selectionMode: row.selection_mode,
      twoWay: row.two_way === 1,
      mirrorSubissues: row.mirror_subissues === 1,
      conflictMode: row.conflict_mode,
      // resolveEffectiveMapping over an EMPTY state list is exactly "the stored
      // overlay, filtered to valid targets" — the defensive parse we want, with
      // no network round-trip for the provider's live state list.
      stateMapping: resolveEffectiveMapping([], row.state_mapping_json),
      lastSyncAt: row.last_sync_at,
      lastSyncLog: parseLogEntries(row.last_sync_log_json),
      linkedCount: listLinks(this.db, row.id, { activeOnly: true }).length,
      openConflictCount: listOpenConflicts(this.db, row.id).length,
    };
  }

  /**
   * Patch the connected view's editable settings. Only the keys present on
   * `patch` are written (mirroring the store's own patch semantics); an unknown
   * connection id is an idempotent no-op.
   */
  async updateSettings(connectionId: string, patch: TrackerSettingsPatch): Promise<void> {
    const connection = getConnection(this.db, connectionId);
    if (connection === null) return;
    updateConnectionSettings(this.db, connectionId, {
      ...(patch.twoWay !== undefined ? { two_way: patch.twoWay ? 1 : 0 } : {}),
      ...(patch.mirrorSubissues !== undefined
        ? { mirror_subissues: patch.mirrorSubissues ? 1 : 0 }
        : {}),
      ...(patch.conflictMode !== undefined ? { conflict_mode: patch.conflictMode } : {}),
      ...(patch.stateMapping !== undefined
        ? { state_mapping_json: JSON.stringify(patch.stateMapping) }
        : {}),
      ...(patch.selectionMode !== undefined ? { selection_mode: patch.selectionMode } : {}),
      ...(patch.selectionJson !== undefined
        ? {
            selection_json:
              patch.selectionJson === null ? null : JSON.stringify(patch.selectionJson),
          }
        : {}),
    });
    this.emitTrackerChange(connection.project_id, connectionId, 'connection');
  }

  /**
   * Retire a connection: `status = 'disconnected'` and the stored ciphertext
   * cleared. The row and its LINKS stay — they are the history of what synced —
   * but nothing can sync again without a fresh key.
   *
   * The armed write-back drain is disarmed as part of this: it would otherwise
   * fire two seconds later, find no stored key, and PAUSE the connection —
   * flipping the row straight back off 'disconnected'.
   */
  async disconnect(connectionId: string): Promise<void> {
    const connection = getConnection(this.db, connectionId);
    if (connection === null) return;
    updateConnectionSettings(this.db, connectionId, { status: 'disconnected' });
    clearSecret(this.db, connectionId);
    const timer = this.drainTimers.get(connectionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.drainTimers.delete(connectionId);
    }
    this.emitTrackerChange(connection.project_id, connectionId, 'connection');
  }

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  /**
   * The connection's OPEN conflicts, each carrying the linked entity's ref +
   * title where they can still be resolved (a conflict outlives its link — the
   * `link_id` FK is ON DELETE SET NULL — and can outlive the entity too).
   */
  async conflicts(connectionId: string): Promise<TrackerConflictSummary[]> {
    const links = new Map(listLinks(this.db, connectionId).map((link) => [link.id, link]));
    return listOpenConflicts(this.db, connectionId).map((row) => {
      const link = row.link_id === null ? undefined : links.get(row.link_id);
      const entity =
        link === undefined ? null : readEntityIdentity(this.db, link.entity_type, link.entity_id);
      return {
        id: row.id,
        connectionId: row.connection_id,
        kind: row.kind,
        field: row.field,
        localValue: row.local_value,
        remoteValue: row.remote_value,
        entityRef: entity?.ref ?? null,
        entityTitle: entity?.title ?? null,
        createdAt: row.created_at,
      };
    });
  }

  /**
   * Resolve ONE open conflict the user's way. An unknown, already-resolved, or
   * orphan-connection conflict id is an idempotent no-op (the list the user
   * clicked may be a few seconds stale).
   *
   * Every branch ends with a resolved row, so the next inbound pass stops
   * skipping the item (hasOpenConflictForLink) and it starts flowing again.
   */
  async resolveConflictChoice(
    conflictId: number,
    choice: TrackerConflictChoice,
  ): Promise<void> {
    const conflict = getConflict(this.db, conflictId);
    if (conflict === null || conflict.state !== 'open') return;
    const connection = getConnection(this.db, conflict.connection_id);
    if (connection === null) return;
    const link = conflict.link_id === null ? null : getLinkById(this.db, conflict.link_id);

    if (conflict.kind === 'remote_deleted') {
      await this.resolveRemoteDeleted(connection, conflict, link, choice);
    } else {
      await this.resolveFieldConflict(connection, conflict, link, choice);
    }
    this.emitTrackerChange(connection.project_id, connection.id, 'conflicts');
  }

  /**
   * The remote issue is gone. 'remote' accepts that: archive the entity IN
   * PLACE (we never hard-delete locally) and orphan the link. 'local' keeps the
   * entity and STILL orphans the link — there is no issue left to sync it
   * against, and an un-orphaned link would have the deletion sweep re-open the
   * same conflict on its next run.
   */
  private async resolveRemoteDeleted(
    connection: TrackerConnectionRow,
    conflict: TrackerConflictRow,
    link: EntityExternalLinkRow | null,
    choice: TrackerConflictChoice,
  ): Promise<void> {
    if (choice === 'remote' && link !== null) {
      await this.router.applyChange(connection.project_id, {
        actor: connection.provider,
        entityType: link.entity_type,
        taskId: link.entity_id,
        archived: true,
      });
    }
    if (link !== null) markOrphaned(this.db, link.id);
    resolveConflict(this.db, conflict.id, choice === 'remote' ? 'manual-remote' : 'manual-local');
  }

  /**
   * A three-way field conflict the Manual mode parked. 'remote' applies the
   * stored `remote_value` to the entity; 'local' leaves the entity alone and —
   * for a STAGE conflict only — queues the write-back that makes the tracker
   * converge onto our stage. Title/description have no outbound path in v1 (the
   * adapter seam writes state, not content), so accepting the local side of one
   * is purely a "stop asking me" ruling.
   */
  private async resolveFieldConflict(
    connection: TrackerConnectionRow,
    conflict: TrackerConflictRow,
    link: EntityExternalLinkRow | null,
    choice: TrackerConflictChoice,
  ): Promise<void> {
    if (choice === 'remote') {
      if (link !== null) await this.applyRemoteFieldValue(connection, conflict, link);
      resolveConflict(this.db, conflict.id, 'manual-remote');
      return;
    }
    if (conflict.field === 'stage' && link !== null) {
      this.enqueueStageWriteBack(connection, link, conflict.local_value);
    }
    resolveConflict(this.db, conflict.id, 'manual-local');
  }

  /** Write one conflict's `remote_value` onto the linked entity, per field. */
  private async applyRemoteFieldValue(
    connection: TrackerConnectionRow,
    conflict: TrackerConflictRow,
    link: EntityExternalLinkRow,
  ): Promise<void> {
    const remote = conflict.remote_value;
    // actor = the provider: this IS the tracker's value landing locally, and the
    // entity_events row should read that way whoever clicked the button.
    const base = {
      actor: connection.provider,
      entityType: link.entity_type,
      taskId: link.entity_id,
    } as const;

    if (conflict.field === 'stage') {
      // `remote_value` on a stage conflict is the MAPPED board stage id, not the
      // tracker's state id — so there is nothing to stamp back into the
      // baseline's `stateId` here. Harmless: the entity now agrees with the
      // remote, so the next pass's three-way merge sees no divergence and
      // refreshes the whole baseline itself.
      if (remote === null) return;
      await this.router.applyChange(connection.project_id, { ...base, stageId: remote });
      return;
    }

    if (conflict.field === 'title') {
      if (remote === null) return;
      await this.router.applyChange(connection.project_id, { ...base, fields: { title: remote } });
      this.stampBaseline(link, { title: remote });
      return;
    }

    if (conflict.field === 'description') {
      // Only the remote-owned HALF of the body is replaced — the cyboflow-owned
      // provenance footer is split off and re-joined, exactly as an inbound
      // description apply would do it.
      const entity = readEntityIdentity(this.db, link.entity_type, link.entity_id);
      const { footer } = splitBody(entity?.body ?? null);
      await this.router.applyChange(connection.project_id, {
        ...base,
        fields: { body: joinBody(remote, footer) },
      });
      this.stampBaseline(link, { description: remote });
    }
  }

  /**
   * Merge `patch` into a link's `baseline_json` without disturbing the other
   * half's keys (the outbound worker stamps its own `lastWrittenGroup` /
   * `lastWrittenAt` onto the same blob).
   */
  private stampBaseline(link: EntityExternalLinkRow, patch: Record<string, unknown>): void {
    updateBaseline(
      this.db,
      link.id,
      JSON.stringify({ ...parseJsonObject(link.baseline_json), ...patch }),
    );
  }

  /**
   * Queue the state write that makes the tracker converge onto our stage after
   * the user accepts the LOCAL side of a stage conflict. Mirrors writeBack's own
   * enqueue guard (same-intent unresolved rows dedupe), and no-ops when the
   * connection is one-way or the stage has no outbound meaning — Idea and Ready
   * for development deliberately write nothing.
   */
  private enqueueStageWriteBack(
    connection: TrackerConnectionRow,
    link: EntityExternalLinkRow,
    stageId: string | null,
  ): void {
    if (stageId === null || connection.two_way !== 1) return;
    const group = writeBackGroupForStage(stageId, resolveStageIds(this.db, connection.project_id));
    if (group === null) return;
    const duplicate = listUnresolvedOutbox(this.db, connection.id).some(
      (row) =>
        row.external_id === link.external_id &&
        (row.kind === 'update_state' || row.kind === 'close_parent') &&
        readDesiredGroup(row.payload_json) === group,
    );
    if (duplicate) return;
    const payload: UpdateStatePayload = { desiredGroup: group };
    enqueueOutbox(this.db, {
      connection_id: connection.id,
      kind: 'update_state',
      entity_type: link.entity_type,
      entity_id: link.entity_id,
      external_id: link.external_id,
      payload_json: JSON.stringify(payload),
    });
  }

  // -------------------------------------------------------------------------
  // Entity link lookup
  // -------------------------------------------------------------------------

  /**
   * The live tracker link for one entity, or null when it is not synced.
   * ORPHANED links read back as null: they point at an issue the remote no
   * longer has, so an "open in Linear" affordance built on one would be a dead
   * end.
   */
  async linkForEntity(
    entityType: TrackerEntityType,
    entityId: string,
  ): Promise<TrackerEntityLinkRef | null> {
    for (const provider of LINK_PROVIDERS) {
      const link = getLinkByEntity(this.db, entityType, entityId, provider);
      if (link === null || link.orphaned_at !== null) continue;
      return {
        provider,
        externalUrl: link.external_url,
        externalIdentifier: link.external_identifier,
      };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Log composition
// ---------------------------------------------------------------------------

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** Phases 1+2's counters. `drained` is null when an auth failure stopped the pass early. */
function appendWriteBackLines(
  entries: TrackerSyncLogEntry[],
  ambiguous: OutboxReport,
  drained: OutboxReport | null,
): void {
  const sent = ambiguous.sent + (drained?.sent ?? 0);
  const created = ambiguous.created + (drained?.created ?? 0);
  const recovered = ambiguous.ambiguousResolved;
  const retries = ambiguous.retriesScheduled + (drained?.retriesScheduled ?? 0);
  const failed = ambiguous.failedTerminal + (drained?.failedTerminal ?? 0);

  if (recovered > 0) {
    entries.push({ marker: '·', line: `recovered ${plural(recovered, 'in-flight write')}` });
  }
  if (sent > 0) entries.push({ marker: '✓', line: `wrote ${plural(sent, 'issue state')}` });
  if (created > 0) entries.push({ marker: '✓', line: `mirrored ${plural(created, 'sub-issue')}` });
  if (retries > 0) entries.push({ marker: '·', line: `${plural(retries, 'write')} queued for retry` });
  if (failed > 0) entries.push({ marker: '⚠', line: `${plural(failed, 'write')} failed` });
}

/** Phase 3's counters. */
function appendInboundLines(entries: TrackerSyncLogEntry[], report: InboundSyncReport): void {
  // "matched" = fetched issues that already had a local counterpart, whether or
  // not they carried a change (updated) or were deliberately passed over
  // (skipped). Fresh imports are reported on their own line below.
  entries.push({ marker: '·', line: `matched ${report.updated + report.skipped}` });
  if (report.imported > 0) {
    entries.push({ marker: '✓', line: `created ${plural(report.imported, 'idea')}` });
  }
  if (report.updated > 0) {
    entries.push({ marker: '✓', line: `updated ${plural(report.updated, 'linked item')}` });
  }
  const conflicts = report.conflictsOpened + report.autoResolved;
  if (conflicts > 0) entries.push({ marker: '✎', line: `conflicts ${conflicts}` });
  if (report.archivedRemotely > 0) {
    entries.push({ marker: '·', line: `archived ${plural(report.archivedRemotely, 'remote item')}` });
  }
  if (report.haltedOnOutbox !== undefined) {
    entries.push({ marker: '·', line: `held at ${report.haltedOnOutbox} — our write is in flight` });
  }
}

/** Phase 4's counters. */
function appendSweepLines(entries: TrackerSyncLogEntry[], sweep: InboundSweepReport): void {
  if (sweep.sweepArchived > 0) {
    entries.push({ marker: '·', line: `swept ${plural(sweep.sweepArchived, 'deleted issue')}` });
  }
  if (sweep.conflictsOpened > 0) {
    entries.push({ marker: '✎', line: `conflicts ${sweep.conflictsOpened}` });
  }
}

/** The connection's currently-stored log; an absent/corrupt blob reads back empty. */
function readStoredLog(db: Database.Database, connectionId: string): TrackerSyncLogEntry[] {
  return parseLogEntries(getConnection(db, connectionId)?.last_sync_log_json ?? null);
}

/**
 * Parse a `last_sync_log_json` blob. DEFENSIVE by contract: an absent, corrupt,
 * non-array, or partially-malformed blob degrades to the entries it can read
 * (or none) — a log is a display artifact, and a bad one must never break the
 * connected view or a pass that appends to it.
 */
function parseLogEntries(raw: string | null): TrackerSyncLogEntry[] {
  if (raw === null || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isLogEntry);
}

function isLogEntry(value: unknown): value is TrackerSyncLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.marker === 'string' && typeof candidate.line === 'string';
}

// ---------------------------------------------------------------------------
// Connected-view + reconcile reads
//
// Plain SELECTs against the NATIVE entity tables, which store.ts does not own —
// the same split inboundSync.readLocalEntity documents: the chokepoint rule
// governs WRITES, and taskListing's projections carry run overlays these reads
// have no use for.
// ---------------------------------------------------------------------------

/** Link lookup order for an entity whose provider we do not know up front. */
const LINK_PROVIDERS: readonly TrackerProvider[] = ['linear', 'plane'];

/** The connected view's source label, read back off `source_json`. */
function readSourceLabel(connection: TrackerConnectionRow): string {
  const parsed = parseJsonObject(connection.source_json);
  if (typeof parsed.label === 'string' && parsed.label.length > 0) return parsed.label;
  // Pre-label rows (and any hand-edited blob) fall back to the narrow/container
  // id — meaningless to a human but never blank, and never a crash.
  if (typeof parsed.narrowId === 'string' && parsed.narrowId.length > 0) return parsed.narrowId;
  if (typeof parsed.containerId === 'string') return parsed.containerId;
  return '';
}

/** An entity's display identity + body, for conflict rows and description merges. */
interface EntityIdentity {
  ref: string;
  title: string;
  body: string | null;
}

const IDENTITY_TABLE: Record<TrackerEntityType, 'ideas' | 'epics' | 'tasks'> = {
  idea: 'ideas',
  epic: 'epics',
  task: 'tasks',
};

function readEntityIdentity(
  db: Database.Database,
  entityType: TrackerEntityType,
  entityId: string,
): EntityIdentity | null {
  const row = db
    .prepare(`SELECT ref, title, body FROM ${IDENTITY_TABLE[entityType]} WHERE id = ?`)
    .get(entityId) as EntityIdentity | undefined;
  return row ?? null;
}

/** One Reconcile candidate row (the union of active ideas + active tasks). */
interface ReconcileCandidateRow {
  id: string;
  type: 'idea' | 'task';
  ref: string;
  title: string;
}

/**
 * The project's reconcilable entities: ideas + tasks that are not archived, not
 * on a terminal stage, not a retired (decomposed) idea, not an A/B experiment
 * sandbox row, and not already linked to a tracker issue. Epics are excluded —
 * they are never linked to an issue (imports land as ideas, mirroring creates
 * sub-issues for tasks).
 */
function listReconcileCandidates(
  db: Database.Database,
  projectId: number,
): ReconcileCandidateRow[] {
  return db
    .prepare(
      `SELECT i.id AS id, 'idea' AS type, i.ref AS ref, i.title AS title
         FROM ideas i
         JOIN board_stages s ON s.id = i.stage_id
        WHERE i.project_id = ?
          AND i.archived_at IS NULL
          AND i.decomposed_at IS NULL
          AND i.experiment_id IS NULL
          AND s.is_terminal = 0
          AND NOT EXISTS (
            SELECT 1 FROM entity_external_links l
             WHERE l.entity_type = 'idea' AND l.entity_id = i.id
          )
        UNION ALL
       SELECT t.id AS id, 'task' AS type, t.ref AS ref, t.title AS title
         FROM tasks t
         JOIN board_stages s ON s.id = t.stage_id
        WHERE t.project_id = ?
          AND t.archived_at IS NULL
          AND t.experiment_id IS NULL
          AND s.is_terminal = 0
          AND NOT EXISTS (
            SELECT 1 FROM entity_external_links l
             WHERE l.entity_type = 'task' AND l.entity_id = t.id
          )
        ORDER BY type ASC, ref ASC`,
    )
    .all(projectId, projectId) as ReconcileCandidateRow[];
}

// ---------------------------------------------------------------------------
// Reconcile title matching
// ---------------------------------------------------------------------------

/** The token-overlap ratio at which two titles are treated as the same item. */
const TITLE_MATCH_THRESHOLD = 0.75;

/** Lowercase, collapse every non-alphanumeric run to one space, trim. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Word set of a normalized title (empty string -> empty set). */
function tokenize(normalized: string): Set<string> {
  return new Set(normalized.length === 0 ? [] : normalized.split(' '));
}

/**
 * 1.0 for a containment match (one normalized title inside the other), else the
 * Jaccard overlap of the two word sets (|A n B| / |A u B|). Containment scores
 * highest because "Ship tracker sync" inside "Ship tracker sync (Linear)" is a
 * stronger signal than any partial word overlap.
 */
function titleScore(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const setA = tokenize(a);
  const setB = tokenize(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The best-matching issue for a local title, or null when nothing clears
 * {@link TITLE_MATCH_THRESHOLD}. Ties break on the lower externalId so the same
 * inputs always yield the same suggestion.
 */
function suggestMatch(
  title: string,
  issues: ReadonlyArray<{ externalId: string; normalized: string }>,
): string | null {
  const normalized = normalizeTitle(title);
  let bestId: string | null = null;
  let bestScore = 0;
  for (const issue of issues) {
    const score = titleScore(normalized, issue.normalized);
    if (score < TITLE_MATCH_THRESHOLD) continue;
    if (score > bestScore || (score === bestScore && bestId !== null && issue.externalId < bestId)) {
      bestScore = score;
      bestId = issue.externalId;
    }
  }
  return bestId;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Both flavours of "the stored key will not work" — pause, do not retry on a timer. */
function isCredentialFailure(err: unknown): boolean {
  return err instanceof TrackerAuthError || err instanceof TrackerCredentialsError;
}

/**
 * Epoch ms for a timestamp in EITHER shape we write: sqlite's `datetime('now')`
 * ('YYYY-MM-DD HH:MM:SS', implicitly UTC) or a JS ISO-8601 string. Null when
 * absent or unparseable — the caller then treats the connection as never synced.
 */
function parseTimestamp(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
