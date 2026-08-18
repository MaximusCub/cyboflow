/**
 * Migration 101_sessions_agent_runtime_omp_fleet.sql — table-rebuild parity tests.
 *
 * 101 is a full create-new-table + copy + drop + rename rebuild of `sessions`,
 * widening the `agent_runtime` CHECK (060: claude-sdk/claude-interactive/
 * codex-sdk/codex-pty) to include 'omp-fleet' AND the sibling `agent_provider`
 * CHECK (059: claude/codex) to include 'omp'. The pair travels together: the
 * quick-session path stamps providerForRuntime('omp-fleet') = 'omp' on
 * agent_provider, so a CHECK that rejected 'omp' would break the very row the
 * widened runtime enables.
 *
 * A rebuild migration's whole risk is silently dropping or reshaping a
 * column, so these tests run the REAL chain (schema.sql + every migration via
 * DatabaseService.initialize()) against temp DBs — one through 100 (pre-state)
 * and one through 101 — and verify:
 *   1. Triple column parity at 101's own boundary (chain through 101 only):
 *      pre-101 live table === post-101 live table === the column list 101
 *      itself declares (order-sensitive). 101 may change CHECKs, nothing else.
 *      The later merged-chain steps (103/104) re-derive these two columns via
 *      DROP/ADD and get their own test file; the full-chain assertions in test
 *      1 verify nothing is lost or silently UN-widened downstream of 101.
 *   2. The new pair is insertable: agent_provider='omp' with
 *      agent_runtime='omp-fleet' (the Phase-4 quick-session stamp), alongside
 *      legacy values; bogus values are still rejected.
 *   3. Upgrade path: a pre-101 DB (real chain without 101) rejects the pair,
 *      then applying 101 with the runner's FK handling makes it insertable,
 *      with seeded row data, the five pre-existing indexes, and FK
 *      enforcement intact.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database';

const MIG_DIR = join(__dirname, '..', 'migrations');
const MIG_101 = '101_sessions_agent_runtime_omp_fleet.sql';

/**
 * Fresh temp DB run through the real DatabaseService chain. When
 * `excludeAtOrAbove` is given, migrations at or above that prefix are omitted
 * by copying the rest into a scratch dir (the real migrations dir is never
 * touched; schema.sql stays with the class, exactly as on a pre-101 install).
 */
function buildDb(dbPath: string, excludeAtOrAbove?: number): DatabaseService {
  let dir = MIG_DIR;
  if (excludeAtOrAbove !== undefined) {
    // Keyed per threshold: the scratch is never cleared, so a buildDb(_, 102)
    // call (which copies 101) would otherwise leak 101 into a LATER
    // buildDb(_, 101) "pre-state" in the same process, defeating the exclusion.
    const scratch = join(tmpdir(), `cyboflow-m101-scratch-${process.pid}-${excludeAtOrAbove}`);
    mkdirSync(scratch, { recursive: true });
    for (const name of readdirSync(MIG_DIR)) {
      const m = /^(\d{3})_/.exec(name);
      const n = m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
      if (n < excludeAtOrAbove) cpSync(join(MIG_DIR, name), join(scratch, name));
    }
    dir = scratch;
  }
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(dir);
  svc.initialize();
  return svc;
}

/**
 * Apply one migration file the way runFileBasedMigrations does: toggle the FK
 * pragma outside any transaction when the file carries the marker, restore in
 * finally. (101 also carries in-file PRAGMA lines, which take effect directly
 * on this non-transactional exec.)
 */
function applyFile(svc: DatabaseService, name: string): void {
  const raw = svc.getDb();
  const sql = readFileSync(join(MIG_DIR, name), 'utf-8');
  const needsFkOff = sql.includes('PRAGMA foreign_keys=OFF');
  if (needsFkOff) raw.pragma('foreign_keys = OFF');
  try {
    raw.exec(sql);
  } finally {
    if (needsFkOff) raw.pragma('foreign_keys = ON');
  }
}

/** The CREATE TABLE statement SQLite stores for `sessions` (whitespace-normalized). */
function sessionsSql(db: Database.Database): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get() as { sql: string } | undefined;
  return (row?.sql ?? '').replace(/\s+/g, ' ');
}

