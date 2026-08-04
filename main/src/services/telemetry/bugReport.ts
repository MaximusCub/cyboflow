/**
 * In-app bug reporting over Sentry User Feedback.
 *
 * Four properties of the SDK shape everything here, all verified against the
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
 *    sends.
 *
 * 4. NEITHER IS A SUCCESSFUL `flush`. When a send fails, `makeOfflineTransport`
 *    catches the error, writes the envelope to its disk queue, and RESOLVES with
 *    `{}` — an HTTP 4xx likewise resolves with the response. So the transport
 *    reports success to the client either way and `flush` returns true for a
 *    report that never left the machine. Delivery is therefore read off the
 *    transport's own send result, which this module owns by wrapping the
 *    transport it hands to its client (see `makeTrackedTransport`).
 *
 * That last point is why bug reports always go through a dedicated client rather
 * than the globally initialized one: the global client's transport is built by
 * `Sentry.init` and cannot be observed. The dedicated client also gets its own
 * offline queue — two `Store` instances over one JSON file each cache it in
 * memory behind a per-instance mutex, so a shared queue would let the two
 * clients clobber each other's pending envelopes.
 */
import {
  NodeClient,
  Scope,
  captureFeedback,
  defaultStackParser,
  makeElectronOfflineTransport,
  type Event,
  type NodeOptions,
} from '@sentry/electron/main';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { resolveTelemetryCredentials } from './credentials';
import type { BugReportDiagnostics } from './diagnostics';
import type { BugReportDelivery } from '../../../../shared/types/bugReport';

/**
 * Deliveries this layer can produce. `rate-limited` belongs to the IPC limiter
 * and is excluded here rather than re-declared, so the two stay one union.
 */
export type BugReportServiceDelivery = Exclude<BugReportDelivery, 'rate-limited'>;

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
  delivery: BugReportServiceDelivery;
  eventId?: string;
  error?: string;
}

/** How long to wait for the event to be processed and handed to the transport. */
const FLUSH_TIMEOUT_MS = 10_000;
/** How long to wait for that send to settle before calling the outcome unknown. */
const SETTLE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Transport-level delivery tracking
// ---------------------------------------------------------------------------

type TransportFactory = NonNullable<NodeOptions['transport']>;
/**
 * `makeOfflineTransport` reads these off the same bag the client passes to the
 * transport factory, but they are not part of `NodeTransportOptions`, so the
 * option type has to be widened to name them.
 */
type BugReportTransportOptions = NodeOptions['transportOptions'] & { queuePath: string };
type SentryTransport = ReturnType<TransportFactory>;
type SentryEnvelope = Parameters<SentryTransport['send']>[0];
type SendResponse = Awaited<ReturnType<SentryTransport['send']>>;

/** What the transport actually did with one envelope. */
type SendOutcome =
  | { kind: 'accepted' }
  | { kind: 'queued' }
  | { kind: 'rejected'; status: number }
  | { kind: 'threw'; message: string }
  | { kind: 'unknown' };

interface SendTracker {
  /** Set once `captureFeedback` returns; only this envelope is tracked. */
  eventId?: string;
  settle: (outcome: SendOutcome) => void;
  settled: Promise<SendOutcome>;
}

/**
 * The submission currently awaiting a transport result. Module-level because the
 * transport wrapper is built once with the client and has no other channel back
 * to the caller. At most one is ever armed: submissions are single-flighted by
 * the IPC handler, and the wrapper only matches the exact event id it was armed
 * with, so background retries of previously queued envelopes cannot resolve it.
 */
let activeTracker: SendTracker | null = null;

function beginTracking(): SendTracker {
  let settle: (outcome: SendOutcome) => void = () => {};
  const settled = new Promise<SendOutcome>((resolve) => {
    settle = resolve;
  });
  const tracker: SendTracker = { settle, settled };
  activeTracker = tracker;
  return tracker;
}

function endTracking(tracker: SendTracker): void {
  if (activeTracker === tracker) activeTracker = null;
}

