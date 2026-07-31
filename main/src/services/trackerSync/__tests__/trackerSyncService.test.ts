/**
 * Unit tests for main/src/services/trackerSync/trackerSyncService.ts — the
 * assembly layer (poll loop, boot crash-recovery, per-connection pass).
 *
 * Wiring: a REAL temp-file DB through the full migration chain (same technique
 * as migration093.test.ts / inboundSync.test.ts) with the project's default
 * board seeded, a REAL TaskChangeRouter over that DB, a REAL write-back
 * listener subscribed to the REAL taskChangeEvents emitter, and a fake
 * TrackerAdapter injected through `adapterFactory`. Only two things are mocked:
 * Electron's `safeStorage` (so the secret decryption seam runs for real against
 * a reversible transform) and the network (there is none — the fake adapter IS
 * the seam).
 *
 * The 60s interval is deliberately NOT exercised; `tick()` is public precisely
 * so the loop is driven directly instead of against wall-clock timers.
 *
 * Covers, per the task brief:
 *   - boot recovery: `in_flight` -> `ambiguous` -> adopted on the next pass.
 *   - due-connection gating: a fresh pass stamps last_sync_at, a second tick
 *     inside the interval skips, and syncNow bypasses the gate.
 *   - phase order (ambiguous -> outbox drain -> inbound -> sweep), observed
 *     through the adapter's call log.
 *   - an auth failure pauses the connection and the loop survives it.
 *   - the composed sync log lands in last_sync_log_json with the connected-view
 *     markers.
 *   - the per-connection mutex coalesces concurrent syncConnection calls.
 *   - the entity-event listener is really subscribed: a stage move on a linked
 *     idea enqueues an outbox row, and drainConnection writes it back.
 *   - a connection with no stored key is paused rather than throwing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The global setup (main/src/test/setup.ts) mocks `electron` without
// safeStorage; override it here (hoisted before imports, mirroring
// secrets.test.ts) so the service's decryption seam runs for real.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: vi.fn(),
  safeStorage: {
    isEncryptionAvailable: (): boolean => true,
    encryptString: (plain: string): Buffer => Buffer.from(plain, 'utf-8'),
    decryptString: (cipher: Buffer): string => cipher.toString('utf-8'),
  },
}));

import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { TrackerConnectionRow, TrackerOutboxRow } from '../../../database/models';
import type {
  TrackerIssue,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import type { SubIssueDraft, TrackerAdapter, TrackerAdapterCapabilities } from '../adapterTypes';
import { TrackerAuthError } from '../errors';
import {
  enqueueOutbox,
  getConnection,
  getLinkByEntity,
  getLinkByExternal,
  insertConnection,
  listUnresolvedOutbox,
  type NewConnectionRow,
} from '../store';
import type { UpdateStatePayload } from '../writeBack';
import {
  SYNC_INTERVAL_MS,
  TrackerSyncService,
  type TrackerSyncLogEntry,
} from '../trackerSyncService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const CONN_ID = 'conn-1';

const STAGE = {
  idea: 'stage-board-1-default-1',
  done: 'stage-board-1-default-9',
};

const STATES: TrackerState[] = [
  { id: 'state-backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'state-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'state-done', name: 'Done', color: null, group: 'completed' },
  { id: 'state-canceled', name: 'Canceled', color: null, group: 'cancelled' },
];

const SOURCE: TrackerSourceSelection = { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' };

/**
 * Fake TrackerAdapter with a single ORDERED call log — the phase-order test
 * reads that log, so every method records itself before doing anything.
 */
