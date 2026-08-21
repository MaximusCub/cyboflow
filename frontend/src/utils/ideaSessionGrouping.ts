/**
 * Pure grouping logic for the sidebar idea-session nesting (idea sessions plan,
 * Stage 6). An idea's persistent home session (sessions.home_idea_id) and the
 * sessions its launches minted (sessions.origin_idea_id) otherwise render as
 * unrelated flat rail rows; this nests the launch-origin sessions beneath their
 * idea's home row.
 *
 * Kept OUT of DraggableProjectTreeView so the ~2100-line tree component stays
 * thin and this claim/detach logic is unit-testable in isolation — modeled
 * closely on railExperimentGrouping.ts (see ./__tests__/ideaSessionGrouping.test.ts).
 *
 * Grouping rules:
 *  - A group exists ONLY when a session with `homeIdeaId === ideaId` is present
 *    in the input list (the home). No home → no group, whatever origin-linked
 *    sessions exist for that idea.
 *  - children = sessions with `originIdeaId === ideaId`, excluding the home
 *    session itself (a session can be its own idea's home AND carry a matching
 *    originIdeaId when the idea's own launch minted it).
 *  - Claimed sessions (the home + its children) are removed from
 *    `ungroupedSessions`; everything else passes through untouched — including
 *    a session with an `originIdeaId` whose idea has no live home (stays flat;
 *    this is also how a home-archive detaches its children: the home is simply
 *    absent from the input list, so its origin-linked sessions fall through).
 *  - A home with zero children still forms a group (renders as a normal row
 *    with the idea treatment, no children beneath it).
 *
 * Composition with A/B experiment grouping (railExperimentGrouping.ts): callers
 * MUST run this AFTER `groupRailExperiments` claims arm sessions, passing its
 * `ungroupedSessions` output as this function's `sessions` input — an
 * idea-launched experiment arm is claimed there first so it never renders
 * twice (once as an arm row, once as an idea-group child).
 */
import type { Session } from '../types/session';

/** One idea-session group: the idea's home row + the sessions it launched. */
export interface IdeaSessionGroup {
  ideaId: string;
  homeSession: Session;
  /** Origin-linked sessions for this idea, excluding the home. Deterministically ordered. */
  children: Session[];
}

/** Output of {@link groupIdeaSessions}: the group blocks + the leftover flat sessions. */
export interface IdeaSessionGroupingResult {
  groups: IdeaSessionGroup[];
  ungroupedSessions: Session[];
}

/**
 * Deterministic session ordering: displayOrder (undefined sorts last), then id
 * as a stable tiebreaker — mirrors the flat-list sort in
 * DraggableProjectTreeView's project session render (same rationale: a
 * grouped session's stale/absent displayOrder must not produce unstable order
 * across renders/reloads).
 */
function compareSessions(a: Session, b: Session): number {
  const aOrder = a.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const bOrder = b.displayOrder ?? Number.MAX_SAFE_INTEGER;
  return aOrder - bOrder || a.id.localeCompare(b.id);
}

/**
 * Collapse each idea's home + origin-linked sessions into one group and
 * return the sessions left over (untouched, non-idea-linked or unclaimed).
 *
 * @param sessions  The sessions to group — pass the A/B experiment grouping's
 *                  `ungroupedSessions` output (see the composition note above),
 *                  or the project's plain visible session list when no
 *                  experiment grouping applies.
 */
export function groupIdeaSessions(sessions: Session[]): IdeaSessionGroupingResult {
  // Resolve one home session per idea id. At most one live session per idea
  // should ever hold homeIdeaId (openIdeaSessionCore's find-or-create door),
  // but a deterministic winner is picked defensively rather than trusting
  // input-array order.
  const homesByIdea = new Map<string, Session>();
  for (const session of sessions) {
    const ideaId = session.homeIdeaId;
    if (!ideaId) continue;
    const existing = homesByIdea.get(ideaId);
    if (!existing || compareSessions(session, existing) < 0) {
      homesByIdea.set(ideaId, session);
    }
  }

  const claimed = new Set<string>();
  const groups: IdeaSessionGroup[] = [];

  for (const [ideaId, homeSession] of homesByIdea) {
    const children = sessions
      .filter((s) => s.originIdeaId === ideaId && s.id !== homeSession.id)
      .sort(compareSessions);
    groups.push({ ideaId, homeSession, children });
    claimed.add(homeSession.id);
    for (const child of children) claimed.add(child.id);
  }

  groups.sort((a, b) => compareSessions(a.homeSession, b.homeSession));

  const ungroupedSessions = sessions.filter((s) => !claimed.has(s.id));

  return { groups, ungroupedSessions };
}
