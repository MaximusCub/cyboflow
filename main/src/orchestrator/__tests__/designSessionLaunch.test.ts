/**
 * Unit tests for launchDesignSessionForFork (designSessionLaunch.ts) — the
 * design-mode-fork launch saga QuestionRouter.respond() delegates to when a
 * human answers the planner's `approve-idea` gate with "Approve → design
 * mode". Pure fake-deps tests, no DB / Electron involved — mirrors
 * proposalExecutor.test.ts's idiom for its launch-run saga.
 *
 * Covers:
 *  - a successful launch creates the design-linked session (createDesignSession
 *    + kickoffDesignPanel both called, in order; no compensation, no failure
 *    report).
 *  - a stale/invalid idea link is rejected cleanly (validateIdeaLink fails):
 *    createDesignSession is NEVER called, the failure is reported, no session
 *    is created.
 *  - a failure AFTER the session is minted (kickoffDesignPanel throws)
 *    compensates via dismissSession rather than orphaning the session, and
 *    still reports the failure.
 *  - a failure BEFORE any session is minted (createDesignSession itself
 *    throws) reports the failure WITHOUT calling dismissSession (there is no
 *    session id to compensate) — mirrors the accepted risk documented in
 *    ipc/session.ts's own defensive branch.
 */
import { describe, it, expect, vi } from 'vitest';
import { launchDesignSessionForFork, type DesignSessionLaunchDeps } from '../designSessionLaunch';

function makeDeps(overrides: Partial<DesignSessionLaunchDeps> = {}): {
  deps: DesignSessionLaunchDeps;
  validateIdeaLink: ReturnType<typeof vi.fn>;
  createDesignSession: ReturnType<typeof vi.fn>;
  kickoffDesignPanel: ReturnType<typeof vi.fn>;
  dismissSession: ReturnType<typeof vi.fn>;
  reportLaunchFailure: ReturnType<typeof vi.fn>;
} {
  // Build each collaborator as override-if-given, else a default mock — NOT a
  // spread-after-defaults merge, which would leave the returned handle pointing
  // at the (unused) default mock instead of the override actually wired into
  // `deps`.
  const validateIdeaLink = overrides.validateIdeaLink ?? vi.fn().mockReturnValue({ ok: true });
  const createDesignSession =
    overrides.createDesignSession ??
    vi.fn().mockResolvedValue({ sessionId: 'sess-1', runId: 'run-design-1', worktreePath: '/tmp/wt-1' });
  const kickoffDesignPanel = overrides.kickoffDesignPanel ?? vi.fn().mockResolvedValue(undefined);
  const dismissSession = overrides.dismissSession ?? vi.fn().mockResolvedValue(undefined);
  const reportLaunchFailure = overrides.reportLaunchFailure ?? vi.fn();

  const deps: DesignSessionLaunchDeps = {
    validateIdeaLink,
    createDesignSession,
    kickoffDesignPanel,
    dismissSession,
    reportLaunchFailure,
  };
  return {
    deps,
    validateIdeaLink: validateIdeaLink as ReturnType<typeof vi.fn>,
    createDesignSession: createDesignSession as ReturnType<typeof vi.fn>,
    kickoffDesignPanel: kickoffDesignPanel as ReturnType<typeof vi.fn>,
    dismissSession: dismissSession as ReturnType<typeof vi.fn>,
    reportLaunchFailure: reportLaunchFailure as ReturnType<typeof vi.fn>,
  };
}

const ARGS = { projectId: 1, ideaId: 'idea-42', runId: 'run-planner-1', nameHint: 'design-idea-42-run-planner-1' };

describe('launchDesignSessionForFork', () => {
  it('a successful launch creates the design-linked session (validate → create → kickoff, no compensation, no failure report)', async () => {
    const { deps, validateIdeaLink, createDesignSession, kickoffDesignPanel, dismissSession, reportLaunchFailure } =
      makeDeps();

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: true, sessionId: 'sess-1', runId: 'run-design-1' });
    expect(validateIdeaLink).toHaveBeenCalledWith('idea-42', 1);
    expect(createDesignSession).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      nameHint: 'design-idea-42-run-planner-1',
    });
    expect(kickoffDesignPanel).toHaveBeenCalledWith({ sessionId: 'sess-1', worktreePath: '/tmp/wt-1' });
    expect(dismissSession).not.toHaveBeenCalled();
    expect(reportLaunchFailure).not.toHaveBeenCalled();
  });

  it('a stale/invalid idea link is rejected cleanly — createDesignSession is never called, no session is created', async () => {
    const { deps, createDesignSession, kickoffDesignPanel, dismissSession, reportLaunchFailure } = makeDeps({
      validateIdeaLink: vi.fn().mockReturnValue({ ok: false, error: 'Idea idea-42 is archived.' }),
    });

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'invalid-idea-link', error: 'Idea idea-42 is archived.' });
    expect(createDesignSession).not.toHaveBeenCalled();
    expect(kickoffDesignPanel).not.toHaveBeenCalled();
    expect(dismissSession).not.toHaveBeenCalled();
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'Idea idea-42 is archived.',
    });
  });

  it('a failure AFTER the session is minted (kickoffDesignPanel throws) compensates via dismissSession rather than orphaning it', async () => {
    const { deps, createDesignSession, kickoffDesignPanel, dismissSession, reportLaunchFailure } = makeDeps({
      kickoffDesignPanel: vi.fn().mockRejectedValue(new Error('panel creation failed')),
    });

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'launch-failed', error: 'panel creation failed' });
    expect(createDesignSession).toHaveBeenCalledOnce();
    expect(kickoffDesignPanel).toHaveBeenCalledOnce();
    // Compensated with the sessionId createDesignSession actually minted — no orphan.
    expect(dismissSession).toHaveBeenCalledWith('sess-1');
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'panel creation failed',
    });
  });

  it('a failure BEFORE any session is minted (createDesignSession throws) reports the failure WITHOUT calling dismissSession', async () => {
    const { deps, kickoffDesignPanel, dismissSession, reportLaunchFailure } = makeDeps({
      createDesignSession: vi.fn().mockRejectedValue(new Error('session-create timed out')),
    });

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'launch-failed', error: 'session-create timed out' });
    expect(kickoffDesignPanel).not.toHaveBeenCalled();
    // No sessionId was ever minted — nothing to compensate.
    expect(dismissSession).not.toHaveBeenCalled();
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'session-create timed out',
    });
  });

  it('a dismissSession compensation failure does not mask the original failure report', async () => {
    const { deps, dismissSession, reportLaunchFailure } = makeDeps({
      kickoffDesignPanel: vi.fn().mockRejectedValue(new Error('panel creation failed')),
      dismissSession: vi.fn().mockRejectedValue(new Error('dismiss also failed')),
    });

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'launch-failed', error: 'panel creation failed' });
    expect(dismissSession).toHaveBeenCalledWith('sess-1');
    // The reported error is the ORIGINAL launch failure, not the compensation failure.
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'panel creation failed',
    });
  });
});
