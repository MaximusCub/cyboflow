/**
 * OverviewRecommendedActions — section 2 of the Project Overview page: a 3-up
 * grid of "you should probably do this next" cards.
 *
 * TWO sources feed the same card component:
 *   - the DERIVED set from {@link deriveRecommendedActions} (normal /
 *     empty-ideas / empty-drained). Those three states have real data behind
 *     them, so the copy is computed rather than written here.
 *   - a HARDCODED set for the three states where there is nothing to compute
 *     (empty-new / empty-new-existing / empty-done): a brand-new project has no
 *     backlog, no run history, and no verification signal, so the design's
 *     "where to start" copy is the only honest thing to show.
 *
 * Dismissal is per-project and persisted under {@link OVERVIEW_DISMISSED_KEY}
 * as an `actionId → fingerprint` record; the derived path feeds it back into
 * `deriveRecommendedActions`, which suppresses a card only while its
 * fingerprint still matches — when the card's trigger state changes it
 * reappears. Every read/write is try/catch-guarded —
 * localStorage throws in private mode and a storage failure must never take the
 * page down.
 *
 * CTA wiring lives entirely in the props the page hands down (`onLaunchSprint`
 * scrolls to the Next-up list, `onLaunchPlanner` fires the light planner
 * launch, the rest are navigation) so this component stays presentational.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  Focus,
  GitBranch,
  Lightbulb,
  Play,
  Plus,
  RotateCcw,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { SectionHeader } from './overviewChrome';
import {
  OVERVIEW_DISMISSED_KEY,
  type DerivedRecommendedActions,
  type OverviewPageState,
  type RecommendedAction,
  type RecommendedActionAccent,
  type RecommendedActionCtaKind,
} from './overviewModel';

// ---------------------------------------------------------------------------
// Accent → icon + tinted icon-box color
// ---------------------------------------------------------------------------

/**
 * The accent hue for each card's 24px tinted icon box, as a CSS variable
 * reference. Inline style rather than a token class because the box is a
 * per-accent 12%-alpha tint of a phase/status hue, which has no utility class.
 */
const ACCENT_VAR: Record<RecommendedActionAccent, string> = {
  terracotta: '--color-interactive-primary',
  blue: '--color-phase-plan',
  purple: '--color-phase-compound',
  green: '--color-status-success',
  amber: '--color-phase-review',
};

const ACCENT_ICON: Record<RecommendedActionAccent, LucideIcon> = {
  terracotta: Zap,
  blue: Lightbulb,
  purple: RotateCcw,
  green: Focus,
  amber: GitBranch,
};

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/** One rendered card — a derived {@link RecommendedAction} plus its click handler. */
interface ActionCardModel {
  id: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaKind: RecommendedActionCtaKind;
  accent: RecommendedActionAccent;
  /** Overrides the accent's default icon (the hardcoded empty-state cards use their own). */
  icon?: LucideIcon;
  /** Trigger-state fingerprint (see {@link RecommendedAction.fingerprint}); `'static'` on the hardcoded empty-state cards. */
  fingerprint: string;
  onCta: () => void;
}

