import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, Bug, ChevronRight, ChevronDown, AlertTriangle, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { useSessionStore } from '../stores/sessionStore';
import { useActiveRunsStore } from '../stores/activeRunsStore';
import {
  BUG_REPORT_LIMITS,
  type BugReportPreview,
  type BugReportSubmitResponse,
} from '../../../shared/types/bugReport';

interface BugReportDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type SendState =
  | { phase: 'idle' }
  | { phase: 'sending' }
  | { phase: 'done'; response: BugReportSubmitResponse }
  | { phase: 'error'; message: string };

/** Human-readable outcome text per delivery state. */
function describeDelivery(response: BugReportSubmitResponse): {
  tone: 'success' | 'warning' | 'error';
  title: string;
  detail: string;
} {
  switch (response.delivery) {
    case 'accepted':
      return {
        tone: 'success',
        title: 'Report sent',
        detail: 'Thanks — this went straight through.',
      };
    case 'queued':
      return {
        tone: 'warning',
        title: 'Report queued',
        detail: "It couldn't be delivered right now and will be retried automatically.",
      };
    case 'rate-limited':
      return {
        tone: 'warning',
        title: 'Not sent yet',
        detail:
          response.error ??
          `Please wait ${response.retryAfterSeconds ?? 30}s before sending another report.`,
      };
    case 'unavailable':
      return {
        tone: 'error',
        title: "This build can't send reports",
        detail:
          response.error ??
          'No reporting endpoint is configured in this build. Please file an issue on GitHub instead.',
      };
    default:
      return {
        tone: 'error',
        title: "Report couldn't be sent",
        detail: response.error ?? 'An unexpected error occurred.',
      };
  }
}

