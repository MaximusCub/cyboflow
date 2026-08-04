/**
 * IPC handlers for in-app bug reporting.
 *
 * Channels:
 *   bugReport:getPreview — structured diagnostics + a log tail, for the dialog's
 *                          "what's included" panel. Read-only.
 *   bugReport:submit     — validate, rate-limit, then deliver via Sentry User Feedback.
 *
 * `bugReport:submit` is a renderer-controlled path to an external service backed
 * by a finite quota, so it is treated as a boundary rather than a convenience:
 * schema-validated, size-capped, rate-limited, single-flight, and idempotent. A
 * disabled button in the dialog protects nothing — this handler is the control.
 */
import { IpcMain, app } from 'electron';
import { z } from 'zod';
import type { AppServices } from './types';
import { validateInput } from './validateInput';
import { collectDiagnostics, readLogTail } from '../services/telemetry/diagnostics';
import { submitBugReport } from '../services/telemetry/bugReport';
import { resolveTelemetryCredentials } from '../services/telemetry/credentials';
import { readTelemetryConfigSync } from '../services/configManager';
import {
  BUG_REPORT_LIMITS,
  type BugReportPreview,
  type BugReportSubmitResponse,
} from '../../../shared/types/bugReport';

const submitSchema = z.object({
  whatHappened: z.string().trim().min(1).max(BUG_REPORT_LIMITS.whatHappenedMax),
  stepsToReproduce: z.string().max(BUG_REPORT_LIMITS.stepsMax),
  expectedBehavior: z.string().max(BUG_REPORT_LIMITS.expectedMax),
  email: z.string().max(BUG_REPORT_LIMITS.emailMax).optional(),
  contactConsent: z.boolean(),
  runId: z.string().max(200).optional(),
  sessionId: z.string().max(200).optional(),
  flowName: z.string().max(200).optional(),
  logText: z.string().max(BUG_REPORT_LIMITS.logTextMax).optional(),
  // Echoed back from the preview so the report carries the failures the user
  // actually reviewed (see the request type). Bounded here because it arrives
  // from the renderer like every other field on this channel.
  recentErrors: z
    .array(
      z.object({
        at: z.string().max(64),
        seam: z.string().max(200),
        errorClass: z.string().max(200),
        message: z.string().max(BUG_REPORT_LIMITS.recentErrorMessageMax),
      }),
    )
    .max(BUG_REPORT_LIMITS.recentErrorsMax)
    .optional(),
  idempotencyKey: z.string().min(1).max(200),
});

// ---------------------------------------------------------------------------
// Rate limiting (module-level; one limiter per app process)
// ---------------------------------------------------------------------------

interface LimiterState {
  /**
   * Epoch ms of submissions that reached the network, within the rolling window.
   *
   * ATTEMPTS, not acceptances. Counting only what Sentry accepted leaves the
   * failure path unthrottled — a rejecting endpoint or a dropped send would let
   * a retry loop hammer it as fast as the round trip allows, which is the state
   * a report is most likely to be filed from.
   */
  attemptedAt: number[];
  /** True while a submission is in flight. */
  inFlight: boolean;
  /** Idempotency keys already served, with their result. */
  served: Map<string, BugReportSubmitResponse>;
}

const limiter: LimiterState = { attemptedAt: [], inFlight: false, served: new Map() };

/** Width of the rolling window the hourly ceiling is counted over. */
export const HOUR_MS = 60 * 60 * 1000;
/** How many served idempotency keys are retained before oldest-first eviction. */
export const SERVED_KEYS_MAX = 50;

/**
 * Decide whether a submission may proceed. Returns null when allowed, or the
 * response to return when refused.
 */