class FakeAdapter implements TrackerAdapter {
  readonly provider = 'linear' as const;
  readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: true,
    selfHostedBaseUrl: false,
    idempotentCreate: true,
  };

  /** Every method call, in order — the phase-sequence assertion. */
  readonly calls: string[] = [];

  states: TrackerState[] = STATES;
  issues: TrackerIssue[] = [];
  /** Point-lookup table for getIssue (Linear's client key IS the created issue id). */
  issuesById = new Map<string, TrackerIssue>();
  /** Overrides the deletion sweep's ground truth; null = derive it from `issues`. */
  remoteIds: string[] | null = null;

  /** Scripted failure for listIssues, thrown on every call until cleared. */
  failListIssues: Error | null = null;
  /** When set, listIssues blocks on this promise (mutex / coalescing test). */
  gate: Promise<void> | null = null;

  readonly updateCalls: Array<{ externalId: string; stateId: string }> = [];

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    this.calls.push('validateCredentials');
    return { workspaceId: 'ws-1', workspaceName: 'Acme', actorLabel: 'K.' };
  }
  async listContainers(): Promise<TrackerSourceTree> {
    this.calls.push('listContainers');
    return { containerLabel: 'Team', containers: [] };
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    this.calls.push('listNarrows');
    return [];
  }
  async listStates(): Promise<TrackerState[]> {
    this.calls.push('listStates');
    return this.states;
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.calls.push('listIssues');
    if (this.gate !== null) await this.gate;
    if (this.failListIssues !== null) throw this.failListIssues;
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    this.calls.push('listIssueIds');
    return this.remoteIds ?? this.issues.map((issue) => issue.externalId);
  }
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    this.calls.push('getIssue');
    return this.issuesById.get(externalId) ?? null;
  }
  async createSubIssue(
    parentExternalId: string,
    draft: SubIssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.calls.push('createSubIssue');
    return makeIssue({ externalId: clientKey, title: draft.title, parentExternalId });
  }
  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    this.calls.push('updateIssueState');
    this.updateCalls.push({ externalId, stateId });
  }

  /** Calls filtered to the ones the phase-order assertion cares about. */
  phaseCalls(): string[] {
    return this.calls.filter((call) =>
      ['getIssue', 'listStates', 'updateIssueState', 'listIssues', 'listIssueIds'].includes(call),
    );
  }
}

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: 'ext-1',
    identifier: 'CORE-142',
    title: 'Ship the tracker sync',
    description: 'Two-way sync with Linear.',
    url: 'https://linear.app/acme/issue/CORE-142',
    stateId: 'state-backlog',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-07-30T10:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;
let router: TaskChangeRouter;
let adapter: FakeAdapter;
let service: TrackerSyncService;
let now: string;

/** The injected clock, advanced by tests that exercise the due-connection gate. */
function setNow(iso: string): void {
  now = iso;
}

function makeConnection(overrides: Partial<NewConnectionRow> = {}): TrackerConnectionRow {
  return insertConnection(raw, {
    id: CONN_ID,
    project_id: PROJECT_ID,
    provider: 'linear',
    status: 'active',
    workspace_id: 'ws-1',
    workspace_name: 'Acme',
    actor_label: 'K. Esteva',
    base_url: null,
    secret_ciphertext: Buffer.from('lin_api_key', 'utf-8'),
    source_json: JSON.stringify(SOURCE),
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
  });
}

function outboxRows(connectionId = CONN_ID): TrackerOutboxRow[] {
  return raw
    .prepare('SELECT * FROM tracker_outbox WHERE connection_id = ? ORDER BY id ASC')
    .all(connectionId) as TrackerOutboxRow[];
}

function storedLog(connectionId = CONN_ID): TrackerSyncLogEntry[] {
  const json = getConnection(raw, connectionId)?.last_sync_log_json;
  return json === null || json === undefined ? [] : (JSON.parse(json) as TrackerSyncLogEntry[]);
}

/** The rendered log, one 'marker line' string per entry — what the assertions read. */
function renderedLog(connectionId = CONN_ID): string[] {
  return storedLog(connectionId).map((entry) => `${entry.marker} ${entry.line}`);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-service-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw
    .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
    .run(PROJECT_ID, 'Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(PROJECT_ID);
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeAdapter();
  setNow('2026-07-30T12:00:00.000Z');
  service = new TrackerSyncService({
    db: raw,
    router,
    nowIso: () => now,
    adapterFactory: () => adapter,
  });
});

