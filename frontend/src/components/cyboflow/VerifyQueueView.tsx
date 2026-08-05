/**
 * VerifyQueueView — the L6 Verify-Queue panel (S7).
 *
 * A read-only, full-width observability view over the `verification_requests`
 * work queue. Live state comes from {@link useVerificationRequests} (the polling
 * list hook over `cyboflow.verificationRequests.list`).
 *
 * The panel is split into TWO sections, because the single newest-first list it
 * used to render buried the thing the panel exists for: work still IN FLIGHT
 * scrolls away under history as soon as a few requests finish.
 *
 *   - IN FLIGHT (top) — every non-terminal request (queued / leased / running),
 *     oldest-enqueued FIRST, i.e. the order the scheduler actually drains them.
 *   - HISTORY (below) — terminal requests, newest-first (the pre-existing order).
 *
 * Each card carries an ORIGIN-SESSION pill (`sessions.name`, LEFT-JOINed onto
 * the row by the list query) so a queue shared by several parallel sessions is
 * attributable at a glance, and is CLICKABLE — opening
 * {@link VerifyRequestDetailModal}, which reads the composed task, the agent's
 * per-behavior results, and the captured screenshots off the same row.
 *
 * verification-agent redesign §5.11: an agent-engine row (migration 078
 * `task_json` populated) carries a composed `VerificationTaskV1` instead of a
 * bare intent, and its terminal state is a `VerificationReportV1` in
 * `report_json` rather than a `VerdictV1` in `verdict_json`. The row derivations
 * (engine identity, summary, status line) live in ./verifyRequestModel and are
 * shared with the detail dialog; a legacy row (`task_json === null`) renders
 * exactly as before.
 *
 * NO mutations originate here (Accept-as-baseline was retired outright, §5.10).
 * The header carries a project filter — the list query is project-scoped (no
 * "all projects" option, unlike Insights, because the route requires a
 * positive projectId), defaulting to the active project.
 *
 * Styling mirrors the existing cyboflow panel idiom (SprintLanesPanel status
 * pills + InsightsView header / card surfaces).
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { API } from '../../utils/api';
import { trpc } from '../../trpc/client';
import type { Project } from '../../types/project';
import { useNavigationStore } from '../../stores/navigationStore';
import {
  useVerificationRequests,
  type VerificationRequest,
} from '../../hooks/useVerificationRequests';
import { VerifyRequestDetailModal } from './VerifyRequestDetailModal';
import { VerifyHealthPanel } from './VerifyHealthPanel';
import {
  STATUS_PILL_CLASS,
  budgetLineText,
  isAgentEngineRow,
  isPending,
  sessionLabel,
  statusSummary,
  taskSummary,
} from './verifyRequestModel';

/** Poll cadence for the header's verify-budget line — same as the default request-list poll (useVerificationRequests' DEFAULT_REFETCH_INTERVAL_MS), kept as a LOCAL constant since `judge_calls_used` is a separate sibling query (see the router's own doc for why it's not folded into `list`). */
const BUDGET_REFETCH_INTERVAL_MS = 2500;

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function VerifyQueueRow({
  req,
  onSelect,
}: {
  req: VerificationRequest;
  onSelect: (req: VerificationRequest) => void;
}): ReactElement {
  const isAgent = isAgentEngineRow(req);
  const summary = taskSummary(req);
  const status = statusSummary(req, isAgent);
  const session = sessionLabel(req);

  return (
    <button
      type="button"
      data-testid={`verify-queue-row-${req.id}`}
      onClick={() => onSelect(req)}
      title="Open verification detail"
      className="flex w-full flex-col gap-1 rounded-card border border-border-primary bg-bg-primary p-3 text-left transition-colors hover:border-border-emphasized hover:bg-bg-hover focus:border-border-emphasized focus:outline-none"
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-text-tertiary">{req.id}</span>
        <span className="rounded-button bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
          {req.verify_type}
        </span>
        <span
          data-testid={`verify-queue-engine-${req.id}`}
          className="rounded-button bg-interactive/10 px-1.5 py-0.5 text-[10px] font-medium text-interactive"
          title={isAgent ? 'Deployed as the centrally-run verification agent' : 'Legacy capture/judge backend'}
        >
          {isAgent ? 'agent' : 'legacy'}
        </span>
        <span
          data-testid={`verify-queue-session-${req.id}`}
          className="max-w-[180px] truncate rounded-button bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
          title={`Session: ${session}`}
        >
          {session}
        </span>
        <span
          data-testid={`verify-queue-status-${req.id}`}
          className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_PILL_CLASS[req.status]}`}
        >
          {req.status}
        </span>
      </div>

      {summary.length > 0 && (
        <span className="w-full truncate text-xs text-text-primary" title={summary}>
          {summary}
        </span>
      )}

      <div className="flex items-center gap-3 text-[10px] text-text-tertiary">
        <span>backend: {req.current_backend ?? '—'}</span>
        <span>attempt {req.attempt}</span>
        <span className="font-mono">{req.run_id}</span>
      </div>

      <span className="w-full truncate text-[11px] text-text-secondary" title={status}>
        {status}
      </span>
    </button>
  );
}

/** A titled group of rows with a count chip; renders its own empty copy. */
function QueueSection({
  testId,
  title,
  hint,
  rows,
  emptyCopy,
  onSelect,
}: {
  testId: string;
  title: string;
  hint: string;
  rows: VerificationRequest[];
  emptyCopy: string;
  onSelect: (req: VerificationRequest) => void;
}): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="eyebrow text-text-tertiary">{title}</h2>
        <span
          data-testid={`${testId}-count`}
          className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
        >
          {rows.length}
        </span>
        <span className="text-[10px] text-text-tertiary">{hint}</span>
      </div>
      {rows.length === 0 ? (
        <p data-testid={`${testId}-empty`} className="text-xs text-text-tertiary">
          {emptyCopy}
        </p>
      ) : (
        <div data-testid={testId} className="flex flex-col gap-2">
          {rows.map((req) => (
            <VerifyQueueRow key={req.id} req={req} onSelect={onSelect} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// VerifyQueueView
// ---------------------------------------------------------------------------

export function VerifyQueueView(): ReactElement {
  const activeProjectId = useNavigationStore((s) => s.activeProjectId);
  const [projects, setProjects] = useState<Project[]>([]);
  // The selected project for the queue. Seeds from the active project; the user
  // can switch via the header filter. Null until a project is resolved.
  const [projectId, setProjectId] = useState<number | null>(activeProjectId);
  // The request whose detail dialog is open (null = closed).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // One-shot project load on mount (the ProjectFilter / SessionStartWizard
  // pattern). A failure leaves the list empty — the control degrades to the
  // active project alone, never fatal.
  useEffect(() => {
    let active = true;
    void API.projects
      .getAll()
      .then((res) => {
        if (!active) return;
        if (res.success && Array.isArray(res.data)) {
          const list = res.data as Project[];
          setProjects(list);
          // Adopt the first project when there is no active project yet so the
          // queue has something to show on first open.
          setProjectId((cur) => cur ?? list[0]?.id ?? null);
        }
      })
      .catch(() => {
        // Swallow — keep rendering with whatever project is selected.
      });
    return () => {
      active = false;
    };
  }, []);

  const { requests, isLoading, error } = useVerificationRequests({ projectId });

  // Verify-budget summary for the header line (§3.6 "surface budget state in
  // the Verify Queue") — a SIBLING trpc query, not derived from `requests`:
  // `judge_calls_used` is deliberately excluded from the list row shape (see
  // the router's own doc), so it has no client-side derivation path. Polled
  // independently on the same cadence as the request list. A query failure
  // degrades to hiding the line entirely — the queue's own error banner
  // already covers the primary `requests` failure mode, and a stale/missing
  // budget number is never worth a second error surface.
  const [budget, setBudget] = useState<{ budgetCalls: number | null; usedCalls: number } | null>(
    null,
  );

  useEffect(() => {
    if (projectId === null) {
      setBudget(null);
      return;
    }
    let cancelled = false;
    const fetchBudget = (): void => {
      void trpc.cyboflow.verificationRequests.budget
        .query({ projectId })
        .then((res) => {
          if (cancelled) return;
          setBudget({ budgetCalls: res.budgetCalls, usedCalls: res.usedCalls });
        })
        .catch(() => {
          if (cancelled) return;
          setBudget(null);
        });
    };
    fetchBudget();
    const timer = setInterval(fetchBudget, BUDGET_REFETCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId]);

  const handleProjectChange = (event: React.ChangeEvent<HTMLSelectElement>): void => {
    const raw = event.target.value;
    setProjectId(raw === '' ? null : Number(raw));
    // The dialog belongs to the previous project's queue — close it on switch.
    setSelectedId(null);
  };

  // Pending first (oldest-enqueued first = drain order), history after (the
  // hook's newest-first order, untouched).
  const { pending, history } = useMemo(() => {
    const pendingRows = requests.filter(isPending).slice().reverse();
    const historyRows = requests.filter((req) => !isPending(req));
    return { pending: pendingRows, history: historyRows };
  }, [requests]);

  // Track the selection by ID, not by object identity: the poll hands back a new
  // row object every time the request advances, and an open dialog must follow
  // that row's live status rather than freezing on the snapshot it was opened on.
  const selected = useMemo(
    () => (selectedId === null ? null : requests.find((req) => req.id === selectedId) ?? null),
    [requests, selectedId],
  );

  const body = useMemo<ReactElement>(() => {
    if (projectId === null) {
      return (
        <div data-testid="verify-queue-no-project" className="text-sm text-text-tertiary">
          Select a project to view its verification queue.
        </div>
      );
    }
    if (isLoading && requests.length === 0) {
      return (
        <div data-testid="verify-queue-loading" className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 w-full animate-pulse rounded-card border border-border-primary bg-bg-secondary"
            />
          ))}
        </div>
      );
    }
    if (requests.length === 0) {
      // The empty state is where a user who needs verification set up actually
      // stands, so it carries the health panel + the setup CTA rather than a
      // bare sentence. An empty queue is ambiguous on its own — it means either
      // "nothing has needed verifying" or "every check silently skipped for
      // want of a proven runbook", and the health rows are what tell them
      // apart.
      return (
        <div className="flex flex-col gap-6">
          <div data-testid="verify-queue-empty" className="flex flex-col items-start gap-2">
            <p className="text-sm text-text-tertiary">
              No verification requests for this project yet.
            </p>
          </div>
          {/* The panel's project list carries this state's setup affordance —
              including a row for THIS project — so the empty state no longer
              needs a button of its own. Two of them a few pixels apart read as
              two different actions. */}
          <VerifyHealthPanel projectId={projectId} projects={projects} />
        </div>
      );
    }
    return (
      <div data-testid="verify-queue-list" className="flex flex-col gap-6">
        <VerifyHealthPanel projectId={projectId} projects={projects} />
        <QueueSection
          testId="verify-queue-pending-list"
          title="In flight"
          hint="oldest first — the order the scheduler drains them"
          rows={pending}
          emptyCopy="Nothing is waiting on verification right now."
          onSelect={(req) => setSelectedId(req.id)}
        />
        <QueueSection
          testId="verify-queue-history-list"
          title="History"
          hint="newest first"
          rows={history}
          emptyCopy="No verifications have finished yet."
          onSelect={(req) => setSelectedId(req.id)}
        />
      </div>
    );
  }, [projectId, isLoading, requests, pending, history, projects]);

  return (
    <div
      data-testid="verify-queue-view"
      className="flex h-full flex-col overflow-hidden bg-bg-secondary"
    >
      {/* Header — title + project filter (mirrors the Insights header idiom). */}
      <div className="flex items-center gap-3 border-b border-border-primary px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-text-primary">Verify Queue</h1>
          <p className="text-[11px] text-text-tertiary">
            Visual-verification requests · captures &amp; verdicts
          </p>
        </div>
        {budget !== null && budget.budgetCalls !== null && (
          <span data-testid="verify-budget-line" className="text-[11px] text-text-tertiary">
            {budgetLineText(budget.usedCalls, budget.budgetCalls)}
          </span>
        )}
        <label className="ml-auto flex items-center gap-2">
          <span className="eyebrow text-text-tertiary">Project</span>
          <select
            data-testid="verify-queue-project-filter"
            aria-label="Filter verification queue by project"
            value={projectId === null ? '' : String(projectId)}
            onChange={handleProjectChange}
            className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 font-mono text-xs text-text-secondary transition-colors hover:border-border-emphasized hover:text-text-primary focus:border-border-emphasized focus:outline-none"
          >
            {projectId === null && <option value="">Select a project…</option>}
            {projects.map((project) => (
              <option key={project.id} value={String(project.id)}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Non-fatal error banner — the panel keeps rendering the last good list. */}
      {error !== null && (
        <div
          data-testid="verify-queue-error"
          className="border-b border-border-primary bg-status-error/10 px-5 py-2 text-xs text-status-error"
        >
          Failed to refresh the verify queue: {error.message}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-5">{body}</div>

      <VerifyRequestDetailModal request={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}
