/**
 * RecommendedActionsSection — the "where to start" card grid at the top of the
 * Human Review Queue.
 *
 * Purely presentational over {@link deriveRecommendedActions}'s output: the
 * engine decides WHICH cards exist and in what order; this file owns their look
 * (per-kind icon + tint, CTA weight) and forwards clicks to the page-level
 * handler, which owns every navigation/launch side effect.
 *
 * Cards past {@link MAX_VISIBLE} arrive as `hidden` and are revealed by the
 * dashed "+N more" row rather than dropped.
 */
import React from 'react';
import {
  AlertTriangle,
  Clock,
  GitBranch,
  Lightbulb,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { RecommendedAction, RecommendedActionKind } from '../../utils/recommendedActions';
import { DashedToggle, GhostButton, PrimaryButton, SecondaryButton, SectionHeader } from './QueuePrimitives';

/** Per-kind icon + the token color its chip and glyph are tinted with. */
const KIND_ICON: Record<RecommendedActionKind, LucideIcon> = {
  'review-blocked': MessageSquare,
  'merge-clean': GitBranch,
  'rebase-behind': RefreshCw,
  'wrap-up-stale': Clock,
  'blocking-finding': AlertTriangle,
  'launch-sprint': Zap,
  'launch-planner': Lightbulb,
  'capture-first-idea': Plus,
  'run-launch-flow': Play,
};

/** Chip fill + glyph color per kind, mirroring the artboards' tinted squares. */
const KIND_TINT: Record<RecommendedActionKind, string> = {
  'review-blocked': 'bg-status-error/10 text-status-error',
  'merge-clean': 'bg-status-success/10 text-status-success',
  'rebase-behind': 'bg-status-warning/10 text-status-warning',
  'wrap-up-stale': 'bg-status-error/10 text-status-error',
  'blocking-finding': 'bg-status-error/10 text-status-error',
  'launch-sprint': 'bg-interactive/10 text-interactive',
  'launch-planner': 'bg-status-info/10 text-status-info',
  'capture-first-idea': 'bg-status-info/10 text-status-info',
  'run-launch-flow': 'bg-interactive/10 text-interactive',
};

/**
 * Which kinds carry the accent-filled CTA. The split follows the artboards:
 * a card that moves work FORWARD (answer, merge, launch, resolve) gets the
 * accent; a card that asks you to tidy up (rebase, wrap up) gets
 * the bordered secondary so the page never shows six competing accent buttons.
 */
const ACCENT_CTA_KINDS: ReadonlySet<RecommendedActionKind> = new Set<RecommendedActionKind>([
  'review-blocked',
  'merge-clean',
  'blocking-finding',
  'launch-sprint',
  'launch-planner',
  'capture-first-idea',
  'run-launch-flow',
]);

export interface RecommendedActionsSectionProps {
  visible: RecommendedAction[];
  hidden: RecommendedAction[];
  /** Contextual sentence beside the header, chosen by the page from its state. Omitted in `normal`. */
  subtitle?: string;
  /** Fire the card's CTA. The page owns every side effect. */
  onAct: (action: RecommendedAction) => void;
  /** Persist a dismissal and re-derive. Only called for `dismissible` cards. */
  onDismiss: (action: RecommendedAction) => void;
  /** Id of the card currently showing a launch spinner, or null. */
  busyActionId: string | null;
}

function ActionCard({
  action,
  onAct,
  onDismiss,
  busy,
}: {
  action: RecommendedAction;
  onAct: (action: RecommendedAction) => void;
  onDismiss: (action: RecommendedAction) => void;
  busy: boolean;
}): React.JSX.Element {
  const Icon = KIND_ICON[action.kind];
  const accentCta = ACCENT_CTA_KINDS.has(action.kind);
  const Cta = accentCta ? PrimaryButton : SecondaryButton;
  // The headline triage card gets a red edge — it is the one card on the page
  // that reports an agent actually halted on you.
  const border = action.kind === 'review-blocked' ? 'border-status-error' : 'border-border-primary';

  return (
    <div
      data-testid={`rq-action-card-${action.kind}`}
      className={`flex flex-col gap-[7px] border ${border} bg-surface-raised px-[13px] py-[11px]`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center ${KIND_TINT[action.kind]}`}
        >
          <Icon className="h-3 w-3" strokeWidth={2} />
        </span>
        <span className="text-[12px] font-bold leading-snug text-text-primary">{action.title}</span>
      </div>
      <p className="flex-1 text-[11px] leading-relaxed text-text-secondary">{action.description}</p>
      <div className="flex items-center gap-2">
        <Cta onClick={() => onAct(action)} disabled={busy}>
          {busy ? 'Launching…' : action.ctaLabel}
        </Cta>
        {action.dismissible && (
          <GhostButton className="ml-auto" onClick={() => onDismiss(action)}>
            Dismiss
          </GhostButton>
        )}
      </div>
    </div>
  );
}

/** RecommendedActionsSection — see {@link RecommendedActionsSectionProps}. */
export function RecommendedActionsSection({
  visible,
  hidden,
  subtitle,
  onAct,
  onDismiss,
  busyActionId,
}: RecommendedActionsSectionProps): React.JSX.Element | null {
  const [showAll, setShowAll] = React.useState(false);

  if (visible.length === 0) return null;
  const shown = showAll ? [...visible, ...hidden] : visible;

  return (
    <section data-testid="rq-recommended-section" className="flex flex-col gap-2.5">
      {/* The human-checkpoint amber has no Tailwind class — reference its token. */}
      <SectionHeader
        dotColor="var(--color-human)"
        title="Recommended actions"
        count={visible.length + hidden.length}
        subtitle={subtitle}
      />
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
        {shown.map((action) => (
          <ActionCard
            key={action.id}
            action={action}
            onAct={onAct}
            onDismiss={onDismiss}
            busy={busyActionId === action.id}
          />
        ))}
      </div>
      {hidden.length > 0 && (
        <DashedToggle onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer ▴' : `+${hidden.length} more ▾`}
        </DashedToggle>
      )}
    </section>
  );
}
