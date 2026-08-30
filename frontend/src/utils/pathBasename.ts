/**
 * Separator-agnostic path helpers for renderer-side display logic.
 *
 * Paths reaching the renderer come from producers that do NOT agree on a
 * separator: main's fileOps returns `path.relative` output (native separators
 * — backslashes on Windows), git diff text is always forward-slash, and Claude
 * Code tool inputs carry absolute paths with native separators. Splitting on
 * '/' alone therefore returns the whole path (or '') on Windows — e.g.
 * FileEditor's post-delete parent recompute yielded '' and reloaded the
 * workspace root instead of the deleted file's folder.
 *
 * These helpers accept both separators, mirroring the inline pattern already
 * used in useSessionMetrics and WorkflowCanvas. They are DISPLAY helpers:
 * they never normalize the surviving prefix's separators, so a parent dir can
 * be handed straight back to main.
 */

/**
 * Last path segment of `p` — the basename — regardless of separator.
 *
 * Trailing separators are stripped first, so `pathBasename('a/b/')` is 'b'
 * (a directory path yields its own name, not ''). Returns '' for an empty or
 * all-separator input. A Windows drive root ('C:\') reads as 'C:'.
 */
export function pathBasename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Everything before the last path segment of `p` — the parent directory —
 * regardless of separator. The prefix's own separators are preserved as-is.
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
