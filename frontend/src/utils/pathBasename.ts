/**
 * Separator-agnostic path helpers for renderer-side display logic.
 *
 * Paths reaching the renderer come from producers that do NOT agree on a
 * separator: main's fileOps returns `path.relative` output (backslashes on
 * Windows), git diff text is always forward-slash, and Claude Code tool inputs
 * carry native separators. Splitting on '/' alone therefore returns the whole
 * path (or '') on Windows — e.g. FileEditor's post-delete parent recompute
 * once reloaded the workspace root instead of the deleted file's folder.
 *
 * These helpers are DISPLAY helpers: they accept both separators (the inline
 * pattern useSessionMetrics / WorkflowCanvas already used) but never normalize
 * the surviving prefix's separators, so a parent dir can be handed straight
 * back to main.
 */

/**
 * Last path segment of `p` — the basename — regardless of separator.
 *
 * Trailing separators are stripped first, so `pathBasename('a/b/')` is 'b'.
 * Returns '' for an empty or all-separator input; a Windows drive root
 * ('C:\') reads as 'C:'.
 */
export function pathBasename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Everything before the last path segment of `p` — the parent directory —
 * regardless of separator, prefix separators preserved as-is.
 *
 * Trailing separators are stripped before the split, so `parentPath('a/b/')`
 * is 'a' (not 'a/b'). Returns '' for a root-level or empty path — the
 * workspace-root sentinel callers like FileEditor.loadFiles expect.
 */
export function parentPath(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? '' : trimmed.slice(0, idx);
}
