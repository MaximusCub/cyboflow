/**
 * VerifyHealthPanel — the phase-3 health surface on the Verify Queue
 * (docs/proposals/verification-setup-flow.md §6).
 *
 * Two tables, both LIVE rather than remembered:
 *
 *   - HOST — one row per capability probe, re-run on every panel open. Never a
 *     stored checkbox: a TCC grant rots silently on any app-path or version
 *     change while a remembered "configured" keeps claiming otherwise, which is
 *     the failure this replaces. Chromium's row carries an in-place fix
 *     (provisioning, not consent).
 *   - MODALITIES — per modality: runbook state, attempts, pass rate,
 *     failure-class histogram, median duration, and any capability suppression
 *     with the time until it re-probes.
 *
 * The runbook line leads each modality row on purpose. Until a runbook is
 * PROVEN, the §3.2 degrade gate skips every build/serve verification for that
 * modality — so the queue looks calm while nothing is actually being verified,
 * and no other number on this panel means what it appears to mean.
 *
 * Setup-proof traffic is shown apart from lane traffic (§8's "separate
 * counter"), including the spend that still lands against the project budget.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { trpc } from '../../trpc/client';
import { useNavigationStore } from '../../stores/navigationStore';
import { VERIFY_SETUP_WORKFLOW_NAME } from './wizard/workflowMeta';
import type {
  VerificationHealthSummary,
  VerificationModalityHealth,
  VerifyHostProbeReport,
  VerifyProbeRow,
} from '../../../../shared/types/visualVerification';
import {
  PROBE_LABEL,
  PROBE_STATE_CLASS,
  PROBE_STATE_LABEL,
  attemptsText,
  capabilityLine,
  durationText,
  failureHistogramText,
  hasProvenRunbook,
  passRateText,
  probeFixLabel,
  runbookLine,
} from './verifyHealthModel';

/** Health polls far slower than the request list: these numbers move per verification, not per tick. */
const HEALTH_REFETCH_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Setup CTA
// ---------------------------------------------------------------------------

/**
 * Launches the verify-setup flow by opening the session wizard PRESELECTED to
 * it, rather than calling `runs.start` here.
 *
 * The flow is hidden from the wizard's own list (it configures the project
 * rather than doing project work), so this CTA is its primary entry point —
 * see `wizard/workflowMeta.ts` SETUP_WORKFLOW_NAMES. That is why the button is
 * rendered UNCONDITIONALLY rather than only when setup looks needed: a health
 * query that failed, or one modality already proven while another is not, must
 * not be able to hide the only affordance for repairing the rest.
 *
 * A flow launch needs a host session, a resolved substrate/provider pair, a
 * model and a permission mode — all of which the wizard already owns. Starting
 * a run directly from this panel would duplicate that ladder and drift from it.
 */
