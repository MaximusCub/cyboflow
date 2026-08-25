/**
 * quickSessionListing — derives the live quick-session status board.
 *
 * A "quick session" is an interactive/SDK chat session created via the
 * quick-create path: it carries a `chat_run_id` sentinel (the chat-REPL run),
 * is not the hidden main-repo singleton, and is not archived. This module reads
 * those rows and derives each session's live {@link QuickSessionState} from its
 * DB status plus a caller-supplied set of "blocked" run ids (runs with a
 * pending AskUserQuestion / permission gate). It is the read-side replacement
 * for the old IdleSessionDetector mint — nothing is persisted; state is
 * computed fresh on every call.
 *
 * The blocked-run resolution (QuestionRouter / ApprovalRouter pending maps + the
 * interactive manager's PTY awaiting-input set) lives at the IPC seam, which may
 * import services; this module stays pure (db + a plain Set) so it unit-tests
 * against a fake db without the orchestrator layering rule being violated.
 */
import type { DatabaseLike, PreparedStatement } from './types';
import type { QuickSessionRow, QuickSessionState } from '../../../shared/types/quickSessions';

/**
 * `session_summaries.state` values the review-home board understands
 * (migration 121). Mirrors database.ts's SESSION_SUMMARY_STATES — this
 * module reads the joined column straight from SQL (bypassing
 * DatabaseService's own read-boundary normalization), so it re-validates
 * here rather than trusting the raw column.
 */
const SESSION_SUMMARY_STATES = new Set(['working', 'complete', 'needs_input']);

const WAITING_ON_MAX_LENGTH = 300;

/** Providers the summarizer can never cover (see QuickSessionRow.summarySupported). */
const SUMMARY_UNSUPPORTED_PROVIDERS = new Set(['codex', 'omp']);

/** Validate a joined `summary_state` value; anything outside the known set (including non-string) degrades to null. */
function normalizeSummaryState(value: unknown): 'working' | 'complete' | 'needs_input' | null {
  return typeof value === 'string' && SESSION_SUMMARY_STATES.has(value)
    ? (value as 'working' | 'complete' | 'needs_input')
    : null;
}

/** Validate/clamp a joined `waiting_on` value: non-string or blank (after trim) becomes null; over-length is truncated. */
function normalizeWaitingOn(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > WAITING_ON_MAX_LENGTH ? trimmed.slice(0, WAITING_ON_MAX_LENGTH) : trimmed;
}

/** A candidate quick-session row as read from SQLite. */
export interface QuickSessionCandidateRow {
  id: string;
  project_id: number;
  name: string;
  status: string;
  chat_run_id: string | null;
  /**
   * The session's real last-REST boundary (migration 119) normalized to UTC ISO:
   * `COALESCE(sessions.idle_since, sessions.updated_at)`.
   *
   * `idle_since` is stamped only at the busy→resting status transition, so —
   * unlike `updated_at`, which any write to the row bumps — a rename, a folder
   * move, the boot sweep or a status refinement no longer resets the quiet
   * clock. Migration 120 backfilled every row that was already at rest, so the
   * COALESCE arm is reached only by a row that is currently BUSY (idle_since
   * NULL by design) — and such a row never reports idleSince anyway, since
   * toQuickSessionRow returns it for `idle` rows only.
   * May be null for a malformed timestamp.
   */
  idle_since_iso: string | null;
  /**
   * 1 when NOT viewed since the last update (last_viewed_at null or < updated_at).
   * Computed in SQL via datetime() so the ' ' vs 'T' timestamp-format mismatch
   * (CURRENT_TIMESTAMP vs ISO) can't corrupt the comparison — mirrors
   * IdleSessionDetector's IN_SCOPE_PREDICATE.
   */
  unviewed: number;
  /** sessions.exit_code — usually null on the SDK substrate; the PTY substrate writes it. */
  exit_code: number | null;
  /** sessions.agent_provider ('claude'/'codex'/'omp'/…); NOT NULL in schema but read defensively. */
  agent_provider: string | null;
  /** sessions.worktree_name. */
  worktree_name: string | null;
  /** session_summaries.summary, via LEFT JOIN — null when never summarized. */
  summary: string | null;
  /** session_summaries.state, via LEFT JOIN — raw, re-validated by {@link normalizeSummaryState}. */
  summary_state: string | null;
  /** session_summaries.waiting_on, via LEFT JOIN — raw, re-validated by {@link normalizeWaitingOn}. */
  waiting_on: string | null;
}

