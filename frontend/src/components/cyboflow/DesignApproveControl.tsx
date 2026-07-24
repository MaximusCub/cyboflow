/**
 * DesignApproveControl — the canvas-header Approve button + draft-freshness
 * indicator for a design session's `ui-prototype` artifact (design-mode.md
 * "Approve — intent-first recoverable state machine" + "Design-spec draft").
 *
 * Fetches `cyboflow.design.draftStatus` on mount, whenever `sessionId` changes,
 * and whenever the passed `artifactRevision` (the canvas's current prototype
 * revision) changes — the freshness line must react the moment the agent
 * regenerates the prototype. While the status is UNSETTLED (no draft yet, or
 * draft/prototype out of sync) and no approve is in flight, it additionally
 * re-polls silently every few seconds: a draft update does NOT bump the
 * artifact revision (the agent's normal order is report-prototype → refresh-
 * draft), so revision-keyed refetches alone would strand a mounted control on
 * "No design-spec draft yet" / a stale line until remount — the v0 live smoke
 * hit exactly that window. Polling stops once in sync (or link-broken), so the
 * steady state costs nothing. Renders, in state-precedence order:
 *
 *   1. no draft yet (`status === null`)        -> a muted hint, no button.
 *   2. `status.linkBroken`                      -> a warning chip, Approve disabled.
 *   3. draft present                            -> a freshness line (in-sync /
 *      stale) + the Approve button, disabled while stale or when there is no
 *      prototype bound / no resolvable idea version.
 *
 * The Approve button uses an in-place two-step confirm (arm on first click,
 * a second explicit click executes) rather than a modal — this control lives
 * in the compact ArtifactHeader action row. `{ ok: true }` shows a success
 * line and refetches; `{ ok: false }` surfaces the router's ready-made
 * `result.message` inline and refetches (the codes that resolve by refreshing
 * — stale-draft / stale-idea-version — pick up the new numbers on that refetch).
 *
 * Types come from `AppRouter` inference only (never a local mirror of the
 * `main/src/orchestrator/trpc/routers/design.ts` shapes) per the IPC/type-
 * parity rules in docs/CODE-PATTERNS.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { inferRouterOutputs } from '@trpc/server';
import { trpc } from '../../trpc/client';
import type { AppRouter } from '../../../../shared/types/trpc';

type RouterOutputs = inferRouterOutputs<AppRouter>;
type DesignDraftStatus = RouterOutputs['cyboflow']['design']['draftStatus'];
type DesignApproveResult = RouterOutputs['cyboflow']['design']['approve'];

type ApprovePhase = 'idle' | 'confirming' | 'pending' | 'success';

/** Silent re-poll cadence while the draft status is unsettled (exported for tests). */
export const DRAFT_STATUS_POLL_MS = 5000;

const INK = 'var(--color-text-primary)';
const FAINT = 'var(--color-text-tertiary)';
const PAGE = 'var(--color-bg-primary)';
const HAIRLINE = 'var(--color-border-primary)';
const WARN = 'var(--color-status-warning)';
const ERROR = 'var(--color-status-error)';
const SUCCESS = 'var(--color-status-success)';

interface DesignApproveControlProps {
  sessionId: string;
  /** The canvas's current prototype artifact revision — a refetch key. */
  artifactRevision?: number;
  /**
   * Fired once when an approve mutation resolves `{ ok: true }`, with the
   * linked idea as of the approve. The design surface uses it to exit design
   * mode and arm the "start the planner?" prompt; the artifact-header host
   * omits it (no behavior change there).
   */
  onApproved?: (info: { ideaId: string | null; ideaTitle: string | null }) => void;
}

/** Freshness copy for a non-null, link-ok draft status. */
function freshnessText(status: NonNullable<DesignDraftStatus>): string {
  const { latestDraftRevision, boundArtifactRevision, currentPrototypeRevision } = status;
  if (
    boundArtifactRevision !== null &&
    currentPrototypeRevision !== null &&
    boundArtifactRevision === currentPrototypeRevision
  ) {
    return `Draft r${latestDraftRevision} · in sync`;
  }
  if (boundArtifactRevision === null) {
    return `Draft r${latestDraftRevision} · no prototype bound yet — ask the agent to report one`;
  }
  return `Draft r${latestDraftRevision} · prototype at r${currentPrototypeRevision ?? '?'} — ask the agent to refresh the draft`;
}

const approveButtonStyle = {
  fontSize: '10px',
  fontWeight: 700,
  letterSpacing: '.02em',
  color: INK,
  background: PAGE,
  border: `1px solid ${INK}`,
  borderRadius: 3,
  padding: '3px 10px',
  whiteSpace: 'nowrap' as const,
};