function columnNames(db: Database.Database): string[] {
  return (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((r) => r.name);
}

function indexes(db: Database.Database): string[] {
  return (db.prepare('PRAGMA index_list(sessions)').all() as Array<{ name: string }>).map((r) => r.name);
}

/**
 * The column list 101's own CREATE TABLE declares, in order. Parsing the file
 * (rather than hardcoding 42 names) keeps the parity check honest: the test
 * compares what the rebuild *says* it copies against what the live table
 * *has*.
 */
function declaredRebuildColumns(): string[] {
  const sql = readFileSync(join(MIG_DIR, MIG_101), 'utf-8');
  const body = /CREATE TABLE sessions_new \(([\s\S]*?)\n\);/m.exec(sql)?.[1] ?? '';
  const cols: string[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('--')) continue;
    if (/^(PRAGMA|FOREIGN|PRIMARY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(t)) continue;
    cols.push(t.split(/\s+/)[0]);
  }
  return cols;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-m101-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  // Scratch migration dir (shared per process) is rebuilt per buildDb; leave it.
});

describe('Migration 101: sessions agent_runtime/agent_provider OMP widening', () => {
  it('changes only the two CHECKs: pre-101, post-101 and declared column sets are identical', () => {
    const pre = buildDb(join(tmpDir, 'pre.db'), 101);
    // Through 101 ONLY. The merged chain continues into 103/104, which re-derive
    // the same two columns via DROP/ADD (position-shifting them to the end) and
    // widen the CHECK further (103's superset) — 101's own rebuild contract can
    // only be measured at its own boundary.
    const post = buildDb(join(tmpDir, 'post.db'), 102);
    const declared = declaredRebuildColumns();

    expect(declared).toContain('agent_provider');
    expect(declared).toContain('agent_runtime');
    expect(declared).toContain('enabled_plugins_json'); // last column added pre-101 (039/059-era)

    // Order-sensitive triple parity. A live column missing from 101's list
    // would be silently dropped by the rebuild; an extra declared column
    // would make the INSERT ... SELECT fail at boot.
    expect(columnNames(post.getDb())).toEqual(declared);
    expect(columnNames(post.getDb())).toEqual(columnNames(pre.getDb()));

    // And the intended change is present exactly:
    expect(sessionsSql(post.getDb())).toContain("CHECK (agent_provider IN ('claude','codex','omp'))");
    expect(sessionsSql(post.getDb())).toContain(
      "CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty','omp-fleet'))",
    );
    // Pre-state sanity: the narrow CHECKs are what 059/060 installed.
    expect(sessionsSql(pre.getDb())).toContain("CHECK (agent_provider IN ('claude','codex'))");
    expect(sessionsSql(pre.getDb())).toContain(
      "CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty'))",
    );

    // Full merged chain (101 → 103 → 104): 103 re-ADDs the two columns at the
    // end (order shifts, set does not) and carries 101's pair forward into its
    // superset CHECK — a dropped 'omp-fleet' there would brick fleet sessions on
    // every upgraded install.
    const full = buildDb(join(tmpDir, 'full.db'));
    expect([...columnNames(full.getDb())].sort()).toEqual([...declared].sort());
    expect(sessionsSql(full.getDb())).toContain("CHECK (agent_provider IN ('claude','codex','omp'))");
    expect(sessionsSql(full.getDb())).toContain(
      "CHECK (agent_runtime IN ('claude-sdk','claude-interactive','codex-sdk','codex-pty','omp-sdk','omp-pty','omp-fleet'))",
    );
    full.close();

    pre.close();
    post.close();
  });

  it('accepts the new omp/omp-fleet pair and legacy values; rejects bogus values', () => {
    const svc = buildDb(join(tmpDir, 'fresh.db'));
    const db = svc.getDb();
    const insert = db.prepare(
      `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, agent_provider, agent_runtime, agent_model)
       VALUES (@id, @name, 'p', 'w', '/w', @agent_provider, @agent_runtime, 'model-x')`,
    );

    // The Phase-4 quick-session stamp.
    insert.run({ id: 's-omp', name: 'omp', agent_provider: 'omp', agent_runtime: 'omp-fleet' });
    // Legacy rows still fine.
    insert.run({ id: 's-claude', name: 'claude', agent_provider: 'claude', agent_runtime: 'claude-sdk' });
    insert.run({ id: 's-codex', name: 'codex', agent_provider: 'codex', agent_runtime: 'codex-pty' });

    const rows = db
      .prepare('SELECT agent_provider, agent_runtime FROM sessions ORDER BY id')
      .all() as Array<{ agent_provider: string; agent_runtime: string }>;
    expect(rows).toEqual([
      { agent_provider: 'claude', agent_runtime: 'claude-sdk' },
      { agent_provider: 'codex', agent_runtime: 'codex-pty' },
      { agent_provider: 'omp', agent_runtime: 'omp-fleet' },
    ]);

    // Bogus values are still rejected by the widened CHECKs.
    expect(() =>
      insert.run({ id: 's-bad1', name: 'b1', agent_provider: 'omp-fleet', agent_runtime: 'claude-sdk' }),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run({ id: 's-bad2', name: 'b2', agent_provider: 'claude', agent_runtime: 'omp' }),
    ).toThrow(/CHECK/);
    expect(() =>
      insert.run({ id: 's-bad3', name: 'b3', agent_provider: 'gemini', agent_runtime: 'claude-sdk' }),
    ).toThrow(/CHECK/);

    svc.close();
  });

  it('upgrade path: pre-101 DB rejects the pair; after 101 rows, indexes and FKs survive', () => {
    const svc = buildDb(join(tmpDir, 'pre.db'), 101);
    const db = svc.getDb();
    const projectId = svc.createProject('P', join(tmpDir, 'repo')).id;

    // Pre-101 (059's CHECK): the provider half of the pair is rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, agent_provider)
           VALUES ('s-early', 'early', 'p', 'w', '/w', 'omp')`,
        )
        .run(),
    ).toThrow(/CHECK/);

    // Seed a realistic row: all NOT NULL columns plus interesting nullables,
    // both CHECK columns, and a live FK.
    db.prepare(
      `INSERT INTO sessions (
         id, name, initial_prompt, worktree_name, worktree_path, status, project_id,
         archived, permission_mode, is_main_repo, display_order, is_favorite, auto_commit,
         skip_continue_next, tool_type, in_place, last_output, exit_code, pid,
         agent_provider, agent_runtime, agent_model, disabled_mcp_servers_json,
         enabled_plugins_json
       ) VALUES (
         's-legacy', 'seed', 'p', 'w', '/w', 'running', @project_id,
         1, 'approve', 0, 7, 1, 0, 1, 'codex', 0, 'out', 2, NULL,
         'codex', 'codex-pty', 'model-y', '[]', NULL
       )`,
    ).run({ project_id: projectId });
    const before = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s-legacy') as Record<string, unknown>;
    const idxBefore = indexes(db);
    expect(idxBefore).toEqual(
      expect.arrayContaining([
        'idx_sessions_archived',
        'idx_sessions_project_id',
        'idx_sessions_is_main_repo',
        'idx_sessions_display_order',
        'idx_sessions_folder_id',
      ]),
    );

    // Apply 101 the way the runner does.
    applyFile(svc, MIG_101);

    // Row data survived the rebuild verbatim.
    const after = db.prepare('SELECT * FROM sessions WHERE id = ?').get('s-legacy') as Record<string, unknown>;
    expect(after).toEqual(before);
    // All five pre-existing indexes restored, nothing dropped.
    expect(indexes(db)).toEqual(idxBefore);
    // FK enforcement survived the rebuild (both directions).
    expect((db.prepare('PRAGMA foreign_key_check').all() as unknown[]).length).toBe(0);
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id)
           VALUES ('s-orphan', 'o', 'p', 'w', '/w', 99999)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);

    // And the widened pair now inserts post-migration.
    db.prepare(
      `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, agent_provider, agent_runtime)
       VALUES ('s-omp', 'omp', 'p', 'w', '/w', 'omp', 'omp-fleet')`,
    ).run();
    expect(db.prepare("SELECT agent_provider, agent_runtime FROM sessions WHERE id = 's-omp'").get()).toEqual({
      agent_provider: 'omp',
      agent_runtime: 'omp-fleet',
    });

    svc.close();
  });
});
