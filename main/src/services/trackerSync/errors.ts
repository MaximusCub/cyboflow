/**
 * Typed errors for the tracker-sync provider seam. Adapters throw these (and
 * only these) for API failures so the sync core and the wizard can branch on
 * class instead of parsing messages: auth failures surface as re-connect
 * prompts, everything else feeds the outbox retry/backoff machinery.
 */

import type { TrackerProvider } from '../../../../shared/types/trackerSync';

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
