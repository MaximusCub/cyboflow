export interface Project {
  id: number;
  name: string;
  path: string;
  system_prompt?: string | null;
  run_script?: string | null;
  build_script?: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  open_ide_command?: string | null;
  displayOrder?: number;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  /**
   * Per-project trust for repo-supplied permission ALLOW rules (migration 127).
   * NULL/undefined = undecided (the trust prompt has not been answered yet);
   * 'trusted' | 'untrusted' are terminal.
   */
  permission_trust?: 'trusted' | 'untrusted' | null;
  /**
   * Computed by `projects:get-all` (not stored): true when the project's repo
   * has enough commit history to count as an established codebase rather than
   * a fresh project. Absent on responses from other project endpoints.
   */
  established_repo?: boolean;
}

export interface ProjectRunCommand {
  id: number;
  project_id: number;
  command: string;
  display_name?: string;
  order_index: number;
  created_at: string;
}

export interface CreateProjectRequest {
  name: string;
  path: string;
  systemPrompt?: string;
  runScript?: string;
  buildScript?: string;
  openIdeCommand?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  path?: string;
  system_prompt?: string | null;
  run_script?: string | null;
  build_script?: string | null;
  active?: boolean;
  open_ide_command?: string | null;
  worktree_folder?: string | null;
  lastUsedModel?: string;
  permission_trust?: 'trusted' | 'untrusted' | null;
}