/**
 * Unit tests for main/src/services/trackerSync/inboundSync.ts — the inbound
 * half of the tracker-sync engine (tracker -> cyboflow).
 *
 * Wiring: a REAL temp-file DB through the full migration chain (same technique
 * as migration093.test.ts / store.test.ts) with the project's default board
 * seeded, a REAL TaskChangeRouter over that DB (so idea creation, stage moves
 * and the archive toggle actually land, refs and entity_events included), and
 * a fake TrackerAdapter serving canned issues. Nothing is mocked below the
 * adapter seam.
 *
 * Covers, per the task brief:
 *   - fresh import: an idea with the provenance footer, a link, and a baseline;
 *     the mapped stage is applied and the compound cursor advances.
 *   - overlap-window dedup: a second pass re-delivers the same issue and the
 *     compound cursor drops it (no duplicate idea).
 *   - remote-only change: applied locally, baseline advances.
 *   - both-changed content field, AUTO: remote wins + an already-resolved
 *     conflict row records the override.
 *   - both-changed content field, MANUAL: an OPEN conflict row, nothing
 *     applied, baseline unchanged, and the next pass skips the item.
 *   - conflict payloads: a STAGE row carries the remote's RAW state id and
 *     write-back group (its `remote_value` is only the mapped board stage), so
 *     accepting the LOCAL side later has something true to stamp.
 *   - both-changed STAGE, AUTO: local wins (nothing applied) and the override
 *     is recorded as 'auto-local'.
 *   - selection_mode 'assignee' and 'manual' filtering of fresh imports.
 *   - remote archive: local archive + orphaned link in Auto, open conflict in
 *     Manual.
 *   - import crash recovery: a pass killed between the create and the link
 *     write adopts the half-imported idea instead of duplicating it.
 *   - deletion sweep in both conflict modes, including the scope-exit case —
 *     an issue absent from the SCOPED id listing but still alive on the point
 *     lookup is out of scope, not deleted.
 *   - echo suppression: an unresolved outbox row halts the batch and the
 *     cursor never advances past the blocked issue (by external_id AND by the
 *     create path's client_key).
 *   - inbound changes never echo back OUTBOUND: the real writeBack listener is
 *     subscribed to the real taskChangeEvents (the way TrackerSyncService wires
 *     it) and must stay silent for provider-authored stage moves while still
 *     firing for local ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../database/database';
import { TASK_ALL_CHANNEL, TaskChangeRouter, taskChangeEvents } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import type { TaskChangedEvent } from '../../../../../shared/types/tasks';
import type {
  TrackerIssue,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerWorkspaceIdentity,
} from '../../../../../shared/types/trackerSync';
import type { TrackerAdapter, TrackerAdapterCapabilities } from '../adapterTypes';
import type { TrackerConflictRow, TrackerConnectionRow, TrackerOutboxRow } from '../../../database/models';
import {
  insertConnection,
  getConnection,
  getLinkByExternal,
  enqueueOutbox,
  type NewConnectionRow,
} from '../store';
import { createWriteBackListener, type WriteBackListener } from '../writeBack';
import {
  runInboundSync,
  runDeletionSweep,
  type EntityWriteRouter,
  type InboundSyncDeps,
  type TrackerBaseline,
  type TrackerConflictPayload,
} from '../inboundSync';
import type { TaskChange } from '../../../orchestrator/taskChangeRouter';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STAGE = {
  idea: 'stage-board-1-default-1',
  ready: 'stage-board-1-default-6',
  done: 'stage-board-1-default-9',
  wontdo: 'stage-board-1-default-10',
};

const STATES: TrackerState[] = [
  { id: 'st-triage', name: 'Triage', color: null, group: 'triage' },
  { id: 'st-backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'st-todo', name: 'Todo', color: null, group: 'unstarted' },
  { id: 'st-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'st-done', name: 'Done', color: null, group: 'completed' },
  { id: 'st-canceled', name: 'Canceled', color: null, group: 'cancelled' },
];

const SOURCE: TrackerSourceSelection = { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' };

/**
 * Canned-issue TrackerAdapter. Only the four read methods the inbound pass
 * uses are implemented; the write/wizard methods throw so an accidental call
 * fails loudly instead of silently returning undefined.
 */
class FakeAdapter implements TrackerAdapter {
  readonly provider = 'linear' as const;
  readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: true,
    selfHostedBaseUrl: false,
    idempotentCreate: true,
  };

  issues: TrackerIssue[] = [];
  states: TrackerState[] = STATES;
  /** Overrides the deletion sweep's id set; null = derive it from `issues`. */
  remoteIds: string[] | null = null;
  /**
   * The selection-INDEPENDENT point-lookup table behind getIssue. Deliberately
   * NOT backed by `issues`: an id absent here reads as hard-deleted, which is
   * what the sweep's deletion tests mean, while a scope-exit test puts the
   * still-alive issue in here and out of `remoteIds`.
   */
  issuesById = new Map<string, TrackerIssue>();
  /** Every `sinceIso` listIssues was called with, in order. */
  sinceCalls: Array<string | undefined> = [];

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    throw new Error('not used');
  }
  async listContainers(): Promise<TrackerSourceTree> {
    throw new Error('not used');
  }
  async listNarrows(): Promise<TrackerSourceNarrow[]> {
    throw new Error('not used');
  }
  async listStates(): Promise<TrackerState[]> {
    return this.states;
  }
  async listIssues(_selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]> {
    this.sinceCalls.push(sinceIso);
    return this.issues;
  }
  async listIssueIds(): Promise<string[]> {
    return this.remoteIds ?? this.issues.map((i) => i.externalId);
  }
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    return this.issuesById.get(externalId) ?? null;
  }
  async createSubIssue(): Promise<TrackerIssue> {
    throw new Error('not used');
  }
  async updateIssueState(): Promise<void> {
    throw new Error('not used');
  }
}

