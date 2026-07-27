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
