/**
 * Tests for ptyTranscriptIngest — the PTY-session transcript backfill that lets
 * the idle-gated session summarizer see interactive-substrate conversations
 * (migration 084, docs/proposals/session-summary-plan.md PTY follow-up).
 *
 * Uses a REAL DatabaseService against a temp-file DB (so the migration-083
 * partial-unique dedupe index is exactly as it ships) and a REAL fixture JSONL
 * written under an injected `projectsRoot` temp dir — never touches the real
 * `~/.claude`. The fixture entry shapes (top-level uuid/timestamp/isMeta/
 * isSidechain; message.content as string OR an array of typed blocks) were
 * verified against live `~/.claude/projects/*.jsonl` transcripts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../database/database';
import { encodeCwd } from '../panels/claude/transcript/encodeCwd';
import { ingestPtyTranscript } from '../ptyTranscriptIngest';

let tmpDir: string;
let projectsRoot: string;
let db: DatabaseService;
let projectId: number;
let worktreePath: string;

const CLAUDE_SESSION_ID = 'cs-uuid-1234';

/** Create a session and optionally stamp its substrate + claude_session_id. */
function createSession(
  id: string,
  opts: { substrate?: string | null; claudeSessionId?: string | null } = {},
): void {
  db.createSession({
    id,
    name: id,
    initial_prompt: 'p',
    worktree_name: `w-${id}`,
    worktree_path: worktreePath,
    project_id: projectId,
  });
  db.getDb()
    .prepare('UPDATE sessions SET substrate = ?, claude_session_id = ? WHERE id = ?')
    .run(opts.substrate ?? null, opts.claudeSessionId ?? null, id);
}

/** Write a JSONL transcript at the path ingest resolves for `worktreePath`/`sessionId`. */
function writeTranscript(claudeSessionId: string, lines: unknown[]): void {
  const keyDir = join(projectsRoot, encodeCwd(worktreePath));
  mkdirSync(keyDir, { recursive: true });
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  writeFileSync(join(keyDir, `${claudeSessionId}.jsonl`), body, 'utf8');
}

function userString(uuid: string, ts: string, content: string): unknown {
  return { type: 'user', uuid, timestamp: ts, isMeta: null, isSidechain: false, message: { role: 'user', content } };
}
function assistantText(uuid: string, ts: string, text: string): unknown {
  return {
    type: 'assistant',
    uuid,
    timestamp: ts,
    isMeta: null,
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }] },
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-pty-ingest-'));
  projectsRoot = join(tmpDir, 'claude-projects');
  worktreePath = join(tmpDir, 'worktree');
  db = new DatabaseService(join(tmpDir, 'test.db'));
  db.initialize();
  projectId = db.createProject('Proj', join(tmpDir, 'repo')).id;
});