function ActionCard({
  action,
  onDismiss,
  dismissed = false,
  onRestore,
}: {
  action: ActionCardModel;
  onDismiss: (id: string, fingerprint: string) => void;
  /** Renders the muted "dismissed but still qualifying" variant: no CTA, a Restore link instead of Dismiss. */
  dismissed?: boolean;
  onRestore?: (id: string) => void;
}): React.JSX.Element {
  const Icon = action.icon ?? ACCENT_ICON[action.accent];
  const accent = `var(${ACCENT_VAR[action.accent]})`;
  if (dismissed) {
    return (
      <div
        data-testid={`overview-dismissed-action-${action.id}`}
        className="flex flex-col gap-2 border border-dashed border-border-primary bg-surface-primary px-4 py-3.5 opacity-70"
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex h-6 w-6 shrink-0 items-center justify-center"
            style={{ backgroundColor: `color-mix(in srgb, ${accent} 12%, transparent)` }}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2} style={{ color: accent }} />
          </span>
          <span className="font-bold text-text-primary" style={{ fontSize: '12.5px' }}>
            {action.title}
          </span>
        </div>
        <p className="flex-1 text-text-secondary" style={{ fontSize: '11.5px', lineHeight: 1.55 }}>
          {action.body}
        </p>
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => onRestore?.(action.id)}
            data-testid={`overview-action-restore-${action.id}`}
            className="font-semibold text-text-secondary hover:text-text-primary"
            style={{ fontSize: '10px' }}
          >
            Restore
          </button>
        </div>
      </div>
    );
  }
  return (
    <div
      data-testid={`overview-action-${action.id}`}
      className="flex flex-col gap-2 border border-border-primary bg-surface-primary px-4 py-3.5"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center"
          style={{ backgroundColor: `color-mix(in srgb, ${accent} 12%, transparent)` }}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={2} style={{ color: accent }} />
        </span>
        <span className="font-bold text-text-primary" style={{ fontSize: '12.5px' }}>
          {action.title}
        </span>
      </div>
      <p
        className="flex-1 text-text-secondary"
        style={{ fontSize: '11.5px', lineHeight: 1.55 }}
      >
        {action.body}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={action.onCta}
          data-testid={`overview-action-cta-${action.id}`}
          className={
            action.ctaKind === 'primary'
              ? 'border border-interactive-hover bg-interactive px-3 py-1 font-semibold text-text-on-interactive hover:bg-interactive-hover'
              : 'border border-border-primary bg-surface-primary px-3 py-1 font-semibold text-text-primary hover:bg-bg-hover'
          }
          style={{ fontSize: '11px' }}
        >
          {action.ctaLabel}
        </button>
        <button
          type="button"
          onClick={() => onDismiss(action.id, action.fingerprint)}
          data-testid={`overview-action-dismiss-${action.id}`}
          className="ml-auto text-text-muted hover:text-text-secondary"
          style={{ fontSize: '10px' }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Persisted dismissals
// ---------------------------------------------------------------------------

/**
 * Read the persisted dismissals for a project as an `actionId → fingerprint`
 * record; {} on any failure (including the pre-fingerprint array shape, which
 * simply resurfaces those cards once).
 */
export function readDismissed(projectId: number): Record<string, string> {
  try {
    const raw = localStorage.getItem(OVERVIEW_DISMISSED_KEY(projectId));
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** Persist the dismissals for a project. Swallows storage failures. */
function writeDismissed(projectId: number, dismissed: Record<string, string>): void {
  try {
    localStorage.setItem(OVERVIEW_DISMISSED_KEY(projectId), JSON.stringify(dismissed));
  } catch {
    // Private mode / quota — a failed persist must never crash the page.
  }
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

/** Muted descriptor beside the section title, per page state. */
const DESCRIPTOR: Record<OverviewPageState, string> = {
  normal: "Computed from this project's recent activity",
  'empty-new': 'Where to start on a fresh codebase',
  'empty-new-existing': 'Where to start in an existing codebase',
  'empty-ideas': "Computed from this project's recent activity",
  'empty-drained': "Computed from this project's recent activity",
  'empty-done': 'Close out this milestone, then start the next one',
};

/** The states whose cards are written here rather than derived from data. */
const HARDCODED_STATES: ReadonlySet<OverviewPageState> = new Set<OverviewPageState>([
  'empty-new',
  'empty-new-existing',
  'empty-done',
]);

export interface OverviewRecommendedActionsProps {
  projectId: number;
  pageState: OverviewPageState;
  /** The derived cards, partitioned into active vs dismissed-but-qualifying by the model. */
  actions: DerivedRecommendedActions;
  /** `actionId → fingerprint` dismissals, owned by the page so the derive call and this list agree. */
  dismissed: Record<string, string>;
  onDismissedChange: (dismissed: Record<string, string>) => void;
  /** launch-sprint CTA — opens the sprint batch picker modal. */
  onSelectTasks: () => void;
  /** launch-planner CTA — fires the light planner launch on the top idea. */
  onLaunchTopIdea: () => void;
  /** Opens the wizard preselected to a flow, locked to this project. */
  onRunFlow: (workflowName: 'compound' | 'verify-setup' | 'launch' | 'planner') => void;
  /** tracker-conflicts CTA — opens Settings on the integrations tab. */
  onReviewTrackerConflicts: () => void;
  /** "Add an idea" CTA — opens the backlog pane filtered to this project. */
  onAddIdea: () => void;
}

export function OverviewRecommendedActions({
  projectId,
  pageState,
  actions,
  dismissed,
  onDismissedChange,
  onSelectTasks,
  onLaunchTopIdea,
  onRunFlow,
  onReviewTrackerConflicts,
  onAddIdea,
}: OverviewRecommendedActionsProps): React.JSX.Element | null {
  // Hardcoded and derived cards ride the SAME persisted set, so "Dismiss"
  // behaves identically in every page state. The set is owned by the page (it
  // also feeds `deriveRecommendedActions`), so this only writes + lifts.
  const dismiss = useCallback(
    (id: string, fingerprint: string) => {
      const next = { ...dismissed, [id]: fingerprint };
      writeDismissed(projectId, next);
      onDismissedChange(next);
    },
    [dismissed, onDismissedChange, projectId],
  );

  const restore = useCallback(
    (id: string) => {
      const next = { ...dismissed };
      delete next[id];
      writeDismissed(projectId, next);
      onDismissedChange(next);
    },
    [dismissed, onDismissedChange, projectId],
  );

  /** Whether the "dismissed but still qualifying" cards are expanded. */
  const [showDismissed, setShowDismissed] = useState(false);

  const cards = useMemo<{ active: ActionCardModel[]; dismissedCards: ActionCardModel[] }>(() => {
    if (HARDCODED_STATES.has(pageState)) {
      const hardcoded: ActionCardModel[] =
        pageState === 'empty-new'
          ? [
              {
                id: 'run-launch',
                title: 'Run the Launch flow',
                body: 'An in-depth interview about the project produces a brief and a seeded idea backlog — the fastest way to a working pipeline.',
                ctaLabel: 'Run Launch',
                ctaKind: 'primary',
                accent: 'terracotta',
                icon: Play,
                fingerprint: 'static',
                onCta: () => onRunFlow('launch'),
              },
              {
                id: 'capture-idea',
                title: 'Capture your first idea',
                body: 'Already know what to build? Add it to the backlog by hand and take it straight into a planner.',
                ctaLabel: 'Add an idea',
                ctaKind: 'secondary',
                accent: 'blue',
                icon: Plus,
                fingerprint: 'static',
                onCta: onAddIdea,
              },
            ]
          : pageState === 'empty-new-existing'
            ? [
                {
                  id: 'launch-planner',
                  title: 'Launch a planner',
                  body: 'Start from what you want to change: the planner interviews you, drafts the first idea spec, and decomposes it into tasks.',
                  ctaLabel: 'Launch Planner',
                  ctaKind: 'primary',
                  accent: 'blue',
                  icon: Lightbulb,
                  fingerprint: 'static',
                  onCta: () => onRunFlow('planner'),
                },
                {
                  id: 'capture-idea',
                  title: 'Capture your first idea',
                  body: "Jot ideas into the backlog as they come — plan and prioritize them when you're ready.",
                  ctaLabel: 'Add an idea',
                  ctaKind: 'secondary',
                  accent: 'blue',
                  icon: Plus,
                  fingerprint: 'static',
                  onCta: onAddIdea,
                },
                {
                  id: 'verify-setup',
                  title: 'Set up visual verification',
                  body: "This codebase already has a UI — prove a runbook now so your first sprint's visual checks run instead of being skipped.",
                  ctaLabel: 'Run Verify Setup',
                  ctaKind: 'primary',
                  accent: 'green',
                  icon: Focus,
                  fingerprint: 'static',
                  onCta: () => onRunFlow('verify-setup'),
                },
              ]
            : [
                {
                  id: 'run-compound',
                  title: 'Run a Compound flow',
                  body: 'Everything captured has shipped and nothing has been compounded since the final sprint — bank the learnings while they are fresh.',
                  ctaLabel: 'Launch Compound',
                  ctaKind: 'primary',
                  accent: 'purple',
                  icon: RotateCcw,
                  fingerprint: 'static',
                  onCta: () => onRunFlow('compound'),
                },
                {
                  id: 'plan-next-milestone',
                  title: 'Plan the next milestone',
                  body: 'Re-run the Launch interview to shape what comes next into a fresh idea backlog.',
                  ctaLabel: 'Run Launch',
                  ctaKind: 'primary',
                  accent: 'terracotta',
                  icon: Play,
                  fingerprint: 'static',
                  onCta: () => onRunFlow('launch'),
                },
                {
                  id: 'capture-idea',
                  title: 'Capture a new idea',
                  body: 'Got something specific in mind? Add it directly to the backlog and plan it when you are ready.',
                  ctaLabel: 'Add an idea',
                  ctaKind: 'secondary',
                  accent: 'blue',
                  icon: Plus,
                  fingerprint: 'static',
                  onCta: onAddIdea,
                },
              ];
      return {
        active: hardcoded.filter((c) => dismissed[c.id] !== c.fingerprint),
        dismissedCards: hardcoded.filter((c) => dismissed[c.id] === c.fingerprint),
      };
    }

    // Derived path — the model already partitions active vs dismissed, so
    // only the CTA handler needs attaching here.
    const toCard = (a: RecommendedAction): ActionCardModel => ({
      id: a.id,
      title: a.title,
      body: a.body,
      ctaLabel: a.ctaLabel,
      ctaKind: a.ctaKind,
      accent: a.accent,
      fingerprint: a.fingerprint,
      onCta: () => {
        switch (a.id) {
          case 'launch-sprint':
            onSelectTasks();
            return;
          case 'launch-planner':
            onLaunchTopIdea();
            return;
          case 'run-compound':
            onRunFlow('compound');
            return;
          case 'verify-setup':
            onRunFlow('verify-setup');
            return;
          case 'tracker-conflicts':
            onReviewTrackerConflicts();
            return;
        }
      },
    });
    return { active: actions.active.map(toCard), dismissedCards: actions.dismissed.map(toCard) };
  }, [
    actions,
    dismissed,
    onAddIdea,
    onSelectTasks,
    onLaunchTopIdea,
    onReviewTrackerConflicts,
    onRunFlow,
    pageState,
  ]);

  if (cards.active.length === 0 && cards.dismissedCards.length === 0) return null;

  return (
    <section className="flex flex-col gap-2.5" data-testid="overview-recommended-actions">
      <SectionHeader
        dotColor="var(--human)"
        title="Recommended actions"
        count={cards.active.length}
        descriptor={DESCRIPTOR[pageState]}
      />
      {/* auto-fill keys the column count on the PANE's width (viewport
          breakpoints lie when side panels compress the center pane), and
          keeps partial rows at column width instead of stretching. */}
      {cards.active.length > 0 && (
        <div
          className="grid gap-2.5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}
        >
          {cards.active.map((card) => (
            <ActionCard key={card.id} action={card} onDismiss={dismiss} />
          ))}
          {/* The dismissed-cards toggle rides the grid as a card-sized ghost
              tile so it reads as part of the deck, not fine print under it. */}
          {cards.dismissedCards.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDismissed((v) => !v)}
              data-testid="overview-dismissed-toggle"
              className="flex min-h-[96px] flex-col items-center justify-center gap-1 border border-dashed border-border-primary text-text-muted hover:bg-bg-hover hover:text-text-secondary"
            >
              <span className="font-semibold" style={{ fontSize: '12px' }}>
                {showDismissed
                  ? 'Hide dismissed ▴'
                  : `View dismissed (${cards.dismissedCards.length}) ▾`}
              </span>
            </button>
          )}
        </div>
      )}
      {/* EVERY qualifying action dismissed: the toggle grows into a full-width
          well so the section explains its own emptiness. */}
      {cards.active.length === 0 && cards.dismissedCards.length > 0 && (
        <button
          type="button"
          onClick={() => setShowDismissed((v) => !v)}
          data-testid="overview-dismissed-toggle"
          className="flex flex-col items-center gap-1 border border-dashed border-border-primary px-4 py-6 text-center hover:bg-bg-hover"
        >
          <span className="font-semibold text-text-secondary" style={{ fontSize: '12.5px' }}>
            All pending actions dismissed
          </span>
          <span className="text-interactive" style={{ fontSize: '11px' }}>
            {showDismissed
              ? 'Hide dismissed actions ▴'
              : `View dismissed actions (${cards.dismissedCards.length}) ▾`}
          </span>
        </button>
      )}
      {showDismissed && cards.dismissedCards.length > 0 && (
        <div
          className="grid gap-2.5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}
        >
          {cards.dismissedCards.map((card) => (
            <ActionCard
              key={card.id}
              action={card}
              onDismiss={dismiss}
              dismissed
              onRestore={restore}
            />
          ))}
        </div>
      )}
    </section>
  );
}