export function VerifySetupCta({
  projectId,
  label,
  testId,
}: {
  projectId: number | null;
  label: string;
  testId: string;
}): ReactElement {
  const onClick = useCallback(() => {
    useNavigationStore.getState().goToWizard({
      preselectWorkflowName: VERIFY_SETUP_WORKFLOW_NAME,
      ...(projectId !== null ? { lockProjectId: projectId } : {}),
    });
  }, [projectId]);

  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="rounded-button border border-border-primary bg-bg-primary px-2.5 py-1 text-xs font-medium text-text-primary transition-colors hover:border-border-emphasized hover:bg-bg-hover focus:border-border-emphasized focus:outline-none"
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function ProbeTableRow({
  row,
  onFix,
  fixInFlight,
}: {
  row: VerifyProbeRow;
  onFix: (row: VerifyProbeRow) => void;
  fixInFlight: boolean;
}): ReactElement {
  const fixLabel = probeFixLabel(row);
  return (
    <div
      data-testid={`verify-probe-${row.id}`}
      className="flex items-center gap-2 border-b border-border-primary/50 py-1.5 last:border-b-0"
    >
      <span
        data-testid={`verify-probe-state-${row.id}`}
        className={`w-16 shrink-0 rounded-full px-2 py-0.5 text-center text-[10px] font-medium ${PROBE_STATE_CLASS[row.state]}`}
      >
        {PROBE_STATE_LABEL[row.state]}
      </span>
      <span className="w-28 shrink-0 text-xs text-text-primary">{PROBE_LABEL[row.id]}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-tertiary" title={row.detail}>
        {row.detail}
      </span>
      {fixLabel !== null && row.fix === 'provision-chromium' && (
        <button
          type="button"
          data-testid={`verify-probe-fix-${row.id}`}
          disabled={fixInFlight}
          onClick={() => onFix(row)}
          className="shrink-0 rounded-button border border-border-primary bg-bg-primary px-2 py-0.5 text-[11px] text-text-primary transition-colors hover:border-border-emphasized hover:bg-bg-hover disabled:opacity-50 focus:border-border-emphasized focus:outline-none"
        >
          {fixInFlight ? 'Installing…' : fixLabel}
        </button>
      )}
      {row.fix === 'grant-screen-recording' && (
        // No in-app action: the grant lives in System Settings and cannot be
        // toggled from here. Say where it is rather than offering a button that
        // would only open a pane the user still has to act in.
        <span className="shrink-0 text-[10px] text-text-tertiary">
          System Settings → Privacy → Screen Recording
        </span>
      )}
    </div>
  );
}

function ModalityRow({ row }: { row: VerificationModalityHealth }): ReactElement {
  const runbook = runbookLine(row.runbook);
  const capability = capabilityLine(row.capability);
  const histogram = failureHistogramText(row);

  return (
    <div
      data-testid={`verify-health-modality-${row.modality}`}
      className="flex flex-col gap-0.5 border-b border-border-primary/50 py-2 last:border-b-0"
    >
      <div className="flex items-center gap-2">
        <span className="w-28 shrink-0 font-mono text-xs text-text-primary">{row.modality}</span>
        <span
          data-testid={`verify-health-runbook-${row.modality}`}
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            runbook.tone === 'ok'
              ? 'bg-status-success/15 text-status-success'
              : 'bg-status-warning/15 text-status-warning'
          }`}
        >
          {runbook.text}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-text-secondary">
          {attemptsText(row)} · {passRateText(row)} pass · median {durationText(row.medianDurationMs)}
        </span>
      </div>

      {histogram.length > 0 && (
        <div
          data-testid={`verify-health-failures-${row.modality}`}
          className="pl-[7.5rem] text-[10px] text-text-tertiary"
        >
          {histogram}
        </div>
      )}

      {capability !== null && (
        <div
          data-testid={`verify-health-capability-${row.modality}`}
          className="pl-[7.5rem] text-[10px] text-status-warning"
        >
          {capability}
        </div>
      )}

      {row.inFlight > 0 && (
        <div className="pl-[7.5rem] text-[10px] text-text-tertiary">{row.inFlight} in flight</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function VerifyHealthPanel({
  projectId,
  showSetupCta = true,
}: {
  projectId: number | null;
  /**
   * Whether to render the header's setup CTA. The Verify Queue's EMPTY state
   * carries its own prominent one directly above this panel, and two buttons
   * doing the same thing a few pixels apart reads as two different actions.
   */
  showSetupCta?: boolean;
}): ReactElement | null {
  const [health, setHealth] = useState<VerificationHealthSummary | null>(null);
  const [probes, setProbes] = useState<VerifyHostProbeReport | null>(null);
  const [fixInFlight, setFixInFlight] = useState(false);

  // Health + probes poll together on a slow cadence. Both degrade to `null`
  // (section hidden) on failure rather than raising a second error surface —
  // the queue's own banner already covers the primary failure mode, and a
  // missing health section is never worth an alarm of its own.
  useEffect(() => {
    if (projectId === null) {
      setHealth(null);
      setProbes(null);
      return;
    }
    let cancelled = false;
    const fetchAll = (): void => {
      void trpc.cyboflow.verificationRequests.health
        .query({ projectId })
        .then((res) => {
          if (!cancelled) setHealth(res);
        })
        .catch(() => {
          if (!cancelled) setHealth(null);
        });
      void trpc.cyboflow.verificationRequests.hostProbes
        .query()
        .then((res) => {
          if (!cancelled) setProbes(res);
        })
        .catch(() => {
          if (!cancelled) setProbes(null);
        });
    };
    fetchAll();
    const timer = setInterval(fetchAll, HEALTH_REFETCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId]);

  const handleFix = useCallback((row: VerifyProbeRow) => {
    if (row.fix !== 'provision-chromium') return;
    setFixInFlight(true);
    void trpc.cyboflow.verificationRequests.provisionChromium
      .mutate()
      .then((res) => {
        // The mutation returns the RE-PROBED report, so a success is reflected
        // immediately instead of waiting out the poll interval.
        setProbes(res);
      })
      .catch(() => {
        // Soft-fail: provisioning never throws for an ordinary "could not
        // install" — the re-probed row carries that outcome. An actual
        // transport error leaves the previous rows in place.
      })
      .finally(() => setFixInFlight(false));
  }, []);

  if (projectId === null) return null;

  // The panel renders even when BOTH queries failed. It degrades to a header
  // and its CTA rather than disappearing: this is the launch path for the flow
  // that repairs verification, and a failing health query is not a reason to
  // take it away — it is a reason to want it.
  //
  // The CTA's LABEL, not its presence, tracks how much is set up. `proven` here
  // means at least one modality is proven, which is not the same as "done" on a
  // project with several.
  const proven = health !== null && hasProvenRunbook(health.modalities);

  return (
    <section data-testid="verify-health-panel" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 className="eyebrow text-text-tertiary">Health</h2>
        <span className="text-[10px] text-text-tertiary">live probes · per-modality outcomes</span>
        {showSetupCta && (
          <span className="ml-auto">
            <VerifySetupCta
              projectId={projectId}
              label={proven ? 'Re-run setup' : 'Set up verification'}
              testId="verify-health-setup-cta"
            />
          </span>
        )}
      </div>

      {probes !== null && (
        <div className="rounded-card border border-border-primary bg-bg-primary px-3 py-1">
          {probes.probes.map((row) => (
            <ProbeTableRow key={row.id} row={row} onFix={handleFix} fixInFlight={fixInFlight} />
          ))}
        </div>
      )}

      {health !== null && health.modalities.length > 0 && (
        <div className="rounded-card border border-border-primary bg-bg-primary px-3 py-1">
          {health.modalities.map((row) => (
            <ModalityRow key={row.modality} row={row} />
          ))}
        </div>
      )}

      {health !== null && health.unattributed.attempts > 0 && (
        <p data-testid="verify-health-unattributed" className="text-[10px] text-text-tertiary">
          {attemptsText(health.unattributed)} not attributed to a modality ·{' '}
          {passRateText(health.unattributed)} pass
        </p>
      )}

      {health !== null && health.setupProof.attempts > 0 && (
        <p data-testid="verify-health-setup-proof" className="text-[10px] text-text-tertiary">
          setup proof: {attemptsText(health.setupProof)} · {passRateText(health.setupProof)} pass ·{' '}
          {health.setupProofCallsUsed} call
          {health.setupProofCallsUsed === 1 ? '' : 's'} counted against the project budget
        </p>
      )}
    </section>
  );
}
