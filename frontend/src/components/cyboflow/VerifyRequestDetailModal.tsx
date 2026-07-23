/**
 * VerifyRequestDetailModal — the per-request detail dialog behind a Verify-Queue
 * card click.
 *
 * The queue card is a one-line summary; everything the row actually CARRIES
 * (the composed `VerificationTaskV1` in `task_json`, the agent's
 * `VerificationReportV1` in `report_json`, the legacy `VerdictV1`, and the PNGs
 * the run wrote to disk) had no reader in the renderer before this. This dialog
 * is that reader, answering the three questions a queue row raises:
 *
 *   1. WHAT WAS TESTED — the task summary plus every composed behavior
 *      (description / steps / expected), or the legacy bare intent + target.
 *   2. WHICH CRITERIA PASSED — the task's behaviors LEFT-JOINed onto the
 *      report's per-behavior results, so an un-judged behavior renders as
 *      "pending" rather than silently vanishing; legacy rows fall back to the
 *      verdict's issue list.
 *   3. WHAT WAS CAPTURED — the report's screenshots (with captions), unioned
 *      with the legacy verdict's `judgedFileNames`, resolved to bytes through
 *      the same run-scoped `artifacts:load-images` channel the screenshots
 *      artifact gallery uses.
 *
 * Read-only: the dialog issues no mutations (Accept-as-baseline was retired,
 * §5.10) and no extra queries — everything renders off the already-polled row
 * plus the on-disk image read.
 */
import { useMemo } from 'react';
import type { ReactElement } from 'react';
import { Modal } from '../ui/Modal';
import { useArtifactImages } from '../../hooks/useArtifactImages';
import type { VerificationRequest } from '../../hooks/useVerificationRequests';
import type {
  VerificationReportV1,
  VerificationTaskV1,
} from '../../../../shared/types/visualVerification';
import {
  STATUS_PILL_CLASS,
  isAgentEngineRow,
  parseDeliverable,
  parseReport,
  parseTask,
  parseVerdict,
  sessionLabel,
  statusSummary,
} from './verifyRequestModel';

// ---------------------------------------------------------------------------
// Criteria model
// ---------------------------------------------------------------------------

type BehaviorResult = VerificationReportV1['behaviors'][number]['result'];

/**
 * One criterion row: a composed behavior (what was asked for) joined with the
 * report entry that judged it (what happened). `result === null` means the
 * behavior was never judged — the request is still in flight, or the agent
 * returned a report that omitted it.
 */
interface CriterionRow {
  id: string;
  description: string;
  steps: string[];
  expected: string;
  result: BehaviorResult | null;
  notes: string;
  screenshots: string[];
}

const RESULT_PILL_CLASS: Readonly<Record<BehaviorResult, string>> = {
  pass: 'bg-status-success/15 text-status-success',
  fail: 'bg-status-error/15 text-status-error',
  not_testable: 'bg-status-warning/15 text-status-warning',
};

/**
 * Join the composed task's behaviors onto the report's results.
 *
 * Task order wins (it is the order the criteria were authored in), then any
 * report entry with no matching task behavior is appended — an agent that
 * invents or renames an id must still be visible, never dropped on the floor.
 */
function buildCriteria(
  task: VerificationTaskV1 | null,
  report: VerificationReportV1 | null,
): CriterionRow[] {
  const judged = new Map<string, VerificationReportV1['behaviors'][number]>();
  for (const entry of report?.behaviors ?? []) {
    if (typeof entry?.id === 'string') judged.set(entry.id, entry);
  }

  const rows: CriterionRow[] = [];
  for (const behavior of task?.behaviors ?? []) {
    const entry = judged.get(behavior.id);
    judged.delete(behavior.id);
    rows.push({
      id: behavior.id,
      description: behavior.description,
      steps: behavior.steps ?? [],
      expected: behavior.expected,
      result: entry?.result ?? null,
      notes: entry?.evidence?.notes ?? '',
      screenshots: entry?.evidence?.screenshots ?? [],
    });
  }
  // Report-only entries (unknown id) — keep them, flagged by an empty description.
  for (const entry of judged.values()) {
    rows.push({
      id: entry.id,
      description: '',
      steps: [],
      expected: '',
      result: entry.result,
      notes: entry.evidence?.notes ?? '',
      screenshots: entry.evidence?.screenshots ?? [],
    });
  }
  return rows;
}

/**
 * Every screenshot basename worth showing, in a stable order: the report's own
 * `screenshots` list first (it carries captions), then any evidence-only or
 * legacy-judged file not already listed. De-duplicated — the same PNG is
 * routinely cited by both the report gallery and a behavior's evidence.
 */
function collectScreenshots(
  report: VerificationReportV1 | null,
  judgedFileNames: string[],
): Array<{ fileName: string; caption: string }> {
  const out: Array<{ fileName: string; caption: string }> = [];
  const seen = new Set<string>();
  const push = (fileName: string, caption: string): void => {
    if (typeof fileName !== 'string' || fileName.length === 0 || seen.has(fileName)) return;
    seen.add(fileName);
    out.push({ fileName, caption });
  };
  for (const shot of report?.screenshots ?? []) push(shot?.fileName, shot?.caption ?? '');
  for (const behavior of report?.behaviors ?? []) {
    for (const fileName of behavior?.evidence?.screenshots ?? []) push(fileName, behavior.id);
  }
  for (const fileName of judgedFileNames) push(fileName, '');
  return out;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="eyebrow text-text-tertiary">{title}</h3>
      {children}
    </section>
  );
}

