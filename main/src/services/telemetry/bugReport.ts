/**
 * In-app bug reporting over Sentry User Feedback.
 *
 * Three properties of the SDK shape everything here, all verified against the
 * installed @sentry/electron 7.13.0 (JS SDK 10.50.0):
 *
 * 1. `beforeSend` NEVER RUNS ON FEEDBACK. `captureFeedback` builds an event with
 *    `type: 'feedback'`, and `processBeforeSend` only invokes `beforeSend` when
 *    `isErrorEvent(event)` is true. The privacy hook that protects every error
 *    event is therefore bypassed, so this module scrubs explicitly via an event
 *    processor on its own scope and never relies on the global hook.
 *
 * 2. A BARE NodeClient LEAKS THE HOSTNAME. Its constructor defaults `serverName`
 *    to `os.hostname()` unless `includeServerName: false` is passed; the normal
 *    Electron init passes it, an ad-hoc client would not. Combined with (1),
 *    nothing downstream would strip it.
 *
 * 3. AN EVENT ID IS NOT DELIVERY. `captureFeedback` returns a UUID synchronously
 *    from `scope.captureEvent` even when there is no DSN and no transport ever
 *    sends. Reporting success on that basis would tell a user their report was
 *    filed while the maintainer receives nothing. Delivery is therefore derived
 *    from an explicit `flush`, and a missing DSN is surfaced, not swallowed.
 */
import {
  NodeClient,
  Scope,
  captureFeedback,
  defaultStackParser,
  makeElectronOfflineTransport,
  getClient,
  type Event,
} from '@sentry/electron/main';
import { app } from 'electron';
import { resolveTelemetryCredentials } from './credentials';
import { isSentryActive } from './index';
import type { BugReportDiagnostics } from './diagnostics';

/**
 * Outcome of a submission attempt.
 *   - `accepted`    — flushed to Sentry within the timeout.
 *   - `queued`      — not flushed in time; the offline transport holds it on disk
 *                     and retries on a later boot.
 *   - `unavailable` — no DSN is configured, so this build can never deliver.
 *   - `failed`      — the SDK threw.
 */
export type BugReportDelivery = 'accepted' | 'queued' | 'unavailable' | 'failed';

export interface BugReportSubmission {
  whatHappened: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  /** Only populated when the user ticked the contact-consent box. */
  email?: string;
  runId?: string;
  flowName?: string;
  /** The exact log text the user previewed and opted to include, if any. */
  logText?: string;
}

export interface BugReportResult {
  delivery: BugReportDelivery;
  eventId?: string;
  error?: string;
}

const FLUSH_TIMEOUT_MS = 10_000;

/** Lazily built isolated client, reused across submissions. */
let isolatedClient: NodeClient | null = null;

/**
 * Strip identifying context that feedback events would otherwise carry.
 *
 * Runs as a scope event processor because `beforeSend` does not fire for
 * feedback (see file header). `includeServerName: false` should already prevent
 * `server_name`, but this is the enforcement point that holds for BOTH the
 * isolated client and the globally initialized one.
 */
function stripIdentifyingContext(event: Event): Event {
  event.server_name = undefined;
  delete event.user;
  // Breadcrumbs accumulate app-wide and can contain paths, commands, and prompts.
  // A bug report must carry only what the user reviewed.
  delete event.breadcrumbs;
  return event;
}

/**
 * Build (once) an isolated client for the case where passive error reporting is
 * switched off. Filing a bug report is a deliberate user action and must work
 * regardless of the telemetry toggle, but it must NOT switch passive capture
 * back on — hence `integrations: []`.
 *
 * Returns null when no DSN is configured.
 */
function ensureIsolatedClient(): NodeClient | null {
  if (isolatedClient) return isolatedClient;

  const { sentryDsn, environment } = resolveTelemetryCredentials();
  if (!sentryDsn) return null;

  const client = new NodeClient({
    dsn: sentryDsn,
    release: app.getVersion(),
    environment,
    // Codex #2: without this the constructor falls back to os.hostname().
    includeServerName: false,
    // Disk-backed queueing, matching what the normal Electron init uses. A plain
    // HTTP transport would silently drop reports filed while offline.
    transport: makeElectronOfflineTransport(),
    stackParser: defaultStackParser,
    // No passive integrations: this client exists solely to send user-initiated
    // feedback, never to capture errors behind the user's back.
    integrations: [],
  });
  client.init();
  isolatedClient = client;
  return client;
}

/** Compose the three prose fields into the single `message` body Sentry stores. */
export function composeFeedbackMessage(input: BugReportSubmission): string {
  return [
    '## What happened',
    input.whatHappened.trim(),
    '',
    '## Steps to reproduce',
    input.stepsToReproduce.trim() || '(not provided)',
    '',
    '## Expected',
    input.expectedBehavior.trim() || '(not provided)',
  ].join('\n');
}

/**
 * Build the tag bag. Low-cardinality and non-PII: these are for filtering the
 * feedback inbox, not for carrying report content.
 */
export function buildFeedbackTags(
  input: BugReportSubmission,
  diagnostics: BugReportDiagnostics,
): Record<string, string> {
  const tags: Record<string, string> = {
    report_source: 'sidebar',
    environment: diagnostics.environment,
    app_version: diagnostics.appVersion,
    platform: diagnostics.platform,
    arch: diagnostics.arch,
    install_id: diagnostics.installId,
    has_logs: input.logText ? 'yes' : 'no',
    has_contact: input.email ? 'yes' : 'no',
  };
  if (input.runId) tags.run_id = input.runId;
  if (input.flowName) tags.flow = input.flowName;
  return tags;
}

/** Test seam: drop the cached isolated client between cases. */
export function __resetIsolatedClientForTests(): void {
  isolatedClient = null;
}

/**
 * Submit a bug report.
 *
 * Uses the globally initialized client when error reporting is on, otherwise the
 * isolated one. In BOTH cases the event is captured on a FRESH `Scope` — the
 * ambient scope carries breadcrumbs, user, and tags accumulated app-wide, and
 * since feedback bypasses `beforeSend` none of that would be scrubbed on the way
 * out.
 */
export async function submitBugReport(
  input: BugReportSubmission,
  diagnostics: BugReportDiagnostics,
): Promise<BugReportResult> {
  try {
    const client = isSentryActive() ? (getClient() ?? ensureIsolatedClient()) : ensureIsolatedClient();
    if (!client) {
      return {
        delivery: 'unavailable',
        error: 'No Sentry DSN is configured in this build, so reports cannot be delivered.',
      };
    }

    const scope = new Scope();
    scope.setClient(client);
    scope.addEventProcessor(stripIdentifyingContext);

    const attachments = [
      {
        filename: 'diagnostics.json',
        data: new TextEncoder().encode(JSON.stringify(diagnostics, null, 2)),
      },
    ];
    // Only present when the user explicitly opted in after previewing the text.
    if (input.logText) {
      attachments.push({
        filename: 'log-tail.txt',
        data: new TextEncoder().encode(input.logText),
      });
    }

    const eventId = captureFeedback(
      {
        message: composeFeedbackMessage(input),
        email: input.email,
        source: 'bug-report-dialog',
        tags: buildFeedbackTags(input, diagnostics),
      },
      { attachments },
      scope,
    );

    // Codex #3: the id above is returned unconditionally. Delivery is whether
    // the transport actually drained.
    const flushed = await client.flush(FLUSH_TIMEOUT_MS);
    return { delivery: flushed ? 'accepted' : 'queued', eventId };
  } catch (error) {
    return {
      delivery: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
