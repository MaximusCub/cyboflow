/**
 * Split a multi-statement SQL script into its individual statements.
 *
 * The file-based migration runner needs this so it can execute a migration
 * STATEMENT BY STATEMENT inside one transaction: SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so a re-applied migration (the ledger tracks by
 * FILENAME, and renumbering a file makes it re-apply) throws on the ALTER that
 * already landed. Executing the file as one `.exec()` blob makes that throw
 * abort — and roll back — every OTHER statement in the file. Per-statement
 * execution lets the runner skip just the already-applied statement.
 *
 * The scanner is deliberately literal-aware rather than a naive `split(';')`:
 *
 *   - `--` line comments and slash-star block comments are skipped whole, so a
 *     semicolon inside prose (every migration in this repo carries a header
 *     comment) never splits a statement.
 *   - `'…'` string literals (with `''` escapes), `"…"` / backtick / `[…]`
 *     quoted identifiers are skipped whole.
 *   - `CREATE TRIGGER … BEGIN … END;` bodies are kept together. Trigger bodies
 *     contain their own semicolon-terminated statements, so the terminator only
 *     counts once the trigger's compound block has closed. `CASE … END` inside
 *     the body is counted so its `END` does not close the block early.
 *
 * No migration in `main/src/database/migrations/` currently defines a trigger;
 * that branch exists so adding one does not silently corrupt the split.
 *
 * Chunks holding only whitespace and comments are dropped — passing them to
 * `exec()` is harmless but pointless, and dropping them keeps the runner's
 * per-statement logging meaningful.
 */

/**
 * Drop leading whitespace and comments from a statement, exposing the first
 * real keyword. Every migration in this repo opens with a header comment, and
 * the splitter keeps those attached to the statement that follows (they are the
 * statement's documentation, and keeping them makes the runner's per-statement
 * logging readable) — so any check on a statement's SHAPE has to look past them.
 */
export function stripLeadingSqlComments(statement: string): string {
  let i = 0;
  const n = statement.length;
  for (;;) {
    while (i < n && /\s/.test(statement[i])) i += 1;
    if (statement[i] === '-' && statement[i + 1] === '-') {
      const nl = statement.indexOf('\n', i + 2);
      if (nl === -1) return '';
      i = nl + 1;
      continue;
    }
    if (statement[i] === '/' && statement[i + 1] === '*') {
      const close = statement.indexOf('*/', i + 2);
      if (close === -1) return '';
      i = close + 2;
      continue;
    }
    return statement.slice(i);
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  const length = sql.length;

  let chunkStart = 0;
  let hasCode = false;
  /** First few keywords of the current chunk, used to detect a CREATE TRIGGER. */
  let leadWords: string[] = [];
  /** Depth of the trigger's BEGIN…END block, plus any CASE…END nested in it. */
  let compoundDepth = 0;
  let sawTriggerBegin = false;

  const isTriggerHead = (): boolean =>
    leadWords[0] === 'CREATE' && leadWords.slice(1, 4).includes('TRIGGER');

  const endStatement = (endExclusive: number): void => {
    if (hasCode) {
      const text = sql.slice(chunkStart, endExclusive).trim();
      if (text.length > 0) statements.push(text);
    }
    chunkStart = endExclusive;
    hasCode = false;
    leadWords = [];
    compoundDepth = 0;
    sawTriggerBegin = false;
  };

  let i = 0;
  while (i < length) {
    const ch = sql[i];

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? length : nl + 1;
      continue;
    }

    // /* block comment */
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? length : close + 2;
      continue;
    }

    // Quoted string / identifier. SQLite doubles the quote character to escape it.
    if (ch === "'" || ch === '"' || ch === '`') {
      hasCode = true;
      i += 1;
      while (i < length) {
        if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            i += 2; // doubled quote — an escaped literal quote, not the close
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    // [bracketed identifier] — no escape form in SQLite
    if (ch === '[') {
      hasCode = true;
      const close = sql.indexOf(']', i + 1);
      i = close === -1 ? length : close + 1;
      continue;
    }

    if (ch === ';') {
      // Inside a trigger body the semicolons belong to the body's own
      // statements; only the one closing the BEGIN…END block terminates.
      if (isTriggerHead() && !(sawTriggerBegin && compoundDepth === 0)) {
        i += 1;
        continue;
      }
      endStatement(i + 1);
      i += 1;
      continue;
    }

    if (IDENT_START.test(ch)) {
      let end = i + 1;
      while (end < length && IDENT_CHAR.test(sql[end])) end += 1;
      const word = sql.slice(i, end).toUpperCase();
      hasCode = true;
      if (leadWords.length < 4) leadWords.push(word);
      if (isTriggerHead()) {
        if (word === 'BEGIN') {
          compoundDepth += 1;
          sawTriggerBegin = true;
        } else if (word === 'CASE') {
          compoundDepth += 1;
        } else if (word === 'END' && compoundDepth > 0) {
          compoundDepth -= 1;
        }
      }
      i = end;
      continue;
    }

    if (!/\s/.test(ch)) hasCode = true;
    i += 1;
  }

  // Trailing statement with no terminating semicolon.
  endStatement(length);

  return statements;
}
