/**
 * Unit tests for the TrackerSyncFacade half of
 * main/src/services/trackerSync/trackerSyncService.ts — everything the
 * Settings > Integrations tRPC surface calls (wizard probes, connect,
 * connected-view reads, settings, disconnect, conflict resolution).
 *
 * Wiring mirrors inboundSync.test.ts / trackerSyncService.test.ts: a REAL
 * temp-file DB through the full migration chain with the project's default
 * board seeded, a REAL TaskChangeRouter over that DB (so archives, title edits
 * and stage moves actually land, entity_events included), and a fake
 * TrackerAdapter injected through `adapterFactory`. Only Electron's
 * `safeStorage` is mocked, with a reversible transform, so the encrypt/decrypt
 * seam runs for real.
 *
 * Covers, per the task brief:
 *   - wizardValidate: adapter passthrough, built from the PASTED key, and
 *     nothing persisted (no connection row, no secret).
 *   - connect: row + encrypted secret + reconcile links/discards + the
 *     fire-and-forget first pass, plus the 'connection' broadcast.
 *   - connections(): the summary's counts, source label, mapping and
 *     defensively-parsed log.
 *   - resolveConflictChoice: all four branches (field remote / field local /
 *     remote_deleted remote / remote_deleted local), plus the description
 *     branch's provenance-footer preservation.
 *   - disconnect: status + the cleared secret + delisting.
 *   - reconcilePreview: which entities are candidates and how a title matches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The global setup (main/src/test/setup.ts) mocks `electron` without
// safeStorage; override it here (hoisted before imports, mirroring
// trackerSyncService.test.ts) so the secret seam runs for real.
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
import {
  trackerProjectChannel,
  trackerSyncEvents,
  type TrackerChangedEvent,
} from '../../../orchestrator/trackerSyncBridge';
import type {
  EntityExternalLinkRow,
  TrackerConflictRow,
  TrackerConnectionRow,
  TrackerOutboxRow,
} from '../../../database/models';
import type {
  TrackerConnectPayload,
  TrackerCredentialsInput,
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
  getConnection,
  insertConflict,
  insertConnection,
  readSecret,
  upsertLink,
  type NewConnectionRow,
} from '../store';
import type { UpdateStatePayload } from '../writeBack';
import { TrackerSyncService } from '../trackerSyncService';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 1;
const CONN_ID = 'conn-1';
const API_KEY = 'lin_api_key_secret';

const STAGE = {
  idea: 'stage-board-1-default-1',
  ready: 'stage-board-1-default-6',
  done: 'stage-board-1-default-9',
};

const STATES: TrackerState[] = [
  { id: 'state-backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'state-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'state-done', name: 'Done', color: null, group: 'completed' },
];

const SOURCE: TrackerSourceSelection = { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' };

const CREDENTIALS: TrackerCredentialsInput = { provider: 'linear', apiKey: API_KEY };

/** Fake adapter recording what the facade asked of it. */
class FakeAdapter implements TrackerAdapter {
  readonly provider = 'linear' as const;
  readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: true,
    selfHostedBaseUrl: false,
    idempotentCreate: true,
  };

  readonly calls: string[] = [];
  states: TrackerState[] = STATES;
  issues: TrackerIssue[] = [];
  /** Scripted failure for validateCredentials (the auth-error path). */
  failValidate: Error | null = null;

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    this.calls.push('validateCredentials');
    if (this.failValidate !== null) throw this.failValidate;
    return { workspaceId: 'ws-1', workspaceName: 'Acme', actorLabel: 'K. Esteva' };
  }
  async listContainers(): Promise<TrackerSourceTree> {
    this.calls.push('listContainers');
    return { containerLabel: 'Team', containers: [{ id: 'team-1', name: 'Core', key: 'COR', openIssueCount: 3 }] };
  }
  async listNarrows(containerId: string): Promise<TrackerSourceNarrow[]> {
    this.calls.push(`listNarrows:${containerId}`);
    return [{ id: 'all', kind: 'all', name: 'Whole team', issueCount: 3 }];
  }
  async listStates(): Promise<TrackerState[]> {
    this.calls.push('listStates');
    return this.states;
  }
  async listIssues(): Promise<TrackerIssue[]> {
    this.calls.push('listIssues');
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    this.calls.push('listIssueIds');
    return this.issues.map((issue) => issue.externalId);
  }
  async getIssue(): Promise<TrackerIssue | null> {
    this.calls.push('getIssue');
    return null;
  }
  async createSubIssue(
    parentExternalId: string,
    draft: SubIssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    this.calls.push('createSubIssue');
    return makeIssue({ externalId: clientKey, title: draft.title, parentExternalId });
  }
  async updateIssueState(): Promise<void> {
    this.calls.push('updateIssueState');
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
/** Every (connection, secret) pair the injected factory was called with. */
let factoryCalls: Array<{ connection: TrackerConnectionRow; secret: string }>;
/** Every TrackerChangedEvent broadcast on the project channel. */
let broadcasts: TrackerChangedEvent[];
let onBroadcast: (event: TrackerChangedEvent) => void;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-facade-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw
    .prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
    .run(PROJECT_ID, 'Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(PROJECT_ID);
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeAdapter();
  factoryCalls = [];
  broadcasts = [];
  onBroadcast = (event: TrackerChangedEvent): void => {
    broadcasts.push(event);
  };
  trackerSyncEvents.on(trackerProjectChannel(PROJECT_ID), onBroadcast);
  service = new TrackerSyncService({
    db: raw,
    router,
    nowIso: () => '2026-07-30T12:00:00.000Z',
    adapterFactory: (connection, secret) => {
      factoryCalls.push({ connection, secret });
      return adapter;
    },
  });
});

