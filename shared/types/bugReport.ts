/**
 * In-app bug reporting contract — the single source of truth shared by the
 * renderer dialog (`frontend/src/components/BugReportDialog.tsx`) and the main
 * process (`main/src/ipc/bugReport.ts`).
 *
 * Declared here rather than dual-declared per side: a request field the handler
 * reads but the client can never send silently falls back to a default, which is
 * the exact silent-drop class `docs/CODE-PATTERNS.md` warns about.
 *
 * PRIVACY: unlike `telemetry.ts`, this contract intentionally carries free text —
 * a bug report is user-authored prose. The invariant is different in kind: every
 * free-text field here is composed BY the user and shown back to them in the
 * dialog's preview before it leaves the machine. Nothing is collected silently.
 */
import type { TelemetryEnvironment } from './telemetry';

/**
 * Outcome of a submission attempt.
 *   - `accepted`    — the transport got a success response from Sentry.
 *   - `queued`      — not delivered; held on disk and retried on a later boot,
 *                     or still in flight when we stopped waiting.
 *   - `unavailable` — this build has no DSN, so reports can never be delivered.
 *   - `failed`      — Sentry rejected it, or the SDK threw.
 *   - `rate-limited`— refused by the main-process limiter.
 */
export type BugReportDelivery = 'accepted' | 'queued' | 'unavailable' | 'failed' | 'rate-limited';

/** Which on-disk log a preview tail was read from. */
export type BugReportLogKind = 'dev-debug' | 'app-log';

/** One locally recorded failure, shown in the preview and attached to the report. */
export interface BugReportRecentError {
  at: string;
  seam: string;
  errorClass: string;
  message: string;
}

/** The structured payload attached to every report. No free text. */
export interface BugReportDiagnostics {
  appVersion: string;
  platform: string;
  arch: string;
  electronVersion: string;
  environment: TelemetryEnvironment;
  installId: string;
  recentErrors: BugReportRecentError[];
}

/** A bounded tail of the user's own log, offered for optional inclusion. */
export interface BugReportLogTail {
  kind: BugReportLogKind;
  filePath: string;
  text: string;
  unavailable: boolean;
}

/**
 * Everything the dialog needs to render its "what's included" preview.
 * `logTail` is supplied so the user can READ their logs before deciding; it is
 * never attached to a report unless they opt in.
 */
export interface BugReportPreview {
  diagnostics: BugReportDiagnostics;
  logTail: BugReportLogTail;
}

export interface BugReportSubmitRequest {
  whatHappened: string;
  stepsToReproduce: string;
  expectedBehavior: string;
  /** Present only when `contactConsent` is true. */
  email?: string;
  contactConsent: boolean;
  runId?: string;
  flowName?: string;
  /**
   * The exact log text the user previewed, echoed back so what they read is what
   * gets sent. Absent when they did not opt in. Size-capped by the handler.
   */
  logText?: string;
  /**
   * The recent-error list from the preview, echoed back for the same reason as
   * `logText`: it is the one part of the diagnostics payload that can change
   * between opening the dialog and pressing send, so re-collecting it in the
   * handler would attach failures the user never reviewed. Every other
   * diagnostics field is fixed for the life of the process and is re-derived in
   * the main process rather than trusted from here.
   */
  recentErrors?: BugReportRecentError[];
  /** Client-generated key so a retried submit does not file a duplicate. */
  idempotencyKey: string;
}

export interface BugReportSubmitResponse {
  delivery: BugReportDelivery;
  eventId?: string;
  error?: string;
  /** Seconds until another submission is permitted; set when rate-limited. */
  retryAfterSeconds?: number;
}

/** Hard caps, enforced in the handler and mirrored by the dialog's counters. */
export const BUG_REPORT_LIMITS = {
  whatHappenedMax: 5_000,
  stepsMax: 5_000,
  expectedMax: 5_000,
  emailMax: 254,
  logTextMax: 128 * 1024,
  /** Ceiling on the echoed recent-error list; the buffer itself holds 20. */
  recentErrorsMax: 50,
  /** Ceiling on one echoed recent-error message; the recorder truncates at 500. */
  recentErrorMessageMax: 2_000,
  /** Minimum gap between accepted submissions. */
  minIntervalMs: 30_000,
  /** Rolling hourly ceiling. */
  maxPerHour: 10,
} as const;
