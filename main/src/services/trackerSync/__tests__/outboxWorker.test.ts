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
 *   - TrackerAuthError -> connection paused and drain HALTS, with the rejected
 *     row HELD unsettled (not terminal) so a key rotation replays it.
 *   - supersession: a newer state write settles the queued older one at ENQUEUE,
 *     and the drain refuses a stale row that never met that sweep.
 *   - a group with no provider state -> terminal failure (no retry storm).
 *   - post-send local failure leaves the row `in_flight` for boot recovery.
 *   - a create whose outcome is UNCERTAIN on a non-idempotent provider parks as
 *     `ambiguous` (never a second POST) and is adopted by the next reconcile;
 *     a 4xx there is still terminal, and an idempotent provider still retries.
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
import type { IssueDraft, TrackerAdapter, TrackerAdapterCapabilities } from '../adapterTypes';
import { TrackerApiError, TrackerAuthError } from '../errors';
import {
  enqueueOutbox,
  getConnection,
  getLinkByEntity,
  insertConnection,
  requeueInFlightAsAmbiguous,
  supersedeQueuedStateWrites,
  updateConnectionSettings,
  upsertLink,
  type NewConnectionRow,
} from '../store';
import { drainOutbox, processAmbiguous, toSqliteUtc, type OutboxDeps } from '../outboxWorker';
import { resolveStageIds } from '../stateMapping';
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
  /** Null on a top-level `createIssue` (the push direction). */
  parentExternalId: string | null;
  draft: IssueDraft;
  clientKey: string;
  /** The source container a top-level create was filed into; null on a sub-issue. */
  containerId?: string | null;
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
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({ parentExternalId, draft, clientKey });
    if (this.failCreate) throw this.takeFailure('failCreate');
    return makeIssue(clientKey, { title: draft.title, parentExternalId });
  }
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({
      parentExternalId: null,
      containerId: selection.containerId,
      draft,
      clientKey,
    });
    if (this.failCreate) throw this.takeFailure('failCreate');
    return makeIssue(clientKey, {
      title: draft.title,
      // The provider settles the state: an omitted draft state takes its
      // default, exactly as a real create would.
      stateId: draft.stateId ?? 'state-backlog',
    });
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
  /** Every scope a recovery lookup was made with, so a test can assert the shape. */
  readonly clientKeyScopes: Array<{ containerId: string | null; parentExternalId: string | null }> =
    [];

  async findIssueByClientKey(
    scope: { containerId: string | null; parentExternalId: string | null },
    clientKey: string,
  ): Promise<TrackerIssue | null> {
    this.clientKeyLookups += 1;
    this.clientKeyScopes.push(scope);
    if (this.failLookup) throw this.takeFailure('failLookup');
    return (
      this.issues.find(
        (issue) =>
          // A null parent means "search the whole container" — the top-level
          // push's shape — so the parent is only compared when one is given.
          (scope.parentExternalId === null ||
            issue.parentExternalId === scope.parentExternalId) &&
          this.markers.get(issue.externalId) === clientKey,
      ) ?? null
    );
  }
}

/**
 * The lost-response case: the server COMMITS the child and the caller still
 * sees a failure (5xx, timeout, dropped connection). The created issue is
 * recorded — marker and all — exactly as the real remote would hold it, so a
 * blind re-POST shows up as a second child.
 */
