/**
 * OverviewActiveAgents — section 1 of the Project Overview page: everything
 * live in THIS project, in one list.
 *
 * Three row kinds, in this order:
 *   1. Flow runs — non-terminal `workflow_runs` for the project (activeRunsStore),
 *      rendered as a card with a pulsing rust dot, the workflow name, a flow
 *      pill, the {@link FlowProgress} phase stepper (reused verbatim — it owns
 *      the phase subscription and the phase-color contract), and a "now line"
 *      of branch / current step / elapsed / model / Open →.
 *   2. Quick sessions — this project's running-or-blocked chat sessions, as a
 *      simpler card (no stepper: a quick session has no workflow phases).
 *   3. Blocked permission checkpoints — pending approvals whose run belongs to
 *      this project, as the red-inset card from the design, with the store's
 *      approve/reject mutations wired to the two buttons.
 *
 * Ownership of the run→project mapping: an approval carries only a `runId`, so
 * "is this checkpoint mine?" is answered from the two live sources this section
 * already subscribes to — the project's flow runs and the project's quick
 * sessions. That deliberately avoids pulling in the cross-project landingStore
 * (which this page does not otherwise render), and it covers BOTH gate origins:
 * a flow run's PreToolUse gate and a quick chat's.
 *
 * Elapsed strings tick on ONE ~30s clock owned by this component and passed
 * down, rather than a timer per card.
 */
import { useEffect, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { FlowProgress } from '../landing/FlowProgress';
import { useWorkflowPhaseState } from '../../hooks/useWorkflowPhaseState';
import { SectionHeader, EmptyWell } from './overviewChrome';
import { formatElapsed } from '../../utils/homeClassify';
import { isTerminalRunStatus, useActiveRunsStore, type ActiveRunRow } from '../../stores/activeRunsStore';
import { useQuickSessionsStore } from '../../stores/quickSessionsStore';
import { useReviewQueueStore } from '../../stores/reviewQueueStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { trpc } from '../../trpc/client';
import type { Approval } from '../../../../shared/types/approvals';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { OverviewPageState } from './overviewModel';

/** Wall-clock refresh cadence for every elapsed counter in this section. */
const ELAPSED_TICK_MS = 30_000;

/** Empty-well copy, per page state (the design gives each state its own hint). */
const EMPTY_COPY: Record<OverviewPageState, { title: string; hint: string }> = {
  normal: {
    title: 'No agents running',
    hint: 'Agents appear here when a flow or a quick session is live in this project.',
  },
  'empty-new': {
    title: 'No agents running yet',
    hint: 'Agents appear here when a flow or a quick session is live in this project.',
  },
  'empty-new-existing': {
    title: 'No agents running yet',
    hint: 'Agents appear here when a flow or a quick session is live in this project.',
  },
  'empty-ideas': {
    title: 'No agents running',
    hint: 'Launch a planner to start turning your ideas into tasks.',
  },
  'empty-drained': {
    title: 'No agents running',
    hint: 'Nothing is in flight — the task queue is empty until another idea is planned.',
  },
  'empty-done': {
    title: 'No agents running',
    hint: 'Nothing left to run — the backlog is fully shipped.',
  },
};

// ---------------------------------------------------------------------------
// Navigation — the canonical "open a run / a quick session" trio.
// ---------------------------------------------------------------------------

function openRunSession(runId: string, projectId: number): void {
  useCyboflowStore.getState().setActiveRun(runId);
  useNavigationStore.getState().setActiveProjectId(projectId);
  useNavigationStore.getState().goToSession();
}

function openQuickSession(sessionId: string, runId: string | null, projectId: number): void {
  useCyboflowStore.getState().setActiveQuickSession(sessionId, runId ?? undefined);
  useNavigationStore.getState().setActiveProjectId(projectId);
  useNavigationStore.getState().goToSession();
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function RunCard({
  run,
  nowMs,
  model,
}: {
  run: ActiveRunRow;
  nowMs: number;
  model: string | null;
}): React.JSX.Element {
  // The current step id for the now-line. ActiveAgentCard sets the precedent of
  // pairing this with FlowProgress on the same card; both read the same cached
  // phase-state subscription for the run.
  const { currentStepId } = useWorkflowPhaseState(run.id);

  return (
    <div
      data-testid={`overview-run-${run.id}`}
      className="flex flex-col gap-2.5 border border-border-primary bg-surface-primary px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full bg-interactive animate-pulse motion-reduce:animate-none"
        />
        <span className="truncate font-bold text-text-primary" style={{ fontSize: '13px' }}>
          {run.workflowName}
        </span>
        <span className="eyebrow ml-auto shrink-0 rounded-full border border-border-primary px-2 py-px text-text-secondary">
          {run.workflowName}
        </span>
      </div>

      <FlowProgress runId={run.id} workflowName={run.workflowName} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ fontSize: '11px' }}>
        {run.branch_name !== null && (
          <span className="truncate text-status-success" title={run.branch_name}>
            ⌥ {run.branch_name}
          </span>
        )}
        <span className="truncate font-bold text-text-primary">
          ▸ {currentStepId ?? run.status}
        </span>
        <span className="text-text-muted">{formatElapsed(run.started_at, nowMs)}</span>
        {model !== null && <span className="truncate text-text-muted">{model}</span>}
        <button
          type="button"
          onClick={() => openRunSession(run.id, run.project_id)}
          className="ml-auto shrink-0 text-interactive hover:text-interactive-hover"
        >
          Open →
        </button>
      </div>
    </div>
  );
}

