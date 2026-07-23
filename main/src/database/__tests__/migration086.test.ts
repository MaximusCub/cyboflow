import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const migration = readFileSync(join(__dirname, '..', 'migrations', '086_panel_substrate_override.sql'), 'utf8');

describe('migration 086: per-panel substrate override', () => {
  it('adds a nullable, constrained substrate column without changing inheritance rows', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tool_panels (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        state TEXT,
        metadata TEXT
      );
    `);
    db.exec(migration);

    const column = (db.prepare('PRAGMA table_info(tool_panels)').all() as Array<{ name: string; notnull: number }>).find(
      (row) => row.name === 'substrate',
    );
    expect(column).toMatchObject({ name: 'substrate', notnull: 0 });

    const insert = db.prepare(
      "INSERT INTO tool_panels (id, session_id, type, title, substrate) VALUES (?, 'session-1', 'claude', ?, ?)",
    );
    expect(() => insert.run('inherit', 'Chat 1', null)).not.toThrow();
    expect(() => insert.run('sdk', 'Chat 2', 'sdk')).not.toThrow();
    expect(() => insert.run('interactive', 'Chat 3', 'interactive')).not.toThrow();
    expect(() => insert.run('invalid', 'Chat 4', 'unknown')).toThrow();
  });
});
