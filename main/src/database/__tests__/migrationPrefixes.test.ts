import { describe, it, expect } from 'vitest';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Ratchet: no NEW duplicate migration prefixes.
 *
 * The runner orders migrations by numeric prefix (with a name tie-break — see
 * runFileBasedMigrations), and the ledger tracks each file by FULL NAME, so two
 * files sharing a prefix do "work" — but every duplicate is a merge hazard: two
 * branches minting the same next number is exactly how the recurring
 * renumber-collision churn happens, and relative order between same-prefix
 * files is only as principled as their names. Five legacy prefixes already
 * shipped duplicated (frozen below, before this guard existed); everything
 * after them takes the next FREE number.
 *
 * If this test fails on your new migration: rename it to one more than the
 * highest prefix in main/src/database/migrations/ (after a rebase, re-check —
 * main may have taken your number; renamed files re-apply by design and the
 * runner's per-statement idempotence makes that converge).
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const PREFIX_RE = /^(\d{3})_.*\.sql$/;

/** Prefixes that were already duplicated when this ratchet landed. FROZEN —
 * entries may be removed (if legacy files are ever renumbered) but never added. */
const LEGACY_DUPLICATE_PREFIXES: Record<string, number> = {
  '059': 3,
  '060': 2,
  '061': 2,
  '062': 2,
  '063': 2,
};

describe('migration file prefixes', () => {
  const counts = new Map<string, string[]>();
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    const match = PREFIX_RE.exec(name);
    if (!match) continue;
    const list = counts.get(match[1]) ?? [];
    list.push(name);
    counts.set(match[1], list);
  }

  it('no prefix outside the frozen legacy set is used by more than one file', () => {
    const offenders = [...counts.entries()]
      .filter(([prefix, files]) => files.length > 1 && !(prefix in LEGACY_DUPLICATE_PREFIXES))
      .map(([prefix, files]) => `${prefix}: ${files.sort().join(', ')}`);
    expect(
      offenders,
      `Duplicate migration prefix — rename to the next free number:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the legacy duplicates only shrink (stale exemptions must be deleted here)', () => {
    for (const [prefix, expected] of Object.entries(LEGACY_DUPLICATE_PREFIXES)) {
      const actual = counts.get(prefix)?.length ?? 0;
      expect(
        actual,
        `prefix ${prefix}: expected at most ${expected} files (frozen legacy count), found ${actual}`
      ).toBeLessThanOrEqual(expected);
      expect(
        actual,
        `prefix ${prefix} is no longer duplicated — remove it from LEGACY_DUPLICATE_PREFIXES`
      ).toBeGreaterThan(1);
    }
  });
});
