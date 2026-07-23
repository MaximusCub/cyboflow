/**
 * validateDesignIdeaLink — the idea-liveness gate for Design Mode session
 * creation (design-mode.md "Idea link — integrity contract", point (a)).
 * Exercises all four rejection reasons + the success case against a minimal
 * in-memory `ideas` table (just the columns the helper reads — no need for
 * the full migration chain since this is a pure read-only SELECT helper).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { validateDesignIdeaLink } from '../designIdeaValidation';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ideas (
      id            TEXT PRIMARY KEY,
      project_id    INTEGER NOT NULL,
      decomposed_at TEXT,
      archived_at   TEXT
    )
  `);
  return db;
}

describe('validateDesignIdeaLink', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
  });

  it("rejects with reason 'not_found' when no idea row exists for the id", () => {
    const result = validateDesignIdeaLink(db, 'idea-missing', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.error).toMatch(/idea-missing/);
      expect(result.error).toMatch(/not found/i);
    }
  });

  it("rejects with reason 'wrong_project' when the idea belongs to a different project", () => {
    db.prepare(
      `INSERT INTO ideas (id, project_id, decomposed_at, archived_at) VALUES (?, ?, NULL, NULL)`,
    ).run('idea-1', 999);

    const result = validateDesignIdeaLink(db, 'idea-1', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('wrong_project');
      expect(result.error).toMatch(/different project/i);
    }
  });

  it("rejects with reason 'decomposed' when the idea has been decomposed", () => {
    db.prepare(
      `INSERT INTO ideas (id, project_id, decomposed_at, archived_at) VALUES (?, ?, ?, NULL)`,
    ).run('idea-1', 42, '2026-07-01T00:00:00Z');

    const result = validateDesignIdeaLink(db, 'idea-1', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('decomposed');
      expect(result.error).toMatch(/decomposed/i);
    }
  });

  it("rejects with reason 'archived' when the idea is archived", () => {
    db.prepare(
      `INSERT INTO ideas (id, project_id, decomposed_at, archived_at) VALUES (?, ?, NULL, ?)`,
    ).run('idea-1', 42, '2026-07-01T00:00:00Z');

    const result = validateDesignIdeaLink(db, 'idea-1', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('archived');
      expect(result.error).toMatch(/archived/i);
    }
  });

  it('succeeds for a live idea owned by the given project (not decomposed, not archived)', () => {
    db.prepare(
      `INSERT INTO ideas (id, project_id, decomposed_at, archived_at) VALUES (?, ?, NULL, NULL)`,
    ).run('idea-1', 42);

    const result = validateDesignIdeaLink(db, 'idea-1', 42);

    expect(result).toEqual({ ok: true });
  });

  it('checks decomposed BEFORE archived when both are set (decomposed wins — matches the row-check order)', () => {
    db.prepare(
      `INSERT INTO ideas (id, project_id, decomposed_at, archived_at) VALUES (?, ?, ?, ?)`,
    ).run('idea-1', 42, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z');

    const result = validateDesignIdeaLink(db, 'idea-1', 42);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('decomposed');
    }
  });
});