/**
 * The quick-session predicate: a chat/quick session (chat_run_id sentinel
 * present), not the hidden main-repo singleton, not archived, with a project.
 * Mirrors IdleSessionDetector's identity clause minus the interactive-only /
 * completed-unviewed narrowing — the board shows EVERY quick session (running,
 * idle, blocked), both substrates.
 */
const QUICK_SESSION_PREDICATE = `
  s.chat_run_id IS NOT NULL
  AND (s.is_main_repo IS NULL OR s.is_main_repo = 0)
  AND (s.archived IS NULL OR s.archived = 0)
  AND s.project_id IS NOT NULL
`;

const SELECT_COLS = `
  s.id, s.project_id, s.name, s.status, s.chat_run_id,
  strftime('%Y-%m-%dT%H:%M:%SZ', COALESCE(s.idle_since, s.updated_at)) AS idle_since_iso,
  CASE WHEN s.last_viewed_at IS NULL OR datetime(s.last_viewed_at) < datetime(s.updated_at)
       THEN 1 ELSE 0 END AS unviewed,
  s.exit_code, s.agent_provider, s.worktree_name,
  ss.summary AS summary, ss.state AS summary_state, ss.waiting_on AS waiting_on
`;

const SUMMARIES_JOIN = `LEFT JOIN session_summaries ss ON ss.session_id = s.id`;

/**
 * Derive a session's board state. Precedence: `blocked` (a pending human answer)
 * wins over everything — a blocked session is technically still "running", but
 * "needs you" is the more useful signal. Otherwise DB status `running`/`pending`
 * → `running`; every resting status (`completed`/`stopped`/`failed`) → `idle`.
 */
export function deriveQuickSessionState(
  row: QuickSessionCandidateRow,
  blockedRunIds: ReadonlySet<string>,
): QuickSessionState {
  if (row.chat_run_id !== null && blockedRunIds.has(row.chat_run_id)) return 'blocked';
  if (row.status === 'running' || row.status === 'pending') return 'running';
  return 'idle';
}

/**
 * Map a candidate row + blocked set to a board row. `idleSince` is set only for
 * idle rows, and comes from `idle_since_iso` (the real rest boundary), NOT from
 * `updated_at` — see the field docs on {@link QuickSessionCandidateRow}.
 */
export function toQuickSessionRow(
  row: QuickSessionCandidateRow,
  blockedRunIds: ReadonlySet<string>,
): QuickSessionRow {
  const state = deriveQuickSessionState(row, blockedRunIds);
  return {
    sessionId: row.id,
    name: row.name,
    projectId: row.project_id,
    runId: row.chat_run_id,
    state,
    idleSince: state === 'idle' ? row.idle_since_iso : null,
    // A blocked row always needs you (a pending gate), independent of viewed-ness.
    unviewed: state === 'blocked' ? false : row.unviewed === 1,
    updatedAtIso: row.updated_at_iso,
    rawStatus: row.status,
    exitCode: row.exit_code,
    summary: row.summary,
    summaryState: normalizeSummaryState(row.summary_state),
    waitingOn: normalizeWaitingOn(row.waiting_on),
    summarySupported: row.agent_provider === null || !SUMMARY_UNSUPPORTED_PROVIDERS.has(row.agent_provider),
    worktreeName: row.worktree_name,
    // The pure listing module never touches services (LAYERING RULE above); the
    // IPC seam attaches a cache-only git snapshot via GitStatusManager.peekCachedStatus.
    git: null,
  };
}

/**
 * Read the quick-session board. `projectId` scopes to one project; omit it for
 * every project (the cross-project review home). Rows are returned oldest-update
 * first; the frontend applies the board sort (blocked → longest-idle → running).
 */
export function listQuickSessions(
  db: DatabaseLike,
  blockedRunIds: ReadonlySet<string>,
  projectId?: number,
): QuickSessionRow[] {
  const stmt: PreparedStatement =
    projectId === undefined
      ? db.prepare(
          `SELECT ${SELECT_COLS} FROM sessions s
            ${SUMMARIES_JOIN}
            WHERE ${QUICK_SESSION_PREDICATE}
            ORDER BY datetime(s.updated_at) ASC`,
        )
      : db.prepare(
          `SELECT ${SELECT_COLS} FROM sessions s
            ${SUMMARIES_JOIN}
            WHERE ${QUICK_SESSION_PREDICATE} AND s.project_id = ?
            ORDER BY datetime(s.updated_at) ASC`,
        );
  const rows = (projectId === undefined
    ? stmt.all()
    : stmt.all(projectId)) as QuickSessionCandidateRow[];
  return rows.map((r) => toQuickSessionRow(r, blockedRunIds));
}