afterEach(() => {
  trackerSyncEvents.off(trackerProjectChannel(PROJECT_ID), onBroadcast);
  service.stop();
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

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
    secret_ciphertext: Buffer.from(API_KEY, 'utf-8'),
    source_json: JSON.stringify({ ...SOURCE, label: 'Core · Whole team' }),
    selection_mode: 'all',
    selection_json: null,
    state_mapping_json: '{}',
    two_way: 1,
    mirror_subissues: 1,
    conflict_mode: 'manual',
    cursor_updated_at: null,
    cursor_external_id: null,
    last_sync_at: null,
    last_sync_log_json: null,
    ...overrides,
  });
}

/** Create an entity through the REAL chokepoint and return its id. */
async function createEntity(
  entityType: 'idea' | 'task',
  fields: { title: string; body?: string | null; stageId?: string },
): Promise<string> {
  const { taskId } = await router.applyChange(PROJECT_ID, {
    actor: 'user',
    entityType,
    title: fields.title,
    body: fields.body ?? null,
    ...(fields.stageId !== undefined ? { initialStageId: fields.stageId } : {}),
  });
  return taskId;
}

interface EntityRow {
  ref: string;
  title: string;
  body: string | null;
  stage_id: string;
  archived_at: string | null;
}

function readIdea(id: string): EntityRow {
  return raw
    .prepare('SELECT ref, title, body, stage_id, archived_at FROM ideas WHERE id = ?')
    .get(id) as EntityRow;
}

function conflictRow(id: number): TrackerConflictRow {
  return raw.prepare('SELECT * FROM tracker_conflicts WHERE id = ?').get(id) as TrackerConflictRow;
}

function linkRow(id: number): EntityExternalLinkRow {
  return raw
    .prepare('SELECT * FROM entity_external_links WHERE id = ?')
    .get(id) as EntityExternalLinkRow;
}

function outboxRows(connectionId = CONN_ID): TrackerOutboxRow[] {
  return raw
    .prepare('SELECT * FROM tracker_outbox WHERE connection_id = ? ORDER BY id ASC')
    .all(connectionId) as TrackerOutboxRow[];
}