afterEach(() => {
  service.stop();
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Boot recovery
// ---------------------------------------------------------------------------

describe('TrackerSyncService boot recovery', () => {
  it('requeues in-flight writes as ambiguous at boot and adopts them on the next pass', async () => {
    makeConnection();
    const queued = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: 'tsk-1',
      client_key: 'ck-1',
      payload_json: JSON.stringify({
        parentExternalId: 'ext-parent',
        title: 'Mirrored task',
        description: null,
      }),
    });
    // The state a crash mid-API-call leaves behind.
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(queued.id);

    // The create DID land remotely — the response was just never seen.
    adapter.issuesById.set('ck-1', makeIssue({ externalId: 'ck-1', parentExternalId: 'ext-parent' }));
    adapter.remoteIds = ['ck-1'];

    service.start();

    expect(outboxRows()[0].state).toBe('ambiguous');

    const result = await service.syncConnection(CONN_ID);

    expect(result.error).toBeNull();
    expect(outboxRows()[0].state).toBe('done');
    const link = getLinkByEntity(raw, 'task', 'tsk-1', 'linear');
    expect(link?.external_id).toBe('ck-1');
    expect(link?.external_parent_id).toBe('ext-parent');
    expect(renderedLog()).toContain('· recovered 1 in-flight write');
  });

  it('leaves a paused connection alone at boot', () => {
    makeConnection({ status: 'paused' });
    const queued = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_state',
      external_id: 'ext-1',
      payload_json: JSON.stringify({ desiredGroup: 'completed' } satisfies UpdateStatePayload),
    });
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(queued.id);

    service.start();

    expect(outboxRows()[0].state).toBe('in_flight');
  });
});

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

