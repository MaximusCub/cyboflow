/**
 * designSessionLaunch — the launch-a-design-session saga for the planner's
 * `approve-idea` DESIGN FORK (planner.md step 2 "The design fork": "Approve →
 * design mode"). QuestionRouter.respond() detects the fork answer and delegates
 * here; this module owns the CRASH-RECOVERABLE COMPENSATION SAGA itself, a
 * sibling of `agentThread/proposalExecutor.ts`'s launch-run saga — but triggered
 * by a HUMAN's gate answer rather than a confirmed agent proposal, so there is
 * no `agent_proposals` CAS row to claim/finalize: the saga runs once, inline,
 * as a respond() side effect.
 *
 * Design-session creation is a THREE-LAYER belt documented in
 * main/src/ipc/session.ts (~787-1091) / main/src/orchestrator/workflowRegistry.ts
 * (createRun's requireSdkSubstrate guard) / claudeCodeManager (re-reads
 * design_idea_id fresh every turn). This module does NOT re-implement any of
 * those layers — it drives them through the SAME injected primitives
 * proposalExecutor uses (createQuickSessionCore, the full session-dismiss path),
 * wired at the composition root (main/src/index.ts) exactly like
 * ProposalExecutorDeps.
 *
 * Standalone-typecheck invariant (mirrors questionRouter.ts / proposalExecutor.ts):
 * NO imports from 'electron', 'better-sqlite3', or main/src/services/*. Every
 * collaborator is a structural closure injected via {@link DesignSessionLaunchDeps}.
 */

/**
 * The canonical first-turn message for a design session, fired immediately
 * after its Chat panel is created (design-mode.md "v0.5 — fullscreen design
 * surface", "Auto-start + clarify-first").
 *
 * Re-exported from `shared/types/designKickoff.ts`, which both processes
 * import: main cannot reach into `frontend/src`, and a hand-kept second copy
 * would drift silently — nothing would fail, the renderer's launch door and
 * this server-initiated one would just quietly brief the design agent
 * differently.
 */
export { DESIGN_KICKOFF_PROMPT as DESIGN_MODE_KICKOFF_PROMPT } from '../../../shared/types/designKickoff';

// ---------------------------------------------------------------------------
// Collaborator deps (injected — standalone-typecheck invariant)
// ---------------------------------------------------------------------------

/** Result of re-validating the idea link at launch time (mirrors validateDesignIdeaLink). */
export interface DesignIdeaLinkValidation {
  ok: boolean;
  /** Human-readable reason, present when ok=false. */
  error?: string;
}

export interface DesignSessionLaunchDeps {
  /**
   * Re-validate the idea link RIGHT BEFORE creating anything — the idea can be
   * archived, decomposed, or deleted in the (potentially long) window between
   * the approve-idea gate opening and the human answering it; the validation
   * captured when the gate was FIRST asked is stale by the time it resolves.
   * Mirrors validateDesignIdeaLink's read-only contract (exists / same-project
   * / not-decomposed / not-archived) — wired at the composition root as a thin
   * wrapper over that exact function.
   */
  validateIdeaLink(ideaId: string, projectId: number): DesignIdeaLinkValidation;

  /**
   * Mint the SDK-pinned, Claude-provider design session + its `__quick__`
   * sentinel run (createQuickSessionCore with requireSdkSubstrate: true),
   * stamp `sessions.design_idea_id`, and create the session's ui-prototype
   * artifact stub — mirrors sessions:create-quick's design branch
   * (main/src/ipc/session.ts ~1009-1091), the only other place a design
   * session is minted. Throws on failure (session-create timeout, substrate
   * resolution mismatch, Claude/SDK unavailable) — the caller here does not
   * yet hold a sessionId in that case, so there is nothing to compensate
   * (mirrors the same accepted risk in ipc/session.ts's own defensive branch).
   */
  createDesignSession(args: {
    projectId: number;
    ideaId: string;
    nameHint: string;
  }): Promise<{ sessionId: string; runId: string; worktreePath: string }>;

