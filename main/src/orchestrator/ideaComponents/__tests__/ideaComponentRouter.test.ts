/**
 * Unit tests for IdeaComponentRouter — the `idea_components` write
 * chokepoint (migration 098, `../ideaComponentRouter.ts`).
 *
 * Covered:
 *  - setComponentState UPSERTs: first call inserts a row, a second call for
 *    the same (idea, component) updates it in place (row count stays 1).
 *  - setComponentState always clears a previously-set stale flag, even when
 *    re-affirming a non-complete state.
 *  - markStale only flips currently-'complete' rows to 'incomplete' +
 *    stale_at/stale_reason; a 'skipped' row stays skipped and untouched; an
 *    already-'incomplete' row is left completely untouched.
 *  - clearStale drops stale_at/stale_reason AND restores 'complete' (the exact
 *    inverse of markStale); rejects (not_found) a component with no ledger row;
 *    is idempotent on an already-non-stale row.
 *  - deleteForIdea removes every row for the target idea and leaves a
 *    sibling idea's rows untouched.
 *  - ideaComponentChangeEvents emits on the project channel AFTER commit,
 *    carrying the full merged hybrid snapshot (resolveIdeaComponents' shape).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  IdeaComponentRouter,
  IdeaComponentError,
  ideaComponentChangeEvents,
  ideaComponentProjectChannel,
} from '../ideaComponentRouter';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { resolveIdeaComponents } from '../resolveIdeaComponents';
import type { DatabaseLike } from '../../types';
import type { IdeaComponentChangedEvent } from '../../../../../shared/types/ideaComponents';

// ---------------------------------------------------------------------------
// Test DB builder — the neighbouring resolveIdeaComponents.test.ts's ad-hoc
// schema idiom (hand-rolled CREATE TABLEs pared to exactly what this feature
// reads/writes) rather than the full migration chain.
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ideas (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE idea_components (
      idea_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      component TEXT NOT NULL CHECK (component IN ('idea-spec','prototype','architecture','epics','stories')),
      state TEXT NOT NULL CHECK (state IN ('complete','incomplete','skipped')),
      source TEXT NOT NULL CHECK (source IN ('flow','manual')),
      source_run_id TEXT,
      source_session_id TEXT,
      built_against_version INTEGER,
      stale_at TEXT,
      stale_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (idea_id, component)
    );
    CREATE TABLE approved_designs (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL, superseded_at TEXT);
    CREATE TABLE epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_epic_id TEXT, originating_idea_id TEXT);
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, seed_idea_id TEXT, seed_idea_ids TEXT);
    CREATE TABLE entity_events (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, run_id TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, atype TEXT NOT NULL);
  `);
  return db;
}

function insertIdea(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO ideas (id, body) VALUES (?, NULL)').run(id);
}

function rowCount(db: Database.Database, ideaId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM idea_components WHERE idea_id = ?')
    .get(ideaId) as { n: number };
  return row.n;
}

function rawRow(
  db: Database.Database,
  ideaId: string,
  component: string,
): {
  state: string;
  source: string;
  source_run_id: string | null;
  built_against_version: number | null;
  stale_at: string | null;
  stale_reason: string | null;
} | undefined {
  return db
    .prepare(
      `SELECT state, source, source_run_id, built_against_version, stale_at, stale_reason
         FROM idea_components WHERE idea_id = ? AND component = ?`,
    )
    .get(ideaId, component) as
    | {
        state: string;
        source: string;
        source_run_id: string | null;
        built_against_version: number | null;
        stale_at: string | null;
        stale_reason: string | null;
      }
    | undefined;
}

describe('IdeaComponentRouter', () => {
  afterEach(() => {
    IdeaComponentRouter._resetForTesting();
    ideaComponentChangeEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // setComponentState — UPSERT
  // -------------------------------------------------------------------------

  it('setComponentState inserts a row on first call, updates it in place on the second', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'incomplete',
      source: 'flow',
      sourceRunId: 'run-1',
    });
    expect(rowCount(db, 'idea-1')).toBe(1);
    expect(rawRow(db, 'idea-1', 'architecture')).toMatchObject({
      state: 'incomplete',
      source: 'flow',
      source_run_id: 'run-1',
    });

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'complete',
      source: 'flow',
      sourceRunId: 'run-2',
      builtAgainstVersion: 3,
    });
    // Still exactly one row for (idea-1, architecture) — UPSERT, not a second insert.
    expect(rowCount(db, 'idea-1')).toBe(1);
    expect(rawRow(db, 'idea-1', 'architecture')).toMatchObject({
      state: 'complete',
      source: 'flow',
      source_run_id: 'run-2',
      built_against_version: 3,
    });
  });

  it('setComponentState always clears a previously-set stale flag, even when re-affirming a non-complete state', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'stories',
      state: 'complete',
      source: 'flow',
    });
    await router.applyChange(1, { op: 'mark-stale', ideaId: 'idea-1', staleReason: 'body changed' });
    expect(rawRow(db, 'idea-1', 'stories')?.stale_at).not.toBeNull();

    // Re-affirming 'incomplete' (not 'complete') still clears the stale flag —
    // an explicit write is a reviewed judgment, not a stale carry-over.
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'stories',
      state: 'incomplete',
      source: 'manual',
    });
    const row = rawRow(db, 'idea-1', 'stories');
    expect(row?.state).toBe('incomplete');
    expect(row?.stale_at).toBeNull();
    expect(row?.stale_reason).toBeNull();
  });

  // -------------------------------------------------------------------------
  // markStale
  // -------------------------------------------------------------------------

  it('markStale flips only currently-complete rows; skipped and incomplete rows are untouched', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'complete',
      source: 'flow',
    });
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'epics',
      state: 'skipped',
      source: 'manual',
    });
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'stories',
      state: 'incomplete',
      source: 'flow',
    });

    await router.applyChange(1, { op: 'mark-stale', ideaId: 'idea-1', staleReason: 'body changed' });

    const architecture = rawRow(db, 'idea-1', 'architecture');
    expect(architecture?.state).toBe('incomplete');
    expect(architecture?.stale_at).not.toBeNull();
    expect(architecture?.stale_reason).toBe('body changed');

    const epics = rawRow(db, 'idea-1', 'epics');
    expect(epics?.state).toBe('skipped');
    expect(epics?.stale_at).toBeNull();

    const stories = rawRow(db, 'idea-1', 'stories');
    expect(stories?.state).toBe('incomplete');
    expect(stories?.stale_at).toBeNull();
  });

  it('markStale is a no-op when the idea has no complete rows', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    const result = await router.applyChange(1, {
      op: 'mark-stale',
      ideaId: 'idea-1',
      staleReason: 'body changed',
    });
    expect(rowCount(db, 'idea-1')).toBe(0);
    expect(result.states).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // clearStale
  // -------------------------------------------------------------------------

  it('clearStale drops stale_at/stale_reason and restores complete', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'idea-spec',
      state: 'complete',
      source: 'flow',
    });
    await router.applyChange(1, { op: 'mark-stale', ideaId: 'idea-1', staleReason: 'body changed' });
    expect(rawRow(db, 'idea-1', 'idea-spec')?.state).toBe('incomplete');
    expect(rawRow(db, 'idea-1', 'idea-spec')?.stale_at).not.toBeNull();

    await router.applyChange(1, { op: 'clear-stale', ideaId: 'idea-1', component: 'idea-spec' });
    const row = rawRow(db, 'idea-1', 'idea-spec');
    expect(row?.stale_at).toBeNull();
    expect(row?.stale_reason).toBeNull();
    // clearStale is the exact inverse of markStale: a non-NULL stale_at can
    // only have come from a row that was 'complete', so re-verifying it must
    // land back on 'complete'. Leaving it 'incomplete' would be
    // indistinguishable from "never started".
    expect(row?.state).toBe('complete');
  });

  it('clearStale rejects a component with no ledger row (not_found)', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await expect(
      router.applyChange(1, { op: 'clear-stale', ideaId: 'idea-1', component: 'prototype' }),
    ).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<IdeaComponentError>);
  });

  it('clearStale is idempotent on a row that is already non-stale', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'epics',
      state: 'incomplete',
      source: 'flow',
    });
    await expect(
      router.applyChange(1, { op: 'clear-stale', ideaId: 'idea-1', component: 'epics' }),
    ).resolves.toBeDefined();
    expect(rawRow(db, 'idea-1', 'epics')?.state).toBe('incomplete');
  });

  // -------------------------------------------------------------------------
  // deleteForIdea
  // -------------------------------------------------------------------------

  it('deleteForIdea removes every row for the target idea and leaves a sibling idea untouched', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    insertIdea(db, 'idea-2');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'complete',
      source: 'flow',
    });
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-2',
      component: 'architecture',
      state: 'complete',
      source: 'flow',
    });

    await router.applyChange(1, { op: 'delete-for-idea', ideaId: 'idea-1' });

    expect(rowCount(db, 'idea-1')).toBe(0);
    expect(rowCount(db, 'idea-2')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Change event
  // -------------------------------------------------------------------------

  it('emits on the project channel after commit, carrying the full merged snapshot', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    const received: IdeaComponentChangedEvent[] = [];
    ideaComponentChangeEvents.on(ideaComponentProjectChannel(1), (ev: IdeaComponentChangedEvent) => {
      received.push(ev);
    });

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'prototype',
      state: 'complete',
      source: 'flow',
    });

    expect(received).toHaveLength(1);
    expect(received[0].projectId).toBe(1);
    expect(received[0].ideaId).toBe('idea-1');
    expect(received[0].states).toHaveLength(5);
    expect(received[0].states).toEqual(resolveIdeaComponents(dbAdapter(db) as DatabaseLike, 'idea-1'));
  });
});
