/**
 * Unit tests for the outbox drain + ambiguous recovery
 * (main/src/services/trackerSync/outboxWorker.ts).
 *
 * Real temp-file DB through the full migration chain (same technique as
 * store.test.ts / migration093.test.ts) + a hand-rolled FakeAdapter with call
 * capture and per-method scripted failures. No network, no mocking framework
 * on the adapter seam — the adapter interface is small enough to implement
 * honestly, which also keeps these tests a compile-time check that the worker
 * only uses the documented surface.
 *
 * Covers, per the task brief:
 *   - drain happy path: update_state writes the mapped provider state, settles
 *     the row `done`, and stamps the echo-suppression baseline on the link.
 *   - create_sub_issue: links the created issue (parent + baseline snapshot).
 *   - 5xx -> retry with next_attempt_at = now + min(2^attempts, 32) minutes.
 *   - TrackerAuthError -> terminal failure, connection paused, drain HALTS.
 *   - a group with no provider state -> terminal failure (no retry storm).
 *   - post-send local failure leaves the row `in_flight` for boot recovery.
 *   - ambiguous recovery: Linear point-lookup (found -> adopted, missing ->
 *     pending), Plane client-key match (a same-title sibling is NOT ours), and
 *     update_state -> straight to pending.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../database/database';
import type { TrackerConnectionRow, TrackerOutboxRow } from '../../../database/models';
import type {
  TrackerIssue,
  TrackerProvider,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import type { SubIssueDraft, TrackerAdapter, TrackerAdapterCapabilities } from '../adapterTypes';
import { TrackerApiError, TrackerAuthError } from '../errors';
import {
  enqueueOutbox,
  getConnection,
  getLinkByEntity,
  insertConnection,
  requeueInFlightAsAmbiguous,
  upsertLink,
  type NewConnectionRow,
} from '../store';
import { drainOutbox, processAmbiguous, toSqliteUtc, type OutboxDeps } from '../outboxWorker';
import type { CreateSubIssuePayload, UpdateStatePayload } from '../writeBack';

const PROJECT_ID = 1;
const NOW = '2026-07-30 12:00:00';
const SELECTION: TrackerSourceSelection = { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' };

const STATES: TrackerState[] = [
  { id: 'state-backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'state-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'state-done', name: 'Done', color: null, group: 'completed' },
  { id: 'state-canceled', name: 'Canceled', color: null, group: 'cancelled' },
];

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-outbox-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(PROJECT_ID, 'Proj 1', '/tmp/p1');
});

afterEach(() => {
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

interface UpdateCall {
  externalId: string;
  stateId: string;
}
interface CreateCall {
  parentExternalId: string;
  draft: SubIssueDraft;
  clientKey: string;
}

/** Scriptable TrackerAdapter: records every call, throws whatever a test queues. */
class FakeAdapter implements TrackerAdapter {
  provider: TrackerProvider = 'linear';
  capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: true,
    selfHostedBaseUrl: false,
    idempotentCreate: true,
  };

  states: TrackerState[] = STATES;
  issues: TrackerIssue[] = [];
  /** Point-lookup table for getIssue (Linear's client key IS the issue id). */
  issuesById = new Map<string, TrackerIssue>();

  /** Per-method scripted failure; consumed on the next call. */
  failUpdate: Error | null = null;
  failCreate: Error | null = null;
  failLookup: Error | null = null;

  readonly updateCalls: UpdateCall[] = [];
  readonly createCalls: CreateCall[] = [];
  listStatesCalls = 0;
  listIssuesCalls = 0;

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    return { workspaceId: 'ws-1', workspaceName: 'Acme', actorLabel: 'K.' };
  }
  async listContainers(): Promise<TrackerSourceTree> {
    return { containerLabel: 'Team', containers: [] };
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    return [];
  }
  async listStates(): Promise<TrackerState[]> {
    this.listStatesCalls += 1;
    return this.states;
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.listIssuesCalls += 1;
    if (this.failLookup) throw this.takeFailure('failLookup');
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    return this.issues.map((i) => i.externalId);
  }
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    if (this.failLookup) throw this.takeFailure('failLookup');
    return this.issuesById.get(externalId) ?? null;
  }
  async createSubIssue(
    parentExternalId: string,
    draft: SubIssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({ parentExternalId, draft, clientKey });
    if (this.failCreate) throw this.takeFailure('failCreate');
    return makeIssue(clientKey, { title: draft.title, parentExternalId });
  }
  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    this.updateCalls.push({ externalId, stateId });
    if (this.failUpdate) throw this.takeFailure('failUpdate');
  }

  protected takeFailure(key: 'failUpdate' | 'failCreate' | 'failLookup'): Error {
    const err = this[key] as Error;
    this[key] = null;
    return err;
  }
}