  /**
   * Create the session's Chat panel and fire the canonical design kickoff
   * prompt as its first turn — mirrors useQuickSession.ts's post-create panel
   * + auto-start kickoff sequence (frontend/src/hooks/useQuickSession.ts /
   * frontend/src/components/cyboflow/design/designKickoff.ts), replayed
   * server-side since this launch has no renderer client driving it. A throw
   * here IS a post-session-creation failure — the caller compensates via
   * dismissSession.
   */
  kickoffDesignPanel(args: { sessionId: string; worktreePath: string }): Promise<void>;

  /**
   * Compensation: the FULL safe session-dismiss path (cancels hosted runs,
   * then removes the worktree) — the SAME primitive proposalExecutor's
   * launch-run saga uses (dismissSessionFully in main/src/index.ts).
   */
  dismissSession(sessionId: string): Promise<void>;

  /**
   * Surface an unrecoverable launch failure to the human. Unlike
   * QuestionRouter's OTHER post-answer methods (fail-soft best-effort reveals
   * of an already-successful gate answer, which silently no-op on failure),
   * every failure path through this saga calls reportLaunchFailure — a fork
   * that silently does nothing is worse than one that reports it could not
   * launch. Synchronous by contract (fire-and-forget internally if the
   * concrete write is async) so the saga never blocks on it.
   */
  reportLaunchFailure(args: { projectId: number; ideaId: string; runId: string; error: string }): void;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type DesignSessionLaunchResult =
  | { ok: true; sessionId: string; runId: string }
  | { ok: false; reason: 'invalid-idea-link' | 'launch-failed'; error: string };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// launchDesignSessionForFork — the saga itself
// ---------------------------------------------------------------------------

/**
 * Run the design-mode-fork launch saga for one idea:
 *   1. Re-validate the idea link (fail closed on a stale/dead idea — reported,
 *      no session created).
 *   2. createDesignSession — mints the session + sentinel run.
 *   3. kickoffDesignPanel — creates the Chat panel and fires the first turn.
 * Any failure at step 3 (after step 2 already minted a real sessionId) is
 * compensated via dismissSession before the failure is reported, so a launch
 * failure never leaves an orphaned half-created session behind. Never throws
 * — every failure path is reported through deps.reportLaunchFailure and
 * reflected in the returned result.
 */
export async function launchDesignSessionForFork(
  deps: DesignSessionLaunchDeps,
  args: { projectId: number; ideaId: string; runId: string; nameHint: string },
): Promise<DesignSessionLaunchResult> {
  const { projectId, ideaId, runId, nameHint } = args;

  const validation = deps.validateIdeaLink(ideaId, projectId);
  if (!validation.ok) {
    const error = validation.error ?? `idea ${ideaId} is no longer eligible for a design session`;
    deps.reportLaunchFailure({ projectId, ideaId, runId, error });
    return { ok: false, reason: 'invalid-idea-link', error };
  }

  // Track the one resource createDesignSession mints so a later boundary
  // failure (kickoffDesignPanel) can unwind it (proposalExecutor.runLaunch's
  // compensation-tracking shape).
  const created: { sessionId?: string } = {};
  try {
    const session = await deps.createDesignSession({ projectId, ideaId, nameHint });
    created.sessionId = session.sessionId;

    await deps.kickoffDesignPanel({ sessionId: session.sessionId, worktreePath: session.worktreePath });

    return { ok: true, sessionId: session.sessionId, runId: session.runId };
  } catch (err) {
    const error = errMsg(err);
    if (created.sessionId !== undefined) {
      try {
        await deps.dismissSession(created.sessionId);
      } catch {
        // Best-effort compensation — the launch is already being reported as
        // failed regardless; a compensation failure must not mask that report.
      }
    }
    deps.reportLaunchFailure({ projectId, ideaId, runId, error });
    return { ok: false, reason: 'launch-failed', error };
  }
}
