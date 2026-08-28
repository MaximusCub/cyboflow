/**
 * Migration 127_project_permission_trust.sql — projects.permission_trust
 * ( per-project trust for repo-supplied permission ALLOW rules).
 *
 * Mirrors migration118.test.ts's two-boot real-upgrade pattern: a DB is
 * migrated by a DatabaseService whose migrations dir omits 127, rows are
 * seeded in the pre-127 shape, then a second DatabaseService pointed at the
 * full dir boots on the same file — exactly what happens when a user updates
 * the app.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_127 = '127_project_permission_trust.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration127-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 127 — i.e. the pre-127 app. */
function migrationsDirWithout127(): string {
  const dir = join(tmpDir, 'migrations-pre-127');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_127) continue;
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

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function seedProject(db: Database.Database, id: number, path: string): void {
  db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, `Proj ${id}`, path);
}

describe('migration 127: projects.permission_trust', () => {
  it('(a) upgrades a pre-127 DB: existing projects land at NULL (undecided)', () => {
    const pre127 = migrationsDirWithout127();
    const pre = openAt(pre127);
    seedProject(pre.getDb(), 1, '/tmp/p127-legacy');
    expect(columnNames(pre.getDb(), 'projects')).not.toContain('permission_trust');
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    expect(columnNames(db, 'projects')).toContain('permission_trust');
    const row = db.prepare('SELECT permission_trust FROM projects WHERE id = ?').get(1) as {
      permission_trust: string | null;
    };
    expect(row.permission_trust).toBeNull();
    svc.close();
  });

  it('(b) accepts NULL/trusted/untrusted and rejects anything else', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    for (const [id, value] of [[10, null], [11, 'trusted'], [12, 'untrusted']] as const) {
      expect(() =>
        db
          .prepare('INSERT INTO projects (id, name, path, permission_trust) VALUES (?, ?, ?, ?)')
          .run(id, `Proj ${id}`, `/tmp/p127-${id}`, value),
        `value=${value}`,
      ).not.toThrow();
    }

    expect(() =>
      db
        .prepare("INSERT INTO projects (id, name, path, permission_trust) VALUES (13, 'Bad', '/tmp/p127-bad', 'maybe')")
        .run(),
    ).toThrow(/CHECK/i);

    svc.close();
  });

  it('(c) a fresh-install DB also carries the column, defaulting to NULL', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProject(db, 1, '/tmp/p127-fresh');

    const row = db.prepare('SELECT permission_trust FROM projects WHERE id = ?').get(1) as {
      permission_trust: string | null;
    };
    expect(row.permission_trust).toBeNull();
    svc.close();
  });

  it('(d) DatabaseService.updateProject / getProject round-trip permission_trust', () => {
    const svc = openAt(MIGRATIONS_DIR);
    seedProject(svc.getDb(), 1, '/tmp/p127-roundtrip');

    expect(svc.getProject(1)?.permission_trust).toBeFalsy();

    const trusted = svc.updateProject(1, { permission_trust: 'trusted' });
    expect(trusted?.permission_trust).toBe('trusted');
    expect(svc.getProject(1)?.permission_trust).toBe('trusted');

    const untrusted = svc.updateProject(1, { permission_trust: 'untrusted' });
    expect(untrusted?.permission_trust).toBe('untrusted');
    expect(svc.getProject(1)?.permission_trust).toBe('untrusted');

    svc.close();
  });
});