/**
 * Plane-shaped fake: creates are NOT idempotent, so recovery goes through the
 * client-key marker the adapter stamps into every issue it creates.
 *
 * The key lives in `markers`, not on the TrackerIssue — exactly like the real
 * marker paragraph, which PlaneAdapter strips from every description it
 * returns. A recovery that matched on anything the sync core can see (title,
 * description) would be matching on the wrong thing.
 */
class FakeMarkerAdapter extends FakeAdapter {
  provider: TrackerProvider = 'plane';
  capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: false,
    selfHostedBaseUrl: true,
    idempotentCreate: false,
  };

  /** externalId -> the client key stamped into that issue's description. */
  readonly markers = new Map<string, string>();
  clientKeyLookups = 0;

  async findSubIssueByClientKey(
    parentExternalId: string,
    clientKey: string,
  ): Promise<TrackerIssue | null> {
    this.clientKeyLookups += 1;
    if (this.failLookup) throw this.takeFailure('failLookup');
    return (
      this.issues.find(
        (issue) =>
          issue.parentExternalId === parentExternalId &&
          this.markers.get(issue.externalId) === clientKey,
      ) ?? null
    );
  }
}

function makeIssue(externalId: string, overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId,
    identifier: `CORE-${externalId.slice(0, 4)}`,
    title: 'Sub issue',
    description: null,
    url: `https://linear.app/acme/issue/${externalId}`,
    stateId: 'state-backlog',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-07-30T11:59:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConnectionRow(overrides: Partial<NewConnectionRow> = {}): NewConnectionRow {
  return {
    id: 'conn-1',
    project_id: PROJECT_ID,
    provider: 'linear',
    status: 'active',
    workspace_id: 'ws-1',
    workspace_name: 'Acme',
    actor_label: 'K.',
    base_url: null,
    secret_ciphertext: null,
    // The Step-1 SOURCE choice lives in source_json (selection_json carries the
    // Step-2 tasks-selection payload, which the outbox worker never reads).
    source_json: JSON.stringify(SELECTION),
    selection_mode: 'all',
    selection_json: null,
    state_mapping_json: '{}',
    two_way: 1,
    mirror_subissues: 1,
    conflict_mode: 'auto',
    cursor_updated_at: null,
    cursor_external_id: null,
    last_sync_at: null,
    last_sync_log_json: null,
    ...overrides,
  };
}

function seedConnection(overrides: Partial<NewConnectionRow> = {}): TrackerConnectionRow {
  return insertConnection(raw, makeConnectionRow(overrides));
}

function makeDeps(adapter: TrackerAdapter, now: string = NOW): OutboxDeps {
  return { db: raw, adapterFor: () => adapter, nowIso: () => now };
}

function enqueueStateWrite(
  connectionId: string,
  externalId: string,
  desiredGroup: UpdateStatePayload['desiredGroup'],
  kind: 'update_state' | 'close_parent' = 'update_state',
): TrackerOutboxRow {
  return enqueueOutbox(raw, {
    connection_id: connectionId,
    kind,
    entity_type: 'task',
    entity_id: 'tsk_1',
    external_id: externalId,
    payload_json: JSON.stringify({ desiredGroup } satisfies UpdateStatePayload),
  });
}

function enqueueCreate(connectionId: string, entityId: string, clientKey: string): TrackerOutboxRow {
  const payload: CreateSubIssuePayload = {
    parentExternalId: 'ext-idea',
    title: 'Task TASK-1',
    description: 'body one',
  };
  return enqueueOutbox(raw, {
    connection_id: connectionId,
    kind: 'create_sub_issue',
    entity_type: 'task',
    entity_id: entityId,
    client_key: clientKey,
    payload_json: JSON.stringify(payload),
  });
}

function fetchOutbox(id: number): TrackerOutboxRow {
  return raw.prepare('SELECT * FROM tracker_outbox WHERE id = ?').get(id) as TrackerOutboxRow;
}

// ---------------------------------------------------------------------------
// Drain — happy paths
// ---------------------------------------------------------------------------

describe('drainOutbox — state writes', () => {
  it('writes the mapped state, settles the row, and stamps the echo-suppression baseline', async () => {
    const connection = seedConnection();
    upsertLink(raw, {
      connection_id: connection.id,
      entity_type: 'task',
      entity_id: 'tsk_1',
      provider: 'linear',
      external_id: 'ext-1',
      baseline_json: JSON.stringify({ stateId: 'state-backlog', title: 'kept' }),
    });
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(report.sent).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');

    const link = getLinkByEntity(raw, 'task', 'tsk_1', 'linear');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toEqual({
      // Untouched inbound baseline field survives the merge...
      title: 'kept',
      // ...while the state we just wrote replaces the stale one.
      stateId: 'state-done',
      lastWrittenGroup: 'completed',
      lastWrittenAt: NOW,
    });
  });

  it('drains every eligible row and fetches the provider state list ONCE', async () => {
    const connection = seedConnection();
    enqueueStateWrite(connection.id, 'ext-1', 'completed');
    enqueueStateWrite(connection.id, 'ext-2', 'started');
    enqueueStateWrite(connection.id, 'ext-idea', 'completed', 'close_parent');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.sent).toBe(3);
    expect(adapter.listStatesCalls).toBe(1);
    expect(adapter.updateCalls.map((c) => c.stateId)).toEqual(['state-done', 'state-progress', 'state-done']);
  });

  it('fails terminally when no provider state maps to the desired group', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'cancelled');
    const adapter = new FakeAdapter();
    adapter.states = STATES.filter((s) => s.group !== 'cancelled');

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toHaveLength(0);
    expect(report.failedTerminal).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('failed');
    expect(settled.next_attempt_at).toBeNull();
    expect(settled.last_error).toContain('cancelled');
  });
});

