/**
 * eagerSpawnFailure.ts — reporting a swallowed EAGER PTY spawn failure
 * (create-quick's and restart's fire-and-forget `startPanel`) to Sentry AND to
 * the person it happened to.
 *
 * The eager spawn is deliberately fail-soft — create-quick has already returned
 * `success` plus a `claudePanelId`, and a later `sessions:input` re-spawns the
 * REPL — but fail-soft is also INVISIBLE: the renderer mounts a terminal on a
 * `cyboflow:pty:<id>` channel that will never emit a byte and shows a bare
 * cursor indefinitely. Only `spawnCliProcess`'s own final failure self-reports
 * (`pty-spawn-failed`); anything `startPanel` throws before reaching it
 * (worktree checks, settings writes, briefing prep) used to die in a
 * `console.error` nobody would ever read on a user's machine.
 *
 * Telemetry alone closed half of that: it made the failure diagnosable for US
 * and left the user staring at the same blank cursor (CYBOFLOW-APP-1E — four
 * silent `binary-missing` failures in forty seconds on a fresh 0.2.6 install).
 * So this module does both, and lives outside session.ts so the pairing is
 * unit-testable without standing up the whole IPC surface.
 *
 * Sentry payload rules are unchanged: fixed message, bounded `errorClass`, and
 * the raw text only ever in the caller's local `console.error` and in the
 * session-error `details`, which stay on the machine.
 */
import { captureSeamError } from '../services/telemetry';
import { classifyErrorPattern, unclassifiedErrorTags } from '../orchestrator/programmatic/systemicError';

/**
 * The user-visible half of an eager-spawn failure. Structural so the real
 * SessionManager satisfies it and a unit test can pass a spy.
 */
export interface EagerSpawnSessionSurface {
  addSessionError(id: string, error: string, details?: string): void;
}

/**
 * The user-facing wording for a failed eager spawn, chosen by the BOUNDED error
 * class rather than the raw text.
 *
 * `binary-missing` earns its own copy because it is the one cause the user can
 * actually fix, and the one observed in the wild. Every other class gets the
 * honest generic — the raw message rides along as `details`, which is written
 * to the local sessions DB and never to telemetry.
 */
export function eagerSpawnFailureCopy(
  errorClass: string,
  cliTool: string,
  rawMessage: string,
): { error: string; details: string } {
  if (errorClass === 'binary-missing') {
    return {
      error: `${cliTool} not found`,
      details: [
        `cyboflow could not find the \`${cliTool}\` executable on this machine.`,
        '',
        `Install ${cliTool} and make sure it is on your PATH, or set a custom executable path in Settings.`,
        'Then send a message to start the session again.',
        '',
        rawMessage,
      ].join('\n'),
    };
  }
  return {
    error: `${cliTool} failed to start`,
    details: ['Send a message to try again.', '', rawMessage].join('\n'),
  };
}

export function reportEagerSpawnFailure(
  err: unknown,
  substrate: string,
  cliTool: string,
  surface: { sessionManager: EagerSpawnSessionSurface; sessionId: string },
): void {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const errorClass = classifyErrorPattern(rawMessage);
  captureSeamError(
    'eager-pty-spawn-failed',
    new Error(`eager ${cliTool} REPL spawn failed (${errorClass})`),
    { substrate, cliTool, errorClass, ...unclassifiedErrorTags(errorClass, rawMessage) },
  );
  // TELL THE USER. `addSessionError` writes an error output AND flips the
  // session to 'error', so the blank terminal becomes a stated failure with a
  // next step. Best-effort: a surfacing failure must never replace the spawn
  // failure it is reporting.
  const { error, details } = eagerSpawnFailureCopy(errorClass, cliTool, rawMessage);
  try {
    surface.sessionManager.addSessionError(surface.sessionId, error, details);
  } catch (surfaceErr) {
    console.error(
      `[IPC] Failed to surface eager spawn failure for session ${surface.sessionId}:`,
      surfaceErr,
    );
  }
}