function checkRateLimit(now: number): BugReportSubmitResponse | null {
  if (limiter.inFlight) {
    return {
      delivery: 'rate-limited',
      error: 'A bug report is already being sent.',
      retryAfterSeconds: 5,
    };
  }

  // Drop entries that have aged out of the rolling window.
  limiter.attemptedAt = limiter.attemptedAt.filter((t) => now - t < HOUR_MS);

  const last = limiter.attemptedAt[limiter.attemptedAt.length - 1];
  if (last !== undefined && now - last < BUG_REPORT_LIMITS.minIntervalMs) {
    return {
      delivery: 'rate-limited',
      error: 'Please wait a moment before sending another report.',
      retryAfterSeconds: Math.ceil((BUG_REPORT_LIMITS.minIntervalMs - (now - last)) / 1000),
    };
  }

  if (limiter.attemptedAt.length >= BUG_REPORT_LIMITS.maxPerHour) {
    const oldest = limiter.attemptedAt[0];
    return {
      delivery: 'rate-limited',
      error: 'Too many reports sent in the last hour.',
      retryAfterSeconds: Math.ceil((HOUR_MS - (now - oldest)) / 1000),
    };
  }

  return null;
}

/** Remember a served idempotency key, evicting oldest beyond the cap. */
function remember(key: string, response: BugReportSubmitResponse): void {
  limiter.served.set(key, response);
  while (limiter.served.size > SERVED_KEYS_MAX) {
    const oldest = limiter.served.keys().next().value;
    if (oldest === undefined) break;
    limiter.served.delete(oldest);
  }
}

/** Test seam: reset limiter state between cases. */
export function __resetBugReportLimiterForTests(): void {
  limiter.attemptedAt = [];
  limiter.inFlight = false;
  limiter.served.clear();
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBugReportHandlers(ipcMain: IpcMain, _services: AppServices): void {
  void _services;

  ipcMain.handle('bugReport:getPreview', async () => {
    try {
      const { environment } = resolveTelemetryCredentials();
      const preview: BugReportPreview = {
        diagnostics: collectDiagnostics({
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron ?? 'unknown',
          environment,
          installId: readTelemetryConfigSync().installId,
        }),
        logTail: readLogTail(app.isPackaged),
      };
      return { success: true, data: preview };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('bugReport:submit', async (_event, args: unknown) => {
    const v = validateInput(submitSchema, args, 'bugReport:submit');
    if (!v.ok) return { success: false, error: v.error };
    const request = v.value;

    // Replaying a key returns the original outcome rather than filing again.
    const alreadyServed = limiter.served.get(request.idempotencyKey);
    if (alreadyServed) return { success: true, data: alreadyServed };

    const refusal = checkRateLimit(Date.now());
    if (refusal) return { success: true, data: refusal };

    limiter.inFlight = true;
    // Assume the attempt reaches the network until proven otherwise, so a throw
    // on the way out is throttled too. Only `unavailable` is free: it is decided
    // from a missing DSN before anything is composed, let alone sent.
    let reachedNetwork = true;
    try {
      const { environment } = resolveTelemetryCredentials();
      const diagnostics = {
        ...collectDiagnostics({
          appVersion: app.getVersion(),
          electronVersion: process.versions.electron ?? 'unknown',
          environment,
          installId: readTelemetryConfigSync().installId,
        }),
        // Re-collecting here would attach failures recorded AFTER the user read
        // the preview — the payload would no longer be the one they consented
        // to. The reviewed list is echoed back instead, and its absence (a
        // preview that failed to load) means the user reviewed nothing, so
        // nothing is attached.
        recentErrors: request.recentErrors ?? [],
      };

      const result = await submitBugReport(
        {
          whatHappened: request.whatHappened,
          stepsToReproduce: request.stepsToReproduce,
          expectedBehavior: request.expectedBehavior,
          // Contact info rides only on explicit consent, regardless of whether
          // the field happens to hold text.
          email: request.contactConsent ? request.email : undefined,
          runId: request.runId,
          sessionId: request.sessionId,
          flowName: request.flowName,
          logText: request.logText,
        },
        diagnostics,
      );

      const response: BugReportSubmitResponse = {
        delivery: result.delivery,
        eventId: result.eventId,
        error: result.error,
      };

      // A build with no DSN must not rate-limit the user out of retrying once
      // one is configured.
      reachedNetwork = result.delivery !== 'unavailable';

      // Only a report we believe was FILED becomes replayable. A failure has to
      // stay retryable under its original key, or the one report the user cared
      // enough to write by hand is the one they can never resend.
      if (result.delivery === 'accepted' || result.delivery === 'queued') {
        remember(request.idempotencyKey, response);
      }

      return { success: true, data: response };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (reachedNetwork) limiter.attemptedAt.push(Date.now());
      limiter.inFlight = false;
    }
  });
}
