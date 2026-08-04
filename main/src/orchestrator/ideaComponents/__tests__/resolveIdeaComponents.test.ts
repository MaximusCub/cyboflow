import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../../types';
import { resolveIdeaComponents, resolveIdeaComponentsBatch } from '../resolveIdeaComponents';
import { IDEA_COMPONENT_KEYS } from '../../../../../shared/types/ideaComponents';

/**
 * Minimal ad-hoc schema — the neighbouring `entityRunLinks.test.ts` idiom of
 * hand-rolled CREATE TABLEs rather than running the full migration chain.
 * Column sets are pared to exactly what resolveIdeaComponents.ts reads.
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ideas (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE idea_components (
      idea_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      component TEXT NOT NULL,
      state TEXT NOT NULL,
      source TEXT NOT NULL,
      source_run_id TEXT,
      source_session_id TEXT,
      built_against_version INTEGER,
      stale_at TEXT,
      stale_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (idea_id, component)
    );
    CREATE TABLE approved_designs (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL,
      superseded_at TEXT
    );
    CREATE TABLE epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_epic_id TEXT,
      originating_idea_id TEXT
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      seed_idea_id TEXT,
      seed_idea_ids TEXT
    );
    CREATE TABLE entity_events (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      run_id TEXT
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      atype TEXT NOT NULL
    );
  `);
  return db;
}

function insertIdea(db: Database.Database, id: string, body: string | null): void {
  db.prepare('INSERT INTO ideas (id, body) VALUES (?, ?)').run(id, body);
}

function insertLedgerRow(
  db: Database.Database,
  ideaId: string,
  component: (typeof IDEA_COMPONENT_KEYS)[number],
  fields: {
    state: 'complete' | 'incomplete' | 'skipped';
    source?: 'flow' | 'manual';
    sourceRunId?: string | null;
    sourceSessionId?: string | null;
    builtAgainstVersion?: number | null;
    staleAt?: string | null;
    staleReason?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO idea_components
       (idea_id, project_id, component, state, source, source_run_id, source_session_id,
        built_against_version, stale_at, stale_reason, created_at, updated_at)
     VALUES (?, '1', ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(
    ideaId,
    component,
    fields.state,
    fields.source ?? 'flow',
    fields.sourceRunId ?? null,
    fields.sourceSessionId ?? null,
    fields.builtAgainstVersion ?? null,
    fields.staleAt ?? null,
    fields.staleReason ?? null,
  );
}

/** Find one component's resolved state out of the five, by key. */
function pick(
  states: ReturnType<typeof resolveIdeaComponents>,
  component: (typeof IDEA_COMPONENT_KEYS)[number],
) {
  const found = states.find((s) => s.component === component);
  if (!found) throw new Error(`missing component ${component} in resolved states`);
  return found;
}

const IDEA_SPEC_BODY = '## Idea spec\n\nSome spec content.\n';
const ARCH_DESIGN_BODY = '## Architecture design\n\nSome arch content.\n';
const BOTH_SECTIONS_BODY = `${IDEA_SPEC_BODY}\n${ARCH_DESIGN_BODY}`;