class CommitThenFailAdapter extends FakeMarkerAdapter {
  /** Thrown AFTER the child is committed; consumed on the next create. */
  failAfterCommit: Error | null = null;

  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({ parentExternalId, draft, clientKey });
    return this.commit(draft, clientKey, parentExternalId);
  }

  /** Same lost-response shape for the TOP-LEVEL push: committed, then thrown. */
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.createCalls.push({
      parentExternalId: null,
      containerId: selection.containerId,
      draft,
      clientKey,
    });
    return this.commit(draft, clientKey, null);
  }

  private commit(
    draft: IssueDraft,
    clientKey: string,
    parentExternalId: string | null,
  ): TrackerIssue {
    const issue = makeIssue(`proj-1/child-${this.createCalls.length}`, {
      title: draft.title,
      parentExternalId,
      stateId: draft.stateId ?? 'state-backlog',
    });
    this.issues.push(issue);
    this.markers.set(issue.externalId, clientKey);
    if (this.failAfterCommit) {
      const err = this.failAfterCommit;
      this.failAfterCommit = null;
      throw err;
    }
    return issue;
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
    recoveryClientKey: null,
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
    status_sync_mode: 'auto',
    pull_mode: 'auto',
    push_mode: 'auto',
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
// Drain — the PUSH direction (create_issue)
// ---------------------------------------------------------------------------

describe('drainOutbox — top-level issue creation (push)', () => {
  /** A real board + idea row: the push draft is composed from them at drain time. */
  function seedIdea(
    id: string,
    opts: { title?: string; body?: string | null; stage?: 'idea' | 'done'; archived?: boolean } = {},
  ): void {
    svc.seedDefaultBoard(PROJECT_ID);
    const stageIds = resolveStageIds(raw, PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, summary, body, board_id, stage_id, archived_at)
         VALUES (?, ?, 'IDEA-1', ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        PROJECT_ID,
        opts.title ?? 'Ship the push direction',
        opts.body ?? null,
        `board-${PROJECT_ID}-default`,
        opts.stage === 'done' ? stageIds.done : stageIds.idea,
        opts.archived === true ? '2026-07-30 11:00:00' : null,
      );
  }

  function enqueuePush(connectionId: string, entityId: string, clientKey: string): TrackerOutboxRow {
    return enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: entityId,
      client_key: clientKey,
      // Empty BY DESIGN — the draft is composed at drain time.
      payload_json: '{}',
    });
  }

  it('composes the draft from the idea AT DRAIN TIME, files it in the source container, and links it', async () => {
    const connection = seedConnection();
    seedIdea('ide_1', {
      title: 'Ship the push direction',
      // A provenance footer must never reach a remote body, even though an idea
      // carrying one is not pushed in the first place.
      body: 'The local description.\n\n---\n<!-- cyboflow:tracker linear:ext-9 -->\nImported from Linear',
    });
    const row = enqueuePush(connection.id, 'ide_1', 'client-key-push');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls).toEqual([
      {
        parentExternalId: null,
        containerId: SELECTION.containerId,
        draft: {
          title: 'Ship the push direction',
          description: 'The local description.',
          // Stage 'Idea' maps to no write-back group, so the create falls back
          // to the BACKLOG-group state.
          stateId: 'state-backlog',
        },
        clientKey: 'client-key-push',
      },
    ]);
    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');

    const link = getLinkByEntity(raw, 'idea', 'ide_1', 'linear');
    expect(link?.external_id).toBe('client-key-push');
    expect(link?.external_parent_id).toBeNull();
    const baseline = JSON.parse(link?.baseline_json ?? '{}') as Record<string, unknown>;
    expect(baseline).toMatchObject({ stateId: 'state-backlog', title: 'Ship the push direction' });
    // Backlog is not a write-back group, so no stamp — a stale one would
    // suppress the first genuine Done/Won't-do write-back.
    expect(baseline).not.toHaveProperty('lastWrittenGroup');
  });

  it("stamps lastWrittenGroup with the group the issue ACTUALLY landed in", async () => {
    const connection = seedConnection();
    seedIdea('ide_1', { stage: 'done' });
    enqueuePush(connection.id, 'ide_1', 'client-key-done');
    const adapter = new FakeAdapter();

    await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls[0].draft.stateId).toBe('state-done');
    const link = getLinkByEntity(raw, 'idea', 'ide_1', 'linear');
    expect(JSON.parse(link?.baseline_json ?? '{}')).toMatchObject({
      stateId: 'state-done',
      lastWrittenGroup: 'completed',
    });
  });

  it('settles a push whose idea was deleted or archived, WITHOUT a remote write', async () => {
    const connection = seedConnection();
    // (a) hard-deleted: no row at all.
    const gone = enqueuePush(connection.id, 'ide_gone', 'client-key-gone');
    // (b) archived while the push waited.
    seedIdea('ide_archived', { archived: true });
    const archived = enqueuePush(connection.id, 'ide_archived', 'client-key-archived');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls).toEqual([]);
    expect(report.created).toBe(0);
    expect(report.failedTerminal).toBe(0);
    for (const row of [gone, archived]) expect(fetchOutbox(row.id).state).toBe('done');
    expect(getLinkByEntity(raw, 'idea', 'ide_archived', 'linear')).toBeNull();
  });

  it('leaves a push row untouched when the drain does not own the push direction', async () => {
    const connection = seedConnection();
    seedIdea('ide_1');
    const push = enqueuePush(connection.id, 'ide_1', 'client-key-held');
    const state = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection, ['update_state', 'close_parent']);

    expect(adapter.createCalls).toEqual([]);
    expect(report.sent).toBe(1);
    expect(fetchOutbox(state.id).state).toBe('done');
    // Held, not consumed: still pending, still attempt 0.
    expect(fetchOutbox(push.id).state).toBe('pending');
    expect(fetchOutbox(push.id).attempts).toBe(0);
  });

  it('parks an uncertain push as ambiguous on a provider without idempotent creates', async () => {
    const connection = seedConnection({ provider: 'plane' });
    seedIdea('ide_1');
    const row = enqueuePush(connection.id, 'ide_1', 'client-key-lost');
    const adapter = new CommitThenFailAdapter();
    adapter.failAfterCommit = new TrackerApiError('plane', 'gateway timeout', 504);

    const report = await drainOutbox(makeDeps(adapter), connection);

    // NOT a blind retry: the issue may well exist remotely already.
    expect(fetchOutbox(row.id).state).toBe('ambiguous');
    expect(report.retriesScheduled).toBe(1);
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drain — supersession
//
// The drain is serial, so two writes are never in flight at once — but they can
// still land out of ORDER across passes, and the tracker keeps whichever
// arrived last.
// ---------------------------------------------------------------------------

describe('a stale state write never lands after a newer one', () => {
  /**
   * Enqueue a state write the way the two real call sites do —
   * writeBack.enqueueStateWrite and TrackerSyncService.enqueueGroupWriteBack —
   * which is `enqueueOutbox` followed by the supersession sweep.
   */
  function enqueueSuperseding(
    connectionId: string,
    externalId: string,
    desiredGroup: UpdateStatePayload['desiredGroup'],
    kind: 'update_state' | 'close_parent' = 'update_state',
  ): TrackerOutboxRow {
    const row = enqueueStateWrite(connectionId, externalId, desiredGroup, kind);
    supersedeQueuedStateWrites(raw, connectionId, externalId, row.id);
    return row;
  }

  it('settles the queued older write the moment a newer one is enqueued', async () => {
    const connection = seedConnection();
    const stale = enqueueSuperseding(connection.id, 'ext-1', 'started');
    const fresh = enqueueSuperseding(connection.id, 'ext-1', 'completed');

    // Settled at ENQUEUE, before any drain: `done`, not `failed`. Nothing went
    // wrong — the instruction was replaced — so there is nothing to retry and
    // nothing to report as a failure.
    const dropped = fetchOutbox(stale.id);
    expect(dropped.state).toBe('done');
    expect(dropped.next_attempt_at).toBeNull();
    expect(dropped.last_error).toContain('superseded');

    const adapter = new FakeAdapter();
    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(report.sent).toBe(1);
    expect(report.failedTerminal).toBe(0);
    expect(fetchOutbox(fresh.id).state).toBe('done');
  });

  it('drops a stale write whose backoff outlived the newer one that ALREADY LANDED', async () => {
    // THE REGRESSION, in the sequence that produces it: 'started' fails and
    // takes a two-minute backoff; 'completed' is enqueued, is eligible
    // immediately, and drains; then the backoff expires and the stale row is
    // claimed — dragging a Done issue back to In Progress.
    //
    // This is also why the fix cannot live at claim time alone: by then the
    // newer row is `done`, so nothing the drain can query still knows it
    // existed. The enqueue in the middle of this test is the only moment both
    // rows are visible at once.
    const connection = seedConnection();
    const stale = enqueueSuperseding(connection.id, 'ext-1', 'started');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerApiError('linear', 'bad gateway', 502);
    await drainOutbox(makeDeps(adapter), connection);
    expect(fetchOutbox(stale.id).state).toBe('pending');
    expect(fetchOutbox(stale.id).next_attempt_at).not.toBeNull();

    adapter.failUpdate = null;
    const fresh = enqueueSuperseding(connection.id, 'ext-1', 'completed');
    await drainOutbox(makeDeps(adapter), connection);
    expect(fetchOutbox(fresh.id).state).toBe('done');

    // The backoff expires. Nothing more may go out for this issue.
    raw.prepare('UPDATE tracker_outbox SET next_attempt_at = NULL WHERE id = ?').run(stale.id);
    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.sent).toBe(0);
    // The last thing the tracker was told is the CURRENT state, not the stale one.
    expect(adapter.updateCalls.at(-1)).toEqual({ externalId: 'ext-1', stateId: 'state-done' });
    expect(fetchOutbox(stale.id).state).toBe('done');
  });

  it('supersedes ACROSS the two status kinds, and never across different issues', async () => {
    // update_state and close_parent both move the SAME issue's state, so a
    // later one of either kind states the truth the earlier one is wrong about
    // — the same key writeBack's enqueue dedupe uses. A write for a DIFFERENT
    // issue supersedes nothing.
    const connection = seedConnection();
    const stale = enqueueSuperseding(connection.id, 'ext-idea', 'started');
    const other = enqueueSuperseding(connection.id, 'ext-other', 'started');
    enqueueSuperseding(connection.id, 'ext-idea', 'completed', 'close_parent');

    expect(fetchOutbox(stale.id).state).toBe('done');
    expect(fetchOutbox(other.id).state).toBe('pending');

    const adapter = new FakeAdapter();
    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.sent).toBe(2);
    expect(adapter.updateCalls).toEqual([
      { externalId: 'ext-other', stateId: 'state-progress' },
      { externalId: 'ext-idea', stateId: 'state-done' },
    ]);
  });

  it('leaves an IN-FLIGHT older write alone — its request is already out', async () => {
    // Settling it would be a lie about an outcome nobody knows, and it needs no
    // handling: the claim is serial, so the newer row is claimed only after the
    // in-flight one finishes and therefore still lands last.
    const connection = seedConnection();
    const older = enqueueStateWrite(connection.id, 'ext-1', 'started');
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(older.id);

    enqueueSuperseding(connection.id, 'ext-1', 'completed');

    expect(fetchOutbox(older.id).state).toBe('in_flight');
  });

  it('BACKSTOP: the drain refuses a stale row that never met the enqueue sweep', async () => {
    // The invariant re-checked at the point of use, for a row queued before this
    // behaviour existed (or by an enqueue path that forgets the sweep). Raw
    // enqueues here, deliberately — no supersession at write time.
    const connection = seedConnection();
    const stale = enqueueStateWrite(connection.id, 'ext-1', 'started');
    const fresh = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    expect(fetchOutbox(stale.id).state).toBe('pending');
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.superseded).toBe(1);
    expect(report.sent).toBe(1);
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(fetchOutbox(stale.id).last_error).toContain('superseded');
    expect(fetchOutbox(fresh.id).state).toBe('done');
  });

  it('BACKSTOP: a TERMINALLY FAILED newer row supersedes nothing', async () => {
    // Only an UNSETTLED row can still speak for the issue. A newer write that
    // failed for good will never reach the tracker, so dropping the older one
    // for it would leave the remote at neither value.
    const connection = seedConnection();
    const older = enqueueStateWrite(connection.id, 'ext-1', 'started');
    const newer = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    raw
      .prepare("UPDATE tracker_outbox SET state = 'failed', next_attempt_at = NULL WHERE id = ?")
      .run(newer.id);
    const adapter = new FakeAdapter();

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.superseded).toBe(0);
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-progress' }]);
    expect(fetchOutbox(older.id).state).toBe('done');
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

  it('pauses the connection and HALTS the drain on an auth failure, HOLDING the rejected row', async () => {
    const connection = seedConnection();
    const first = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const second = enqueueStateWrite(connection.id, 'ext-2', 'completed');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerAuthError('linear', 'invalid api key', 401);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.authPaused).toBe(true);
    expect(getConnection(raw, connection.id)?.status).toBe('paused');

    // NOT terminal: the credentials are wrong, the WRITE is not, and nothing
    // re-derives a stage move whose entity event is long past. The row waits,
    // eligible the instant the connection is usable again — no backoff, because
    // no drain claims a non-active connection's rows in the meantime.
    expect(report.failedTerminal).toBe(0);
    expect(report.retriesScheduled).toBe(1);
    const held = fetchOutbox(first.id);
    expect(held.state).toBe('pending');
    expect(held.next_attempt_at).toBe(NOW);
    expect(held.last_error).toContain('invalid api key');

    // The second row was never claimed — the drain stopped.
    expect(fetchOutbox(second.id).state).toBe('pending');
    expect(fetchOutbox(second.id).attempts).toBe(0);
    expect(adapter.updateCalls).toHaveLength(1);
  });

  it('replays every held write once the connection is resumed with a working key', async () => {
    const connection = seedConnection();
    const first = enqueueStateWrite(connection.id, 'ext-1', 'completed');
    const second = enqueueStateWrite(connection.id, 'ext-2', 'cancelled');
    const adapter = new FakeAdapter();
    adapter.failUpdate = new TrackerAuthError('linear', 'invalid api key', 401);
    await drainOutbox(makeDeps(adapter), connection);
    expect(adapter.updateCalls).toHaveLength(1);

    // The rotation (facade: updateCredentials) stores a fresh key and flips the
    // connection back to 'active'. Both held rows are still queued, in order.
    adapter.failUpdate = null;
    updateConnectionSettings(raw, connection.id, { status: 'active' });
    const resumed = getConnection(raw, connection.id);
    if (resumed === null) throw new Error('connection vanished');

    const report = await drainOutbox(makeDeps(adapter), resumed);

    expect(report.sent).toBe(2);
    // Past the one rejected attempt the paused drain made, both held writes go
    // out — in their original order, which is what holding them preserved.
    expect(adapter.updateCalls.slice(1).map((call) => call.externalId)).toEqual(['ext-1', 'ext-2']);
    expect(fetchOutbox(first.id).state).toBe('done');
    expect(fetchOutbox(second.id).state).toBe('done');
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
// Drain — uncertain creates on a non-idempotent provider
// ---------------------------------------------------------------------------

describe('drainOutbox — non-idempotent create failures', () => {
  it('parks a create whose outcome is UNKNOWN as ambiguous instead of re-POSTing it', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new CommitThenFailAdapter();
    // The classic lost create: committed server-side, 500 on the way back.
    adapter.failAfterCommit = new TrackerApiError('plane', 'internal server error', 500);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(adapter.createCalls).toHaveLength(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('ambiguous');
    expect(settled.last_error).toContain('internal server error');
    // Not eligible for a blind retry: a second drain must claim nothing.
    expect(settled.next_attempt_at).toBeNull();
    expect(report.retriesScheduled).toBe(1);

    await drainOutbox(makeDeps(adapter), connection);
    expect(adapter.createCalls).toHaveLength(1);

    // The next pass reconciles FIRST (trackerSyncService.runWriteBack calls
    // processAmbiguous ahead of drainOutbox) and adopts the child the lost
    // response created...
    const recovery = await processAmbiguous(makeDeps(adapter), connection);
    expect(recovery.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    expect(getLinkByEntity(raw, 'task', 'tsk_1', 'plane')?.external_id).toBe('proj-1/child-1');

    // ...so the drain behind it has nothing to send and the parent holds
    // EXACTLY ONE child.
    const drained = await drainOutbox(makeDeps(adapter), connection);
    expect(drained.created).toBe(0);
    expect(adapter.createCalls).toHaveLength(1);
    expect(adapter.issues).toHaveLength(1);
  });

  it('parks a network failure (no HTTP status) as ambiguous too', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new CommitThenFailAdapter();
    adapter.failAfterCommit = new TrackerApiError('plane', 'socket hang up');

    await drainOutbox(makeDeps(adapter), connection);

    expect(fetchOutbox(row.id).state).toBe('ambiguous');
  });

  it('still fails a non-idempotent create terminally on a 4xx (it provably never landed)', async () => {
    const connection = seedConnection({ provider: 'plane' });
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new FakeMarkerAdapter();
    adapter.failCreate = new TrackerApiError('plane', 'parent issue not found', 404);

    const report = await drainOutbox(makeDeps(adapter), connection);

    expect(report.failedTerminal).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('failed');
  });

  it('keeps the plain backoff retry for a provider with idempotent creates', async () => {
    const connection = seedConnection();
    const row = enqueueCreate(connection.id, 'tsk_1', 'client-key-1');
    const adapter = new FakeAdapter();
    adapter.failCreate = new TrackerApiError('linear', 'bad gateway', 502);

    const report = await drainOutbox(makeDeps(adapter), connection);

    // The client key IS the issue id there, so a repeat create cannot duplicate.
    expect(report.retriesScheduled).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('pending');
    expect(settled.next_attempt_at).toBe('2026-07-30 12:02:00');
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

  it('adopts an ambiguous TOP-LEVEL push by its marker, searching the container with no parent', async () => {
    const connection = seedConnection({ provider: 'plane' });
    // The originating idea has to still BE there: recovery re-reads it before
    // adopting, so that a create whose idea was removed mid-crash cannot come
    // back as an active link (see the orphan cases below).
    svc.seedDefaultBoard(PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id)
         VALUES ('ide_1', ?, 'IDEA-1', 'Ship the push direction', ?, ?)`,
      )
      .run(PROJECT_ID, `board-${PROJECT_ID}-default`, resolveStageIds(raw, PROJECT_ID).idea);
    const row = enqueueOutbox(raw, {
      connection_id: connection.id,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: 'ide_1',
      client_key: 'client-key-push',
      payload_json: '{}',
    });
    makeAmbiguous(row.id, connection.id);

    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      // A same-title top-level issue somebody else filed. Listed first, so a
      // title match would take it.
      makeIssue('proj-1/theirs', { title: 'Ship the push direction', parentExternalId: null }),
      makeIssue('proj-1/ours', { title: 'Ship the push direction', parentExternalId: null }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-push');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('done');
    // Linked back to the ORIGINATING idea — the whole point of the row.
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')?.external_id).toBe('proj-1/ours');
    // Scoped by the connection's source container, with NO parent constraint:
    // a top-level issue has no parent to key on.
    expect(adapter.clientKeyScopes).toEqual([
      { containerId: SELECTION.containerId, parentExternalId: null },
    ]);
  });

  /** A board + one idea row, so a recovered push has something to adopt onto. */
  function seedPushIdea(id: string, opts: { archived?: boolean } = {}): void {
    svc.seedDefaultBoard(PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id, archived_at)
         VALUES (?, ?, 'IDEA-1', 'Ship the push direction', ?, ?, ?)`,
      )
      .run(
        id,
        PROJECT_ID,
        `board-${PROJECT_ID}-default`,
        resolveStageIds(raw, PROJECT_ID).idea,
        opts.archived === true ? '2026-07-30 11:00:00' : null,
      );
  }

  /** An ambiguous top-level push whose issue DID land, carrying the row's marker. */
  function seedRecoverablePush(connectionId: string, entityId: string): TrackerOutboxRow {
    const row = enqueueOutbox(raw, {
      connection_id: connectionId,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: entityId,
      client_key: 'client-key-push',
      payload_json: '{}',
    });
    makeAmbiguous(row.id, connectionId);
    return row;
  }

  it('does NOT link a recovered push whose idea was DELETED during the crash window', async () => {
    // The remote create committed; only its response was lost. By the time
    // recovery runs — potentially a whole app restart later — the user has
    // hard-deleted the idea. Adopting anyway wrote an active link to an entity
    // that no longer exists: a zombie the inbound poller finds, fails to
    // resolve, and skips on every pass forever.
    const connection = seedConnection({ provider: 'plane' });
    const row = seedRecoverablePush(connection.id, 'ide_gone');
    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      makeIssue('proj-1/ours', { title: 'Ship the push direction', identifier: 'PROJ-8' }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-push');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(getLinkByEntity(raw, 'idea', 'ide_gone', 'plane')).toBeNull();
    expect(report.created).toBe(0);
    expect(report.orphanedCreates).toBe(1);
    expect(report.ambiguousResolved).toBe(1);

    // Settled, not failed — nothing is left to attempt. The stranded remote
    // issue is named on the row (and counted into the connection's sync log),
    // because this is the only record that it exists at all. It is deliberately
    // NOT deleted or cancelled remotely: the user's local removal said nothing
    // about an issue they never knew had been created.
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('done');
    expect(settled.last_error).toContain('gone');
    expect(settled.last_error).toContain('PROJ-8');
  });

  it('does NOT link a recovered push whose idea was ARCHIVED during the crash window', async () => {
    // Archived is the more dangerous of the two: the entity still EXISTS, so an
    // active link would keep inbound sync mutating something the user retired.
    const connection = seedConnection({ provider: 'plane' });
    seedPushIdea('ide_archived', { archived: true });
    const row = seedRecoverablePush(connection.id, 'ide_archived');
    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      makeIssue('proj-1/ours', { title: 'Ship the push direction', identifier: 'PROJ-8' }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-push');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(getLinkByEntity(raw, 'idea', 'ide_archived', 'plane')).toBeNull();
    expect(report.orphanedCreates).toBe(1);
    const settled = fetchOutbox(row.id);
    expect(settled.state).toBe('done');
    expect(settled.last_error).toContain('archived');
  });

  it('links a recovered push whose idea is still live', async () => {
    const connection = seedConnection({ provider: 'plane' });
    seedPushIdea('ide_1');
    seedRecoverablePush(connection.id, 'ide_1');
    const adapter = new FakeMarkerAdapter();
    adapter.issues = [
      makeIssue('proj-1/ours', { title: 'Ship the push direction', identifier: 'PROJ-8' }),
    ];
    adapter.markers.set('proj-1/ours', 'client-key-push');

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(1);
    expect(report.orphanedCreates).toBe(0);
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')?.external_id).toBe('proj-1/ours');
  });

  it('returns a PROVABLY-UNSENT top-level push to pending, and the drain then creates it once', async () => {
    const connection = seedConnection({ provider: 'plane' });
    svc.seedDefaultBoard(PROJECT_ID);
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id)
         VALUES ('ide_1', ?, 'IDEA-1', 'Ship the push direction', ?, ?)`,
      )
      .run(PROJECT_ID, `board-${PROJECT_ID}-default`, resolveStageIds(raw, PROJECT_ID).idea);
    const row = enqueueOutbox(raw, {
      connection_id: connection.id,
      kind: 'create_issue',
      entity_type: 'idea',
      entity_id: 'ide_1',
      client_key: 'client-key-push',
      payload_json: '{}',
    });
    makeAmbiguous(row.id, connection.id);

    // Nothing in the container carries our key, and every create writes one —
    // so the create PROVABLY never landed and a retry cannot duplicate it.
    const adapter = new FakeMarkerAdapter();
    adapter.issues = [makeIssue('proj-1/unrelated', { title: 'Something else' })];

    const report = await processAmbiguous(makeDeps(adapter), connection);

    expect(report.created).toBe(0);
    expect(report.ambiguousResolved).toBe(1);
    expect(fetchOutbox(row.id).state).toBe('pending');
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')).toBeNull();

    const drainReport = await drainOutbox(makeDeps(adapter), connection);
    expect(drainReport.created).toBe(1);
    expect(adapter.createCalls).toHaveLength(1);
    expect(getLinkByEntity(raw, 'idea', 'ide_1', 'plane')).not.toBeNull();
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
    // The row STAYS ambiguous — and specifically is not returned to `pending`.
    // An auth failure on the reconciling lookup says nothing about whether the
    // create landed, so retrying it could duplicate a sub-issue; and settling it
    // terminally would abandon a write that is still perfectly valid.
    const held = fetchOutbox(first.id);
    expect(held.state).toBe('ambiguous');
    expect(held.last_error).toContain('revoked key');
    expect(report.failedTerminal).toBe(0);
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