/**
 * A real TaskChangeRouter behind a kill switch, so a test can end the pass at
 * either of the import's two un-transacted seams: right AFTER the create
 * commits (the create -> link window the provenance marker exists to recover)
 * and INSTEAD of the follow-up stage move (the link -> placement window).
 */
class CrashingRouter implements EntityWriteRouter {
  /** Throw once the create has already landed in sqlite. */
  crashAfterCreate = false;
  /** Throw before a stage move is applied. */
  crashOnStageMove = false;

  constructor(private readonly inner: TaskChangeRouter) {}

  async applyChange(projectId: number, change: TaskChange): Promise<{ taskId: string }> {
    if (this.crashOnStageMove && change.taskId !== undefined && change.stageId !== undefined) {
      throw new Error('simulated crash: stage move');
    }
    const result = await this.inner.applyChange(projectId, change);
    if (this.crashAfterCreate && change.taskId === undefined) {
      throw new Error('simulated crash: after create');
    }
    return result;
  }
}

function makeIssue(overrides: Partial<TrackerIssue> = {}): TrackerIssue {
  return {
    externalId: 'ext-1',
    identifier: 'CORE-142',
    title: 'Ship the tracker sync',
    description: 'Two-way sync with Linear.',
    url: 'https://linear.app/acme/issue/CORE-142',
    stateId: 'st-backlog',
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
let deps: InboundSyncDeps;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-inbound-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(1);
  router = new TaskChangeRouter(dbAdapter(raw));
  adapter = new FakeAdapter();
  deps = { db: raw, adapter, router, nowIso: () => '2026-07-30T12:00:00.000Z' };
});

