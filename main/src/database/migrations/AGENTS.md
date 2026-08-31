# Migration rules — read before adding or editing a file here

Shared guidance for every agent runtime (the `CLAUDE.md` beside this file just imports it).
Full detail: `docs/CODE-PATTERNS.md` → the "SQLite migrations" and "Database Schema" sections.

- **Numbering:** take the next FREE three-digit prefix — and re-check after every rebase,
  because main may have taken your number. Duplicate prefixes fail
  `migrationPrefixes.test.ts` (five legacy pairs are frozen exemptions).
- **Idempotence is per STATEMENT, and the ledger tracks by FILENAME** — a renumbered file
  re-applies wholesale, so every statement must be safe to re-run. Prefer
  `IF NOT EXISTS` DDL and `WHERE col IS NULL`-guarded backfills; gate an unconditional
  backfill on a `pragma_table_info` probe (pattern: `094_tracker_direction_modes.sql`).
  Only `duplicate column name` and `… already exists` are tolerated, per statement; any
  other error rolls the whole file back and blocks boot.
- **`PRAGMA foreign_keys` toggles OUTSIDE `db.transaction()`** — inside a transaction it
  is silently ignored and a table rebuild CASCADE-deletes FK children. The runner hoists
  it for you when the pragma appears in the file; see `docs/CODE-PATTERNS.md` for the
  full pattern.
- **Dual-source sync:** mirror any column change into `main/src/database/schema.sql` in
  the same commit — `pnpm run verify:schema` asserts parity. Entity/review tables are
  additionally pinned field-for-field to their TS row types by
  `entitySchemaParity.test.ts` (update migration + `schema.sql` + `models.ts` + the
  shared type together).