export function DesignApproveControl({ sessionId, artifactRevision, onApproved }: DesignApproveControlProps): ReactElement {
  const [status, setStatus] = useState<DesignDraftStatus>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<ApprovePhase>('idle');
  const [resultMessage, setResultMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchStatus = useCallback((opts?: { background?: boolean }): Promise<void> => {
    // Background polls stay silent — flipping `loading` would flicker the
    // control back to "…" every poll tick.
    if (!opts?.background) setLoading(true);
    return trpc.cyboflow.design.draftStatus.query({ sessionId }).then(
      (result) => {
        if (!mountedRef.current) return;
        setStatus(result);
        setLoading(false);
      },
      () => {
        if (!mountedRef.current) return;
        if (opts?.background) return; // keep the last good status on a failed poll
        setStatus(null);
        setLoading(false);
      },
    );
  }, [sessionId]);

  useEffect(() => {
    void fetchStatus();
    setPhase('idle');
    setResultMessage(null);
    // artifactRevision is a deliberate refetch key (not read directly) — the
    // canvas passes the prototype's current revision so the freshness line
    // reacts the moment the agent regenerates it.
  }, [fetchStatus, artifactRevision]);

  // Silent re-poll while unsettled (see the header comment): a draft write does
  // not bump the artifact revision, so without this a control mounted between
  // the artifact report and the draft write never leaves "No design-spec draft
  // yet" (nor a stale line) until remount. Runs only while idle — never under a
  // confirm/pending/success interaction — and stops once in sync or link-broken.
  const unsettled =
    status === null ||
    (!status.linkBroken &&
      !(
        status.boundArtifactRevision !== null &&
        status.currentPrototypeRevision !== null &&
        status.boundArtifactRevision === status.currentPrototypeRevision
      ));
  useEffect(() => {
    if (!unsettled || phase !== 'idle') return;
    const timer = setInterval(() => {
      void fetchStatus({ background: true });
    }, DRAFT_STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [unsettled, phase, fetchStatus]);

  const handleApproveClick = (): void => {
    setResultMessage(null);
    setPhase('confirming');
  };

  const handleCancel = (): void => {
    setPhase('idle');
  };

  const handleConfirm = (): void => {
    if (!status || status.ideaVersion === null) return;
    // Snapshot the idea as of the confirm — the post-approve refetch could
    // flip linkBroken (idea folded/decomposed) before the callback consumer
    // reads it.
    const approvedIdea = { ideaId: status.ideaId, ideaTitle: status.ideaTitle };
    setPhase('pending');
    trpc.cyboflow.design.approve
      .mutate({
        sessionId,
        draftRevision: status.latestDraftRevision,
        expectedIdeaVersion: status.ideaVersion,
      })
      .then(
        (result: DesignApproveResult) => {
          if (!mountedRef.current) return;
          if (result.ok) {
            setPhase('success');
            setResultMessage(null);
            onApproved?.(approvedIdea);
          } else {
            setPhase('idle');
            setResultMessage(result.message);
          }
          void fetchStatus();
        },
        (err: unknown) => {
          if (!mountedRef.current) return;
          setPhase('idle');
          setResultMessage(err instanceof Error ? err.message : 'Approve failed.');
          void fetchStatus();
        },
      );
  };

  if (loading) {
    return (
      <span data-testid="design-approve-loading" style={{ fontSize: '10px', color: FAINT }}>
        …
      </span>
    );
  }

  if (status === null) {
    return (
      <span
        data-testid="design-approve-no-draft"
        style={{ fontSize: '10px', color: FAINT, fontStyle: 'italic', whiteSpace: 'nowrap' }}
      >
        No design-spec draft yet
      </span>
    );
  }

  if (status.linkBroken) {
    return (
      <span data-testid="design-approve-control" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          data-testid="design-link-broken-chip"
          style={{
            fontSize: '8.5px',
            fontWeight: 700,
            color: WARN,
            border: `1px solid ${WARN}`,
            borderRadius: 2,
            padding: '1px 5px',
            whiteSpace: 'nowrap',
          }}
        >
          Idea link broken — relink or end session
        </span>
        <button type="button" data-testid="design-approve-button" disabled style={{ ...approveButtonStyle, opacity: 0.5, cursor: 'default' }}>
          Approve design
        </button>
      </span>
    );
  }

  const stale = !(
    status.boundArtifactRevision !== null &&
    status.currentPrototypeRevision !== null &&
    status.boundArtifactRevision === status.currentPrototypeRevision
  );
  const disabled = stale || status.boundArtifactRevision === null || status.ideaVersion === null;

  return (
    <span data-testid="design-approve-control" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span data-testid="design-approve-freshness" style={{ fontSize: '10px', color: FAINT, whiteSpace: 'nowrap' }}>
        {freshnessText(status)}
      </span>

      {phase === 'success' && (
        <span data-testid="design-approve-success" style={{ fontSize: '10px', fontWeight: 700, color: SUCCESS, whiteSpace: 'nowrap' }}>
          Approved ✓ — spec folded into the idea
        </span>
      )}

      {resultMessage && (
        <span data-testid="design-approve-result" style={{ fontSize: '10px', fontWeight: 600, color: ERROR }}>
          {resultMessage}
        </span>
      )}

      {phase === 'confirming' ? (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span data-testid="design-approve-confirm-prompt" style={{ fontSize: '10px', fontWeight: 600, color: WARN, whiteSpace: 'nowrap' }}>
            {`Confirm fold into ${status.ideaTitle ?? 'the idea'}?`}
          </span>
          <button type="button" data-testid="design-approve-confirm-yes" onClick={handleConfirm} style={approveButtonStyle}>
            Yes, approve
          </button>
          <button
            type="button"
            data-testid="design-approve-confirm-cancel"
            onClick={handleCancel}
            style={{ ...approveButtonStyle, border: `1px solid ${HAIRLINE}` }}
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          data-testid="design-approve-button"
          onClick={handleApproveClick}
          disabled={disabled || phase === 'pending'}
          style={{ ...approveButtonStyle, opacity: disabled || phase === 'pending' ? 0.5 : 1, cursor: disabled || phase === 'pending' ? 'default' : 'pointer' }}
        >
          {phase === 'pending' ? 'Approving…' : 'Approve design'}
        </button>
      )}
    </span>
  );
}