afterEach(() => {
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeConnection(overrides: Partial<NewConnectionRow> = {}): TrackerConnectionRow {
  return insertConnection(raw, {
    id: 'conn-1',
    project_id: 1,
    provider: 'linear',
    status: 'active',
    workspace_id: 'ws-1',
    workspace_name: 'Acme',
    actor_label: 'K. Esteva',
    base_url: null,
    secret_ciphertext: null,
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

/** Re-read the connection row (cursor assertions need the persisted values). */
function reload(id = 'conn-1'): TrackerConnectionRow {
  const row = getConnection(raw, id);
  if (!row) throw new Error(`connection ${id} vanished`);
  return row;
}

interface IdeaRow {
  id: string;
  title: string;
  body: string | null;
  stage_id: string;
  archived_at: string | null;
}

function ideas(): IdeaRow[] {
  return raw
    // rowid = true insertion order. created_at is datetime('now') with ONE-SECOND
    // resolution, so same-second rows tie and the id tiebreak is a minted UUID —
    // i.e. random — which made apply-order assertions a coin flip.
    .prepare('SELECT id, title, body, stage_id, archived_at FROM ideas ORDER BY rowid ASC')
    .all() as IdeaRow[];
}

function conflicts(): TrackerConflictRow[] {
  return raw
    .prepare('SELECT * FROM tracker_conflicts ORDER BY id ASC')
    .all() as TrackerConflictRow[];
}

function baselineOf(externalId: string): TrackerBaseline {
  const link = getLinkByExternal(raw, 'conn-1', externalId);
  if (!link || link.baseline_json === null) throw new Error(`no baseline for ${externalId}`);
  return JSON.parse(link.baseline_json) as TrackerBaseline;
}

// ---------------------------------------------------------------------------
// Fresh import
// ---------------------------------------------------------------------------

describe('runInboundSync — fresh import', () => {
  it('imports an orphaned issue as an idea with a provenance footer, link, baseline and cursor', async () => {
    const connection = makeConnection();
    const issue = makeIssue();
    adapter.issues = [issue];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(0);
    expect(report.haltedOnOutbox).toBeUndefined();

    const [idea] = ideas();
    expect(idea.title).toBe('Ship the tracker sync');
    expect(idea.body).toContain('Two-way sync with Linear.');
    // The marker carries (provider, externalId) — the import's recovery key.
    expect(idea.body).toContain('<!-- cyboflow:tracker linear:ext-1 -->');
    expect(idea.body).toContain('CORE-142');
    expect(idea.body).toContain('https://linear.app/acme/issue/CORE-142');
    // 'backlog' maps to the Idea stage, so no follow-up move.
    expect(idea.stage_id).toBe(STAGE.idea);

    const link = getLinkByExternal(raw, 'conn-1', 'ext-1');
    expect(link).not.toBeNull();
    expect(link?.entity_type).toBe('idea');
    expect(link?.entity_id).toBe(idea.id);
    expect(link?.external_identifier).toBe('CORE-142');
    expect(baselineOf('ext-1')).toEqual({
      title: 'Ship the tracker sync',
      description: 'Two-way sync with Linear.',
      stateId: 'st-backlog',
      updatedAt: '2026-07-30T10:00:00.000Z',
    });

    const after = reload();
    expect(after.cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    expect(after.cursor_external_id).toBe('ext-1');
    // No cursor yet on the first pass -> a full fetch.
    expect(adapter.sinceCalls).toEqual([undefined]);
  });

  it('moves an imported idea to the mapped stage when the target is not Idea', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ stateId: 'st-progress' })];

    await runInboundSync(deps, connection);

    expect(ideas()[0].stage_id).toBe(STAGE.ready);
  });

  it('skips a don’t-import state and still advances the cursor', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ stateId: 'st-triage' })];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(1);
    expect(ideas()).toHaveLength(0);
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it('never imports an already-archived remote issue as a new idea', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ archivedAt: '2026-07-29T09:00:00.000Z' })];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(0);
    expect(report.skipped).toBe(1);
    expect(ideas()).toHaveLength(0);
  });

  it('applies issues in ascending (updatedAt, externalId) order', async () => {
    const connection = makeConnection();
    adapter.issues = [
      makeIssue({ externalId: 'ext-c', identifier: 'C-3', title: 'C', updatedAt: '2026-07-30T10:00:02.000Z' }),
      makeIssue({ externalId: 'ext-b', identifier: 'B-2', title: 'B', updatedAt: '2026-07-30T10:00:01.000Z' }),
      makeIssue({ externalId: 'ext-a', identifier: 'A-1', title: 'A', updatedAt: '2026-07-30T10:00:01.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(3);
    expect(ideas().map((i) => i.title)).toEqual(['A', 'B', 'C']);
    const after = reload();
    expect(after.cursor_updated_at).toBe('2026-07-30T10:00:02.000Z');
    expect(after.cursor_external_id).toBe('ext-c');
  });
});

// ---------------------------------------------------------------------------
// Import crash recovery
// ---------------------------------------------------------------------------

describe('runInboundSync — import crash recovery', () => {
  it('adopts a half-imported idea instead of importing the issue a second time', async () => {
    const connection = makeConnection();
    const crashing = new CrashingRouter(router);
    const crashDeps: InboundSyncDeps = { ...deps, router: crashing };
    adapter.issues = [makeIssue({ stateId: 'st-progress' })];

    // Killed after the idea commits but before the link is written.
    crashing.crashAfterCreate = true;
    await expect(runInboundSync(crashDeps, connection)).rejects.toThrow('simulated crash');

    // A durable idea nothing points at, and a cursor that never advanced — so
    // the next pass sees the same unlinked issue all over again.
    const [orphan] = ideas();
    expect(ideas()).toHaveLength(1);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).toBeNull();
    expect(reload().cursor_updated_at).toBeNull();

    crashing.crashAfterCreate = false;
    const report = await runInboundSync(crashDeps, reload());

    // Adopted, not duplicated.
    expect(report.imported).toBe(1);
    const rows = ideas();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(orphan.id);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.entity_id).toBe(orphan.id);
    expect(baselineOf('ext-1').stateId).toBe('st-progress');
    // The placement the crash skipped is made on the adopt pass.
    expect(rows[0].stage_id).toBe(STAGE.ready);
    expect(reload().cursor_external_id).toBe('ext-1');
  });

  it('does not adopt an idea whose marker belongs to a DIFFERENT issue', async () => {
    const connection = makeConnection();
    const crashing = new CrashingRouter(router);
    const crashDeps: InboundSyncDeps = { ...deps, router: crashing };
    adapter.issues = [makeIssue({ externalId: 'ext-1', title: 'First' })];

    crashing.crashAfterCreate = true;
    await expect(runInboundSync(crashDeps, connection)).rejects.toThrow('simulated crash');

    // A different issue must get its own idea, not the orphaned one.
    crashing.crashAfterCreate = false;
    adapter.issues = [makeIssue({ externalId: 'ext-2', identifier: 'CORE-143', title: 'Second' })];
    const report = await runInboundSync(crashDeps, reload());

    expect(report.imported).toBe(1);
    const rows = ideas();
    expect(rows).toHaveLength(2);
    const link = getLinkByExternal(raw, 'conn-1', 'ext-2');
    expect(rows.find((row) => row.id === link?.entity_id)?.title).toBe('Second');
    // The orphan is still an orphan; only ITS issue may adopt it.
    expect(rows.some((row) => row.title === 'First')).toBe(true);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).toBeNull();
  });

  it('never re-imports after a crash between the link write and the stage move', async () => {
    const connection = makeConnection();
    const crashing = new CrashingRouter(router);
    const crashDeps: InboundSyncDeps = { ...deps, router: crashing };
    adapter.issues = [makeIssue({ stateId: 'st-progress' })];

    crashing.crashOnStageMove = true;
    await expect(runInboundSync(crashDeps, connection)).rejects.toThrow('simulated crash');

    // The link is already durable, so the issue is no longer importable at all.
    expect(ideas()).toHaveLength(1);
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')).not.toBeNull();

    crashing.crashOnStageMove = false;
    const report = await runInboundSync(crashDeps, reload());

    expect(report.imported).toBe(0);
    expect(ideas()).toHaveLength(1);
    // The residual cost of two writes that cannot share a transaction: the
    // entity is linked and syncable, but the placement this window skipped is
    // not re-derived (the remote state has not changed since the baseline).
    expect(ideas()[0].stage_id).toBe(STAGE.idea);
  });
});

// ---------------------------------------------------------------------------
// Overlap-window dedup
// ---------------------------------------------------------------------------

