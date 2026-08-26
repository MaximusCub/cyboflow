/**
 * Quick-session summary payload (shared across main ↔ frontend).
 *
 * Returned by the `sessions:get-summary` IPC read (`main/src/ipc/session.ts`)
 * and consumed by the quick-session canvas hook (`useSessionSummary.ts`). The
 * summary + history are produced by the idle-debounced Haiku summarizer
 * (`main/src/orchestrator/sessionSummary/`, session-summary-plan.md); this is
 * the pure read shape — the write side lives in `session_summaries` /
 * `session_summary_entries` (migration 083).
 *
 * Promoted to shared per the IPC parity rules (`docs/CODE-PATTERNS.md`): both
 * the main handler's `IPCResponse<T>` and the two frontend mirror surfaces
 * (`electron.d.ts`, `api.ts`) import THIS type — never a local re-declaration.
 */
export interface SessionSummaryPayload {
  /**
   * Whether the session-summary feature is enabled (config toggle). Carried on
   * the read so the canvas hides the summary UI without a separate config fetch;
   * when false the summary/entries are still whatever was last persisted.
   */
  enabled: boolean;
  /** The current rolling summary, or null when the session has never been summarized. */
  summary: string | null;
  /** `session_summaries.updated_at` (last summarize time), or null when never summarized. */
  updatedAt: string | null;
  /** The append-only per-sitting history sentences, oldest first. */
  entries: Array<{ id: number; entry: string; createdAt: string }>;
}

/**
 * Agent providers whose INTERACTIVE (PTY) sessions the summarizer cannot cover.
 *
 * Coverage is provider × SUBSTRATE, not provider alone. Every SDK substrate —
 * Claude, Codex, OMP alike — streams its turns into `conversation_messages`
 * (`sessionManager.addPanelConversationMessage`, including Codex/OMP
 * `agent_message` events), so the content-watermark read has real rows to fold.
 * A PTY session writes none of its own: its content is raw ANSI stdout in
 * `session_outputs`, and the only backfill that exists
 * (`services/ptyTranscriptIngest.ts`) parses the CLAUDE CLI's JSONL transcript.
 * There is no equivalent transcript for a Codex/OMP REPL, so those sessions
 * have nothing to summarize — and pointing the Claude ingest at one would
 * resolve a path from a `claude_session_id` that is not a Claude session's.
 *
 * This is the single source of truth for both sides of the feature: the
 * scheduler's eligibility gate (`orchestrator/sessionSummary/`) and the board
 * row's `summarySupported` flag (`orchestrator/quickSessionListing.ts`), which
 * previously disagreed — the scheduler excluded `codex` only while the listing
 * marked BOTH `codex` and `omp` unsupported, so an OMP session could be
 * summarized into a row that rendered the result as "unsupported".
 */
export const SUMMARY_UNSUPPORTED_PTY_PROVIDERS: ReadonlySet<string> = new Set(['codex', 'omp']);

/**
 * Whether the summarizer can cover a session, from its provider + substrate.
 *
 * A NULL/absent provider is the pre-migration-059 Claude default and is
 * eligible; an unrecognized provider is treated as coverable rather than
 * silently dropped (an SDK lane it does not know about still writes
 * conversation rows, and an empty delta is already a silent no-op downstream).
 */
export function isSessionSummarySupported(params: {
  agentProvider: string | null | undefined;
  substrate: string | null | undefined;
}): boolean {
  const { agentProvider, substrate } = params;
  if (agentProvider === null || agentProvider === undefined) return true;
  if (substrate !== 'interactive') return true;
  return !SUMMARY_UNSUPPORTED_PTY_PROVIDERS.has(agentProvider);
}
