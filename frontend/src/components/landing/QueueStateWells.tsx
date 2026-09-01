/**
 * QueueStateWells — the panels that stand in for (or sit above) the ordinary
 * queue sections when the page is in one of its non-`normal` states.
 *
 * Each one answers a different "why is this page not a list of work":
 *   - {@link LoadErrorPanel}   — we could not read the queue. It says so, and it
 *     says what is still fine (the rail), because the honest failure is "this
 *     list can't refresh", not "your sessions are gone".
 *   - {@link NoAccountsPanel}  — nothing can run without a provider, so the
 *     usage cards flip to connect CTAs and the queue is replaced outright.
 *   - {@link NoProjectsPanel}  — reuses {@link CreateProjectDialog} and the
 *     wizard hand-off that the old landing EmptyState owned, restyled to the
 *     artboard's prominent CTA.
 *   - {@link NoSessionsWell}   — projects exist but nothing has ever run; the
 *     three session sections collapse into this one well.
 *   - {@link CaughtUpWell}     — everything landed and nothing is waiting.
 *   - {@link AllIdleStrip}     — something is waiting, but nothing is blocked or
 *     running, so the page leads with reassurance rather than alarm.
 */
import React from 'react';
import { AlertTriangle, CheckCircle2, FolderPlus, Users, Zap } from 'lucide-react';
import { CreateProjectDialog } from '../CreateProjectDialog';
import { useNavigationStore } from '../../stores/navigationStore';
import { EmptyWell, ProminentButton, SectionHeader } from './QueuePrimitives';

/** The backend fan-out failed. Retry re-runs the landing store's resync. */
export function LoadErrorPanel({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div
      data-testid="rq-state-well-error"
      className="flex flex-col items-center gap-1.5 border border-border-primary bg-surface-raised px-[18px] py-[26px] text-center shadow-[inset_3px_0_0_var(--color-status-error)]"
    >
      <AlertTriangle className="h-[18px] w-[18px] text-status-error" strokeWidth={1.8} />
      <div className="text-[14px] font-bold text-status-error">Couldn&rsquo;t load the review queue</div>
      <div className="max-w-[460px] text-[11px] leading-relaxed text-text-tertiary">
        The backend didn&rsquo;t respond. Sessions in the rail are unaffected — this list just
        can&rsquo;t refresh right now.
      </div>
      <ProminentButton variant="bordered" onClick={onRetry}>
        Retry
      </ProminentButton>
    </div>
  );
}

/** One provider's not-connected card, mirroring the usage cards' frame. */
function ConnectCard({
  name,
  blurb,
  ctaLabel,
  variant,
  onConnect,
}: {
  name: string;
  blurb: string;
  ctaLabel: string;
  variant: 'accent' | 'bordered';
  onConnect: () => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 border border-border-primary bg-surface-raised px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold text-text-primary">{name}</span>
        <span className="eyebrow ml-auto text-text-tertiary">Not connected</span>
      </div>
      <p className="text-[11px] text-text-tertiary">{blurb}</p>
      <div className="flex">
        <ProminentButton variant={variant} onClick={onConnect}>
          {ctaLabel}
        </ProminentButton>
      </div>
    </div>
  );
}

/** No provider is connected — connect CTAs replace the usage cards and the queue. */
export function NoAccountsPanel(): React.JSX.Element {
  const openIntegrations = (): void => useNavigationStore.getState().openSettings('integrations');
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
        <ConnectCard
          name="Claude"
          blurb="Sign in with your Anthropic account to run Claude sessions."
          ctaLabel="Connect Claude"
          variant="accent"
          onConnect={openIntegrations}
        />
        <ConnectCard
          name="Codex"
          blurb="Optional second provider — connect to route flows onto Codex."
          ctaLabel="Connect Codex"
          variant="bordered"
          onConnect={openIntegrations}
        />
      </div>
      <EmptyWell
        testId="rq-state-well-no-accounts"
        icon={<Users className="h-[18px] w-[18px] text-text-tertiary" strokeWidth={1.8} />}
        title="No accounts connected"
        body="Sessions can't run without a provider. Connect at least one account above — your projects and backlog are still browsable."
      />
    </>
  );
}

/**
 * No projects yet. Carries over the old landing EmptyState's behaviour verbatim:
 * the CTA opens {@link CreateProjectDialog}, and a successful create hands off to
 * the wizard locked to the new project with the quick escape hatch allowed.
 */
export function NoProjectsPanel(): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  return (
    <>
      <EmptyWell
        testId="rq-state-well-no-projects"
        className="py-10"
        icon={<FolderPlus className="h-6 w-6 text-text-tertiary" strokeWidth={1.8} />}
        title="Add your first project"
        body="Point Cyboflow at a local git repository — sessions, flows, and the backlog all live inside a project."
        action={<ProminentButton onClick={() => setDialogOpen(true)}>Browse for a folder</ProminentButton>}
      />
      <CreateProjectDialog
        isOpen={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={(project) => {
          useNavigationStore.getState().goToWizard({ lockProjectId: project.id, allowQuick: true });
        }}
      />
    </>
  );
}

/** Projects exist, but nothing has ever run — the three session sections collapse to this. */
export function NoSessionsWell({ onStartSession }: { onStartSession: () => void }): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2.5">
      <SectionHeader dotClass="bg-interactive" title="Sessions" count={0} countMuted />
      <EmptyWell
        testId="rq-state-well-no-sessions"
        icon={<Zap className="h-[18px] w-[18px] text-text-tertiary" strokeWidth={1.8} />}
        title="No sessions yet"
        body="Start a quick session or launch a flow — sessions land here as they need you."
        action={<ProminentButton onClick={onStartSession}>Start a session</ProminentButton>}
      />
    </section>
  );
}

/** Nothing is waiting. Working agents are named so the zero doesn't read as "idle". */
export function CaughtUpWell({
  workingCount,
  onStartSession,
}: {
  workingCount: number;
  onStartSession: () => void;
}): React.JSX.Element {
  return (
    <EmptyWell
      testId="rq-state-well-caught-up"
      tone="success"
      icon={<CheckCircle2 className="h-5 w-5 text-status-success" strokeWidth={1.8} />}
      title="All caught up"
      body={
        workingCount > 0
          ? `Nothing needs your attention. ${workingCount} ${workingCount === 1 ? 'agent is' : 'agents are'} still working — they'll land here when they finish.`
          : 'Nothing needs your attention.'
      }
      action={<ProminentButton onClick={onStartSession}>Start a new session</ProminentButton>}
    />
  );
}

/** Something is waiting, but nothing is blocked or running — review at leisure. */
export function AllIdleStrip({ sessionCount }: { sessionCount: number }): React.JSX.Element {
  return (
    <div
      data-testid="rq-state-well-all-idle"
      className="flex items-center gap-2.5 border border-border-primary bg-surface-raised px-3.5 py-[11px] shadow-[inset_3px_0_0_var(--color-status-success)]"
    >
      <CheckCircle2 className="h-[15px] w-[15px] shrink-0 text-status-success" strokeWidth={2} />
      <span className="shrink-0 text-[12px] font-bold text-status-success">Nothing is blocked</span>
      <span className="text-[11px] text-text-secondary">
        All {sessionCount} {sessionCount === 1 ? 'session is' : 'sessions are'} idle — review them at
        your leisure.
      </span>
    </div>
  );
}
