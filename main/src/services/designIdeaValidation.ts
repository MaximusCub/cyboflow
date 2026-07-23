/**
 * validateDesignIdeaLink — the idea-liveness gate for Design Mode session
 * creation (design-mode.md "Idea link — integrity contract", point (a)):
 * launching a design session must validate the target idea EXISTS, belongs to
 * the launching request's project, and is neither decomposed nor archived —
 * BEFORE any worktree/session/run is created.
 *
 * Extracted as a small pure/injectable helper (takes a raw `better-sqlite3`
 * handle, not the `databaseService` singleton) so it is unit-testable without
 * booting Electron — mirrors the read-only SELECT style already used for
 * liveness checks elsewhere (e.g. taskChangeRouter's archived_at/decomposed_at
 * reads). This function performs NO writes; the chokepoint rule
 * (TaskChangeRouter.applyChange owns all entity writes) governs writes only,
 * and this is a read.
 *
 * Distinct, human-readable reasons per failure so the IPC handler can surface
 * a clear error string without re-deriving it.
 */
import type Database from 'better-sqlite3';

export type DesignIdeaValidationFailureReason = 'not_found' | 'wrong_project' | 'decomposed' | 'archived';

export type DesignIdeaValidationResult =
  | { ok: true }
  | { ok: false; reason: DesignIdeaValidationFailureReason; error: string };

interface IdeaLivenessRow {
  project_id: number;
  decomposed_at: string | null;
  archived_at: string | null;
}

/**
 * Validate that `ideaId` is a live idea owned by `projectId`. Read-only —
 * callers are responsible for any subsequent write (e.g. stamping
 * sessions.design_idea_id).
 */
export function validateDesignIdeaLink(
  db: Database.Database,
  ideaId: string,
  projectId: number,
): DesignIdeaValidationResult {
  const row = db
    .prepare(`SELECT project_id, decomposed_at, archived_at FROM ideas WHERE id = ?`)
    .get(ideaId) as IdeaLivenessRow | undefined;

  if (!row) {
    return { ok: false, reason: 'not_found', error: `Idea ${ideaId} not found.` };
  }
  if (row.project_id !== projectId) {
    return {
      ok: false,
      reason: 'wrong_project',
      error: `Idea ${ideaId} belongs to a different project and cannot be linked to this design session.`,
    };
  }
  if (row.decomposed_at !== null) {
    return {
      ok: false,
      reason: 'decomposed',
      error: `Idea ${ideaId} has already been decomposed into tasks and can no longer be linked to a new design session.`,
    };
  }
  if (row.archived_at !== null) {
    return {
      ok: false,
      reason: 'archived',
      error: `Idea ${ideaId} is archived and can no longer be linked to a new design session.`,
    };
  }
  return { ok: true };
}
