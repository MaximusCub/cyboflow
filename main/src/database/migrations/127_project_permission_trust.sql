-- Migration 126: per-project trust for repo-supplied permission ALLOW rules.
--
-- WHY. main/src/orchestrator/permissionRules.ts honors `permissions.allow`
-- rules from the USER settings file only; the worktree's `.claude/settings*`
-- files (repo-controlled, arriving via clone/checkout) contribute deny/ask
-- SUPPRESSORS only, because a hostile repo shipping `"allow": ["Bash"]` must
-- not be able to grant itself auto-approval. Before this migration the only
-- way to lift that was the global env var CYBOFLOW_TRUST_PROJECT_PERMISSION_RULES=1,
-- which trusts every project at once. This column lets the user trust one
-- project's repo-supplied allow rules without opening the hole everywhere.
--
-- NULL = undecided (the trust prompt has not been shown yet) — the safe
-- default, identical to today's project-files-are-suppressors-only behaviour.
-- 'trusted' / 'untrusted' are terminal: once set, the prompt in
-- projects:activate / projects:create never asks again for that project, and
-- dismissing the prompt (Escape/close) stamps 'untrusted' — the safe answer
-- (see main/src/ipc/project.ts; reversible in the project settings UI).
ALTER TABLE projects
  ADD COLUMN permission_trust TEXT
  CHECK (permission_trust IS NULL OR permission_trust IN ('trusted', 'untrusted'));
