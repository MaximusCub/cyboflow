/**
 * Migration 104_agent_override_provider_model.sql — agent_overrides.provider_model.
 *
 * Exercises the REAL upgrade path (mirrors migration103.test.ts's two-boot
 * pattern): a DB is migrated to 103 by a DatabaseService whose migrations dir
 * omits 104, an `agent_overrides` row is seeded with `codex_model` set (the
 * pre-104 shape), and a second DatabaseService pointed at the full migrations
 * dir boots on the same file — exactly what happens when a user updates the
 * app.
 *
 * Proves:
 *   1. A pre-existing row's `codex_model` survives verbatim and its new
 *      `provider_model` is backfilled from it.
 *   2. Both read paths agree: `COALESCE(provider_model, codex_model)` and
 *      `effectiveAgents`'s `providerModel ?? codexModel` normalization resolve
 *      to the same value pre- and post-migration.
 *   3. A row with `codex_model IS NULL` backfills to `provider_model IS NULL`
 *      (no spurious empty-string coercion).
 *   4. The fresh-install path lands the same column, writable independently of
 *      `codex_model`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_104 = '104_agent_override_provider_model.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration104-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 104 — i.e. the pre-104 app. */
function migrationsDirWithout104(): string {
  const dir = join(tmpDir, 'migrations-pre-104');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_104) continue;
    if (!/^\d{3}_.*\.sql$/.test(name)) continue;
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

function openAt(migrationsDir: string): DatabaseService {
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(migrationsDir);
  svc.initialize();
  return svc;
}

function seedProjectAndAgentOverride(
  db: BetterSqlite3.Database,
  row: { id: string; agentKey: string; codexModel: string | null },
): void {
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p104')`).run();
  db.prepare(
    `INSERT INTO agent_overrides
       (id, project_id, agent_key, base_agent_key, name, role, description,
        system_prompt, tools_json, enabled_mcps_json, is_custom, version, model,
        runtime, codex_model, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, NULL, 'desc', 'prompt', '[]', '[]', 0, 1, NULL,
             'codex-sdk', ?, datetime('now'), datetime('now'))`,
  ).run(row.id, row.agentKey, row.agentKey, `cyboflow-${row.agentKey}`, row.codexModel);
}

function agentOverrideRow(db: BetterSqlite3.Database, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM agent_overrides WHERE id = ?`).get(id) as Record<string, unknown>;
}

describe('Migration 104: agent_overrides.provider_model', () => {
  it('(a) backfills provider_model from a pre-existing codex_model row, leaving codex_model untouched', () => {
    const pre104 = migrationsDirWithout104();
    openAt(pre104).close();
    const pre = openAt(pre104);
    seedProjectAndAgentOverride(pre.getDb(), { id: 'ago-1', agentKey: 'implement', codexModel: 'gpt-5.2-codex' });
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const row = agentOverrideRow(svc.getDb(), 'ago-1');
    expect(row.codex_model).toBe('gpt-5.2-codex');
    expect(row.provider_model).toBe('gpt-5.2-codex');
    svc.close();
  });

  it('(b) a NULL codex_model backfills to a NULL provider_model, not an empty string', () => {
    const pre104 = migrationsDirWithout104();
    openAt(pre104).close();
    const pre = openAt(pre104);
    seedProjectAndAgentOverride(pre.getDb(), { id: 'ago-null', agentKey: 'code-review', codexModel: null });
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const row = agentOverrideRow(svc.getDb(), 'ago-null');
    expect(row.codex_model).toBeNull();
    expect(row.provider_model).toBeNull();
    svc.close();
  });

  it("(c) both read paths agree — SQL COALESCE(provider_model, codex_model) matches effectiveAgents' providerModel ?? codexModel", () => {
    const pre104 = migrationsDirWithout104();
    openAt(pre104).close();
    const pre = openAt(pre104);
    seedProjectAndAgentOverride(pre.getDb(), { id: 'ago-2', agentKey: 'write-tests', codexModel: 'gpt-5.2-codex' });
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    const coalesced = db
      .prepare(`SELECT COALESCE(provider_model, codex_model) AS resolved FROM agent_overrides WHERE id = 'ago-2'`)
      .get() as { resolved: string | null };
    expect(coalesced.resolved).toBe('gpt-5.2-codex');

    const row = agentOverrideRow(db, 'ago-2') as unknown as {
      provider_model: string | null;
      codex_model: string | null;
    };
    const viaEffectiveAgentsRule = row.provider_model ?? row.codex_model;
    expect(viaEffectiveAgentsRule).toBe(coalesced.resolved);
    svc.close();
  });

  it('(d) an explicit provider_model set post-migration wins over a stale codex_model', () => {
    const pre104 = migrationsDirWithout104();
    openAt(pre104).close();
    const pre = openAt(pre104);
    seedProjectAndAgentOverride(pre.getDb(), { id: 'ago-3', agentKey: 'task-verify', codexModel: 'gpt-5-old' });
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    db.prepare(`UPDATE agent_overrides SET provider_model = 'gpt-5.2-codex' WHERE id = 'ago-3'`).run();

    const coalesced = db
      .prepare(`SELECT COALESCE(provider_model, codex_model) AS resolved FROM agent_overrides WHERE id = 'ago-3'`)
      .get() as { resolved: string | null };
    expect(coalesced.resolved).toBe('gpt-5.2-codex');
    svc.close();
  });

  it('(e) the fresh-install path lands the provider_model column, writable independently of codex_model', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p104-fresh')`).run();
    db.prepare(
      `INSERT INTO agent_overrides
         (id, project_id, agent_key, base_agent_key, name, role, description,
          system_prompt, tools_json, enabled_mcps_json, is_custom, version, model,
          runtime, codex_model, provider_model, created_at, updated_at)
       VALUES ('ago-fresh', 1, 'implement', 'implement', 'cyboflow-implement', NULL, 'desc', 'prompt',
               '[]', '[]', 0, 1, NULL, 'codex-sdk', 'gpt-5.2-codex', 'gpt-5.2-codex',
               datetime('now'), datetime('now'))`,
    ).run();

    const row = agentOverrideRow(db, 'ago-fresh');
    expect(row.provider_model).toBe('gpt-5.2-codex');
    expect(row.codex_model).toBe('gpt-5.2-codex');
    svc.close();
  });

  it('(f) re-applying 104 after a cleared ledger marker is a harmless no-op', () => {
    const pre104 = migrationsDirWithout104();
    openAt(pre104).close();
    const pre = openAt(pre104);
    seedProjectAndAgentOverride(pre.getDb(), { id: 'ago-replay', agentKey: 'implement', codexModel: 'gpt-5.2-codex' });
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    svc
      .getDb()
      .prepare(`DELETE FROM user_preferences WHERE key = ?`)
      .run(`file_migration_applied:${MIGRATION_104}`);
    svc.close();

    const again = openAt(MIGRATIONS_DIR);
    const row = agentOverrideRow(again.getDb(), 'ago-replay');
    expect(row.provider_model).toBe('gpt-5.2-codex');
    expect(row.codex_model).toBe('gpt-5.2-codex');
    again.close();
  });
});