/** Envelope headers carry the event id for event envelopes; other kinds do not. */
function envelopeEventId(envelope: SentryEnvelope): string | undefined {
  const header: unknown = envelope[0];
  if (typeof header === 'object' && header !== null && 'event_id' in header) {
    const id = header.event_id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/**
 * Classify a transport response.
 *
 * An absent status code means the request never completed: the offline transport
 * resolves with `{}` after writing the envelope to disk. (The same `{}` is
 * returned in two much rarer cases — a full 64-deep send buffer, or an envelope
 * emptied by a prior rate-limit header — where nothing is stored either. Both
 * report as `queued`, which overstates the retry but never overstates delivery.)
 */
function classifySendResponse(response: SendResponse): SendOutcome {
  const status = response?.statusCode;
  if (status === undefined) return { kind: 'queued' };
  return status >= 400 ? { kind: 'rejected', status } : { kind: 'accepted' };
}

/**
 * Wrap the Electron offline transport so the outcome of OUR envelope is
 * observable. Everything else is passed straight through.
 */
function makeTrackedTransport(): TransportFactory {
  const base = makeElectronOfflineTransport();
  return (options) => {
    const inner = base(options);
    return {
      ...inner,
      send: async (envelope: SentryEnvelope) => {
        const id = envelopeEventId(envelope);
        const tracker = activeTracker && id && activeTracker.eventId === id ? activeTracker : null;
        try {
          const response = await inner.send(envelope);
          tracker?.settle(classifySendResponse(response));
          return response;
        } catch (error) {
          tracker?.settle({ kind: 'threw', message: describeError(error) });
          throw error;
        }
      },
    };
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Race the tracked send against a ceiling, so a hung request cannot hang the dialog. */
async function settleWithin(tracker: SendTracker, timeoutMs: number): Promise<SendOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      tracker.settled,
      new Promise<SendOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'unknown' }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toResult(outcome: SendOutcome): { delivery: BugReportServiceDelivery; error?: string } {
  switch (outcome.kind) {
    case 'accepted':
      return { delivery: 'accepted' };
    case 'rejected':
      return {
        delivery: 'failed',
        error: `The reporting service rejected the report (HTTP ${outcome.status}).`,
      };
    case 'threw':
      return { delivery: 'failed', error: outcome.message };
    case 'queued':
    case 'unknown':
      // Not confirmed delivered. `queued` is the honest label for both the
      // written-to-disk case and the still-in-flight one.
      return { delivery: 'queued' };
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Lazily built client, reused across submissions. */
let bugReportClient: NodeClient | null = null;

/** Offline queue for bug reports only — never shared with the error reporter's. */
function queuePath(): string {
  return path.join(app.getPath('userData'), 'sentry', 'bug-report-queue');
}

/**
 * Strip identifying context that feedback events would otherwise carry.
 *
 * Runs as a scope event processor because `beforeSend` does not fire for
 * feedback (see file header). `includeServerName: false` should already prevent
 * `server_name`, but this is the single enforcement point.
 */
function stripIdentifyingContext(event: Event): Event {
  event.server_name = undefined;
  delete event.user;
  // Breadcrumbs accumulate app-wide and can contain paths, commands, and prompts.
  // A bug report must carry only what the user reviewed.
  delete event.breadcrumbs;
  // `extra` is dropped from error events by scrubSentryEvent; feedback bypasses
  // that hook entirely, so it is dropped here for the same reason.
  delete event.extra;
  return event;
}

/**
 * Build (once) the client used for bug reports.
 *
 * Deliberately separate from the globally initialized one even when error
 * reporting is on: this module must be able to observe its own transport (file
 * header, point 4). Filing a bug report is a deliberate user action and must
 * work regardless of the telemetry toggle, but it must NOT switch passive
 * capture back on — hence `integrations: []`.
 *
 * Returns null when no DSN is configured.
 */
function ensureClient(): NodeClient | null {
  if (bugReportClient) return bugReportClient;

  const { sentryDsn, environment } = resolveTelemetryCredentials();
  if (!sentryDsn) return null;

  const transportOptions: BugReportTransportOptions = { queuePath: queuePath() };
  const client = new NodeClient({
    dsn: sentryDsn,
    release: app.getVersion(),
    environment,
    // Codex #2: without this the constructor falls back to os.hostname().
    includeServerName: false,
    // Disk-backed queueing, matching what the normal Electron init uses. A plain
    // HTTP transport would silently drop reports filed while offline.
    transport: makeTrackedTransport(),
    transportOptions,
    stackParser: defaultStackParser,
    // No passive integrations: this client exists solely to send user-initiated
    // feedback, never to capture errors behind the user's back.
    integrations: [],
  });
  client.init();
  bugReportClient = client;
  return client;
}

/**
 * Drain bug reports queued by an earlier session.
 *
 * The offline transport flushes its queue when the client is constructed
 * (`flushAtStartup`), and this client is built lazily on first submission — so
 * without this call a report queued while offline would sit on disk until the
 * user happened to file another one. Invoked at boot regardless of the telemetry
 * toggle, because bug reporting is decoupled from it.
 *
 * Never throws: this runs on the boot path.
 */
export function drainQueuedBugReports(): void {
  try {
    const dir = queuePath();
    if (!fs.existsSync(dir)) return;
    // The queue index lives alongside the envelope bodies; only bodies are work.
    const pending = fs.readdirSync(dir).filter((f) => !f.endsWith('.json'));
    if (pending.length === 0) return;
    ensureClient();
  } catch {
    // Diagnostics must never break app boot.
  }
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

/** Test seam: drop the cached client between cases. */
export function __resetIsolatedClientForTests(): void {
  bugReportClient = null;
  activeTracker = null;
}

/**
 * Submit a bug report.
 *
 * The event is captured on a FRESH `Scope` — the ambient scope carries
 * breadcrumbs, user, and tags accumulated app-wide, and since feedback bypasses
 * `beforeSend` none of that would be scrubbed on the way out.
 */
export async function submitBugReport(
  input: BugReportSubmission,
  diagnostics: BugReportDiagnostics,
): Promise<BugReportResult> {
  const client = ensureClient();
  if (!client) {
    return {
      delivery: 'unavailable',
      error: 'No Sentry DSN is configured in this build, so reports cannot be delivered.',
    };
  }

  const tracker = beginTracking();
  try {
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
    tracker.eventId = eventId;

    // `flush` gets the event processed and handed to the transport, but resolves
    // whether or not the envelope reached Sentry (file header, point 4). The
    // tracked send is what actually settles the outcome.
    await client.flush(FLUSH_TIMEOUT_MS);
    const outcome = await settleWithin(tracker, SETTLE_TIMEOUT_MS);

    return { ...toResult(outcome), eventId };
  } catch (error) {
    return { delivery: 'failed', error: describeError(error) };
  } finally {
    endTracking(tracker);
  }
}