describe('resolveIdeaComponents / resolveIdeaComponentsBatch', () => {
  it('always returns all five components, in IDEA_COMPONENT_KEYS order', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');
    expect(states.map((s) => s.component)).toEqual([...IDEA_COMPONENT_KEYS]);
  });

  it('derives every component correctly for a bare/legacy idea with no ledger rows', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', BOTH_SECTIONS_BODY);
    db.prepare('INSERT INTO approved_designs (id, idea_id, superseded_at) VALUES (?, ?, NULL)').run(
      'ad-1',
      'idea-1',
    );
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-1', 'idea-1');
    db.prepare('INSERT INTO tasks (id, originating_idea_id) VALUES (?, ?)').run('tsk-1', 'idea-1');

    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');

    expect(pick(states, 'idea-spec')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'architecture')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'prototype')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'epics')).toMatchObject({ state: 'complete', source: 'derived' });
    expect(pick(states, 'stories')).toMatchObject({ state: 'complete', source: 'derived' });

    // Every derived entry carries null lineage/staleness fields.
    for (const s of states) {
      expect(s.sourceRunId).toBeNull();
      expect(s.sourceSessionId).toBeNull();
      expect(s.builtAgainstVersion).toBeNull();
      expect(s.staleAt).toBeNull();
      expect(s.staleReason).toBeNull();
      expect(s.updatedAt).toBeNull();
    }
  });

  it('derives incomplete for every component when nothing exists', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', 'Just a plain body, no headings.');

    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');
    for (const s of states) {
      expect(s.state).toBe('incomplete');
      expect(s.source).toBe('derived');
    }
  });

  it('a ledger row overrides derivation: incomplete row wins while the heading exists', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', ARCH_DESIGN_BODY);
    insertLedgerRow(db, 'idea-1', 'architecture', { state: 'incomplete', source: 'manual' });

    const architecture = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'architecture');
    expect(architecture.state).toBe('incomplete');
    expect(architecture.source).toBe('manual');
  });

  it('a ledger row overrides derivation: complete row wins while nothing exists', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', 'no headings here');
    insertLedgerRow(db, 'idea-1', 'epics', { state: 'complete', source: 'flow', sourceRunId: 'run-1' });

    const epics = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'epics');
    expect(epics.state).toBe('complete');
    expect(epics.source).toBe('flow');
    expect(epics.sourceRunId).toBe('run-1');
  });

  it('returns skipped only from a ledger row, and derivation never produces it', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', 'no headings here');
    insertLedgerRow(db, 'idea-1', 'stories', { state: 'skipped', source: 'manual' });

    const states = resolveIdeaComponents(dbAdapter(db), 'idea-1');
    expect(pick(states, 'stories')).toMatchObject({ state: 'skipped', source: 'manual' });

    // Every OTHER (derived) component must never be 'skipped'.
    for (const s of states) {
      if (s.source === 'derived') expect(s.state).not.toBe('skipped');
    }
  });

  it('round-trips stale_at: a complete row with stale_at set comes back with staleAt non-null', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertLedgerRow(db, 'idea-1', 'idea-spec', {
      state: 'complete',
      source: 'flow',
      staleAt: '2026-02-01T00:00:00Z',
      staleReason: 'idea body changed',
    });

    const ideaSpec = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'idea-spec');
    expect(ideaSpec.state).toBe('complete');
    expect(ideaSpec.staleAt).toBe('2026-02-01T00:00:00Z');
    expect(ideaSpec.staleReason).toBe('idea body changed');
  });

  it('prototype completes via an approved_designs current row', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    db.prepare('INSERT INTO approved_designs (id, idea_id, superseded_at) VALUES (?, ?, NULL)').run(
      'ad-1',
      'idea-1',
    );

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('complete');
    expect(prototype.source).toBe('derived');
  });

  it('a SUPERSEDED approved_designs row does NOT complete prototype on its own', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    db.prepare(
      'INSERT INTO approved_designs (id, idea_id, superseded_at) VALUES (?, ?, ?)',
    ).run('ad-1', 'idea-1', '2026-01-01T00:00:00Z');

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('incomplete');
  });

  it('prototype completes via a ui-prototype artifact on a run linked to the idea', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, ?)').run('run-1', 'idea-1');
    db.prepare('INSERT INTO artifacts (id, run_id, atype) VALUES (?, ?, ?)').run(
      'art-1',
      'run-1',
      'ui-prototype',
    );

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('complete');
    expect(prototype.source).toBe('derived');
  });

  it('prototype completes via an interactive-prototype artifact reached through entity_events lineage', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    // No seed_idea_id/seed_idea_ids link — only entity_events lineage on the idea itself.
    db.prepare('INSERT INTO workflow_runs (id) VALUES (?)').run('run-1');
    db.prepare("INSERT INTO entity_events (entity_type, entity_id, run_id) VALUES ('idea', 'idea-1', 'run-1')").run();
    db.prepare('INSERT INTO artifacts (id, run_id, atype) VALUES (?, ?, ?)').run(
      'art-1',
      'run-1',
      'interactive-prototype',
    );

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('complete');
  });

  it('an unlinked ui-prototype artifact (a different idea owns the run) does not complete prototype', () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertIdea(db, 'idea-2', null);
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, ?)').run('run-2', 'idea-2');
    db.prepare('INSERT INTO artifacts (id, run_id, atype) VALUES (?, ?, ?)').run(
      'art-2',
      'run-2',
      'ui-prototype',
    );

    const prototype = pick(resolveIdeaComponents(dbAdapter(db), 'idea-1'), 'prototype');
    expect(prototype.state).toBe('incomplete');
  });

  it('batch returns an entry for EVERY requested id, including an idea that does not exist', () => {
    const db = buildDb();
    insertIdea(db, 'idea-real', null);

    const batch = resolveIdeaComponentsBatch(dbAdapter(db), ['idea-real', 'idea-ghost']);

    expect(batch.has('idea-real')).toBe(true);
    expect(batch.has('idea-ghost')).toBe(true);
    const ghostStates = batch.get('idea-ghost');
    expect(ghostStates).toBeDefined();
    expect(ghostStates?.map((s) => s.component)).toEqual([...IDEA_COMPONENT_KEYS]);
    for (const s of ghostStates ?? []) {
      expect(s.state).toBe('incomplete');
      expect(s.source).toBe('derived');
    }
  });

  it('batch resolves distinct ideas independently in one call (ledger row on one does not leak to another)', () => {
    const db = buildDb();
    insertIdea(db, 'idea-a', ARCH_DESIGN_BODY);
    insertIdea(db, 'idea-b', null);
    insertLedgerRow(db, 'idea-a', 'architecture', { state: 'skipped', source: 'manual' });

    const batch = resolveIdeaComponentsBatch(dbAdapter(db), ['idea-a', 'idea-b']);
    const a = batch.get('idea-a');
    const b = batch.get('idea-b');
    expect(a?.find((s) => s.component === 'architecture')).toMatchObject({ state: 'skipped', source: 'manual' });
    expect(b?.find((s) => s.component === 'architecture')).toMatchObject({ state: 'incomplete', source: 'derived' });
  });

  it('empty id array yields an empty map', () => {
    const db = buildDb();
    const batch = resolveIdeaComponentsBatch(dbAdapter(db), []);
    expect(batch.size).toBe(0);
  });

  it('issues a bounded number of prepare() calls, not one per idea', () => {
    const db = buildDb();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = `idea-${i}`;
      ids.push(id);
      insertIdea(db, id, i % 2 === 0 ? ARCH_DESIGN_BODY : null);
    }

    let prepareCount = 0;
    const counting: DatabaseLike = {
      prepare: (sql: string) => {
        prepareCount += 1;
        return db.prepare(sql);
      },
      transaction: <T>(fn: (...args: unknown[]) => T) =>
        db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
      name: db.name,
    };

    resolveIdeaComponentsBatch(counting, [ids[0]]);
    const countForOne = prepareCount;

    prepareCount = 0;
    resolveIdeaComponentsBatch(counting, ids);
    const countForFifty = prepareCount;

    // Both fit in a single chunk (well under the 400/id chunk size), so the
    // query COUNT must be identical regardless of how many ideas were asked
    // for — the whole point of the grouped-query design.
    expect(countForFifty).toBe(countForOne);
    // Sanity: this is a small constant, not e.g. hundreds.
    expect(countForFifty).toBeLessThan(20);
  });
});