describe('TrackerSyncService cadence', () => {
  it('syncs a never-synced connection, then skips it until the interval elapses', async () => {
    makeConnection();
    service.start();

    await service.tick();
    const first = getConnection(raw, CONN_ID);
    expect(first?.last_sync_at).not.toBeNull();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    // Same instant -> not due.
    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    // One second short of the interval -> still not due.
    setNow(new Date(Date.parse('2026-07-30T12:00:00.000Z') + SYNC_INTERVAL_MS - 1000).toISOString());
    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    // A full interval later -> due again.
    setNow(new Date(Date.parse('2026-07-30T12:00:00.000Z') + SYNC_INTERVAL_MS).toISOString());
    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(2);
  });

  it('syncNow bypasses the due gate', async () => {
    makeConnection();
    service.start();

    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    // Clock unchanged: the tick would skip, but a manual sync must not.
    await service.tick();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);

    const result = await service.syncNow(CONN_ID);
    expect(result.ran).toBe(true);
    expect(result.swept).toBe(true);
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(2);
  });

  it('skips connections that are not active', async () => {
    makeConnection({ status: 'paused' });
    service.start();

    await service.tick();

    expect(adapter.calls).toHaveLength(0);
    expect(getConnection(raw, CONN_ID)?.last_sync_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase order
// ---------------------------------------------------------------------------

describe('TrackerSyncService pass sequence', () => {
  it('runs ambiguous recovery, then the outbox drain, then inbound, then the sweep', async () => {
    makeConnection();

    // (1) an ambiguous create -> resolved by a point lookup (getIssue).
    const create = enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'create_sub_issue',
      entity_type: 'task',
      entity_id: 'tsk-1',
      client_key: 'ck-1',
      payload_json: JSON.stringify({
        parentExternalId: 'ext-parent',
        title: 'Mirrored task',
        description: null,
      }),
    });
    raw.prepare("UPDATE tracker_outbox SET state = 'in_flight' WHERE id = ?").run(create.id);
    adapter.issuesById.set('ck-1', makeIssue({ externalId: 'ck-1', parentExternalId: 'ext-parent' }));

    // (2) a pending state write -> listStates + updateIssueState.
    enqueueOutbox(raw, {
      connection_id: CONN_ID,
      kind: 'update_state',
      external_id: 'ext-parent',
      payload_json: JSON.stringify({ desiredGroup: 'completed' } satisfies UpdateStatePayload),
    });

    // (3) inbound has nothing to import; (4) the sweep still sees the adopted link.
    adapter.remoteIds = ['ck-1'];

    service.start();
    const result = await service.syncConnection(CONN_ID);

    expect(result.error).toBeNull();
    expect(adapter.phaseCalls()).toEqual([
      'getIssue', // 1. ambiguous recovery
      'listStates', // 2. outbox drain
      'updateIssueState',
      'listStates', // 3. inbound
      'listIssues',
      'listIssueIds', // 4. deletion sweep
    ]);
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-parent', stateId: 'state-done' }]);
    expect(outboxRows().every((row) => row.state === 'done')).toBe(true);
  });

  it('only sweeps on the first pass and on a forced one', async () => {
    makeConnection();
    service.start();

    // Pass 0 sweeps (the boot pass — the app was closed while deletes happened).
    setNow('2026-07-30T12:00:00.000Z');
    expect((await service.syncConnection(CONN_ID)).swept).toBe(true);

    // Pass 1 does not.
    setNow('2026-07-30T12:06:00.000Z');
    expect((await service.syncConnection(CONN_ID)).swept).toBe(false);

    // ...but a forced pass always does.
    expect((await service.syncNow(CONN_ID)).swept).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure policy
// ---------------------------------------------------------------------------

describe('TrackerSyncService failure policy', () => {
  it('pauses the connection on an auth failure and keeps the loop alive', async () => {
    makeConnection();
    adapter.failListIssues = new TrackerAuthError('linear', 'token revoked', 401);
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.paused).toBe(true);
    expect(result.error).toContain('token revoked');
    expect(getConnection(raw, CONN_ID)?.status).toBe('paused');
    expect(renderedLog().some((line) => line.startsWith('⚠ authorization failed'))).toBe(true);

    // The loop survives: a later tick simply skips the now-paused connection.
    setNow('2026-07-30T13:00:00.000Z');
    await expect(service.tick()).resolves.toBeUndefined();
    expect(adapter.calls.filter((c) => c === 'listIssues')).toHaveLength(1);
  });

  it('pauses a connection whose API key was never stored', async () => {
    makeConnection({ secret_ciphertext: null });
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.paused).toBe(true);
    expect(result.error).toContain('no stored API key');
    expect(getConnection(raw, CONN_ID)?.status).toBe('paused');
    // Nothing reached the provider.
    expect(adapter.calls).toHaveLength(0);
  });

  it('keeps a connection ACTIVE after a non-auth failure so the next tick retries', async () => {
    makeConnection();
    adapter.failListIssues = new Error('socket hang up');
    service.start();

    const result = await service.syncConnection(CONN_ID);

    expect(result.paused).toBe(false);
    expect(getConnection(raw, CONN_ID)?.status).toBe('active');
    expect(renderedLog()).toContain('⚠ sync failed · socket hang up');
    // last_sync_at is stamped even on failure, so the retry waits a full
    // interval instead of hammering every tick.
    expect(getConnection(raw, CONN_ID)?.last_sync_at).not.toBeNull();
  });

  it('returns a not-found result for an unknown connection without persisting anything', async () => {
    const result = await service.syncConnection('nope');
    expect(result).toEqual({
      connectionId: 'nope',
      ran: false,
      swept: false,
      paused: false,
      entries: [],
      error: 'connection not found',
    });
  });
});

// ---------------------------------------------------------------------------
// Sync log
// ---------------------------------------------------------------------------

describe('TrackerSyncService sync log', () => {
  it('persists the pass log to last_sync_log_json with the connected-view markers', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    service.start();

    await service.syncConnection(CONN_ID);

    expect(renderedLog()).toEqual([
      '▸ GET issues',
      '· matched 0',
      '✓ created 1 idea',
      '▸ GET issue ids',
      '✓ sync complete · next in 5m',
    ]);

    // Now diverge both sides of one field so the Auto merge records an override.
    const link = getLinkByExternal(raw, CONN_ID, 'ext-1');
    expect(link).not.toBeNull();
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: link?.entity_id ?? '',
      fields: { title: 'Locally renamed' },
    });
    adapter.issues = [makeIssue({ title: 'Remotely renamed', updatedAt: '2026-07-30T11:00:00.000Z' })];

    await service.syncNow(CONN_ID);

    const lines = renderedLog();
    expect(lines).toContain('▸ GET issues');
    expect(lines).toContain('· matched 1');
    expect(lines).toContain('✓ updated 1 linked item');
    expect(lines).toContain('✎ conflicts 1');
    expect(lines[lines.length - 1]).toBe('✓ sync complete · next in 5m');
  });
});

// ---------------------------------------------------------------------------
// Mutex
// ---------------------------------------------------------------------------

describe('TrackerSyncService per-connection mutex', () => {
  it('coalesces concurrent syncConnection calls onto one pass', async () => {
    makeConnection();
    let release: () => void = () => undefined;
    adapter.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.start();

    const first = service.syncConnection(CONN_ID);
    const second = service.syncConnection(CONN_ID);
    const third = service.syncNow(CONN_ID);

    release();
    const [a, b, c] = await Promise.all([first, second, third]);

    // One pass, one fetch, one identical result handed to all three callers.
    expect(adapter.calls.filter((call) => call === 'listIssues')).toHaveLength(1);
    expect(b).toBe(a);
    expect(c).toBe(a);

    // The lock releases: a later call runs a fresh pass.
    adapter.gate = null;
    await service.syncNow(CONN_ID);
    expect(adapter.calls.filter((call) => call === 'listIssues')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Write-back wiring
// ---------------------------------------------------------------------------

describe('TrackerSyncService write-back wiring', () => {
  it('turns a stage move on a linked idea into an outbox row and drains it', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    service.start();

    // Pass 1 imports the issue as an idea and links it.
    await service.syncConnection(CONN_ID);
    const link = getLinkByExternal(raw, CONN_ID, 'ext-1');
    expect(link).not.toBeNull();
    const ideaId = link?.entity_id ?? '';

    // A real entity write -> a real TaskChangedEvent on TASK_ALL_CHANNEL ->
    // the subscribed listener enqueues the write-back.
    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });

    const pending = listUnresolvedOutbox(raw, CONN_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0].kind).toBe('update_state');
    expect(pending[0].external_id).toBe('ext-1');

    // The debounced drain's body, invoked directly (the 2s timer is the only
    // part not exercised here).
    const drained = await service.drainConnection(CONN_ID);

    expect(drained.error).toBeNull();
    expect(adapter.updateCalls).toEqual([{ externalId: 'ext-1', stateId: 'state-done' }]);
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
    // The drain APPENDS to the pass log and leaves the poll clock alone.
    expect(renderedLog()).toContain('✓ wrote 1 issue state');
    expect(renderedLog()).toContain('▸ GET issues');
  });

  it('stops reacting to entity events after stop()', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    service.start();
    await service.syncConnection(CONN_ID);
    const ideaId = getLinkByExternal(raw, CONN_ID, 'ext-1')?.entity_id ?? '';

    service.stop();

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });

    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(0);
  });

  it('start() is idempotent — a second start does not double-subscribe', async () => {
    makeConnection();
    adapter.issues = [makeIssue()];
    service.start();
    service.start();
    await service.syncConnection(CONN_ID);
    const ideaId = getLinkByExternal(raw, CONN_ID, 'ext-1')?.entity_id ?? '';

    await router.applyChange(PROJECT_ID, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideaId,
      stageId: STAGE.done,
    });

    // A double subscription would enqueue twice (the dedupe guard would in fact
    // catch it, but the row count is the honest signal for "subscribed once").
    expect(listUnresolvedOutbox(raw, CONN_ID)).toHaveLength(1);
  });
});
