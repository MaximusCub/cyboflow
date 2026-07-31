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
 *     fire-and-forget first pass, plus the 'connection' broadcast — and the
 *     ordering that makes it safe: nothing is written when the credential probe
 *     fails, and a reconcile row rejected AFTER the row+secret anchor is logged
 *     and skipped rather than sinking the connection. Plus the revival IDENTITY:
 *     the same workspace slug on a DIFFERENT tracker instance mints a new
 *     connection, while the same instance spelled with a trailing slash (or left
 *     on the provider's default origin) revives the retired row.
 *   - connections(): the summary's counts, source label, mapping and
 *     defensively-parsed log.
 *   - resolveConflictChoice: all four branches (field remote / field local /
 *     remote_deleted remote / remote_deleted local), plus the description
 *     branch's provenance-footer preservation.
 *   - resolveConflictChoice ACROSS a following inbound pass: a ruling that does
 *     not advance the link's baseline re-opens the same conflict forever, so
 *     title/description/one-way-stage local rulings (and the remote ones) are
 *     each driven through a real second pass with the remote unchanged. The
 *     stage + 'remote' cases additionally run with the REAL write-back listener
 *     subscribed, because accepting a remote stage without first stamping the
 *     raw remote state echoed a write-back that overwrote the accepted state.
 *   - disconnect: status + the cleared secret + delisting.
 *   - unlinkEntity: the ruling applied DIRECTLY — 'keep' orphans with an empty
 *     outbox, 'cancel' queues exactly one deduped cancelled-group write, an
 *     unlinked entity reports { unlinked: false }.
 *   - stageUnlinkRuling: the STAGED ruling the board's delete path uses —
 *     staging alone mutates nothing, the committed delete/archive applies it,
 *     an abandoned one expires, a consumed one is not reused, a delete cascade
 *     orphans its children's links (with or without a ruling) and those children
 *     inherit the root's answer, and an archive with no ruling is left entirely
 *     alone (that is inbound sync's link to manage).
 *   - the three defenses that keep an ABANDONED ruling from being spent by an
 *     unrelated later removal: clearUnlinkRuling (the renderer's explicit
 *     discard), the ACTOR check (only an actor:'user' removal consumes one, so
 *     a provider- or orchestrator-authored archive/delete inside the window
 *     cannot), and the TTL underneath both.
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
import {
  TASK_ALL_CHANNEL,
  TaskChangeRouter,
  taskChangeEvents,
} from '../../../orchestrator/taskChangeRouter';
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
import { joinBody, splitBody, type EntityWriteRouter } from '../inboundSync';
import {
  getConnection,
  getLinkByExternal,
  insertConflict,
  insertConnection,
  readSecret,
  upsertLink,
  type NewConnectionRow,
  type UpsertLinkInput,
} from '../store';
import {
  createWriteBackListener,
  type UpdateStatePayload,
  type WriteBackListener,
} from '../writeBack';
import { TrackerSyncService } from '../trackerSyncService';
import type { TaskChangedEvent } from '../../../../../shared/types/tasks';

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
  /** The workspace the live probe reports — the reconnect identity key. */
  workspaceId = 'ws-1';

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    this.calls.push('validateCredentials');
    if (this.failValidate !== null) throw this.failValidate;
    return { workspaceId: this.workspaceId, workspaceName: 'Acme', actorLabel: 'K. Esteva' };
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
    recoveryClientKey: null,
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
/**
 * The service's injected clock, as a MUTABLE fixture: the staged-ruling TTL
 * reads it, so an expiry case advances this instead of waiting.
 */
let now: string;

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
  now = '2026-07-30T12:00:00.000Z';
  service = new TrackerSyncService({
    db: raw,
    router,
    nowIso: () => now,
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
  entityType: 'idea' | 'epic' | 'task',
  fields: {
    title: string;
    body?: string | null;
    stageId?: string;
    /** Lineage, so a case can build a real idea -> epic -> task delete cascade. */
    parentEpicId?: string;
    originatingIdeaId?: string;
  },
): Promise<string> {
  const { taskId } = await router.applyChange(PROJECT_ID, {
    actor: 'user',
    entityType,
    title: fields.title,
    body: fields.body ?? null,
    ...(fields.stageId !== undefined ? { initialStageId: fields.stageId } : {}),
    ...(fields.parentEpicId !== undefined ? { parentEpicId: fields.parentEpicId } : {}),
    ...(fields.originatingIdeaId !== undefined
      ? { originatingIdeaId: fields.originatingIdeaId }
      : {}),
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

/** Every conflict row for the connection, oldest first. */
function allConflicts(): TrackerConflictRow[] {
  return raw
    .prepare('SELECT * FROM tracker_conflicts ORDER BY id ASC')
    .all() as TrackerConflictRow[];
}

/** The one idea a real inbound pass imported (rowid = true insertion order). */
function importedIdeaId(): string {
  const rows = raw.prepare('SELECT id FROM ideas ORDER BY rowid ASC').all() as Array<{ id: string }>;
  if (rows.length !== 1) throw new Error(`expected exactly one imported idea, got ${rows.length}`);
  return rows[0].id;
}

/** A link's `baseline_json`, parsed. */
function baselineOf(externalId: string): Record<string, unknown> {
  const link = getLinkByExternal(raw, CONN_ID, externalId);
  if (!link) throw new Error(`no link for ${externalId}`);
  return JSON.parse(link.baseline_json ?? '{}') as Record<string, unknown>;
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

  it('writes nothing at all when the live credential probe fails', async () => {
    // The probe precedes the durable anchor (row + secret), which itself
    // precedes every reconcile decision — so a bad key leaves no connection row
    // AND no archived entity behind.
    const discardId = await createEntity('idea', { title: 'Discard me' });
    adapter.failValidate = new TrackerAuthError('linear', 'invalid API key', 401);

    await expect(
      service.connect(
        connectPayload({
          reconcile: [{ entityType: 'idea', entityId: discardId, action: 'discard' }],
        }),
      ),
    ).rejects.toBeInstanceOf(TrackerAuthError);

    const rows = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(rows.n).toBe(0);
    expect(readIdea(discardId).archived_at).toBeNull();
  });

  it('keeps the connection when one reconcile discard is rejected, and applies the rest', async () => {
    // The regression: discards used to be committed BEFORE the connection row
    // existed, so a rejection midway through archived the earlier entities and
    // then failed the connect — user data mutated, nothing to sync it with.
    const first = await createEntity('idea', { title: 'Discard one' });
    const rejected = await createEntity('idea', { title: 'Discard two' });
    const third = await createEntity('idea', { title: 'Discard three' });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    // A chokepoint that refuses exactly one of the three archives (an active run
    // on the entity is the real-world shape of this rejection).
    const guarded: EntityWriteRouter = {
      applyChange: async (projectId, change) => {
        if (change.taskId === rejected) throw new Error('an active run holds this entity');
        return router.applyChange(projectId, change);
      },
    };
    const guardedService = new TrackerSyncService({
      db: raw,
      router: guarded,
      nowIso: () => '2026-07-30T12:00:00.000Z',
      adapterFactory: () => adapter,
      logger,
    });

    const { connectionId } = await guardedService.connect(
      connectPayload({
        reconcile: [
          { entityType: 'idea', entityId: first, action: 'discard' },
          { entityType: 'idea', entityId: rejected, action: 'discard' },
          { entityType: 'idea', entityId: third, action: 'discard' },
        ],
      }),
    );

    // The connection the user just authorized survives, key included.
    expect(getConnection(raw, connectionId)?.status).toBe('active');
    expect((readSecret(raw, connectionId) as Buffer).toString('utf-8')).toBe(API_KEY);

    // Every OTHER decision still landed — one rejected row does not halt the loop.
    expect(readIdea(first).archived_at).not.toBeNull();
    expect(readIdea(rejected).archived_at).toBeNull();
    expect(readIdea(third).archived_at).not.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      '[trackerSync] reconcile discard failed',
      expect.objectContaining({ connectionId, entityId: rejected }),
    );

    // And the connection is live: the fire-and-forget first pass runs.
    await vi.waitFor(() => {
      expect(getConnection(raw, connectionId)?.last_sync_at).not.toBeNull();
    });
  });

  it('REVIVES the disconnected connection for the same workspace instead of duplicating the backlog', async () => {
    // The regression: disconnect deliberately KEEPS the links, but connect used
    // to always mint a fresh id — so a routine credential rotation (disconnect,
    // paste a new key, connect) stranded every link on the dead connection and
    // re-imported the entire synced backlog as brand-new ideas.
    adapter.issues = [makeIssue()];

    const first = await service.connect(connectPayload());
    await vi.waitFor(() => {
      expect(getConnection(raw, first.connectionId)?.last_sync_at).not.toBeNull();
    });
    const importedId = importedIdeaId();
    const link = getLinkByExternal(raw, first.connectionId, 'ext-1');
    expect(link?.entity_id).toBe(importedId);

    await service.disconnect(first.connectionId);
    const second = await service.connect(connectPayload());

    // Same row, re-armed — not a second connection.
    expect(second.connectionId).toBe(first.connectionId);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(count.n).toBe(1);
    const revived = getConnection(raw, first.connectionId);
    expect(revived?.status).toBe('active');
    expect((readSecret(raw, first.connectionId) as Buffer).toString('utf-8')).toBe(API_KEY);

    // The link survived the round trip and still points at the same idea.
    const relinked = getLinkByExternal(raw, first.connectionId, 'ext-1');
    expect(relinked?.id).toBe(link?.id);
    expect(relinked?.entity_id).toBe(importedId);

    // ...so the pass the reconnect kicks MERGES the same remote issue against
    // that link (a no-op diff) instead of importing a duplicate idea.
    await vi.waitFor(() => {
      expect(getConnection(raw, first.connectionId)?.last_sync_at).not.toBeNull();
    });
    expect(importedIdeaId()).toBe(importedId);
  });

  it('still mints a NEW connection when the workspace identity differs', async () => {
    const first = await service.connect(connectPayload());
    await service.disconnect(first.connectionId);

    // A different Linear organization is a different connection, links and all.
    adapter.workspaceId = 'ws-2';
    const second = await service.connect(connectPayload());

    expect(second.connectionId).not.toBe(first.connectionId);
    expect(getConnection(raw, first.connectionId)?.status).toBe('disconnected');
    expect(getConnection(raw, second.connectionId)?.status).toBe('active');
  });

  /** Plane credentials for a given instance — the workspace slug stays constant. */
  function planeCredentials(baseUrl: string | undefined): TrackerCredentialsInput {
    return {
      provider: 'plane',
      apiKey: API_KEY,
      workspaceSlug: 'acme',
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    };
  }

  it('mints a NEW connection when the same workspace slug lives on a DIFFERENT instance', async () => {
    // The regression: the revival key was (project, provider, workspace_id), but
    // a Plane workspace slug is unique only within ONE deployment. Reviving here
    // would rewrite base_url while KEEPING every link, so write-back would target
    // issue ids that belong to the other instance and the deletion sweep would
    // read its 404s as remote deletions.
    const first = await service.connect(
      connectPayload({ credentials: planeCredentials('https://plane.a.example') }),
    );
    await service.disconnect(first.connectionId);

    const second = await service.connect(
      connectPayload({ credentials: planeCredentials('https://plane.b.example') }),
    );

    expect(second.connectionId).not.toBe(first.connectionId);
    // The retired row keeps its links; nothing reads them while it is retired.
    expect(getConnection(raw, first.connectionId)?.status).toBe('disconnected');
    expect(getConnection(raw, first.connectionId)?.base_url).toBe('https://plane.a.example');
    expect(getConnection(raw, second.connectionId)?.base_url).toBe('https://plane.b.example');
  });

  it('still REVIVES when the base URL differs only by a trailing slash', async () => {
    const first = await service.connect(
      connectPayload({ credentials: planeCredentials('https://plane.a.example') }),
    );
    await service.disconnect(first.connectionId);

    const second = await service.connect(
      connectPayload({ credentials: planeCredentials('https://plane.a.example/') }),
    );

    expect(second.connectionId).toBe(first.connectionId);
    const count = raw.prepare('SELECT COUNT(*) AS n FROM tracker_connections').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('still REVIVES a Plane CLOUD connection whose base URL was left implicit', async () => {
    // The wizard pre-fills the cloud origin, so one life of the same cloud
    // connection can hold the literal string and the next a NULL.
    const first = await service.connect(
      connectPayload({ credentials: planeCredentials('https://api.plane.so') }),
    );
    await service.disconnect(first.connectionId);

    const second = await service.connect(connectPayload({ credentials: planeCredentials(undefined) }));

    expect(second.connectionId).toBe(first.connectionId);
    expect(getConnection(raw, first.connectionId)?.base_url).toBeNull();
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
// Conflicts — the pass AFTER the ruling
// ---------------------------------------------------------------------------

/**
 * A ruling has to SURVIVE the next inbound pass. These drive the whole loop
 * through the real engine — a pass that imports the issue, a local edit, a pass
 * that opens the conflict, the ruling, then ANOTHER pass with the remote
 * unchanged — because the defect they cover is invisible to any test that stops
 * at the ruling: accepting the LOCAL side left the link's baseline on the
 * PRE-conflict snapshot, so the next pass still read both sides as changed and
 * re-opened the conflict the user had just settled, every pass, forever.
 */
describe('TrackerSyncService conflict resolution — the pass AFTER the ruling', () => {
  /** A remote touch (a comment, a label) that carries the SAME merge-relevant fields. */
  const TOUCHED = '2026-07-30T11:00:00.000Z';
  const TOUCHED_AGAIN = '2026-07-30T12:30:00.000Z';

  /**
   * Import an issue through a REAL pass, apply `localEdit`, then run a second
   * pass with `remote` overlaid — which is what opens the conflict in manual
   * mode. Returns the imported idea and the single open conflict.
   */
  async function openConflict(
    remote: Partial<TrackerIssue>,
    localEdit: (ideaId: string) => Promise<unknown>,
    connection: Partial<NewConnectionRow> = {},
    imported: Partial<TrackerIssue> = {},
  ): Promise<{ ideaId: string; conflictId: number }> {
    makeConnection({ conflict_mode: 'manual', ...connection });
    adapter.issues = [makeIssue(imported)];
    await service.syncConnection(CONN_ID);

    const ideaId = importedIdeaId();
    await localEdit(ideaId);

    adapter.issues = [makeIssue({ updatedAt: TOUCHED, ...remote })];
    await service.syncConnection(CONN_ID);

    const opened = allConflicts();
    expect(opened).toHaveLength(1);
    expect(opened[0].state).toBe('open');
    return { ideaId, conflictId: opened[0].id };
  }

  const editTitle =
    (title: string) =>
    (ideaId: string): Promise<{ taskId: string }> =>
      router.applyChange(PROJECT_ID, {
        actor: 'user',
        entityType: 'idea',
        taskId: ideaId,
        fields: { title },
      });

  /** Rewrite the remote-owned HALF of the body, leaving the provenance footer. */
  const editDescription =
    (description: string) =>
    async (ideaId: string): Promise<void> => {
      const { footer } = splitBody(readIdea(ideaId).body);
      await router.applyChange(PROJECT_ID, {
        actor: 'user',
        entityType: 'idea',
        taskId: ideaId,
        fields: { body: joinBody(description, footer) },
      });
    };

  const moveStage =
    (stageId: string) =>
    (ideaId: string): Promise<{ taskId: string }> =>
      router.applyChange(PROJECT_ID, {
        actor: 'user',
        entityType: 'idea',
        taskId: ideaId,
        stageId,
      });

  it("title + 'local': the next pass re-opens nothing and the local title stands", async () => {
    const { ideaId, conflictId } = await openConflict({ title: 'Remote title' }, editTitle('Local title'));

    await service.resolveConflictChoice(conflictId, 'local');

    // The SAME remote title, re-delivered behind a bumped updatedAt — any remote
    // touch does that, and the merge sees the issue again.
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(allConflicts()[0].state).toBe('resolved');
    expect(readIdea(ideaId).title).toBe('Local title');
  });

  it("description + 'local': the next pass re-opens nothing and the local body stands", async () => {
    const { ideaId, conflictId } = await openConflict(
      { description: 'Remote description' },
      editDescription('Local description'),
    );

    await service.resolveConflictChoice(conflictId, 'local');

    adapter.issues = [makeIssue({ description: 'Remote description', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(allConflicts()[0].state).toBe('resolved');
    const body = readIdea(ideaId).body ?? '';
    expect(body).toContain('Local description');
    expect(body).not.toContain('Remote description');
    // The footer the import wrote is still there — the local half was kept whole.
    expect(body).toContain('<!-- cyboflow:tracker linear:ext-1 -->');
  });

  it("stage + 'local': the next pass re-opens nothing on a ONE-WAY connection", async () => {
    // two_way off means there is no convergence write-back to paper over a
    // baseline that never moved, so the baseline stamp is the ONLY thing that
    // can end the loop.
    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-progress' },
      moveStage(STAGE.done),
      { two_way: 0 },
    );
    expect(conflictRow(conflictId).field).toBe('stage');

    await service.resolveConflictChoice(conflictId, 'local');
    expect(outboxRows()).toEqual([]);

    adapter.issues = [makeIssue({ stateId: 'state-progress', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(allConflicts()[0].state).toBe('resolved');
    expect(readIdea(ideaId).stage_id).toBe(STAGE.done);
    // The stamp says what is TRUE: the remote is at that state, in that group.
    expect(baselineOf('ext-1').stateId).toBe('state-progress');
    expect(baselineOf('ext-1').lastWrittenGroup).toBe('started');
  });

  it("stage + 'local' clears a STALE write-back stamp and still queues the convergence write", async () => {
    // Imported from a started state, so the link's baseline carries
    // lastWrittenGroup='started'. The remote has since dropped back to Backlog,
    // which belongs to no write-back group — the stamp must REMOVE the key, or a
    // later genuine local move to In development would be deduped away against
    // a group the remote no longer sits in.
    const { conflictId } = await openConflict(
      { stateId: 'state-backlog' },
      moveStage(STAGE.done),
      { two_way: 1 },
      { stateId: 'state-progress' },
    );
    expect(baselineOf('ext-1').lastWrittenGroup).toBe('started');

    await service.resolveConflictChoice(conflictId, 'local');

    expect(baselineOf('ext-1')).not.toHaveProperty('lastWrittenGroup');
    expect(baselineOf('ext-1').stateId).toBe('state-backlog');
    // Two-way is on, so the tracker is still asked to converge onto our stage.
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect((JSON.parse(rows[0].payload_json) as UpdateStatePayload).desiredGroup).toBe('completed');
  });

  it('a LATER genuine remote edit still conflicts after a local ruling', async () => {
    const { conflictId } = await openConflict({ title: 'Remote title' }, editTitle('Local title'));
    await service.resolveConflictChoice(conflictId, 'local');

    adapter.issues = [makeIssue({ title: 'Remote title, revised', updatedAt: TOUCHED_AGAIN })];
    await service.syncConnection(CONN_ID);

    const rows = allConflicts();
    expect(rows).toHaveLength(2);
    expect(rows[1].state).toBe('open');
    expect(rows[1].field).toBe('title');
    expect(rows[1].local_value).toBe('Local title');
    expect(rows[1].remote_value).toBe('Remote title, revised');
  });

  it("stage + 'remote': the next pass refreshes the whole baseline by itself", async () => {
    // The stage branch of applyRemoteFieldValue deliberately stamps nothing
    // (`remote_value` is a board stage, not a provider state) and leans on the
    // merge to refresh the baseline once the entity agrees with the remote.
    // Proven here rather than assumed.
    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-progress' },
      moveStage(STAGE.done),
    );

    await service.resolveConflictChoice(conflictId, 'remote');
    expect(readIdea(ideaId).stage_id).toBe(STAGE.ready);

    adapter.issues = [makeIssue({ stateId: 'state-progress', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(readIdea(ideaId).stage_id).toBe(STAGE.ready);
    expect(baselineOf('ext-1').stateId).toBe('state-progress');
  });

  it("title + 'remote': the next pass re-opens nothing either", async () => {
    const { ideaId, conflictId } = await openConflict({ title: 'Remote title' }, editTitle('Local title'));

    await service.resolveConflictChoice(conflictId, 'remote');
    expect(readIdea(ideaId).title).toBe('Remote title');

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: TOUCHED_AGAIN })];
    const pass = await service.syncConnection(CONN_ID);

    expect(pass.error).toBeNull();
    expect(allConflicts()).toHaveLength(1);
    expect(readIdea(ideaId).title).toBe('Remote title');
  });

  /**
   * The REAL write-back listener on the REAL emitter, wired the way
   * TrackerSyncService.start does (and inboundSync.test.ts's echo-suppression
   * suite) — the only way an enqueue triggered by a resolution's own applyChange
   * is observable, since the listener runs INLINE on TaskChangeRouter's
   * post-commit emit.
   */
  let listener: WriteBackListener | null = null;
  let handler: ((event: TaskChangedEvent) => void) | null = null;

  function subscribeWriteBack(): void {
    const built = createWriteBackListener({ db: raw, nowIso: () => '2026-07-30 12:00:00' });
    const fn = (event: TaskChangedEvent): void => built.handleTaskChanged(event);
    taskChangeEvents.on(TASK_ALL_CHANNEL, fn);
    listener = built;
    handler = fn;
  }

  afterEach(() => {
    if (handler !== null) taskChangeEvents.off(TASK_ALL_CHANNEL, handler);
    listener?.dispose();
    listener = null;
    handler = null;
  });

  it("stage + 'remote' does not echo a write-back over the state the user just accepted", async () => {
    // The regression: accepting the REMOTE stage applied the mapped stage without
    // first stamping the raw remote state onto the baseline, so the inline
    // write-back listener read Done as a LOCAL move and queued an update_state —
    // and the worker picks the FIRST state of the group, dragging the issue off
    // 'Released' (the exact state the user accepted) onto 'Done'.
    adapter.states = [
      ...STATES,
      { id: 'state-released', name: 'Released', color: null, group: 'completed' },
    ];
    subscribeWriteBack();

    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-released' },
      // Ready for development deliberately writes nothing back, so the LOCAL half
      // of the conflict contributes no outbox row of its own.
      moveStage(STAGE.ready),
    );
    expect(conflictRow(conflictId).field).toBe('stage');
    expect(outboxRows()).toEqual([]);

    await service.resolveConflictChoice(conflictId, 'remote');

    // The entity moves...
    expect(readIdea(ideaId).stage_id).toBe(STAGE.done);
    // ...and NOTHING is queued back at the provider.
    expect(outboxRows()).toEqual([]);
    // The stamp says what is TRUE: the remote sits on that state, in that group.
    expect(baselineOf('ext-1').stateId).toBe('state-released');
    expect(baselineOf('ext-1').lastWrittenGroup).toBe('completed');
  });

  it("stage + 'remote' clears a STALE write-back stamp when the remote leaves the terminal groups", async () => {
    // Imported from a started state, so the baseline carries
    // lastWrittenGroup='started'. The remote has since dropped to Backlog, which
    // belongs to no write-back group — leaving the stale key would suppress a
    // later, genuine local move to In development.
    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-backlog' },
      moveStage(STAGE.done),
      { two_way: 1 },
      { stateId: 'state-progress' },
    );
    expect(baselineOf('ext-1').lastWrittenGroup).toBe('started');

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdea(ideaId).stage_id).toBe(STAGE.idea);
    expect(baselineOf('ext-1').stateId).toBe('state-backlog');
    expect(baselineOf('ext-1')).not.toHaveProperty('lastWrittenGroup');
  });

  it("stage + 'remote' on a LEGACY conflict row (no recorded remote state) still applies the stage", async () => {
    // Rows written before the payload carried the raw state cannot be stamped
    // without inventing a state id, so they keep the pre-fix behavior.
    const { ideaId, conflictId } = await openConflict(
      { stateId: 'state-progress' },
      moveStage(STAGE.done),
      { two_way: 0 },
    );
    raw
      .prepare('UPDATE tracker_conflicts SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify({ externalId: 'ext-1', mode: 'manual' }), conflictId);

    await service.resolveConflictChoice(conflictId, 'remote');

    expect(readIdea(ideaId).stage_id).toBe(STAGE.ready);
    expect(baselineOf('ext-1')).not.toHaveProperty('lastWrittenGroup');
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

// ---------------------------------------------------------------------------
// unlinkEntity — the local-delete ruling
// ---------------------------------------------------------------------------

describe('TrackerSyncService.unlinkEntity', () => {
  /** A linked idea on the default connection, ready to be deleted locally. */
  async function seedLinkedIdea(
    overrides: Partial<UpsertLinkInput> = {},
  ): Promise<{ ideaId: string; link: EntityExternalLinkRow }> {
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    const link = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
      external_identifier: 'CORE-142',
      external_url: 'https://linear.app/acme/issue/CORE-142',
      ...overrides,
    });
    return { ideaId, link };
  }

  it("'keep in the tracker' orphans the link and writes NOTHING to the outbox", async () => {
    makeConnection();
    const { ideaId, link } = await seedLinkedIdea();
    broadcasts.length = 0;

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: false })).resolves.toEqual({
      unlinked: true,
    });

    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(outboxRows()).toEqual([]);
    // The link is gone as far as every read model is concerned.
    await expect(service.linkForEntity('idea', ideaId)).resolves.toBeNull();
    expect(broadcasts).toEqual([
      { projectId: PROJECT_ID, connectionId: CONN_ID, kind: 'connection' },
    ]);
  });

  it("'cancel in the tracker' queues exactly one cancelled-group write and orphans the link", async () => {
    makeConnection();
    const { ideaId, link } = await seedLinkedIdea();

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: true })).resolves.toEqual({
      unlinked: true,
    });

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].external_id).toBe('ext-1');
    expect(rows[0].entity_type).toBe('idea');
    expect(rows[0].entity_id).toBe(ideaId);
    expect((JSON.parse(rows[0].payload_json) as UpdateStatePayload).desiredGroup).toBe('cancelled');
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('dedupes against an unresolved row already carrying the cancel', async () => {
    makeConnection();
    const { ideaId } = await seedLinkedIdea();

    await service.unlinkEntity('idea', ideaId, { cancelRemote: true });
    // The link is orphaned now, so a second ruling is a no-op — but re-linking
    // and ruling again must still not double-queue the same intent.
    upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
    });
    await service.unlinkEntity('idea', ideaId, { cancelRemote: true });

    expect(outboxRows()).toHaveLength(1);
  });

  it('reports { unlinked: false } for an unlinked or already-orphaned entity, queueing nothing', async () => {
    makeConnection();
    const { ideaId, link } = await seedLinkedIdea();
    raw.prepare(`UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?`).run(
      link.id,
    );
    broadcasts.length = 0;

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: true })).resolves.toEqual({
      unlinked: false,
    });
    await expect(
      service.unlinkEntity('idea', 'ide_missing', { cancelRemote: true }),
    ).resolves.toEqual({ unlinked: false });

    expect(outboxRows()).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('cancels even on a one-way connection — the ruling is about THIS issue, not the sync policy', async () => {
    makeConnection({ two_way: 0 });
    const { ideaId } = await seedLinkedIdea();

    await service.unlinkEntity('idea', ideaId, { cancelRemote: true });

    expect(outboxRows()).toHaveLength(1);
    expect((JSON.parse(outboxRows()[0].payload_json) as UpdateStatePayload).desiredGroup).toBe(
      'cancelled',
    );
  });

  it('skips the cancel on a disconnected connection (its key is gone) but still unlinks', async () => {
    makeConnection({ status: 'disconnected' });
    const { ideaId, link } = await seedLinkedIdea();

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: true })).resolves.toEqual({
      unlinked: true,
    });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('drops the entity\'s links in EVERY provider so nothing is left pointing at it', async () => {
    makeConnection();
    const planeConnection = makeConnection({ id: 'conn-plane', provider: 'plane' });
    const { ideaId, link } = await seedLinkedIdea();
    const planeLink = upsertLink(raw, {
      connection_id: planeConnection.id,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'plane',
      external_id: 'ext-plane-1',
    });

    await expect(service.unlinkEntity('idea', ideaId, { cancelRemote: true })).resolves.toEqual({
      unlinked: true,
    });

    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(linkRow(planeLink.id).orphaned_at).not.toBeNull();
    expect(outboxRows()).toHaveLength(1);
    expect(outboxRows(planeConnection.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stageUnlinkRuling — the STAGED local-removal ruling
//
// The whole point of the staging design: the dialog collects the answer and the
// COMMITTED delete/archive applies it, so a user who backs out of the confirm
// dialog behind it has mutated nothing. `service.start()` is what subscribes the
// consumption half to the entity-change broadcast, so every case here starts it.
// ---------------------------------------------------------------------------

describe('TrackerSyncService staged local-removal ruling', () => {
  /** A linked idea on the default connection, ready to be removed locally. */
  async function seedLinkedIdea(
    overrides: Partial<UpsertLinkInput> = {},
  ): Promise<{ ideaId: string; link: EntityExternalLinkRow }> {
    const ideaId = await createEntity('idea', { title: 'Linked idea' });
    const link = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-1',
      external_identifier: 'CORE-142',
      ...overrides,
    });
    return { ideaId, link };
  }

  /** The desired group of every outbox row, oldest first. */
  function queuedGroups(connectionId = CONN_ID): Array<string | undefined> {
    return outboxRows(connectionId).map(
      (row) => (JSON.parse(row.payload_json) as UpdateStatePayload).desiredGroup,
    );
  }

  it('stages WITHOUT mutating anything — no orphan, no outbox row, no broadcast', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();
    broadcasts.length = 0;

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });

    // The user is still looking at the delete confirm and may dismiss it.
    expect(linkRow(link.id).orphaned_at).toBeNull();
    expect(outboxRows()).toEqual([]);
    expect(broadcasts).toEqual([]);
    await expect(service.linkForEntity('idea', ideaId)).resolves.not.toBeNull();
  });

  it('applies the ruling only once the delete actually commits', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    expect(queuedGroups()).toEqual(['cancelled']);
    expect(outboxRows()[0].external_id).toBe('ext-1');
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('a ruling the user backed out of expires instead of surprising a later delete', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    // The confirm was dismissed; much later the idea is deleted for other reasons.
    now = '2026-07-30T12:11:00.000Z';
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    // The link still has to go (its entity is gone) — but nothing was cancelled.
    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('consumes the ruling — a second removal of the same id does not re-apply it', async () => {
    makeConnection();
    service.start();
    const { ideaId } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });
    expect(queuedGroups()).toEqual(['cancelled']);

    // Re-created under the same id with a fresh link, deleted again: the ruling
    // was spent by the first delete, so this one only unlinks.
    raw
      .prepare(
        `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ideaId, PROJECT_ID, 'IDEA-999', 'Back again', 'board-1-default', STAGE.idea);
    const relinked = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'idea',
      entity_id: ideaId,
      provider: 'linear',
      external_id: 'ext-2',
    });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    expect(queuedGroups()).toEqual(['cancelled']);
    expect(linkRow(relinked.id).orphaned_at).not.toBeNull();
  });

  it('orphans a CASCADED child link even with no ruling anywhere (no zombie links)', async () => {
    makeConnection();
    service.start();
    const ideaId = await createEntity('idea', { title: 'Parent idea' });
    const epicId = await createEntity('epic', {
      title: 'Parent epic',
      originatingIdeaId: ideaId,
    });
    const taskId = await createEntity('task', {
      title: 'Mirrored child',
      parentEpicId: epicId,
      originatingIdeaId: ideaId,
    });
    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: taskId,
      provider: 'linear',
      external_id: 'ext-child',
      external_parent_id: 'ext-1',
    });

    // The epic itself is unlinked, so the dialog never even opened — the child
    // link is exactly the one the old design stranded.
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: epicId });

    expect(linkRow(childLink.id).orphaned_at).not.toBeNull();
    expect(outboxRows()).toEqual([]);
  });

  it("cascade members inherit the ROOT's ruling: root + child are cancelled, then orphaned", async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();
    const epicId = await createEntity('epic', { title: 'Epic', originatingIdeaId: ideaId });
    const childId = await createEntity('task', {
      title: 'Mirrored child',
      parentEpicId: epicId,
      originatingIdeaId: ideaId,
    });
    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: childId,
      provider: 'linear',
      external_id: 'ext-child',
      external_parent_id: 'ext-1',
    });

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    // Both issues were told to cancel BEFORE their links were orphaned — an
    // enqueue after the orphan would have had no live link to read.
    expect(queuedGroups()).toEqual(['cancelled', 'cancelled']);
    expect(outboxRows().map((row) => row.external_id).sort()).toEqual(['ext-1', 'ext-child']);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(linkRow(childLink.id).orphaned_at).not.toBeNull();
  });

  it("'keep' on the root unlinks the whole cascade and queues nothing", async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();
    const childId = await createEntity('task', {
      title: 'Mirrored child',
      originatingIdeaId: ideaId,
    });
    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: childId,
      provider: 'linear',
      external_id: 'ext-child',
    });

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: false });
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(linkRow(childLink.id).orphaned_at).not.toBeNull();
  });

  it('an ARCHIVE with a staged ruling applies it', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyChange(PROJECT_ID, { actor: 'user', taskId: ideaId, archived: true });

    expect(queuedGroups()).toEqual(['cancelled']);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('an archive with NO staged ruling leaves the link completely alone', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    // The shape an inbound remote-archive apply takes: the provider is the actor
    // and no dialog ever staged anything, so the inbound half keeps owning the
    // link (it archives locally and orphans on its own terms).
    await router.applyChange(PROJECT_ID, { actor: 'linear', taskId: ideaId, archived: true });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).toBeNull();
    await expect(service.linkForEntity('idea', ideaId)).resolves.not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // The three defenses against an ABANDONED ruling (TTL above, plus these two)
  // -------------------------------------------------------------------------

  it('clearUnlinkRuling discards a ruling the user backed out of, so a later delete only unlinks', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    // The confirm dialog behind the ruling closed without committing.
    await service.clearUnlinkRuling('idea', ideaId);
    // Well inside the TTL, so nothing but the explicit clear can save this.
    await router.applyDelete(PROJECT_ID, { actor: 'user', taskId: ideaId });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('clearing an entity with no staged ruling is a harmless no-op', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await expect(service.clearUnlinkRuling('idea', ideaId)).resolves.toBeUndefined();
    // Nothing was staged and nothing was touched — the link is still live.
    expect(linkRow(link.id).orphaned_at).toBeNull();
    expect(outboxRows()).toEqual([]);
  });

  it('a PROVIDER-authored archive cannot spend a human\'s staged ruling — the user\'s own later archive still can', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    // The user staged 'cancel it' and then backed out of the confirm. Inbound
    // sync archives the same idea on the tracker's behalf moments later.
    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyChange(PROJECT_ID, { actor: 'linear', taskId: ideaId, archived: true });

    // The provider's archive is treated exactly as it would be with no ruling
    // staged at all: inbound sync keeps owning the link, and NOTHING was
    // queued at the tracker.
    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).toBeNull();

    // ...and the ruling is not destroyed either — it is still there for the
    // removal it was actually collected for, well inside the TTL.
    await router.applyChange(PROJECT_ID, { actor: 'linear', taskId: ideaId, archived: false });
    await router.applyChange(PROJECT_ID, { actor: 'user', taskId: ideaId, archived: true });

    expect(queuedGroups()).toEqual(['cancelled']);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
  });

  it('an ORCHESTRATOR-authored delete orphans the links without spending the ruling', async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'orchestrator', taskId: ideaId });

    // A delete ALWAYS orphans (the entity is gone and nothing else ever will),
    // but the cancel the user backed out of is not queued.
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(outboxRows()).toEqual([]);
  });

  it("a cascade child cannot inherit the root's ruling on a non-user delete", async () => {
    makeConnection();
    service.start();
    const { ideaId, link } = await seedLinkedIdea();
    const childId = await createEntity('task', {
      title: 'Mirrored child',
      originatingIdeaId: ideaId,
    });
    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: childId,
      provider: 'linear',
      external_id: 'ext-child',
    });

    await service.stageUnlinkRuling('idea', ideaId, { cancelRemote: true });
    await router.applyDelete(PROJECT_ID, { actor: 'orchestrator', taskId: ideaId });

    expect(outboxRows()).toEqual([]);
    expect(linkRow(link.id).orphaned_at).not.toBeNull();
    expect(linkRow(childLink.id).orphaned_at).not.toBeNull();
  });

  it('reports whether a delete cascade will take synced children with it', async () => {
    makeConnection();
    const ideaId = await createEntity('idea', { title: 'Parent idea' });
    const epicId = await createEntity('epic', { title: 'Epic', originatingIdeaId: ideaId });
    const childId = await createEntity('task', {
      title: 'Child',
      parentEpicId: epicId,
      originatingIdeaId: ideaId,
    });

    await expect(service.hasLinkedDescendants('idea', ideaId)).resolves.toBe(false);

    const childLink = upsertLink(raw, {
      connection_id: CONN_ID,
      entity_type: 'task',
      entity_id: childId,
      provider: 'linear',
      external_id: 'ext-child',
    });

    // Reachable from the idea (via its epic) AND from the epic itself.
    await expect(service.hasLinkedDescendants('idea', ideaId)).resolves.toBe(true);
    await expect(service.hasLinkedDescendants('epic', epicId)).resolves.toBe(true);
    // A task has no cascade of its own, and an orphaned child does not count.
    await expect(service.hasLinkedDescendants('task', childId)).resolves.toBe(false);
    raw.prepare(`UPDATE entity_external_links SET orphaned_at = datetime('now') WHERE id = ?`).run(
      childLink.id,
    );
    await expect(service.hasLinkedDescendants('idea', ideaId)).resolves.toBe(false);
  });
});
