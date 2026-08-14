/**
 * Git-derived file/line stats for a session — what `sessions:get-statistics`
 * reports as `files.*` (the quick-session card's "files seen" + "+N −M" meter
 * and SessionStats' Files Modified / Lines Added / Lines Deleted).
 *
 * These used to be summed from the `execution_diffs` table, which is written
 * ONLY by ExecutionTracker.endExecution — i.e. when the agent PROCESS EXITS.
 * A warm-SDK or PTY quick session keeps one process alive across every turn,
 * so such a session accumulates ZERO rows however much it edits, and the card
 * read "0 files seen, +0 −0" while the Diff tab beside it listed hundreds of
 * changed files. Sessions that DID get rows were no better: each row is a diff
 * against that turn's HEAD, so a session that commits its work reports 0 too.
 *
 * The honest source is the same one the Diff tab uses: the worktree compared
 * against the commit the session branched from (`base_commit`), which counts
 * committed AND uncommitted AND untracked work, and — unlike a comparison
 * against live main — survives the session's commits being merged into main
 * (see getSessionCommitHistory in ipc/git.ts for the same rationale).
 */
import type { GitDiffManager } from '../services/gitDiffManager';
import type { Logger } from '../utils/logger';
import { runGitAsync } from '../utils/runGit';

/** The `files` block of the sessions:get-statistics payload, minus executionCount. */
export interface SessionFileStats {
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  filesModified: string[];
}

/** The slice of GitDiffManager this module needs (keeps the tests honest). */
type DiffStatsSource = Pick<GitDiffManager, 'getDiffStatsAgainstRef'>;

/**
 * Resolve the ref a session's work should be diffed against: its recorded
 * branch point when that commit still exists, else the project's main branch.
 * Returns null when neither resolves (worktree gone, `base_commit` gc'd and no
 * main branch) — the caller then has no git-derived answer to report.
 */
export async function resolveSessionDiffBaseRef(
  worktreePath: string,
  candidates: Array<string | null | undefined>,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      // `^{commit}` forces a commit-ish resolution, so a branch name, a tag and
      // a raw sha all validate the same way; --quiet keeps git silent on miss.
      await runGitAsync(worktreePath, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Unresolvable in this worktree — try the next candidate.
    }
  }
  return null;
}

/**
 * Compute a session's file stats from git, or return null when git cannot
 * answer (no worktree, archived session whose worktree was removed, no
 * resolvable base ref, git failure). A null return means "no git-derived
 * answer" — never a zeroed one, so the caller can fall back rather than
 * publish a confident 0.
 */
export async function computeSessionFileStats(params: {
  worktreePath: string | null | undefined;
  baseCommit?: string | null;
  /**
   * Lazy on purpose: resolving the project's main branch costs its own git
   * child process, and this whole function runs on the stats poll. A session
   * whose `base_commit` still resolves — nearly all of them — never pays it.
   */
  resolveMainBranch?: () => Promise<string | null | undefined>;
  gitDiffManager: DiffStatsSource;
  logger?: Logger;
}): Promise<SessionFileStats | null> {
  const { worktreePath, baseCommit, resolveMainBranch, gitDiffManager, logger } = params;
  if (!worktreePath) return null;

  try {
    const baseRef =
      (await resolveSessionDiffBaseRef(worktreePath, [baseCommit])) ??
      (resolveMainBranch
        ? await resolveSessionDiffBaseRef(worktreePath, [await resolveMainBranch()])
        : null);
    if (!baseRef) {
      logger?.verbose(`[SessionFileStats] No resolvable base ref in ${worktreePath}`);
      return null;
    }

    const { stats, changedFiles } = await gitDiffManager.getDiffStatsAgainstRef(worktreePath, baseRef);
    return {
      totalFilesChanged: stats.filesChanged,
      totalLinesAdded: stats.additions,
      totalLinesDeleted: stats.deletions,
      filesModified: changedFiles,
    };
  } catch (error) {
    logger?.warn(
      `[SessionFileStats] Could not compute git file stats in ${worktreePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