describe('runInboundSync — overlap-window dedup', () => {
  it('drops issues the overlap window re-delivers at or before the stored cursor', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    expect(ideas()).toHaveLength(1);

    // Second pass: same issue, unchanged updatedAt, re-delivered because the
    // fetch reaches 10 minutes behind the cursor.
    const second = await runInboundSync(deps, reload());

    expect(second.imported).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(0);
    expect(ideas()).toHaveLength(1);
    expect(conflicts()).toHaveLength(0);

    // The second fetch asked for cursor - 10 minutes, inclusive.
    expect(adapter.sinceCalls[1]).toBe('2026-07-30T09:50:00.000Z');
    const after = reload();
    expect(after.cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    expect(after.cursor_external_id).toBe('ext-1');
  });

  it('still applies a same-timestamp neighbour that sorts AFTER the cursor id', async () => {
    const connection = makeConnection();
    adapter.issues = [makeIssue({ externalId: 'ext-a', title: 'A' })];
    await runInboundSync(deps, connection);

    adapter.issues = [
      makeIssue({ externalId: 'ext-a', title: 'A' }),
      makeIssue({ externalId: 'ext-b', identifier: 'CORE-143', title: 'B' }),
    ];
    const second = await runInboundSync(deps, reload());

    expect(second.imported).toBe(1);
    expect(ideas().map((i) => i.title)).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------
// Three-way merge
// ---------------------------------------------------------------------------

describe('runInboundSync — three-way merge', () => {
  /** Import `issue`, then hand back the created idea id. */
  async function importOnce(connection: TrackerConnectionRow, issue: TrackerIssue): Promise<string> {
    adapter.issues = [issue];
    await runInboundSync(deps, connection);
    return ideas()[0].id;
  }

  it('applies a remote-only title/description change and advances the baseline', async () => {
    const connection = makeConnection();
    await importOnce(connection, makeIssue());

    adapter.issues = [
      makeIssue({
        title: 'Ship tracker sync (v1)',
        description: 'Linear AND Plane.',
        updatedAt: '2026-07-30T11:00:00.000Z',
      }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(report.autoResolved).toBe(0);
    expect(report.conflictsOpened).toBe(0);

    const [idea] = ideas();
    expect(idea.title).toBe('Ship tracker sync (v1)');
    expect(idea.body).toContain('Linear AND Plane.');
    // The provenance footer survives a description replacement.
    expect(idea.body).toContain('<!-- cyboflow:tracker linear:ext-1 -->');
    expect(idea.body).not.toContain('Two-way sync with Linear.');

    expect(baselineOf('ext-1')).toEqual({
      title: 'Ship tracker sync (v1)',
      description: 'Linear AND Plane.',
      stateId: 'st-backlog',
      updatedAt: '2026-07-30T11:00:00.000Z',
    });
  });

  it('applies a remote-only STATE change as a stage move', async () => {
    const connection = makeConnection();
    await importOnce(connection, makeIssue());

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
  });

  it('leaves a local-only edit alone (outbound owns pushing it back)', async () => {
    const connection = makeConnection();
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });

    // Remote is unchanged apart from a touch of updatedAt.
    adapter.issues = [makeIssue({ updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(0);
    expect(report.conflictsOpened).toBe(0);
    expect(report.autoResolved).toBe(0);
    expect(ideas()[0].title).toBe('Local title');
  });

  it('AUTO: both sides changed a content field -> remote wins and the override is recorded', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(report.autoResolved).toBe(1);
    expect(report.conflictsOpened).toBe(0);
    expect(ideas()[0].title).toBe('Remote title');

    const [conflict] = conflicts();
    expect(conflict.kind).toBe('field_conflict');
    expect(conflict.field).toBe('title');
    expect(conflict.local_value).toBe('Local title');
    expect(conflict.remote_value).toBe('Remote title');
    expect(conflict.state).toBe('resolved');
    expect(conflict.resolution).toBe('auto-remote');
    expect(conflict.resolved_at).not.toBeNull();

    // Baseline advanced to the remote snapshot, so the next pass is quiet.
    expect(baselineOf('ext-1').title).toBe('Remote title');
  });

  it('AUTO: both sides changed the STAGE -> local wins and the override is recorded', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, stageId: STAGE.wontdo });
    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(0);
    expect(report.autoResolved).toBe(1);
    // Cyboflow wins stage/status: the local parking survives.
    expect(ideas()[0].stage_id).toBe(STAGE.wontdo);

    const [conflict] = conflicts();
    expect(conflict.field).toBe('stage');
    expect(conflict.local_value).toBe(STAGE.wontdo);
    expect(conflict.remote_value).toBe(STAGE.done);
    expect(conflict.resolution).toBe('auto-local');
    expect(baselineOf('ext-1').stateId).toBe('st-done');
  });

  it('MANUAL: a both-changed field opens a conflict, applies nothing, and parks the item', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const first = await runInboundSync(deps, reload());

    expect(first.conflictsOpened).toBe(1);
    expect(first.updated).toBe(0);
    expect(first.autoResolved).toBe(0);
    // Nothing applied…
    expect(ideas()[0].title).toBe('Local title');
    // …and the baseline is deliberately left where it was.
    expect(baselineOf('ext-1').title).toBe('Ship the tracker sync');

    const [conflict] = conflicts();
    expect(conflict.state).toBe('open');
    expect(conflict.field).toBe('title');

    // A later pass sees the open conflict and skips the item without piling up
    // duplicate conflict rows.
    adapter.issues = [makeIssue({ title: 'Remote title again', updatedAt: '2026-07-30T12:00:00.000Z' })];
    const second = await runInboundSync(deps, reload());

    expect(second.skipped).toBe(1);
    expect(second.conflictsOpened).toBe(0);
    expect(second.updated).toBe(0);
    expect(conflicts()).toHaveLength(1);
    expect(ideas()[0].title).toBe('Local title');
    expect(baselineOf('ext-1').title).toBe('Ship the tracker sync');
  });

  it('MANUAL: a STAGE conflict records the remote RAW state, a content one its remote value', async () => {
    // `remote_value` on a stage row is the MAPPED board stage, which cannot
    // advance a baseline — so the row also carries the provider state id and its
    // write-back group, which is what trackerSyncService stamps when the user
    // accepts the LOCAL side. Content fields need nothing extra.
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, stageId: STAGE.wontdo });
    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Local title' } });
    adapter.issues = [
      makeIssue({ title: 'Remote title', stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];

    await runInboundSync(deps, reload());

    const byField = new Map(conflicts().map((row) => [row.field, row]));
    const stage = byField.get('stage');
    expect(stage?.remote_value).toBe(STAGE.done);
    expect(JSON.parse(stage?.payload_json ?? '{}') as TrackerConflictPayload).toEqual({
      externalId: 'ext-1',
      mode: 'manual',
      detectedAt: '2026-07-30T12:00:00.000Z',
      remoteStateId: 'st-done',
      remoteGroup: 'completed',
    });

    const title = byField.get('title');
    expect(title?.remote_value).toBe('Remote title');
    expect(JSON.parse(title?.payload_json ?? '{}') as TrackerConflictPayload).toEqual({
      externalId: 'ext-1',
      mode: 'manual',
      detectedAt: '2026-07-30T12:00:00.000Z',
    });
  });

  it('MANUAL: a stage conflict on a state with NO write-back group records a null group', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue({ stateId: 'st-done' }));

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, stageId: STAGE.wontdo });
    // 'unstarted' maps to Ready for development, which writes nothing back.
    adapter.issues = [makeIssue({ stateId: 'st-todo', updatedAt: '2026-07-30T11:00:00.000Z' })];

    await runInboundSync(deps, reload());

    const [conflict] = conflicts();
    expect(conflict.field).toBe('stage');
    const payload = JSON.parse(conflict.payload_json ?? '{}') as TrackerConflictPayload;
    expect(payload.remoteStateId).toBe('st-todo');
    expect(payload.remoteGroup).toBeNull();
  });

  it('MANUAL: a non-conflicting remote-only change still flows', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    await importOnce(connection, makeIssue());

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(report.conflictsOpened).toBe(0);
    expect(ideas()[0].title).toBe('Remote title');
  });

  it('preserves the OUTBOUND half’s write-back stamp when it refreshes the baseline', async () => {
    // `baseline_json` is shared with writeBack.ts/outboxWorker.ts, which stamp
    // lastWrittenGroup/lastWrittenAt onto it as their write-back dedupe. An
    // inbound refresh must lay its snapshot OVER those keys, not replace them.
    const connection = makeConnection();
    await importOnce(connection, makeIssue());

    const link = getLinkByExternal(raw, 'conn-1', 'ext-1');
    raw
      .prepare('UPDATE entity_external_links SET baseline_json = ? WHERE id = ?')
      .run(
        JSON.stringify({
          ...JSON.parse(link?.baseline_json ?? '{}'),
          lastWrittenGroup: 'completed',
          lastWrittenAt: '2026-07-30T10:30:00.000Z',
        }),
        link?.id,
      );

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());

    const refreshed = JSON.parse(
      getLinkByExternal(raw, 'conn-1', 'ext-1')?.baseline_json ?? '{}',
    ) as Record<string, unknown>;
    expect(refreshed.title).toBe('Remote title');
    expect(refreshed.lastWrittenGroup).toBe('completed');
    expect(refreshed.lastWrittenAt).toBe('2026-07-30T10:30:00.000Z');
  });

  it('seeds a baseline from the remote snapshot when a link carries only the write-back stamp', async () => {
    const connection = makeConnection();
    await importOnce(connection, makeIssue());

    const link = getLinkByExternal(raw, 'conn-1', 'ext-1');
    raw
      .prepare('UPDATE entity_external_links SET baseline_json = ? WHERE id = ?')
      .run(JSON.stringify({ lastWrittenGroup: 'started', stateId: 'st-progress' }), link?.id);

    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    // Not mergeable yet: adopt the snapshot, apply nothing, keep the stamp.
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(1);
    expect(ideas()[0].title).toBe('Ship the tracker sync');
    const refreshed = JSON.parse(
      getLinkByExternal(raw, 'conn-1', 'ext-1')?.baseline_json ?? '{}',
    ) as Record<string, unknown>;
    expect(refreshed.title).toBe('Remote title');
    expect(refreshed.lastWrittenGroup).toBe('started');
  });

  it('treats a converged edit (both sides now equal) as no conflict', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    const ideaId = await importOnce(connection, makeIssue());

    await router.applyChange(1, { actor: 'user', entityType: 'idea', taskId: ideaId, fields: { title: 'Agreed title' } });
    adapter.issues = [makeIssue({ title: 'Agreed title', updatedAt: '2026-07-30T11:00:00.000Z' })];

    const report = await runInboundSync(deps, reload());

    expect(report.conflictsOpened).toBe(0);
    expect(report.updated).toBe(0);
    expect(baselineOf('ext-1').title).toBe('Agreed title');
  });
});