describe('drainOutbox — sub-issue creation', () => {
  it('creates the sub-issue and links it to the minted task', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls).toEqual([
      {
        parentExternalId: 'ext-idea',
        draft: { title: 'Task TASK-1', description: 'body one' },
        clientKey: 'client-key-1',
      },
    ]);
    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');

    const link = getLinkByEntity(raw, 'task', 'tsk_1', 'linear');
    expect(link?.external_id).toBe('client-key-1');
    expect(link?.external_parent_id).toBe('ext-idea');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toMatchObject({
      stateId: 'state-backlog',
      title: 'Task TASK-1',
    });
  });
});

// ---------------------------------------------------------------------------
// Drain — failures
// ---------------------------------------------------------------------------

describe('drainOutbox — failure handling', () => {
  it('schedules an exponential-backoff retry on a 5xx', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerApiError('linear', 'bad gateway', 502);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.retriesScheduled).toBe(1);
    const settled = fetchOutbox(row.id);
    // Re-queued as pending, one attempt in, first backoff = 2^1 minutes.
    expect(settled.state).toBe('pending');
    expect(settled.attempts).toBe(1);
    expect(settled.next_attempt_at).toBe('2026-07-30 12:02:00');
    expect(settled.last_error).toContain('bad gateway');
  });

  it('clamps the backoff at 32 minutes', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    raw.prepare('UPDATE tracker_outbox SET attempts = 9 WHERE id = ?').run(row.id);
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerApiError('linear', 'server exploded', 503);

    await drainOutbox(makeDeps(adapter), connection);

    expect(fetchOutbox(row.id).next_attempt_at).toBe('2026-07-30 12:32:00');
  });

  it('does not retry a non-rate-limit 4xx', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerApiError('linear', 'unknown issue', 404);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.failedTerminal).toBe(1);
    expect(report.retriesScheduled).toBe(0);
    expect(fetchOutbox(row.id).state).toBe('failed');
  });

  it('pauses the connection and HALTS the drain on an auth failure', async () => {
    const connection = seedConnection();
    const first = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const second = enqueueStateWrite(connection.id, 'ext-2', 'completed');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerAuthError('linear', 'invalid api key', 401);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.authPaused).toBe(true);
    expect(report.failedTerminal).toBe(1);
    expect(getConnection(raw, connection.id)?.status).toBe('paused');
    expect(fetchOutbox(first.id).state).toBe('failed');
    // The second row was never claimed — the drain stopped.
    expect(fetchOutbox(second.id).state).toBe('pending');
    expect(fetchOutbox(second.id).attempts).toBe(0);
    expect(adapter.updateCalls).toHaveLength(1);
  });

  it('leaves the row in_flight when the local record fails AFTER a successful send', async () => {
    const connection = seedConnection();
    // A DIFFERENT entity already owns this external id under the connection,
    // so upsertLink's (connection_id, external_id) uniqueness blows up after
    // the create has already landed remotely.
    upsertLink(raw, {
      connection_id: connection.id,
      entity_type: 'task',
      entity_id: 'tsk_other',
      provider: 'linear',
      external_id: 'client-key-1',
    });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new FakeAdapter();

    await expect(drainOutbox(makeDeps(adapter), connection)).rejects.toThrow();

    // NOT failed, NOT retried: the remote write happened, so only boot
    // recovery (in_flight -> ambiguous) may touch this row.
    expect(fetchOutbox(row.id).state).toBe('in_flight');
    expect(adapter.createCalls).toHaveLength(1);
  });

  it('skips a row whose next_attempt_at is still in the future', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    raw
      .prepare("UPDATE tracker_outbox SET next_attempt_at = '2026-07-30 12:30:00' WHERE id = ?")
      .run(row.id);
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.sent).toBe(0);
    expect(adapter.updateCalls).toHaveLength(0);
    expect(fetchOutbox(row.id).state).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Ambiguous recovery
