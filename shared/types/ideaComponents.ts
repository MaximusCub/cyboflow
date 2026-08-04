/**
 * The idea component ledger — shared wire types (migration 098,
 * `main/src/database/migrations/098_idea_component_ledger.sql`).
 *
 * Every idea tracks FIVE components (idea-spec, prototype, architecture,
 * epics, stories), each in one of THREE states (complete, incomplete,
 * skipped). WHY: today an idea half-planned in one planner run leaves no
 * record of what got done, so a second run redundantly repeats stages. Design
 * mode and the planner's own ui-prototype step are two unaware pathways to
 * the same prototype deliverable — this ledger is the shared record both
 * read. This file is the reference every other layer (the DB row shape in
 * `main/src/database/models.ts` IdeaComponentRow, the read-model overlay on
 * `BacklogTaskItem.components` in ./tasks.ts, the card chips, the artifact
 * renderer) reads — keep it the single source of truth for the vocabulary.
 *
 * THE TRUTH MODEL IS HYBRID, and this is the single most important design
 * decision:
 *   - A ledger ROW, when present for a (idea, component) pair, is
 *     authoritative. Full stop.
 *   - A component with NO ledger row falls back to DERIVATION from what
 *     already exists in the DB (body headings, approved_designs, child
 *     entities). This backfills legacy/hand-edited ideas so nothing shows a
 *     blank checklist, WITHOUT a risky data migration.
 *   - Therefore DERIVATION CAN ONLY EVER YIELD 'complete' OR 'incomplete'.
 *     'skipped' is unfalsifiable from absence, so it is ONLY ever set
 *     explicitly by a flow or a user — never derived. This is why
 *     {@link IdeaComponentSource} carries a THIRD value, 'derived', that
 *     never persists to the `idea_components` table (see migration 098's
 *     header comment) — it exists purely as a read-time marker for "no row".
 *
 * STALENESS ("reset means re-verify, NOT discard") is the other decision that
 * shapes this file. When an idea's body materially changes, dependent
 * components are RESET, but their prior work is retained — carried by the
 * separate `staleAt` timestamp field, NOT a fourth state:
 *   state='incomplete' AND staleAt === null     => "not started"
 *   state='incomplete' AND staleAt !== null      => "needs review" (prior work
 *                                                   exists; an agent
 *                                                   re-entering that step gets
 *                                                   the prior artifact plus
 *                                                   the diff, and may
 *                                                   legitimately re-stamp it
 *                                                   complete immediately)
 * Keeping this as a field rather than a state is deliberate: the three states
 * stay exactly three.
 *
 * Keep this file free of Node.js built-ins so it imports in any environment
 * (main process AND renderer).
 */

/** Stable, kebab-case ids for the five tracked components, in display order. */
export const IDEA_COMPONENT_KEYS = ['idea-spec', 'prototype', 'architecture', 'epics', 'stories'] as const;

/** One of the five tracked idea components. */
export type IdeaComponentKey = (typeof IDEA_COMPONENT_KEYS)[number];

/** The three ledger states — deliberately exactly three (see file header). */
export type IdeaComponentStateValue = 'complete' | 'incomplete' | 'skipped';

/**
 * Who/what last set a component's state. 'flow' and 'manual' persist to the
 * `idea_components` table; 'derived' NEVER persists — it is stamped only on
 * READ, for a (idea, component) pair with no ledger row (see file header).
 */
export type IdeaComponentSource = 'flow' | 'manual' | 'derived';

/**
 * One component's read-model state for a given idea — the shape returned
 * over the wire (camelCase), whether backed by an authoritative ledger row or
 * synthesized by derivation.
 */
export interface IdeaComponentState {
  component: IdeaComponentKey;
  state: IdeaComponentStateValue;
  /** 'derived' appears only on READ, for a component with no ledger row. */
  source: IdeaComponentSource;
  sourceRunId: string | null;
  sourceSessionId: string | null;
  /** The idea.version this component was built against, for staleness diffing. */
  builtAgainstVersion: number | null;
  /** Non-null => prior work exists but needs re-verification ("needs review"). */
  staleAt: string | null;
  staleReason: string | null;
  updatedAt: string | null;
}

/**
 * Human-facing label per component key. The ONE source both the backlog card
 * chips and the artifact renderer read, so the two surfaces can never drift
 * on wording.
 */
export const IDEA_COMPONENT_LABELS: Record<IdeaComponentKey, string> = {
  'idea-spec': 'Idea spec',
  prototype: 'Prototype',
  architecture: 'Architecture',
  epics: 'Epics',
  stories: 'Stories',
};

/**
 * Emitted by `main/src/orchestrator/ideaComponents/ideaComponentRouter.ts`
 * (the `idea_components` write chokepoint) AFTER a committed write, and
 * consumed by `cyboflow.ideaComponents.onComponentsChanged`. `states` is the
 * FULL merged hybrid snapshot for the idea (all five components, built via
 * `resolveIdeaComponents` post-commit) rather than a single-row delta, so a
 * subscriber never has to reconcile a partial update against derivation
 * itself — mirrors `ReviewItemChangedEvent` / `FeedbackChangedEvent` carrying
 * the full read-model item rather than a raw column diff.
 */
export interface IdeaComponentChangedEvent {
  projectId: number;
  ideaId: string;
  states: IdeaComponentState[];
}
