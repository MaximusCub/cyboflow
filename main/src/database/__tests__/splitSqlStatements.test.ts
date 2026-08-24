/**
 * Statement splitter used by the file-based migration runner.
 *
 * The runner executes migrations statement-by-statement so it can skip a single
 * already-applied `ALTER TABLE … ADD COLUMN` without discarding the rest of the
 * file. That only works if the split is literal-aware — a naive `split(';')`
 * would cut header comments and string literals apart and turn a re-applied
 * migration into a syntax error.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitSqlStatements } from '../splitSqlStatements';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

describe('splitSqlStatements', () => {
  it('splits plain statements and drops the empty tail', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('keeps a statement with no trailing semicolon', () => {
    expect(splitSqlStatements('SELECT 1')).toEqual(['SELECT 1']);
  });

  it('ignores semicolons inside line and block comments', () => {
    const sql = `-- migration header; with a semicolon
/* block; comment; here */
ALTER TABLE t ADD COLUMN a TEXT;
ALTER TABLE t ADD COLUMN b TEXT;`;
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('ADD COLUMN a');
    expect(parts[1]).toContain('ADD COLUMN b');
  });

  it('drops comment-only chunks', () => {
    expect(splitSqlStatements('-- just a note\n\n/* and another */\n')).toEqual([]);
  });

  it('ignores semicolons inside string literals and quoted identifiers', () => {
    const sql = `UPDATE t SET note = 'a;b', other = '' WHERE x = 1;
UPDATE t SET "weird;col" = 'it''s; fine';`;
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("'a;b'");
    expect(parts[1]).toContain("'it''s; fine'");
  });

  it('ignores semicolons inside bracketed identifiers', () => {
    expect(splitSqlStatements('SELECT [a;b] FROM t; SELECT 2;')).toHaveLength(2);
  });

  it('keeps a CREATE TRIGGER body together', () => {
    const sql = `CREATE TRIGGER t_after AFTER INSERT ON t
BEGIN
  UPDATE t SET a = 1 WHERE id = NEW.id;
  DELETE FROM u WHERE id = NEW.id;
END;
SELECT 1;`;
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('DELETE FROM u');
    expect(parts[0].trimEnd().endsWith('END;')).toBe(true);
    expect(parts[1]).toBe('SELECT 1;');
  });

  it('does not let a CASE…END inside a trigger body close the block early', () => {
    const sql = `CREATE TEMP TRIGGER t_case AFTER UPDATE ON t
BEGIN
  UPDATE t SET a = CASE WHEN NEW.b > 0 THEN 1 ELSE 0 END WHERE id = NEW.id;
  UPDATE t SET c = 2 WHERE id = NEW.id;
END;
SELECT 9;`;
    const parts = splitSqlStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('SET c = 2');
    expect(parts[1]).toBe('SELECT 9;');
  });

  it('every real migration file splits into statements SQLite itself accepts', () => {
    // Corpus check: a bad split shows up as a statement SQLite cannot even
    // parse. We only compile (not run) each statement, against a scratch DB
    // with unchecked_columns on so unresolved table names do not matter — the
    // point is that the SPLIT produced syntactically whole statements.
    const db = new Database(':memory:');
    let checked = 0;
    let skipped = 0;
    for (const name of readdirSync(MIGRATIONS_DIR)) {
      if (!/^\d{3}_.*\.sql$/.test(name)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf-8');
      const parts = splitSqlStatements(sql);
      // 059_session_plugins_default_null.sql is deliberately comment-only (its
      // work was retired), so an empty split is legitimate.
      for (const part of parts) {
        try {
          db.prepare(part);
          checked += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Unresolved schema objects are expected (the scratch DB is empty) and
          // so are statements better-sqlite3 refuses to `prepare` at all
          // (PRAGMA with a value, and any statement it deems unsafe). A genuine
          // bad split reads as a syntax/incomplete-input error.
          expect(message).not.toMatch(/syntax error|incomplete input|unrecognized token/i);
          skipped += 1;
        }
      }
    }
    db.close();
    expect(checked + skipped).toBeGreaterThan(200);
  });
});