function connectPayload(overrides: Partial<TrackerConnectPayload> = {}): TrackerConnectPayload {
  return {
    projectId: PROJECT_ID,
    credentials: CREDENTIALS,
    source: SOURCE,
    sourceLabel: 'Core · Whole team',
    selectionMode: 'all',
    selectionJson: null,
    stateMapping: { 'state-backlog': 'idea', 'state-done': 'done' },
    twoWay: true,
    mirrorSubissues: true,
    conflictMode: 'auto',
    reconcile: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Wizard probes
// ---------------------------------------------------------------------------

describe('TrackerSyncService wizard probes', () => {
  it('validates through an ad-hoc adapter built from the pasted key and persists nothing', async () => {
    const identity = await service.wizardValidate({
      provider: 'plane',
      apiKey: 'plane_key',
      baseUrl: 'https://plane.acme.dev',
      workspaceSlug: 'acme',
    });

    expect(identity).toEqual({ workspaceId: 'ws-1', workspaceName: 'Acme', actorLabel: 'K. Esteva' });
    expect(adapter.calls).toEqual(['validateCredentials']);

    // The scratch row carries the wizard's credentials verbatim...
    expect(factoryCalls).toHaveLength(1);
    expect(factoryCalls[0].secret).toBe('plane_key');
    expect(factoryCalls[0].connection.provider).toBe('plane');
    expect(factoryCalls[0].connection.base_url).toBe('https://plane.acme.dev');
    expect(factoryCalls[0].connection.workspace_id).toBe('acme');

    // ...and NOTHING was written: no connection row, so no secret either.
    const rows = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('passes the wizard listing calls straight through to the adapter', async () => {
    await expect(service.wizardContainers(CREDENTIALS)).resolves.toEqual({
      containerLabel: 'Team',
      containers: [{ id: 'team-1', name: 'Core', key: 'COR', openIssueCount: 3 }],
    });
    await expect(service.wizardNarrows(CREDENTIALS, 'team-1')).resolves.toHaveLength(1);
    await expect(service.wizardStates(CREDENTIALS, SOURCE)).resolves.toEqual(STATES);

    adapter.issues = [makeIssue()];
    await expect(service.wizardIssues(CREDENTIALS, SOURCE)).resolves.toHaveLength(1);

    expect(adapter.calls).toEqual([
      'listContainers',
      'listNarrows:team-1',
      'listStates',
      'listIssues',
    ]);
  });

  it('surfaces the adapter auth error unchanged (the router maps it to UNAUTHORIZED)', async () => {
    adapter.failValidate = new TrackerAuthError('linear', 'invalid API key', 401);
    await expect(service.wizardValidate(CREDENTIALS)).rejects.toBeInstanceOf(TrackerAuthError);
  });
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('TrackerSyncService.connect', () => {
  it('writes the row + encrypted secret, applies reconcile decisions, and kicks the first pass', async () => {
    const keepId = await createEntity('idea', { title: 'Keep me' });
    const linkId = await createEntity('idea', { title: 'Link me' });
    const discardId = await createEntity('idea', { title: 'Discard me' });

    const { connectionId } = await service.connect(
      connectPayload({
        reconcile: [
          { entityType: 'idea', entityId: keepId, action: 'keep' },
          { entityType: 'idea', entityId: linkId, action: 'link', linkExternalId: 'ext-42' },
          { entityType: 'idea', entityId: discardId, action: 'discard' },
        ],
      }),
    );

    const row = getConnection(raw, connectionId);
    expect(row).not.toBeNull();
    expect(row?.project_id).toBe(PROJECT_ID);
    expect(row?.provider).toBe('linear');
    expect(row?.status).toBe('active');
    // Workspace identity comes from the LIVE probe, not from the payload.
    expect(row?.workspace_id).toBe('ws-1');
    expect(row?.workspace_name).toBe('Acme');
    expect(row?.actor_label).toBe('K. Esteva');
    expect(row?.two_way).toBe(1);
    expect(row?.mirror_subissues).toBe(1);
    expect(row?.conflict_mode).toBe('auto');
    expect(JSON.parse(row?.source_json ?? '{}')).toEqual({ ...SOURCE, label: 'Core · Whole team' });
    expect(JSON.parse(row?.state_mapping_json ?? '{}')).toEqual({
      'state-backlog': 'idea',
      'state-done': 'done',
    });

    // The key is stored ENCRYPTED (the mocked transform is reversible).
    const cipher = readSecret(raw, connectionId);
    expect(cipher).not.toBeNull();
    expect((cipher as Buffer).toString('utf-8')).toBe(API_KEY);

    // link -> a link row with NO baseline (the first inbound pass adopts one).
    const link = raw
      .prepare('SELECT * FROM entity_external_links WHERE entity_id = ?')
      .get(linkId) as EntityExternalLinkRow | undefined;
    expect(link?.external_id).toBe('ext-42');
    expect(link?.connection_id).toBe(connectionId);
    expect(link?.baseline_json).toBeNull();

    // discard -> archived IN PLACE; keep -> untouched, and never linked.
    expect(readIdea(discardId).archived_at).not.toBeNull();
    expect(readIdea(keepId).archived_at).toBeNull();
    const keepLink = raw
      .prepare('SELECT * FROM entity_external_links WHERE entity_id = ?')
      .get(keepId);
    expect(keepLink).toBeUndefined();

    // The connect broadcast lands immediately; the fire-and-forget first pass
    // stamps last_sync_at and broadcasts 'sync' a tick later.
    expect(broadcasts.some((e) => e.kind === 'connection' && e.connectionId === connectionId)).toBe(
      true,
    );
    await vi.waitFor(() => {
      expect(getConnection(raw, connectionId)?.last_sync_at).not.toBeNull();
    });
    expect(adapter.calls).toContain('listIssues');
    expect(broadcasts.some((e) => e.kind === 'sync')).toBe(true);
  });

  it('aborts without persisting anything when a reconcile discard is rejected', async () => {
    // The discards run BEFORE anything is written, so a chokepoint rejection
    // (here: a vanished entity) fails the whole connect with no half-built
    // connection row left behind.
    await expect(
      service.connect(
        connectPayload({
          reconcile: [{ entityType: 'task', entityId: 'tsk_gone', action: 'discard' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });

    const rows = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// connections()
// ---------------------------------------------------------------------------

describe('TrackerSyncService.connections', () => {
  it('summarizes a connection with active-link and open-conflict counts', async () => {
    makeConnection({
      state_mapping_json: JSON.stringify({ 'state-backlog': 'idea', 'state-bogus': 'nonsense' }),
      // A malformed entry mixed into the log: the parse keeps what it can.
      last_sync_log_json: JSON.stringify([{ marker: '✓', line: 'sync complete' }, { nope: 1 }]),
      last_sync_at: '2026-07-30 11:59:00',
    });
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    const otherId = await createEntity('idea', { title: 'Orphaned idea' });
    const live = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
    });
    const orphan = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: otherId,
      provider: 'linear',
      external_id: 'ext-2',
    });
    raw.prepare(`UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?`).run(
      orphan.id,
    );
    insertConflict(raw, {
      connection_id: CONN_ID,
      link_id: live.id,
      kind: 'field_conflict',
      field: 'title',
      local_value: 'Ours',
      remote_value: 'Theirs',
    });
    const resolved = insertConflict(raw, {
      connection_id: CONN_ID,
      link_id: live.id,
      kind: 'field_conflict',
      field: 'description',
    });
    raw.prepare(`UPDATE tracker_conflicts SET state = 'resolved' WHERE id = ?`).run(resolved.id);

    const [summary] = await service.connections(PROJECT_ID);

    expect(summary.id).toBe(CONN_ID);
    expect(summary.provider).toBe('linear');
    expect(summary.status).toBe('active');
    expect(summary.workspaceName).toBe('Acme');
    expect(summary.actorLabel).toBe('K. Esteva');
    expect(summary.baseUrl).toBeNull();
    expect(summary.sourceLabel).toBe('Core · Whole team');
    expect(summary.twoWay).toBe(true);
    expect(summary.mirrorSubissues).toBe(true);
    expect(summary.conflictMode).toBe('manual');
    // The unknown mapping target is dropped, the valid one survives.
    expect(summary.stateMapping).toEqual({ 'state-backlog': 'idea' });
    expect(summary.lastSyncAt).toBe('2026-07-30 11:59:00');
    expect(summary.lastSyncLog).toEqual([{ marker: '✓', line: 'sync complete' }]);
    expect(summary.linkedCount).toBe(1);
    expect(summary.openConflictCount).toBe(1);
  });

  it('applies a settings patch key-by-key and broadcasts the change', async () => {
    makeConnection();

    await service.updateSettings(CONN_ID, {
      twoWay: false,
      conflictMode: 'auto',
      selectionMode: 'assignee',
      selectionJson: { assigneeIds: ['user-1'] },
    });

    const row = getConnection(raw, CONN_ID);
    expect(row?.two_way).toBe(0);
    expect(row?.conflict_mode).toBe('auto');
    expect(row?.selection_mode).toBe('assignee');
    expect(JSON.parse(row?.selection_json ?? '{}')).toEqual({ assigneeIds: ['user-1'] });
    // Untouched keys keep their stored value.
    expect(row?.mirror_subissues).toBe(1);
    expect(broadcasts).toContainEqual({
      projectId: PROJECT_ID,
      connectionId: CONN_ID,
      kind: 'connection',
    });
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe('TrackerSyncService.disconnect', () => {
  it('marks the connection disconnected, clears the secret, and keeps the links', async () => {
    makeConnection();
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
    });

    await service.disconnect(CONN_ID);

    expect(getConnection(raw, CONN_ID)?.status).toBe('disconnected');
    expect(readSecret(raw, CONN_ID)).toBeNull();
    const links = raw
      .prepare('SELECT COUNT(*) AS n FROM entity_external_links WHERE connection_id = ?')
      .get(CONN_ID) as { n: number };
    expect(links.n).toBe(1);
    // A disconnected connection is no longer a connected-view card.
    await expect(service.connections(PROJECT_ID)).resolves.toEqual([]);
    expect(broadcasts).toContainEqual({
      projectId: PROJECT_ID,
      connectionId: CONN_ID,
      kind: 'connection',
    });
  });
});

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

describe('TrackerSyncService conflict resolution', () => {
  /** A manual-mode connection + a linked idea + one open conflict on it. */
  async function seedConflict(
    conflict: {
      kind: TrackerConflictRow['kind'];
      field?: string | null;
      local_value?: string | null;
      remote_value?: string | null;
    },
    idea: { title?: string; body?: string | null } = {},
  ): Promise<{ ideaId: string; link: EntityExternalLinkRow; conflictId: number }> {
    makeConnection();
    const ideaId = await createEntity('idea', {
      title: idea.title ?? 'Local title',
      body: idea.body ?? null,
    });
    const link = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
      baseline_json: JSON.stringify({
        title: 'Baseline title',
        description: 'Baseline description',
        stateId: 'state-backlog',
        updatedAt: '2026-07-29T10:00:00.000Z',
        lastWrittenGroup: 'started',
      }),
    });
    const row = insertConflict(raw, {
      connection_id: CONN_ID,
      link_id: link.id,
      kind: conflict.kind,
      field: conflict.field ?? null,
      local_value: conflict.local_value ?? null,
      remote_value: conflict.remote_value ?? null,
    });
    return { ideaId, link, conflictId: row.id };
  }

  it('lists open conflicts with the linked entity ref + title', async () => {
    const { ideaId, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'title',
      local_value: 'Local title',
      remote_value: 'Remote title',
    });

    const [summary] = await service.conflicts(CONN_ID);
    expect(summary.id).toBe(conflictId);
    expect(summary.kind).toBe('field_conflict');
    expect(summary.field).toBe('title');
    expect(summary.localValue).toBe('Local title');
    expect(summary.remoteValue).toBe('Remote title');
    expect(summary.entityRef).toBe(readIdea(ideaId).ref);
    expect(summary.entityTitle).toBe('Local title');
  });

  it("field conflict + 'remote': applies the remote title and stamps the baseline", async () => {
    const { ideaId, link, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'title',
      local_value: 'Local title',
      remote_value: 'Remote title',
    });

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdea(ideaId).title).toBe('Remote title');
    const baseline = JSON.parse(linkRow(link.id).baseline_json ?? '{}') as Record<string, unknown>;
    expect(baseline.title).toBe('Remote title');
    // The outbound half's own key on the same blob survives the stamp.
    expect(baseline.lastWrittenGroup).toBe('started');
    expect(conflictRow(conflictId).state).toBe('resolved');
    expect(conflictRow(conflictId).resolution).toBe('manual-remote');
    expect(broadcasts).toContainEqual({
      projectId: PROJECT_ID,
      connectionId: CONN_ID,
      kind: 'conflicts',
    });
  });

  it("field conflict + 'remote' on a description keeps the provenance footer", async () => {
    const body = 'Old description\n\n---\n<!-- cyboflow:tracker -->\nImported from Linear · [CORE-142](https://x)';
    const { ideaId, conflictId } = await seedConflict(
      {
        kind: 'field_conflict',
        field: 'description',
        local_value: 'Old description',
        remote_value: 'Fresh remote description',
      },
      { body },
    );

    await service.resolveConflictChoice(conflictId, 'remote');

    const next = readIdea(ideaId).body ?? '';
    expect(next).toContain('Fresh remote description');
    expect(next).toContain('<!-- cyboflow:tracker -->');
    expect(next).not.toContain('Old description');
  });

  it("field conflict + 'local' on a stage queues the write-back that converges the tracker", async () => {
    const { ideaId, conflictId } = await seedConflict({
      kind: 'field_conflict',
      field: 'stage',
      local_value: STAGE.done,
      remote_value: STAGE.ready,
    });

    await service.resolveConflictChoice(conflictId, 'local');

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].external_id).toBe('ext-1');
    expect(rows[0].entity_id).toBe(ideaId);
    expect((JSON.parse(rows[0].payload_json) as UpdateStatePayload).desiredGroup).toBe('completed');
    // The entity itself is untouched — local already IS the accepted value.
    expect(readIdea(ideaId).stage_id).toBe(STAGE.idea);
    expect(conflictRow(conflictId).resolution).toBe('manual-local');
  });

  it("remote_deleted + 'remote': archives the entity and orphans the link", async () => {
    const { ideaId, link, conflictId } = await seedConflict({ kind: 'remote_deleted' });

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdea(ideaId).archived_at).not.toBeNull();
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(conflictRow(conflictId).resolution).toBe('manual-remote');
  });

  it("remote_deleted + 'local': keeps the entity but stops syncing the link", async () => {
    const { ideaId, link, conflictId } = await seedConflict({ kind: 'remote_deleted' });

    await service.resolveConflictChoice(conflictId, 'local');

    expect(readIdea(ideaId).archived_at).toBeNull();
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(conflictRow(conflictId).resolution).toBe('manual-local');
  });

  it('is an idempotent no-op for an unknown or already-resolved conflict', async () => {
    const { conflictId } = await seedConflict({ kind: 'remote_deleted' });
    await service.resolveConflictChoice(conflictId, 'remote');
    broadcasts.length = 0;

    await service.resolveConflictChoice(conflictId, 'local');
    await service.resolveConflictChoice(9999, 'remote');

    // Still the FIRST ruling; nothing re-broadcast.
    expect(conflictRow(conflictId).resolution).toBe('manual-remote');
    expect(broadcasts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reconcilePreview + linkForEntity
// ---------------------------------------------------------------------------

describe('TrackerSyncService.reconcilePreview', () => {
  it('lists active unlinked entities and suggests a normalized-title match', async () => {
    makeConnection();
    const matched = await createEntity('idea', { title: 'Ship the Tracker Sync!' });
    const unmatched = await createEntity('task', { title: 'Rewrite the CSS tokens' });
    const done = await createEntity('idea', { title: 'Already done', stageId: STAGE.done });
    const linked = await createEntity('idea', { title: 'Already linked' });
    upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: linked,
      provider: 'linear',
      external_id: 'ext-9',
    });
    const archived = await createEntity('idea', { title: 'Archived idea' });
    await router.applyChange(PROJECT_ID, { actor: 'user', taskId: archived, archived: true });

    const items = await service.reconcilePreview(PROJECT_ID, [
      makeIssue({ externalId: 'ext-1', title: 'Ship the tracker sync' }),
      makeIssue({ externalId: 'ext-2', title: 'Upgrade the build pipeline' }),
    ]);

    const ids = items.map((item) => item.entityId);
    expect(ids).toContain(matched);
    expect(ids).toContain(unmatched);
    expect(ids).not.toContain(done);
    expect(ids).not.toContain(linked);
    expect(ids).not.toContain(archived);

    const matchedItem = items.find((item) => item.entityId === matched);
    expect(matchedItem?.entityType).toBe('idea');
    expect(matchedItem?.suggestedExternalId).toBe('ext-1');
    expect(items.find((item) => item.entityId === unmatched)?.suggestedExternalId).toBeNull();
  });

  it('resolves an entity link and skips orphaned ones', async () => {
    makeConnection();
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    const link = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
      external_identifier: 'CORE-142',
      external_url: 'https://linear.app/acme/issue/CORE-142',
    });

    await expect(service.linkForEntity('idea', ideaId)).resolves.toEqual({
      provider: 'linear',
      externalIdentifier: 'CORE-142',
      externalUrl: 'https://linear.app/acme/issue/CORE-142',
    });
    await expect(service.linkForEntity('idea', 'ide_missing')).resolves.toBeNull();

    raw.prepare(`UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?`).run(
      link.id,
    );
    await expect(service.linkForEntity('idea', ideaId)).resolves.toBeNull();
  });
});
