/**
 * Narrow structural contract for the `workspaceFiles` tRPC router's business
 * logic — the second slice of the IPC→tRPC migration (docs/CODE-PATTERNS.md),
 * following the same seam as `configOps.ts` (the PILOT slice): the router
 * (routers/workspaceFiles.ts) does zod input validation and delegates to this
 * interface; the concrete implementation (main/src/ipc/fileOps.ts) wraps
 * SessionManager/DatabaseService/GitStatusManager/ConfigManager and may freely
 * import from main/src/services/*. Declaring the interface here — rather than
 * importing the concrete factory — keeps the tRPC subtree's standalone-typecheck
 * invariant intact (no 'electron' or 'main/src/services/**' imports; only
 * main/src/types/* and shared/types/* are allowed).
 *
 * Every method returns the EXACT envelope shape the legacy `file:*`/`git:*`
 * ipcMain.handle channels (main/src/ipc/file.ts, now deleted) returned, so
 * frontend call sites keep their existing shape — including the
 * inconsistent-on-purpose ones (`read` returns `{ content }` not `{ data }`;
 * `search`'s failure envelope carries `files: []`; `readProject` returns
 * `data: string | null`; `gitExecuteProject` returns `{ output }`).
 *
 * `file:getPath` was NOT migrated (zero preload/frontend callers) — see
 * main/src/ipc/fileOps.ts for the containment helper it used, which other
 * methods still need and which therefore stays.
 */

/** One entry of a `list`/`search` result. Mirrors the legacy `FileItem` shape. */
export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  modified?: Date;
}

export type FileErrorResult = { success: false; error: string };

export interface WorkspaceFileOpsLike {
  /** Mirrors legacy `file:read`. Reads a file from a session's git worktree. */
  read(request: {
    sessionId: string;
    filePath: string;
  }): Promise<{ success: true; content: string } | FileErrorResult>;

  /** Mirrors legacy `file:write`. Writes a file to a session's git worktree. */
  write(request: {
    sessionId: string;
    filePath: string;
    content: string;
  }): Promise<{ success: true } | FileErrorResult>;

  /** Mirrors legacy `file:list`. Lists one directory level of a session's worktree. */
  list(request: {
    sessionId: string;
    path?: string;
  }): Promise<{ success: true; files: FileItem[] } | FileErrorResult>;

  /** Mirrors legacy `file:delete`. Deletes a file or directory from a session's worktree. */
  delete(request: {
    sessionId: string;
    filePath: string;
  }): Promise<{ success: true } | FileErrorResult>;

  /**
   * Mirrors legacy `file:search`. Search is scoped to EITHER a session's
   * worktree or a project's path — the router validates at least one is
   * present, but this method still guards it (mirrors the legacy handler's own
   * "Either sessionId or projectId must be provided" throw). The failure
   * envelope carries `files: []` (not omitted) — call sites destructure
   * `result.files` unconditionally.
   */
  search(request: {
    sessionId?: string;
    projectId?: number;
    pattern: string;
    limit?: number;
  }): Promise<
    { success: true; files: FileItem[] } | (FileErrorResult & { files: [] })
  >;

  /**
   * Mirrors legacy `file:readAtRevision`. Reads a file's content at a git
   * revision (defaults to HEAD). A file absent at that revision is reported as
   * `{ success: true, content: '' }` — NOT a failure — distinct from a genuine
   * git error (bad revision), which is `success: false`.
   */
  readAtRevision(request: {
    sessionId: string;
    filePath: string;
    revision?: string;
  }): Promise<{ success: true; content: string } | FileErrorResult>;

  /**
   * Mirrors legacy `file:read-project`. Reads a file from a PROJECT's
   * directory (not a session worktree). A missing file is `{ success: true,
   * data: null }`, not a failure.
   */
  readProject(request: {
    projectId: number;
    filePath: string;
  }): Promise<{ success: true; data: string | null } | FileErrorResult>;

  /** Mirrors legacy `file:write-project`. Writes a file to a PROJECT's directory. */
  writeProject(request: {
    projectId: number;
    filePath: string;
    content: string;
  }): Promise<{ success: true } | FileErrorResult>;

  /** Mirrors legacy `git:commit`. Stages all changes and commits in a session's worktree. */
  gitCommit(request: {
    sessionId: string;
    message: string;
  }): Promise<{ success: true } | FileErrorResult>;

  /** Mirrors legacy `git:revert`. Creates a revert commit for one commit hash. */
  gitRevert(request: {
    sessionId: string;
    commitHash: string;
  }): Promise<{ success: true } | FileErrorResult>;

  /** Mirrors legacy `git:restore`. `reset --hard HEAD` + `clean -fd` in a session's worktree. */
  gitRestore(request: { sessionId: string }): Promise<{ success: true } | FileErrorResult>;

  /**
   * Mirrors legacy `git:execute-project`. Runs an allowlisted git subcommand
   * (see PROJECT_GIT_SUBCOMMANDS in fileOps.ts — the SECURITY BOUNDARY) in a
   * PROJECT's directory. The router only asserts input shape; the allowlist
   * enforcement itself lives in the ops implementation.
   */
  gitExecuteProject(request: {
    projectId: number;
    args: string[];
  }): Promise<{ success: true; output: string } | FileErrorResult>;
}
