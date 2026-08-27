/**
 * Typed errors for the tracker-sync provider seam. Adapters throw these (and
 * only these) for API failures so the sync core and the wizard can branch on
 * class instead of parsing messages: auth failures surface as re-connect
 * prompts, everything else feeds the outbox retry/backoff machinery.
 */

import type { TrackerIssue, TrackerProvider } from '../../../../shared/types/trackerSync';

export class TrackerApiError extends Error {
  constructor(
    readonly provider: TrackerProvider,
    message: string,
    /** HTTP status when the failure had one; null for network/parse errors. */
    readonly status: number | null = null
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'TrackerApiError';
  }
}

/** 401/403 — the stored key is missing, revoked, or under-scoped. */
export class TrackerAuthError extends TrackerApiError {
  constructor(provider: TrackerProvider, message: string, status: number | null = null) {
    super(provider, message, status);
    this.name = 'TrackerAuthError';
  }
}

/**
 * The connection id a facade call named does not exist. Its own class (rather
 * than a bare Error) so the tRPC router can map it to NOT_FOUND by NAME — the
 * router may not import this module, which is why every class here sets
 * `this.name`.
 */
export class TrackerConnectionNotFoundError extends Error {
  constructor(connectionId: string) {
    super(`tracker connection ${connectionId} does not exist`);
    this.name = 'TrackerConnectionNotFoundError';
  }
}

/**
 * The push-target role was offered to a PAUSED row while an active sibling is
 * carrying it. A paused row enqueues nothing (write-back skips on status before
 * push_target), and a locally-created idea is pushed exactly once, at creation
 * — never back-filled — so accepting the swap would drop every idea filed until
 * the row is reconnected. Refused with the actionable fix in the message; the
 * tRPC router maps it to CONFLICT by NAME (it may not import this module).
 */
export class TrackerConnectionPausedError extends Error {
  constructor(connectionId: string) {
    super(
      `tracker connection ${connectionId} is paused — reconnect it with a fresh key before ` +
        'making it the push target',
    );
    this.name = 'TrackerConnectionPausedError';
  }
}

/**
 * A credential rotation was offered a key that authorizes a DIFFERENT workspace
 * than the connection is bound to. Storing it would silently repoint every one
 * of the connection's links at issue ids belonging to another workspace, so the
 * rotation is refused rather than applied.
 */
export class TrackerIdentityMismatchError extends Error {
  constructor(
    readonly expectedWorkspaceId: string | null,
    readonly actualWorkspaceId: string,
  ) {
    super(
      `this API key authorizes a different workspace (${actualWorkspaceId}) than this connection ` +
        `is connected to (${expectedWorkspaceId ?? 'unknown'}). Use a key for the connected workspace, ` +
        'or connect the other workspace as a new connection.',
    );
    this.name = 'TrackerIdentityMismatchError';
  }
}

/**
 * Recovery classification was asked of a connection that has none — a KEYED
 * provider. Their reconnect story is a pasted key, and the three shapes
 * {@link TrackerRecoveryClass} distinguishes (moved path, renamed prefix,
 * replaced instance) are all beads-workspace facts with no HTTP-provider
 * analogue, so answering with a guess would put a "Remap links" button in front
 * of a Linear connection. The tRPC router maps this to PRECONDITION_FAILED by
 * NAME (it may not import this module).
 */
export class TrackerRecoveryUnavailableError extends Error {
  constructor(readonly provider: TrackerProvider) {
    super(
      `${provider} connections have no workspace-recovery classification — reconnect them by ` +
        'pasting a fresh API key instead.',
    );
    this.name = 'TrackerRecoveryUnavailableError';
  }
}

/**
 * A recovery ACTION was asked for a state the workspace is not actually in.
 *
 * Every recovery action re-probes before it does anything, because the UI's
 * classification can be arbitrarily stale — the user may have renamed the
 * prefix back, or re-initialized the workspace again, in the seconds between
 * seeing the banner and clicking it. Both actions are destructive in their own
 * way (a remap rewrites every link's external id; an adoption retires a
 * connection and cancels its pending writes), so a state that no longer matches
 * refuses rather than applying a repair for a problem that is not there.
 * Mapped to CONFLICT by NAME.
 */
export class TrackerRecoveryStateError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    detail: string,
  ) {
    super(
      `this recovery applies to a ${expected} workspace, and re-probing now reports ${actual}: ` +
        `${detail} Re-open the connection to see what it needs.`,
    );
    this.name = 'TrackerRecoveryStateError';
  }
}

/**
 * Thrown by a GUARDED update (`capabilities.guardedUpdates === true`,
 * beads today — docs/proposals/tracker-beads-provider.md, "Dual writers on
 * one issue") when a post-write verification finds an interleaved remote
 * commit touched a field the caller's own patch also touched. beads has no
 * conditional-write primitive, so the write ALWAYS lands; this error is
 * raised after the fact, from a history diff back to the caller's
 * `expectedToken`, not in place of the write.
 *
 * `conflictingFields` names exactly which patched field(s) an interleaved
 * commit also touched — an unrelated-field interleave is NOT reported this
 * way (the caller settles it as done; nothing was clobbered).
 * `recoveredIssue` carries the clobbered remote value recovered from the
 * adapter's own write history (beads: `bd show <id> --as-of <CommitHash>`),
 * which is strictly more than an HTTP provider's raced-and-lost value ever
 * offers. The outbox drain consumes this as its own typed outcome — hold as
 * conflict with the recovered value, never an unconditional settle-unsent.
 */
export class TrackerRevisionMismatchError extends Error {
  constructor(
    message: string,
    readonly conflictingFields: readonly string[],
    readonly recoveredIssue: TrackerIssue | null,
  ) {
    super(message);
    this.name = 'TrackerRevisionMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Request timeouts
// ---------------------------------------------------------------------------

/**
 * How long any single adapter HTTP request may take before it is aborted.
 *
 * Both adapters attach `AbortSignal.timeout(...)` to every fetch, because a
 * request that never settles is worse here than one that fails: the sync core's
 * durability machinery is all built around a call RETURNING (the outbox settles
 * a row, the pass releases the per-connection lock, the poll loop moves on). A
 * hung socket instead pins the connection's lock forever, so its outbox never
 * drains again for the life of the process.
 */
export const TRACKER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * True when `err` is the abort an {@link TRACKER_REQUEST_TIMEOUT_MS} signal
 * produces. Node aborts a `AbortSignal.timeout` with a `TimeoutError`
 * DOMException; a caller-driven abort raises `AbortError`. Matched by NAME
 * because neither class is reliably `instanceof`-able across realms.
 */
export function isRequestAbort(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * The message a failed transport-level call reports. A timeout is named as one
 * — "request failed: The operation was aborted" tells a user nothing — and
 * everything else keeps its own message.
 *
 * Callers wrap the result in a `TrackerApiError` with a NULL status, which is
 * what makes a timeout RETRYABLE: outboxWorker's `isTerminalApiError` only
 * terminalizes a 4xx, so a null-status failure takes the backoff path.
 */
export function describeTransportFailure(err: unknown, timeoutMs: number): string {
  if (isRequestAbort(err)) return `request timed out after ${timeoutMs}ms`;
  return `network request failed: ${err instanceof Error ? err.message : String(err)}`;
}