export function BugReportDialog({ isOpen, onClose }: BugReportDialogProps) {
  const [whatHappened, setWhatHappened] = useState('');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [contactConsent, setContactConsent] = useState(false);
  const [email, setEmail] = useState('');
  const [sessionId, setSessionId] = useState<string>('');
  const [includeLogs, setIncludeLogs] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [preview, setPreview] = useState<BugReportPreview | null>(null);
  const [send, setSend] = useState<SendState>({ phase: 'idle' });

  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  // Flatten the per-project run map once so the session→run lookup below is cheap.
  const allRuns = useMemo(() => Object.values(runsByProject).flat(), [runsByProject]);

  /**
   * Resolve the selected session to a flow run, so the report carries a run id
   * and flow name rather than only an opaque session id. Absent when the session
   * has no associated run (a plain quick session).
   */
  const linkedRun = useMemo(
    () => (sessionId ? allRuns.find((r) => r.session_id === sessionId) : undefined),
    [allRuns, sessionId],
  );

  /**
   * The dialog stays mounted while closed, so anything resolving after a close —
   * an in-flight submit, a slow preview — must not write state that would be
   * visible on the next open.
   */
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  /**
   * Read at open time only. Seeding the session picker from a live subscription
   * would silently overwrite the user's choice whenever the app switched
   * sessions behind the dialog.
   */
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  /**
   * One key per dialog session, deliberately stable across retries: the handler
   * only remembers keys it actually filed, so reusing the key is what stops a
   * retry-after-timeout from filing the same report twice.
   */
  const idempotencyKeyRef = useRef('');

  const resetForm = useCallback(() => {
    setWhatHappened('');
    setSteps('');
    setExpected('');
    setContactConsent(false);
    setEmail('');
    setIncludeLogs(false);
    setShowDiagnostics(false);
    setSend({ phase: 'idle' });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      resetForm();
      return;
    }
    setSessionId(activeSessionIdRef.current ?? '');
    idempotencyKeyRef.current = crypto.randomUUID();
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.electronAPI.bugReport.getPreview();
        if (!cancelled && result.success && result.data) {
          setPreview(result.data);
        }
      } catch {
        // Preview is best-effort; the report can still be sent without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, resetForm]);

  const canSubmit =
    whatHappened.trim().length > 0 &&
    whatHappened.length <= BUG_REPORT_LIMITS.whatHappenedMax &&
    send.phase !== 'sending';

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSend({ phase: 'sending' });
    try {
      const result = await window.electronAPI.bugReport.submit({
        whatHappened,
        stepsToReproduce: steps,
        expectedBehavior: expected,
        email: contactConsent && email.trim() ? email.trim() : undefined,
        contactConsent,
        // Two id spaces, two tags. A session id sent as `run_id` reads as a run
        // that does not exist.
        runId: linkedRun?.id,
        sessionId: sessionId || undefined,
        flowName: linkedRun?.workflowName,
        // Send exactly what the user previewed, so what they read is what leaves
        // the machine — both the log text and the recorded-failure list, which is
        // the one part of the diagnostics payload that can change while the
        // dialog is open.
        logText: includeLogs ? preview?.logTail.text : undefined,
        recentErrors: preview?.diagnostics.recentErrors ?? [],
        idempotencyKey: idempotencyKeyRef.current,
      });
      if (!isOpenRef.current) return;
      if (result.success && result.data) {
        setSend({ phase: 'done', response: result.data });
      } else {
        setSend({ phase: 'error', message: result.error ?? 'Failed to send report.' });
      }
    } catch (error) {
      if (!isOpenRef.current) return;
      setSend({
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  if (!isOpen) return null;

  const diagnostics = preview?.diagnostics;
  const logTail = preview?.logTail;

  return (
    <div className="fixed inset-0 bg-modal-overlay flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-primary flex-shrink-0">
          <div className="flex items-center space-x-3">
            <Bug className="w-5 h-5 text-text-secondary" />
            <h2 className="text-xl font-semibold text-text-primary">Report a bug</h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-tertiary hover:text-text-secondary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          {send.phase === 'done' ? (
            <ResultPanel
              response={send.response}
              onClose={onClose}
              // Return to the filled-in form, not a blank one: the report is
              // still there and retrying is the whole point of the button.
              onAgain={() => setSend({ phase: 'idle' })}
            />
          ) : (
            <>
              <Field
                label="What happened?"
                required
                value={whatHappened}
                onChange={setWhatHappened}
                max={BUG_REPORT_LIMITS.whatHappenedMax}
                placeholder="Describe what went wrong."
                rows={3}
              />
              <Field
                label="Steps to reproduce"
                value={steps}
                onChange={setSteps}
                max={BUG_REPORT_LIMITS.stepsMax}
                placeholder="1. …&#10;2. …"
                rows={3}
              />
              <Field
                label="What did you expect to happen?"
                value={expected}
                onChange={setExpected}
                max={BUG_REPORT_LIMITS.expectedMax}
                placeholder="What you expected instead."
                rows={2}
              />

              {/* Session / run association */}
              <div className="space-y-1.5">
                <label htmlFor="bug-report-session" className="block text-sm font-medium text-text-secondary">
                  Where did this happen?
                </label>
                <select
                  id="bug-report-session"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                >
                  <option value="">Not related to a specific session</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {linkedRun && (
                  <p className="text-xs text-text-tertiary">
                    Linked to the {linkedRun.workflowName} run in this session.
                  </p>
                )}
              </div>

              {/* Contact */}
              <div className="pt-4 border-t border-border-primary space-y-3">
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={contactConsent}
                    onChange={(e) => setContactConsent(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-text-secondary">
                    You can contact me about this report
                    <span className="block text-xs text-text-tertiary">
                      Optional, and only used to follow up on this report. See
                      &ldquo;What&apos;s included&rdquo; below for everything else the report carries.
                    </span>
                  </span>
                </label>
                {contactConsent && (
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    maxLength={BUG_REPORT_LIMITS.emailMax}
                    placeholder="you@example.com"
                    aria-label="Email address"
                    className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary"
                  />
                )}
              </div>

              {/* What's included */}
              <div className="pt-4 border-t border-border-primary space-y-3">
                <button
                  type="button"
                  onClick={() => setShowDiagnostics((v) => !v)}
                  className="flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
                >
                  {showDiagnostics ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                  What&apos;s included
                </button>

                {showDiagnostics && (
                  <div className="rounded-md border border-border-primary bg-surface-secondary p-3 space-y-1.5">
                    {diagnostics ? (
                      <>
                        <DiagRow label="Version" value={diagnostics.appVersion} />
                        <DiagRow label="Platform" value={`${diagnostics.platform} · ${diagnostics.arch}`} />
                        <DiagRow label="Electron" value={diagnostics.electronVersion} />
                        <DiagRow label="Build" value={diagnostics.environment} />
                        <DiagRow label="Install ID" value={diagnostics.installId || '(none)'} />
                        <DiagRow
                          label="Recent errors"
                          value={
                            diagnostics.recentErrors.length === 0
                              ? 'none'
                              : `${diagnostics.recentErrors.length} recorded`
                          }
                        />
                        {diagnostics.recentErrors.length > 0 && (
                          <pre className="mt-2 max-h-32 overflow-auto rounded bg-surface-primary p-2 text-[11px] leading-relaxed text-text-tertiary whitespace-pre-wrap">
                            {diagnostics.recentErrors
                              .map((e) => `${e.at} · ${e.seam} · ${e.errorClass}: ${e.message}`)
                              .join('\n')}
                          </pre>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-text-tertiary">Loading…</p>
                    )}
                  </div>
                )}

                {/* Logs — deliberately separate, off by default, shown before sending */}
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeLogs}
                    onChange={(e) => setIncludeLogs(e.target.checked)}
                    // Ticking this before the preview arrives would attach
                    // nothing while telling the user their logs were included.
                    disabled={!logTail || logTail.unavailable}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-text-secondary">
                    Include recent log output
                    <span className="block text-xs text-text-tertiary">
                      {!logTail
                        ? 'Loading…'
                        : logTail.unavailable
                          ? 'No log file is available in this build.'
                          : 'Off by default. Read it below before including it.'}
                    </span>
                  </span>
                </label>

                {includeLogs && logTail && !logTail.unavailable && (
                  <div className="space-y-2">
                    <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2.5">
                      <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-text-secondary leading-relaxed">
                        Logs can contain file paths, repository names, prompts, command output, and
                        occasionally credentials. Automated redaction cannot reliably remove these —
                        please read the text below before sending.
                      </p>
                    </div>
                    <p className="text-[11px] text-text-tertiary font-mono truncate" title={logTail.filePath}>
                      {logTail.filePath}
                    </p>
                    <pre className="max-h-48 overflow-auto rounded bg-surface-secondary p-2 text-[11px] leading-relaxed text-text-tertiary whitespace-pre-wrap">
                      {logTail.text || '(empty)'}
                    </pre>
                  </div>
                )}
              </div>

              {send.phase === 'error' && (
                <p className="flex items-center gap-1.5 text-xs text-status-error">
                  <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                  <span>{send.message}</span>
                </p>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {send.phase !== 'done' && (
          <div className="flex items-center justify-end gap-3 p-6 border-t border-border-primary flex-shrink-0">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md bg-interactive text-text-on-interactive hover:bg-interactive-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {send.phase === 'sending' && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{send.phase === 'sending' ? 'Sending…' : 'Send report'}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-text-tertiary">{label}</span>
      <span className="text-xs text-text-secondary font-mono truncate" title={value}>
        {value}
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  max,
  placeholder,
  rows,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  placeholder: string;
  rows: number;
  required?: boolean;
}) {
  const id = `bug-report-${label.replace(/[^a-z]+/gi, '-').toLowerCase()}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-text-secondary">
        {label}
        {required && <span className="text-status-error ml-0.5">*</span>}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={max}
        rows={rows}
        placeholder={placeholder}
        className="w-full rounded-md border border-border-primary bg-surface-secondary px-3 py-2 text-sm text-text-primary resize-y"
      />
    </div>
  );
}

function ResultPanel({
  response,
  onClose,
  onAgain,
}: {
  response: BugReportSubmitResponse;
  onClose: () => void;
  onAgain: () => void;
}) {
  const { tone, title, detail } = describeDelivery(response);
  const Icon = tone === 'success' ? CheckCircle : tone === 'warning' ? AlertTriangle : AlertCircle;
  const color =
    tone === 'success'
      ? 'text-status-success'
      : tone === 'warning'
        ? 'text-status-warning'
        : 'text-status-error';

  return (
    <div className="space-y-4 py-4 text-center">
      <Icon className={`w-10 h-10 mx-auto ${color}`} />
      <div className="space-y-1">
        <h3 className="text-base font-medium text-text-primary">{title}</h3>
        <p className="text-sm text-text-secondary">{detail}</p>
      </div>
      <div className="flex items-center justify-center gap-3 pt-2">
        {response.delivery !== 'accepted' && response.delivery !== 'queued' && (
          <button
            onClick={onAgain}
            className="px-3 py-1.5 text-sm font-medium rounded-md border border-border-primary text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
          >
            Try again
          </button>
        )}
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-sm font-medium rounded-md bg-interactive text-text-on-interactive hover:bg-interactive-hover transition-colors"
        >
          Close
        </button>
      </div>
    </div>
  );
}