afterEach(() => {
  db.getDb().close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('ingestPtyTranscript happy path', () => {
  it('inserts only top-level user/assistant text turns, with correct uuid/timestamp/type', async () => {
    createSession('s1', { substrate: 'interactive', claudeSessionId: CLAUDE_SESSION_ID });
    writeTranscript(CLAUDE_SESSION_ID, [
      userString('u1', '2026-03-04T12:00:00.000Z', 'fix the parser bug'),
      assistantText('a1', '2026-03-04T12:00:05.000Z', 'Looking into the parser now.'),
      // meta → skip
      { type: 'user', uuid: 'm1', timestamp: '2026-03-04T12:00:06.000Z', isMeta: true, message: { role: 'user', content: 'meta note' } },
      // sidechain → skip
      { type: 'assistant', uuid: 'sc1', timestamp: '2026-03-04T12:00:07.000Z', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } },
      // user tool_result only → skip
      { type: 'user', uuid: 'tr1', timestamp: '2026-03-04T12:00:08.000Z', isMeta: null, isSidechain: false, message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      // assistant tool_use/thinking only (no text) → skip
      { type: 'assistant', uuid: 'tu1', timestamp: '2026-03-04T12:00:09.000Z', isMeta: null, isSidechain: false, message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', name: 'Bash', input: {} }] } },
      // synthetic slash-command echo → skip
      userString('cmd1', '2026-03-04T12:00:10.000Z', '<command-name>/compact</command-name>\n<command-message>compact</command-message>'),
      assistantText('a2', '2026-03-04T12:00:11.000Z', 'Done — parser fixed.'),
    ]);

    const result = await ingestPtyTranscript({ db, projectsRoot }, 's1');
    expect(result).toEqual({ inserted: 3 });

    const rows = db.getConversationMessagesAfter('s1', 0);
    expect(rows.map((r) => r.content)).toEqual([
      'fix the parser bug',
      'Looking into the parser now.',
      'Done — parser fixed.',
    ]);
    // Explicit transcript timestamps are honored (not CURRENT_TIMESTAMP).
    expect(rows[0].timestamp).toBe('2026-03-04T12:00:00.000Z');
    expect(rows[1].timestamp).toBe('2026-03-04T12:00:05.000Z');
    expect(rows.map((r) => r.message_type)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('is idempotent — a second ingest of the same transcript inserts 0', async () => {
    createSession('s1', { substrate: 'interactive', claudeSessionId: CLAUDE_SESSION_ID });
    writeTranscript(CLAUDE_SESSION_ID, [
      userString('u1', '2026-03-04T12:00:00.000Z', 'hi'),
      assistantText('a1', '2026-03-04T12:00:01.000Z', 'hello'),
    ]);

    const first = await ingestPtyTranscript({ db, projectsRoot }, 's1');
    expect(first).toEqual({ inserted: 2 });
    const second = await ingestPtyTranscript({ db, projectsRoot }, 's1');
    expect(second).toEqual({ inserted: 0 });
    expect(db.getConversationMessageCount('s1')).toBe(2);
  });

  it('re-ingest picks up ONLY newly appended turns', async () => {
    createSession('s1', { substrate: 'interactive', claudeSessionId: CLAUDE_SESSION_ID });
    writeTranscript(CLAUDE_SESSION_ID, [userString('u1', '2026-03-04T12:00:00.000Z', 'first')]);
    expect(await ingestPtyTranscript({ db, projectsRoot }, 's1')).toEqual({ inserted: 1 });

    writeTranscript(CLAUDE_SESSION_ID, [
      userString('u1', '2026-03-04T12:00:00.000Z', 'first'),
      assistantText('a1', '2026-03-04T12:00:02.000Z', 'second'),
    ]);
    expect(await ingestPtyTranscript({ db, projectsRoot }, 's1')).toEqual({ inserted: 1 });
    expect(db.getConversationMessageCount('s1')).toBe(2);
  });
});

describe('ingestPtyTranscript skip paths', () => {
  it('skips a non-interactive (SDK) session without reading any file', async () => {
    createSession('s1', { substrate: 'sdk', claudeSessionId: CLAUDE_SESSION_ID });
    // Even if a transcript exists, an SDK session is not ingested here.
    writeTranscript(CLAUDE_SESSION_ID, [userString('u1', '2026-03-04T12:00:00.000Z', 'hi')]);
    const result = await ingestPtyTranscript({ db, projectsRoot }, 's1');
    expect(result).toEqual({ skipped: 'not-interactive' });
    expect(db.getConversationMessageCount('s1')).toBe(0);
  });

  it('skips an interactive session with no claude_session_id', async () => {
    createSession('s1', { substrate: 'interactive', claudeSessionId: null });
    const result = await ingestPtyTranscript({ db, projectsRoot }, 's1');
    expect(result).toEqual({ skipped: 'no-claude-session-id' });
  });

  it('skips quietly when the transcript file is missing', async () => {
    createSession('s1', { substrate: 'interactive', claudeSessionId: CLAUDE_SESSION_ID });
    // no writeTranscript call
    const result = await ingestPtyTranscript({ db, projectsRoot }, 's1');
    expect(result).toEqual({ skipped: 'transcript-missing' });
    expect(db.getConversationMessageCount('s1')).toBe(0);
  });

  it('skips a missing session', async () => {
    const result = await ingestPtyTranscript({ db, projectsRoot }, 'does-not-exist');
    expect(result).toEqual({ skipped: 'session-not-found' });
  });

  it('tolerates malformed JSONL lines, ingesting the valid ones', async () => {
    createSession('s1', { substrate: 'interactive', claudeSessionId: CLAUDE_SESSION_ID });
    const keyDir = join(projectsRoot, encodeCwd(worktreePath));
    mkdirSync(keyDir, { recursive: true });
    const good = JSON.stringify(userString('u1', '2026-03-04T12:00:00.000Z', 'good line'));
    writeFileSync(join(keyDir, `${CLAUDE_SESSION_ID}.jsonl`), `${good}\n{ not json\n\n`, 'utf8');

    const result = await ingestPtyTranscript({ db, projectsRoot }, 's1');
    expect(result).toEqual({ inserted: 1 });
    expect(db.getConversationMessagesAfter('s1', 0).map((r) => r.content)).toEqual(['good line']);
  });
});
