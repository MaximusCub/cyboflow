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
 */
import type Database from 'better-sqlite3';
import type { TrackerConnectionRow } from '../../database/models';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';
import type { LoggerLike } from '../../orchestrator/types';
import { TASK_ALL_CHANNEL, taskChangeEvents } from '../../orchestrator/taskChangeRouter';
import type { TrackerAdapter } from './adapterTypes';
import { TrackerAuthError } from './errors';
import { LinearAdapter } from './linearAdapter';
import { PlaneAdapter } from './planeAdapter';
import { decryptTrackerSecret } from './secrets';
import {
  getConnection,
  listConnections,
  listUnresolvedOutbox,
  readSecret,
  requeueInFlightAsAmbiguous,
  updateConnectionSettings,
} from './store';
import {
  runDeletionSweep,
  runInboundSync,
  type EntityWriteRouter,
  type InboundSweepReport,
  type InboundSyncReport,
} from './inboundSync';
import { drainOutbox, processAmbiguous, toSqliteUtc, type OutboxDeps, type OutboxReport } from './outboxWorker';
import { createWriteBackListener, type WriteBackListener } from './writeBack';

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
 * One line of the connected view's sync log, persisted as a JSON array in
 * `tracker_connections.last_sync_log_json`. `marker` is the leading glyph the
 * prototype's log column renders in its own color; `line` is the text.
 *
 * Kept main-side for now: no renderer surface consumes it yet, so it does not
 * need to cross IPC (promote it to shared/types/trackerSync.ts when the
 * connected view lands) — same treatment as inboundSync's
 * TrackerSelectionPayload.
 */
export interface TrackerSyncLogEntry {
  marker: string;
  line: string;
}

/** What one {@link TrackerSyncService.syncConnection} pass did. */
export interface TrackerSyncPassResult {
  connectionId: string;
  /** False when the connection id is unknown (nothing ran, nothing persisted). */
  ran: boolean;
  /** The deletion sweep ran this pass. */
  swept: boolean;
  /** The connection was left `paused` (bad/absent credentials). */
  paused: boolean;
  /** The composed log, exactly as persisted. */
  entries: TrackerSyncLogEntry[];
  /** Non-null when the pass failed; the message is also in `entries`. */
  error: string | null;
}

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

export class TrackerSyncService {
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

        if (sweepDue) {
          entries.push({ marker: '▸', line: 'GET issue ids' });
          const sweep = await runDeletionSweep(
            { db: this.db, adapter, router: this.router, nowIso: this.nowIso },
            connection,
          );
          swept = true;
          appendSweepLines(entries, sweep);
        }
      }
    } catch (err) {
      error = describeError(err);
      if (isCredentialFailure(err)) {
        updateConnectionSettings(this.db, connection.id, { status: 'paused' });
        paused = true;
        entries.push({ marker: '⚠', line: `authorization failed · ${error}` });
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
        } else {
          entries.push({ marker: '⚠', line: `write-back failed · ${error}` });
          this.logger?.error('[trackerSync] write-back drain failed', { connectionId, error });
        }
      }

      // A drain that had nothing to say leaves the last pass's log alone.
      if (entries.length > 0) {
        this.persistLog(connection.id, entries, { stampSyncedAt: false });
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
  const connection = getConnection(db, connectionId);
  const raw = connection?.last_sync_log_json;
  if (raw === null || raw === undefined || raw.length === 0) return [];
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