// ---------------------------------------------------------------------------
// Selection filtering
// ---------------------------------------------------------------------------

describe('runInboundSync — selection filtering', () => {
  const assigned = (id: string): TrackerIssue['assignee'] => ({ id, name: id, initials: 'XX' });

  it("selection_mode 'assignee' imports only issues assigned to the chosen users", async () => {
    const connection = makeConnection({
      selection_mode: 'assignee',
      selection_json: JSON.stringify({ assigneeIds: ['user-1'] }),
    });
    adapter.issues = [
      makeIssue({ externalId: 'ext-1', title: 'Mine', assignee: assigned('user-1') }),
      makeIssue({ externalId: 'ext-2', title: 'Theirs', assignee: assigned('user-2'), updatedAt: '2026-07-30T10:00:01.000Z' }),
      makeIssue({ externalId: 'ext-3', title: 'Nobody’s', assignee: null, updatedAt: '2026-07-30T10:00:02.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(report.skipped).toBe(2);
    expect(ideas().map((i) => i.title)).toEqual(['Mine']);
    // Filtered-out issues still advance the cursor.
    expect(reload().cursor_external_id).toBe('ext-3');
  });

  it("selection_mode 'manual' imports only the explicitly chosen issue ids", async () => {
    const connection = makeConnection({
      selection_mode: 'manual',
      selection_json: JSON.stringify({ issueIds: ['ext-2'] }),
    });
    adapter.issues = [
      makeIssue({ externalId: 'ext-1', title: 'Unpicked' }),
      makeIssue({ externalId: 'ext-2', title: 'Picked', updatedAt: '2026-07-30T10:00:01.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(ideas().map((i) => i.title)).toEqual(['Picked']);
  });

  it("selection_mode 'all' imports everything mapped", async () => {
    const connection = makeConnection({ selection_mode: 'all' });
    adapter.issues = [
      makeIssue({ externalId: 'ext-1', title: 'One', assignee: assigned('user-9') }),
      makeIssue({ externalId: 'ext-2', title: 'Two', updatedAt: '2026-07-30T10:00:01.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(2);
  });

  it('does not re-filter an issue that is ALREADY linked', async () => {
    const connection = makeConnection({ selection_mode: 'assignee', selection_json: JSON.stringify({ assigneeIds: ['user-1'] }) });
    adapter.issues = [makeIssue({ assignee: assigned('user-1') })];
    await runInboundSync(deps, connection);

    // Re-assigned away from the selected user, then edited remotely.
    adapter.issues = [
      makeIssue({ assignee: assigned('user-2'), title: 'Reassigned', updatedAt: '2026-07-30T11:00:00.000Z' }),
    ];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(ideas()[0].title).toBe('Reassigned');
  });
});

// ---------------------------------------------------------------------------
// Remote archive
// ---------------------------------------------------------------------------

describe('runInboundSync — remote archive', () => {
  it('AUTO: archives the linked entity in place, orphans the link, records the event', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ archivedAt: '2026-07-30T10:30:00.000Z', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.archivedRemotely).toBe(1);
    expect(ideas()[0].archived_at).not.toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).not.toBeNull();

    const [conflict] = conflicts();
    expect(conflict.kind).toBe('remote_deleted');
    expect(conflict.state).toBe('resolved');
    expect(conflict.resolution).toBe('auto-archived');
    expect(JSON.parse(conflict.payload_json ?? '{}')).toMatchObject({ reason: 'archived' });

    // A later pass leaves the orphaned link alone instead of re-recording it.
    adapter.issues = [makeIssue({ archivedAt: '2026-07-30T10:30:00.000Z', updatedAt: '2026-07-30T12:00:00.000Z' })];
    const third = await runInboundSync(deps, reload());
    expect(third.archivedRemotely).toBe(0);
    expect(third.skipped).toBe(1);
    expect(conflicts()).toHaveLength(1);
  });

  it('MANUAL: opens a remote_deleted conflict and leaves the entity alone', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ archivedAt: '2026-07-30T10:30:00.000Z', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.conflictsOpened).toBe(1);
    expect(report.archivedRemotely).toBe(0);
    expect(ideas()[0].archived_at).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
    expect(conflicts()[0].state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Deletion sweep
// ---------------------------------------------------------------------------

describe('runDeletionSweep', () => {
  it('AUTO: archives locally + orphans the link for a vanished issue', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // Gone from the scoped listing AND from the point lookup — a real deletion.
    adapter.remoteIds = [];
    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.sweepArchived).toBe(1);
    expect(sweep.conflictsOpened).toBe(0);
    expect(ideas()[0].archived_at).not.toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).not.toBeNull();
    expect(conflicts()[0]).toMatchObject({ kind: 'remote_deleted', state: 'resolved', resolution: 'auto-archived' });

    // Orphaned links drop out of the active set, so a second sweep is a no-op.
    const again = await runDeletionSweep(deps, reload());
    expect(again.sweepArchived).toBe(0);
    expect(conflicts()).toHaveLength(1);
  });

  it('MANUAL: opens a remote_deleted conflict and does not touch the entity', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // Gone from the scoped listing AND from the point lookup — a real deletion.
    adapter.remoteIds = [];
    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep.conflictsOpened).toBe(1);
    expect(sweep.sweepArchived).toBe(0);
    expect(ideas()[0].archived_at).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
    expect(conflicts()[0].state).toBe('open');

    // The open conflict suppresses duplicate rows on the next sweep.
    const again = await runDeletionSweep(deps, reload());
    expect(again.conflictsOpened).toBe(0);
    expect(conflicts()).toHaveLength(1);
  });

  it('leaves links whose issue is still present untouched', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual({ sweepArchived: 0, conflictsOpened: 0, outOfScope: 0 });
    expect(ideas()[0].archived_at).toBeNull();
  });

  it('archives locally when the point lookup shows the issue was ARCHIVED remotely', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // Archived issues drop out of the scoped listing but still resolve.
    adapter.remoteIds = [];
    adapter.issuesById.set('ext-1', makeIssue({ archivedAt: '2026-07-29T09:00:00.000Z' }));

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual({ sweepArchived: 1, conflictsOpened: 0, outOfScope: 0 });
    expect(ideas()[0].archived_at).not.toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).not.toBeNull();
    expect(JSON.parse(conflicts()[0].payload_json ?? '{}')).toMatchObject({
      reason: 'archived',
      archivedAt: '2026-07-29T09:00:00.000Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Deletion sweep — scope exit is NOT deletion
// ---------------------------------------------------------------------------

describe('runDeletionSweep — an issue that left the configured scope', () => {
  /** Import ext-1, then move it out of the scoped listing while it stays alive. */
  async function importThenMoveOutOfScope(connection: TrackerConnectionRow): Promise<void> {
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);
    adapter.remoteIds = [];
    adapter.issuesById.set('ext-1', makeIssue());
  }

  it('AUTO: leaves the entity and the link exactly as they are', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    await importThenMoveOutOfScope(connection);

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual({ sweepArchived: 0, conflictsOpened: 0, outOfScope: 1 });
    expect(ideas()[0].archived_at).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
    expect(conflicts()).toHaveLength(0);

    // Still linked and still syncable: a later remote edit merges as normal.
    adapter.issues = [makeIssue({ title: 'Remote title', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());
    expect(report.updated).toBe(1);
    expect(ideas()[0].title).toBe('Remote title');
  });

  it('MANUAL: does not open a remote_deleted conflict', async () => {
    const connection = makeConnection({ conflict_mode: 'manual' });
    await importThenMoveOutOfScope(connection);

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual({ sweepArchived: 0, conflictsOpened: 0, outOfScope: 1 });
    expect(conflicts()).toHaveLength(0);
    expect(ideas()[0].archived_at).toBeNull();
    expect(getLinkByExternal(raw, 'conn-1', 'ext-1')?.orphaned_at).toBeNull();
  });

  it('reports every out-of-scope link and still handles a genuinely deleted one', async () => {
    const connection = makeConnection({ conflict_mode: 'auto' });
    adapter.issues = [
      makeIssue({ externalId: 'ext-1', title: 'Moved' }),
      makeIssue({ externalId: 'ext-2', identifier: 'CORE-143', title: 'Deleted', updatedAt: '2026-07-30T10:00:01.000Z' }),
    ];
    await runInboundSync(deps, connection);

    // Both vanish from the scoped listing; only ext-1 still resolves.
    adapter.remoteIds = [];
    adapter.issuesById.set('ext-1', makeIssue({ externalId: 'ext-1', title: 'Moved' }));

    const sweep = await runDeletionSweep(deps, reload());

    expect(sweep).toEqual({ sweepArchived: 1, conflictsOpened: 0, outOfScope: 1 });
    const moved = getLinkByExternal(raw, 'conn-1', 'ext-1');
    const deleted = getLinkByExternal(raw, 'conn-1', 'ext-2');
    expect(moved?.orphaned_at).toBeNull();
    expect(deleted?.orphaned_at).not.toBeNull();
    const rows = ideas();
    expect(rows.find((row) => row.id === moved?.entity_id)?.archived_at).toBeNull();
    expect(rows.find((row) => row.id === deleted?.entity_id)?.archived_at).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Echo suppression
// ---------------------------------------------------------------------------

describe('runInboundSync — echo suppression', () => {
  it('halts the batch at an issue with an unresolved outbox row and never advances past it', async () => {
    const connection = makeConnection();
    enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'update_state',
      external_id: 'ext-b',
      payload_json: JSON.stringify({ stateId: 'st-done' }),
    });

    adapter.issues = [
      makeIssue({ externalId: 'ext-a', title: 'A', updatedAt: '2026-07-30T10:00:00.000Z' }),
      makeIssue({ externalId: 'ext-b', title: 'B', updatedAt: '2026-07-30T10:00:01.000Z' }),
      makeIssue({ externalId: 'ext-c', title: 'C', updatedAt: '2026-07-30T10:00:02.000Z' }),
    ];

    const report = await runInboundSync(deps, connection);

    expect(report.haltedOnOutbox).toBe('ext-b');
    // Only the issue BEFORE the blocked one was applied.
    expect(report.imported).toBe(1);
    expect(ideas().map((i) => i.title)).toEqual(['A']);

    const after = reload();
    expect(after.cursor_updated_at).toBe('2026-07-30T10:00:00.000Z');
    expect(after.cursor_external_id).toBe('ext-a');
  });

  it('recognizes our own in-flight CREATE by its client_key', async () => {
    const connection = makeConnection();
    enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'create_sub_issue',
      external_id: null,
      client_key: 'ext-1',
      payload_json: JSON.stringify({ title: 'Mirrored task' }),
    });
    adapter.issues = [makeIssue()];

    const report = await runInboundSync(deps, connection);

    expect(report.haltedOnOutbox).toBe('ext-1');
    expect(report.imported).toBe(0);
    expect(ideas()).toHaveLength(0);
    expect(reload().cursor_updated_at).toBeNull();
  });

  it('resumes once the outbox row settles', async () => {
    const connection = makeConnection();
    const row = enqueueOutbox(raw, {
      connection_id: 'conn-1',
      kind: 'update_state',
      external_id: 'ext-1',
      payload_json: '{}',
    });
    adapter.issues = [makeIssue()];

    const halted = await runInboundSync(deps, connection);
    expect(halted.haltedOnOutbox).toBe('ext-1');

    raw.prepare("UPDATE tracker_outbox SET state = 'done' WHERE id = ?").run(row.id);
    const resumed = await runInboundSync(deps, reload());

    expect(resumed.haltedOnOutbox).toBeUndefined();
    expect(resumed.imported).toBe(1);
    expect(reload().cursor_external_id).toBe('ext-1');
  });
});

// ---------------------------------------------------------------------------
// Inbound changes must not echo back OUTBOUND
// ---------------------------------------------------------------------------

/**
 * TaskChangedEvent carries no actor/origin, so writeBack.ts routes a
 * provider-authored stage move exactly like a local one. These tests wire the
 * REAL listener onto the REAL emitter the way TrackerSyncService.start does —
 * which is also the only way an inbound-triggered enqueue is observable, since
 * the listener runs INLINE on TaskChangeRouter's post-commit emit.
 */
describe('runInboundSync — inbound changes do not echo back outbound', () => {
  /** STATES plus a SECOND completed-group state, to catch a state-specific overwrite. */
  const TWO_DONE_STATES: TrackerState[] = [
    ...STATES,
    { id: 'st-released', name: 'Released', color: null, group: 'completed' },
  ];

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

  /** Every outbox row, settled or not — "zero enqueued" must mean zero. */
  function outboxRows(): TrackerOutboxRow[] {
    return raw.prepare('SELECT * FROM tracker_outbox ORDER BY id ASC').all() as TrackerOutboxRow[];
  }

  it('queues nothing for an inbound move to Done', async () => {
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(outboxRows()).toEqual([]);
  });

  it("queues nothing for an inbound move to Won't do", async () => {
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ stateId: 'st-canceled', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());

    expect(ideas()[0].stage_id).toBe(STAGE.wontdo);
    expect(outboxRows()).toEqual([]);
  });

  it('does not overwrite the provider’s own completed state when the remote moves to a SECOND done state', async () => {
    adapter.states = TWO_DONE_STATES;
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    // 'Released' is in the completed group but is NOT the state outbound would
    // pick (pickWriteBackState takes the FIRST of the group, 'st-done'), so an
    // echoed write-back here would drag the issue off the user's own state.
    adapter.issues = [makeIssue({ stateId: 'st-released', updatedAt: '2026-07-30T11:00:00.000Z' })];
    const report = await runInboundSync(deps, reload());

    expect(report.updated).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(outboxRows()).toEqual([]);
  });

  it('queues nothing for a fresh import that lands on a mapped terminal stage', async () => {
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue({ stateId: 'st-done' })];

    const report = await runInboundSync(deps, connection);

    expect(report.imported).toBe(1);
    expect(ideas()[0].stage_id).toBe(STAGE.done);
    expect(outboxRows()).toEqual([]);
  });

  it('still enqueues for a genuinely LOCAL stage move', async () => {
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideas()[0].id,
      stageId: STAGE.done,
    });

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('update_state');
    expect(rows[0].external_id).toBe('ext-1');
    expect(JSON.parse(rows[0].payload_json)).toEqual({ desiredGroup: 'completed' });
  });

  it('still enqueues a LOCAL move away from the stage an inbound pass just applied', async () => {
    // The stamp records where the REMOTE is, so it must suppress only the echo
    // — a later local decision to park the idea is a real write-back.
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue()];
    await runInboundSync(deps, connection);

    adapter.issues = [makeIssue({ stateId: 'st-done', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(outboxRows()).toEqual([]);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideas()[0].id,
      stageId: STAGE.wontdo,
    });

    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payload_json)).toEqual({ desiredGroup: 'cancelled' });
  });

  it('re-arms the write-back once the remote leaves the terminal group', async () => {
    // A stale stamp must not wedge outbound: after the remote moves back to a
    // group no local stage demands, a local move to Done is a real write again.
    const connection = makeConnection();
    subscribeWriteBack();
    adapter.issues = [makeIssue({ stateId: 'st-done' })];
    await runInboundSync(deps, connection);
    expect(outboxRows()).toEqual([]);

    adapter.issues = [makeIssue({ stateId: 'st-backlog', updatedAt: '2026-07-30T11:00:00.000Z' })];
    await runInboundSync(deps, reload());
    expect(ideas()[0].stage_id).toBe(STAGE.idea);
    expect(outboxRows()).toEqual([]);

    await router.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      taskId: ideas()[0].id,
      stageId: STAGE.done,
    });

    expect(outboxRows()).toHaveLength(1);
  });
});