function MetaItem({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-text-tertiary">{label}</span>
      <span className="truncate font-mono text-[11px] text-text-secondary" title={value}>
        {value}
      </span>
    </div>
  );
}

/** A monospace shell-step list (build / serve / interaction steps). */
function StepList({ steps }: { steps: string[] }): ReactElement {
  return (
    <ol className="flex list-inside list-decimal flex-col gap-0.5">
      {steps.map((step, i) => (
        <li key={`${i}-${step}`} className="font-mono text-[11px] text-text-secondary">
          {step}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Body (mounted only when a request is selected, so the image hook is keyed to it)
// ---------------------------------------------------------------------------

function VerifyRequestDetail({ req }: { req: VerificationRequest }): ReactElement {
  const isAgent = isAgentEngineRow(req);
  const task = useMemo(() => parseTask(req.task_json), [req.task_json]);
  const report = useMemo(() => parseReport(req.report_json), [req.report_json]);
  const verdict = useMemo(() => parseVerdict(req.verdict_json), [req.verdict_json]);
  const deliverable = useMemo(() => parseDeliverable(req.deliverable_json), [req.deliverable_json]);

  const criteria = useMemo(() => buildCriteria(task, report), [task, report]);
  const shots = useMemo(
    () => collectScreenshots(report, verdict?.judgedFileNames ?? []),
    [report, verdict],
  );
  const fileNames = useMemo(() => shots.map((s) => s.fileName), [shots]);
  const { images, loading: imagesLoading, error: imagesError } = useArtifactImages(
    req.run_id,
    fileNames,
  );

  const summary = task?.summary.trim() ?? deliverable?.intent?.trim() ?? '';
  const target = task?.target ?? {
    url: deliverable?.url,
    htmlPath: deliverable?.htmlPath,
  };
  const feedback = report?.feedback?.trim() ?? verdict?.feedback.trim() ?? '';
  const issues = report?.issues ?? verdict?.issues ?? [];

  return (
    <div data-testid="verify-detail-body" className="flex flex-col gap-5 overflow-y-auto px-6 py-5">
      {/* --- Identity + lifecycle -------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-text-tertiary">{req.id}</span>
        <span className="rounded-button bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
          {req.verify_type}
        </span>
        <span className="rounded-button bg-interactive/10 px-1.5 py-0.5 text-[10px] font-medium text-interactive">
          {isAgent ? 'agent' : 'legacy'}
        </span>
        <span
          data-testid="verify-detail-session"
          className="max-w-[220px] truncate rounded-button bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
          title={sessionLabel(req)}
        >
          {sessionLabel(req)}
        </span>
        <span
          data-testid="verify-detail-status"
          className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_PILL_CLASS[req.status]}`}
        >
          {req.status}
        </span>
      </div>

      <p data-testid="verify-detail-status-summary" className="text-xs text-text-secondary">
        {statusSummary(req, isAgent)}
      </p>

      {/* --- What was tested ------------------------------------------- */}
      <Section title="What was tested">
        {summary.length > 0 ? (
          <p data-testid="verify-detail-summary" className="text-sm text-text-primary">
            {summary}
          </p>
        ) : (
          <p className="text-xs text-text-tertiary">No task summary was recorded.</p>
        )}

        {(target.url !== undefined || target.htmlPath !== undefined) && (
          <p className="font-mono text-[11px] text-text-secondary">
            target: {target.url ?? target.htmlPath}
          </p>
        )}
        {task?.build !== undefined && task.build.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-text-tertiary">build</span>
            <StepList steps={task.build} />
          </div>
        )}
        {task?.serve !== undefined && (
          <p className="font-mono text-[11px] text-text-secondary">serve: {task.serve.cmd}</p>
        )}
      </Section>

      {/* --- Criteria --------------------------------------------------- */}
      <Section title="Criteria">
        {criteria.length === 0 ? (
          <p data-testid="verify-detail-no-criteria" className="text-xs text-text-tertiary">
            {isAgent
              ? 'This task declared no behaviors — the agent judged the deliverable as a whole.'
              : 'Legacy capture/judge request — no per-criterion breakdown was recorded.'}
          </p>
        ) : (
          <ul data-testid="verify-detail-criteria" className="flex flex-col gap-2">
            {criteria.map((row) => (
              <li
                key={row.id}
                data-testid={`verify-detail-criterion-${row.id}`}
                className="flex flex-col gap-1 rounded-card border border-border-primary bg-bg-secondary p-3"
              >
                <div className="flex items-start gap-2">
                  <span className="font-mono text-[10px] text-text-tertiary">{row.id}</span>
                  <span className="flex-1 text-xs text-text-primary">
                    {row.description.length > 0 ? row.description : '(behavior not in the task)'}
                  </span>
                  <span
                    data-testid={`verify-detail-result-${row.id}`}
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      row.result === null
                        ? 'bg-bg-tertiary text-text-tertiary'
                        : RESULT_PILL_CLASS[row.result]
                    }`}
                  >
                    {row.result ?? 'pending'}
                  </span>
                </div>
                {row.expected.length > 0 && (
                  <span className="text-[11px] text-text-secondary">expected: {row.expected}</span>
                )}
                {row.steps.length > 0 && <StepList steps={row.steps} />}
                {row.notes.length > 0 && (
                  <span className="text-[11px] text-text-tertiary">{row.notes}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* --- Captured screenshots --------------------------------------- */}
      <Section title="Captured">
        {shots.length === 0 ? (
          <p data-testid="verify-detail-no-screenshots" className="text-xs text-text-tertiary">
            No screenshots were captured for this request.
          </p>
        ) : (
          <>
            {imagesError !== null && (
              <p className="text-xs text-status-error">Failed to load screenshots: {imagesError}</p>
            )}
            <div
              data-testid="verify-detail-screenshots"
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              {shots.map((shot) => {
                const dataUrl = images[shot.fileName];
                return (
                  <figure
                    key={shot.fileName}
                    className="flex flex-col gap-1 overflow-hidden rounded-card border border-border-primary bg-bg-secondary p-2"
                  >
                    {dataUrl !== undefined ? (
                      <img
                        src={dataUrl}
                        alt={shot.caption.length > 0 ? shot.caption : shot.fileName}
                        className="max-h-72 w-full rounded object-contain"
                      />
                    ) : (
                      <div className="flex h-24 items-center justify-center rounded bg-bg-tertiary text-[11px] text-text-tertiary">
                        {imagesLoading ? 'Loading…' : 'Image not found on disk'}
                      </div>
                    )}
                    <figcaption className="truncate text-[10px] text-text-tertiary" title={shot.fileName}>
                      {shot.caption.length > 0 ? `${shot.caption} · ${shot.fileName}` : shot.fileName}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          </>
        )}
      </Section>

      {/* --- Verdict prose / issues / failures --------------------------- */}
      {(feedback.length > 0 || issues.length > 0) && (
        <Section title="Verdict">
          {feedback.length > 0 && (
            <p data-testid="verify-detail-feedback" className="text-xs text-text-secondary">
              {feedback}
            </p>
          )}
          {issues.length > 0 && (
            <ul className="flex flex-col gap-1">
              {issues.map((issue, i) => (
                <li key={`${i}-${issue.description}`} className="text-[11px] text-text-secondary">
                  <span className="font-medium text-text-primary">{issue.severity}</span> ·{' '}
                  {issue.description}
                  {issue.fileName !== undefined && ` (${issue.fileName})`}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {report?.buildLogExcerpt !== undefined && report.buildLogExcerpt.trim().length > 0 && (
        <Section title="Build log">
          <pre
            data-testid="verify-detail-build-log"
            className="max-h-56 overflow-auto rounded-card border border-border-primary bg-bg-secondary p-3 font-mono text-[11px] text-text-secondary"
          >
            {report.buildLogExcerpt}
          </pre>
        </Section>
      )}

      {req.error_message !== null && req.error_message.trim().length > 0 && (
        <Section title="Error">
          <p className="text-xs text-status-error">{req.error_message}</p>
        </Section>
      )}

      {/* --- Provenance -------------------------------------------------- */}
      <Section title="Provenance">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <MetaItem label="run" value={req.run_id} />
          <MetaItem label="task ref" value={task?.taskRef ?? deliverable?.taskRef ?? '—'} />
          <MetaItem label="backend" value={req.current_backend ?? '—'} />
          <MetaItem label="attempt" value={String(req.attempt)} />
          <MetaItem label="snapshot" value={req.snapshot_sha ?? '—'} />
          <MetaItem label="enqueued" value={req.enqueued_at} />
          <MetaItem label="leased" value={req.leased_at ?? '—'} />
          <MetaItem label="ended" value={req.ended_at ?? '—'} />
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal shell
// ---------------------------------------------------------------------------

export interface VerifyRequestDetailModalProps {
  /** The selected request; `null` keeps the dialog closed (and unmounts its body). */
  request: VerificationRequest | null;
  onClose: () => void;
}

export function VerifyRequestDetailModal({
  request,
  onClose,
}: VerifyRequestDetailModalProps): ReactElement | null {
  if (request === null) return null;
  return (
    <Modal isOpen onClose={onClose} size="xl">
      <div
        data-testid="verify-detail-modal"
        className="flex max-h-[90vh] min-h-0 flex-col overflow-hidden"
      >
        <div className="border-b border-border-primary px-6 py-4 pr-12">
          <h2 className="text-sm font-bold text-text-primary">Verification detail</h2>
          <p className="text-[11px] text-text-tertiary">
            What was tested, what was captured, and which criteria passed
          </p>
        </div>
        <VerifyRequestDetail req={request} />
      </div>
    </Modal>
  );
}
