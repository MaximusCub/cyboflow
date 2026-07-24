/**
 * ptyTranscriptIngest — backfill an interactive (PTY) quick session's
 * conversation into `conversation_messages` so the idle-gated session summarizer
 * (docs/proposals/session-summary-plan.md) can see it.
 *
 * WHY THIS EXISTS: the SDK substrate writes each turn into `conversation_messages`
 * as it streams, but the interactive substrate does not — a PTY session's content
 * exists only as raw ANSI stdout blobs in `session_outputs`. So the scheduler's
 * content-watermark read (migration 082) always sees an empty delta for PTY
 * sessions and never summarizes them. The Claude CLI, however, writes its OWN
 * structured transcript to `~/.claude/projects/<encodeCwd(cwd)>/<uuid>.jsonl`
 * (the same file `transcriptTailSource.ts` tails). This service reads that JSONL
 * and mirrors its top-level user/assistant turns into `conversation_messages`,
 * idempotently (migration 083's `source_uuid` dedupe key), so the watermark read
 * has real rows to fold.
 *
 * Layering: this is a services-layer file (it reads the filesystem and the DB),
 * invoked by the scheduler through an injected closure wired in `index.ts`. The
 * scheduler module itself stays pure. `encodeCwd` is imported (import-only is
 * free); nothing under `services/panels/claude/` is MODIFIED, so the Tier-3 itest
 * gate is not triggered by this file.
 */
import { statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { CliSubstrate } from '../../../shared/types/substrate';
import type { LoggerLike } from '../orchestrator/types';
import { encodeCwd } from './panels/claude/transcript/encodeCwd';

/** Defensive cap: never read more than the last ~10MB of a transcript. */
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** Defensive cap: a single JSONL line longer than this is skipped, not parsed. */
const MAX_LINE_BYTES = 1 * 1024 * 1024;

/** Synthetic slash-command echoes the CLI writes as `user` string turns — not real conversation. */
const SYNTHETIC_WRAPPER_RE =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/;

/** A `sessions` row, narrowed to what transcript-path resolution + the ingest gate read. */
export interface PtyIngestSessionRow {
  id: string;
  substrate?: CliSubstrate | string | null;
  claude_session_id?: string | null;
  worktree_path?: string | null;
}

/** The narrow DB surface this service needs; `DatabaseService` satisfies it structurally. */
export interface PtyTranscriptIngestDb {
  getSession(sessionId: string): PtyIngestSessionRow | undefined;
  insertTranscriptConversationMessage(params: {
    sessionId: string;
    panelId?: string | null;
    messageType: 'user' | 'assistant';
    content: string;
    timestamp: string;
    sourceUuid: string;
  }): boolean;
}

export interface PtyTranscriptIngestDeps {
  db: PtyTranscriptIngestDb;
  logger?: LoggerLike;
  /** Override the `~/.claude/projects` root (tests inject a temp dir). */
  projectsRoot?: string;
}

export type PtyTranscriptIngestResult = { inserted: number } | { skipped: string };

/** One raw transcript line after JSON.parse, narrowed to the fields we read. */
interface RawTranscriptEntry {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { role?: unknown; content?: unknown } | null;
}

/** A content block inside `message.content` when it is an array. */
interface ContentBlock {
  type?: unknown;
  text?: unknown;
}

/**
 * Read at most the last `MAX_TOTAL_BYTES` of the transcript. For an oversized
 * file the leading (now-partial) line is dropped so we never JSON.parse a
 * fragment. Returns the decoded UTF-8 text.
 */
function readTranscriptTail(filePath: string): string {
  const size = statSync(filePath).size;
  if (size <= MAX_TOTAL_BYTES) {
    return readFileSync(filePath, 'utf8');
  }
  const start = size - MAX_TOTAL_BYTES;
  const buf = Buffer.alloc(MAX_TOTAL_BYTES);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, MAX_TOTAL_BYTES, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  const firstNewline = text.indexOf('\n');
  return firstNewline === -1 ? '' : text.slice(firstNewline + 1);
}

/**
 * Extract the plain conversational text from a transcript entry's message
 * content, or null if the entry carries no keepable text (tool-only /
 * thinking-only / synthetic slash-command echo).
 */
function extractPlainText(content: unknown): string | null {
  if (typeof content === 'string') {
    if (SYNTHETIC_WRAPPER_RE.test(content)) return null;
    const trimmed = content.trim();
    return trimmed.length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as ContentBlock[]) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    const joined = parts.join('\n').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

/**
 * Ingest a PTY session's Claude-CLI JSONL transcript into
 * `conversation_messages`. No-op (returns `{ skipped }`) for a non-interactive
 * session, one without a `claude_session_id`/`worktree_path`, or a missing
 * transcript file. Never throws to the caller — any error is logged and returned
 * as `{ skipped }`.
 */
export async function ingestPtyTranscript(
  deps: PtyTranscriptIngestDeps,
  sessionId: string,
): Promise<PtyTranscriptIngestResult> {
  try {
    const session = deps.db.getSession(sessionId);
    if (!session) return { skipped: 'session-not-found' };
    if (session.substrate !== 'interactive') return { skipped: 'not-interactive' };
    if (!session.claude_session_id) return { skipped: 'no-claude-session-id' };
    if (!session.worktree_path) return { skipped: 'no-worktree-path' };

    const projectsRoot = deps.projectsRoot ?? path.join(os.homedir(), '.claude', 'projects');
    const transcriptPath = path.join(
      projectsRoot,
      encodeCwd(session.worktree_path),
      `${session.claude_session_id}.jsonl`,
    );

    let text: string;
    try {
      text = readTranscriptTail(transcriptPath);
    } catch {
      // Missing file (the common case before the CLI has flushed) → quiet skip.
      return { skipped: 'transcript-missing' };
    }

    let inserted = 0;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) continue;

      let entry: RawTranscriptEntry;
      try {
        entry = JSON.parse(line) as RawTranscriptEntry;
      } catch {
        continue; // a truncated / malformed line is skipped, never fatal
      }

      // Top-level conversation turns only: not meta, not a subagent sidechain.
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;
      if (entry.isMeta) continue;
      if (entry.isSidechain) continue;
      if (typeof entry.uuid !== 'string' || entry.uuid.length === 0) continue;
      if (typeof entry.timestamp !== 'string' || entry.timestamp.length === 0) continue;

      const content = entry.message && typeof entry.message === 'object' ? entry.message.content : undefined;
      const plainText = extractPlainText(content);
      if (plainText === null) continue;

      if (
        deps.db.insertTranscriptConversationMessage({
          sessionId,
          messageType: entry.type,
          content: plainText,
          timestamp: entry.timestamp,
          sourceUuid: entry.uuid,
        })
      ) {
        inserted++;
      }
    }

    if (inserted > 0) {
      deps.logger?.debug('[ptyTranscriptIngest] ingested transcript turns', { sessionId, inserted });
    }
    return { inserted };
  } catch (err) {
    deps.logger?.warn('[ptyTranscriptIngest] ingest failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { skipped: 'error' };
  }
}