function QuickCard({ row, nowMs }: { row: QuickSessionRow; nowMs: number }): React.JSX.Element {
  const blocked = row.state === 'blocked';
  return (
    <div
      data-testid={`overview-quick-${row.sessionId}`}
      className="flex flex-col gap-2 border border-border-primary bg-surface-primary px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-2 w-2 shrink-0 rounded-full ${
            blocked ? 'bg-status-error' : 'bg-interactive animate-pulse motion-reduce:animate-none'
          }`}
        />
        <span className="truncate font-bold text-text-primary" style={{ fontSize: '13px' }}>
          {row.name}
        </span>
        <span className="eyebrow ml-auto shrink-0 rounded-full border border-border-primary px-2 py-px text-text-secondary">
          Quick
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ fontSize: '11px' }}>
        {row.worktreeName !== null && (
          <span className="truncate text-status-success" title={row.worktreeName}>
            ⌥ {row.worktreeName}
          </span>
        )}
        <span className={blocked ? 'font-bold text-status-error' : 'text-text-muted'}>
          {blocked ? 'waiting on you' : 'working'}
        </span>
        {row.idleSince !== null && (
          <span className="text-text-muted">{formatElapsed(row.idleSince, nowMs)}</span>
        )}
        <button
          type="button"
          onClick={() => openQuickSession(row.sessionId, row.runId, row.projectId)}
          className="ml-auto shrink-0 text-interactive hover:text-interactive-hover"
        >
          Open →
        </button>
      </div>
    </div>
  );
}

function CheckpointCard({
  approval,
  quickSession,
  projectId,
  nowMs,
}: {
  approval: Approval;
  /**
   * The quick-session row this approval belongs to, when its run is a
   * `__quick__`-sentinel chat rather than a flow run. Quick runs are excluded
   * from workflows.list, so routing them through setActiveRun strands the
   * center pane on "Loading workflow…" — they must open via
   * setActiveQuickSession instead (same split TypeGroupedQueue makes).
   */
  quickSession: QuickSessionRow | null;
  projectId: number;
  nowMs: number;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);

  const decide = (kind: 'approve' | 'reject'): void => {
    setBusy(true);
    const call =
      kind === 'approve'
        ? trpc.cyboflow.approvals.approve.mutate({ approvalId: approval.id })
        : trpc.cyboflow.approvals.reject.mutate({ approvalId: approval.id });
    void call
      .catch((err: unknown) => {
        console.warn('[OverviewActiveAgents] approval decision failed:', err);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div
      data-testid={`overview-checkpoint-${approval.id}`}
      className="flex flex-col gap-2 border border-border-primary bg-surface-primary px-4 py-3"
      style={{ boxShadow: 'inset 3px 0 0 var(--color-status-error)' }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow text-status-error">Permission</span>
        <span className="truncate font-bold text-text-primary" style={{ fontSize: '13px' }}>
          {approval.sessionName ?? approval.workflowName}
        </span>
        {approval.agentProvider !== null && (
          <span className="eyebrow shrink-0 rounded-full border border-border-primary px-2 py-px text-text-secondary">
            {approval.agentProvider}
          </span>
        )}
        <span className="text-text-secondary" style={{ fontSize: '11px' }}>
          {approval.toolName}
        </span>
        {approval.awaited && (
          <span
            className="ml-auto shrink-0 font-bold text-status-error"
            style={{ fontSize: '11px' }}
          >
            blocked {formatElapsed(approval.createdAt, nowMs)}
          </span>
        )}
      </div>

      {approval.rationale !== null && approval.rationale !== '' && (
        <p className="italic text-text-secondary" style={{ fontSize: '11px' }}>
          {approval.rationale}
        </p>
      )}

      <pre
        className="overflow-hidden whitespace-pre border border-border-primary bg-bg-primary px-2.5 py-2 text-text-primary"
        style={{ fontSize: '11px' }}
      >
        {approval.payloadPreview}
      </pre>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => decide('approve')}
          className="border border-interactive-hover bg-interactive px-3.5 py-1 font-semibold text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
          style={{ fontSize: '12px' }}
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide('reject')}
          className="border border-border-primary bg-surface-primary px-3.5 py-1 font-semibold text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          style={{ fontSize: '12px' }}
        >
          Reject
        </button>
        <button
          type="button"
          onClick={() =>
            quickSession !== null
              ? openQuickSession(quickSession.sessionId, quickSession.runId, projectId)
              : openRunSession(approval.runId, projectId)
          }
          className="ml-auto text-interactive hover:text-interactive-hover"
          style={{ fontSize: '11px' }}
        >
          Open in session →
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface OverviewActiveAgentsProps {
  projectId: number;
  /** Drives the empty-well copy only — the live rows are the same in every state. */
  pageState: OverviewPageState;
}

export function OverviewActiveAgents({
  projectId,
  pageState,
}: OverviewActiveAgentsProps): React.JSX.Element {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const runsForProject = useActiveRunsStore((s) => s.runsByProject[projectId]);
  const runs = useMemo(
    () => (runsForProject ?? []).filter((r) => !isTerminalRunStatus(r.status)),
    [runsForProject],
  );

  const quickRows = useQuickSessionsStore((s) => s.rows);
  const quick = useMemo(
    () =>
      quickRows.filter(
        (r) => r.projectId === projectId && (r.state === 'running' || r.state === 'blocked'),
      ),
    [quickRows, projectId],
  );

  const queue = useReviewQueueStore((s) => s.queue);
  const projectRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of runs) ids.add(r.id);
    for (const q of quick) if (q.runId !== null) ids.add(q.runId);
    return ids;
  }, [runs, quick]);
  /** runId → quick-session row, so a chat approval routes via setActiveQuickSession. */
  const quickByRunId = useMemo(() => {
    const map = new Map<string, QuickSessionRow>();
    for (const q of quick) if (q.runId !== null) map.set(q.runId, q);
    return map;
  }, [quick]);
  const checkpoints = useMemo(
    () => queue.filter((a) => projectRunIds.has(a.runId)),
    [queue, projectRunIds],
  );
  const otherCheckpointCount = queue.length - checkpoints.length;

  // The model pill is only honest for the run whose stream log is live.
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const initModel = useCyboflowStore((s) => s.initModel);

  const openHumanReview = useNavigationStore((s) => s.openHumanReview);

  const total = runs.length + quick.length + checkpoints.length;
  const empty = EMPTY_COPY[pageState];

  return (
    <section className="flex flex-col gap-2.5" data-testid="overview-active-agents">
      <SectionHeader
        dotColor="var(--color-interactive-primary)"
        title="Active agents"
        count={total}
        descriptor={
          total > 0 ? 'Live runs in this project — blocked checkpoints surface here' : undefined
        }
        action={{ label: 'Human review', onClick: openHumanReview }}
      />

      {total === 0 ? (
        <EmptyWell
          icon={Activity}
          title={empty.title}
          hint={empty.hint}
          testId="overview-active-agents-empty"
        />
      ) : (
        <>
          {runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              nowMs={nowMs}
              model={activeRunId === run.id ? initModel : null}
            />
          ))}
          {quick.map((row) => (
            <QuickCard key={row.sessionId} row={row} nowMs={nowMs} />
          ))}
          {checkpoints.map((approval) => (
            <CheckpointCard
              key={approval.id}
              approval={approval}
              quickSession={quickByRunId.get(approval.runId) ?? null}
              projectId={projectId}
              nowMs={nowMs}
            />
          ))}
        </>
      )}

      {otherCheckpointCount > 0 && (
        <div className="text-text-muted" style={{ fontSize: '11px' }}>
          {otherCheckpointCount} more checkpoint{otherCheckpointCount === 1 ? '' : 's'} across other
          projects —{' '}
          <button
            type="button"
            onClick={openHumanReview}
            className="text-interactive hover:text-interactive-hover"
          >
            Human review →
          </button>
        </div>
      )}
    </section>
  );
}