// ---------------------------------------------------------------------------

describe('processAmbiguous', () => {
  /** Simulate a crash mid-flight: claim the row, then boot-recover it. */
  function makeAmbiguous(rowId: number, connectionId: string): void {
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight', attempts = 1 WHERE id = ?").run(rowId);
    expect(requeueInFlightAsAmbiguous(raw, connectionId)).toBe(1);
    expect(fetchOutbox(rowId).state).toBe('ambiguous');
  }

  it('adopts a create whose issue the idempotent point-lookup FINDS', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeAdapter();
    adapter.issuesById.set(
      'client-key-1',
      makeIssue('client-key-1', { title: 'Task TASK-1', parentExternalId: 'ext-idea' }),
    );

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(report.ambiguousResolved).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect(adapter.createCalls).toHaveLength(0);
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'linear')?.external_id).toBe('client-key-1');
  });

  it('returns a create to pending when the point-lookup finds NOTHING', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);
    const adapter = new FakeAdapter();

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(0);
    expect(report.ambiguousResolved).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('pending');
    expect(settled.next_attempt_at).toBe(NOW);
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'linear')).toBeNull();

    // ...and the follow-up drain safely performs the create exactly once.
    const drainReport = await drainOutbox(makeDeps(adapter), connection);
    expect(drainReport.created).toBe(1);
    expect(adapter.createCalls).toHaveLength(1);
  });

  it('adopts the Plane child carrying the row CLIENT KEY, not the same-title sibling', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      // Listed FIRST and identical on parent + title: a title match adopts it.
      makeIssue('proj-1/sibling', { title: 'Task TASK-1', parentExternalId: 'ext-idea' }),
      makeIssue('proj-1/ours', { title: 'Task TASK-1', parentExternalId: 'ext-idea' }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-1');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'plane')?.external_id).toBe('proj-1/ours');
    // Recovery goes through the client-key lookup — title is not a criterion.
    expect(adapter.clientKeyLookups).toBe(1);
    expect(adapter.listIssuesCalls).toBe(0);
  });

  it('does NOT adopt a same-title sibling that lacks the marker — the row is requeued', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeMarkerAdapter();
    // Routine case: the parent already holds an unrelated child with our title,
    // and our own create never landed.
    adapter.issues = [makeIssue('proj-1/sibling', { title: 'Task TASK-1', parentExternalId: 'ext-idea' })];

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(0);
    expect(report.ambiguousResolved).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('pending');
    expect(settled.next_attempt_at).toBe(NOW);
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'plane')).toBeNull();

    // ...and the retry creates OUR child, leaving the sibling alone.
    const drainReport = await drainOutbox(makeDeps(adapter), connection);
    expect(drainReport.created).toBe(1);
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'plane')?.external_id).toBe('client-key-1');
  });

  it('leaves the row ambiguous when the adapter can neither point-look-up nor match a client key', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeAdapter();
    adapter.capabilities = { ...adapter.capabilities, idempotentCreate: false };

    const report = await processAmbiguous(makeDeps(adapter), connection);

    // "Cannot look it up" must never read as "it isn't there" — requeueing here
    // would duplicate the sub-issue.
    expect(report.ambiguousResolved).toBe(0);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('ambiguous');
    expect(settled.last_error).toContain('client-key recovery');
  });

  it('sends an ambiguous state write straight back to pending (idempotent by nature)', async () => {
    const connection = seedConnection();
    const row = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    makeAmbiguous(row.id, connection.id);
    const adapter = new FakeAdapter();

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.ambiguousResolved).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('pending');
    // No lookup needed — re-writing a state is a no-op if it already landed.
    expect(adapter.listIssuesCalls).toBe(0);
  });

  it('leaves a create ambiguous when the reconciling lookup itself fails', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    makeAmbiguous(row.id, connection.id);
    const adapter = new FakeAdapter();
    adapter.failLookup = new TrackerApiError('linear', 'gateway timeout', 504);

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.ambiguousResolved).toBe(0);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('ambiguous');
    expect(settled.last_error).toContain('gateway timeout');
  });

  it('pauses and halts when the reconciling lookup hits an auth failure', async () => {
    const connection = seedConnection();
    const first = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const second = enqueueCreate(connection.id, 'tsk_2', 'client-key-2');
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE connection_id = ?").run(connection.id);
    requeueInFlightAsAmbiguous(raw, connection.id);
    const adapter = new FakeAdapter();
    adapter.failLookup = new TrackerAuthError('linear', 'revoked key', 401);

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.authPaused).toBe(true);
    expect(getConnection(raw, connection.id)?.status).toBe('paused');
    expect(fetchOutbox(first.id).state).toBe('failed');
    expect(fetchOutbox(second.id).state).toBe('ambiguous');
  });
});

// ---------------------------------------------------------------------------
// Timestamp normalization
// ---------------------------------------------------------------------------

describe('toSqliteUtc', () => {
  it("normalizes a JS ISO string to sqlite's datetime('now') shape and leaves that shape alone", () => {
    expect(toSqliteUtc('2026-07-30T12:00:00.000Z')).toBe('2026-07-30 12:00:00');
    expect(toSqliteUtc('2026-07-30 12:00:00')).toBe('2026-07-30 12:00:00');
  });

  it('leaves an unparseable value untouched rather than inventing a timestamp', () => {
    expect(toSqliteUtc('not a date')).toBe('not a date');
  });
});
