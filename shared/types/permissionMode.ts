/**
 * Single source of truth for the Cyboflow permissionMode contract.
 * See docs/CODE-PATTERNS.md § "permissionMode contract".
 * 'ignore' remains a typed escape hatch: each CLI manager's own
 * resolveSessionAgentPermissionMode (claudeCodeManager.ts,
 * interactiveClaudeManager.ts, and the Codex/OMP/pi PTY managers) reads it,
 * and interactiveSettingsWriter.ts's resolveInlineGatingHooks still omits the
 * wildcard PreToolUse gating hook for it on the interactive substrate — plus
 * test fixtures. NO user-facing UI surface may expose it as selectable; NO
 * default/fallback may resolve to it.
 */
export type PermissionMode = 'approve' | 'ignore';
// Satisfies PermissionMode — TypeScript infers the literal type 'approve'.
export const DEFAULT_PERMISSION_MODE = 'approve' satisfies PermissionMode;
