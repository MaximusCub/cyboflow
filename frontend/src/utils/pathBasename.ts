/**
 * Path helpers for renderer-side display logic.
 *
 * Paths reaching the renderer come from producers that do NOT agree on a
 * separator: main's fileOps returns `path.relative` output (backslashes on
 * Windows), git diff text is always forward-slash, and Claude Code tool inputs
 * carry native separators. Splitting on '/' alone therefore returns the whole
 * path (or '') on Windows — e.g. FileEditor's post-delete parent recompute
 * once reloaded the workspace root instead of the deleted file's folder.
 *
 * A backslash is a separator only on Windows. Everywhere else it is a legal
 * filename character, so treating it as a separator there truncates the name
 * a user sees. `windows` is a parameter, defaulting to the running platform,
 * so both dialects are testable from either host.
 *
 * These are DISPLAY helpers: they never normalize the surviving prefix's
 * separators, so a parent dir can be handed straight back to main.
 */
import { isWindowsPlatform } from './platform';

/** Trailing separators, in the dialect `windows` selects. */
function trailingSeparators(windows: boolean): RegExp {
  return windows ? /[/\\]+$/ : /\/+$/;
}

/** Index of the last separator in `p`, or -1. */
function lastSeparatorIndex(p: string, windows: boolean): number {
  return windows ? Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) : p.lastIndexOf('/');
}

/**
 * Last path segment of `p` — the basename.
 *
 * Trailing separators are stripped first, so `pathBasename('a/b/')` is 'b'.
 * Returns '' for an empty or all-separator input; a Windows drive root
 * ('C:\') reads as 'C:'.
 */
export function pathBasename(p: string, windows: boolean = isWindowsPlatform()): string {
  const trimmed = p.replace(trailingSeparators(windows), '');
  const idx = lastSeparatorIndex(trimmed, windows);
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Everything before the last path segment of `p` — the parent directory —
 * prefix separators preserved as-is.
 *
 * Trailing separators are stripped before the split, so `parentPath('a/b/')`
 * is 'a' (not 'a/b'). Returns '' for a root-level or empty path — the
 * workspace-root sentinel callers like FileEditor.loadFiles expect.
 */
export function parentPath(p: string, windows: boolean = isWindowsPlatform()): string {
  const trimmed = p.replace(trailingSeparators(windows), '');
  const idx = lastSeparatorIndex(trimmed, windows);
  return idx === -1 ? '' : trimmed.slice(0, idx);
}

/**
 * Everything up to AND INCLUDING the last separator — the directory prefix a
 * file label shows before the name. Unlike {@link parentPath} a trailing
 * separator is kept, because it is part of what the label displays.
 */
export function pathDirPrefix(p: string, windows: boolean = isWindowsPlatform()): string {
  const idx = lastSeparatorIndex(p, windows);
  return idx === -1 ? '' : p.slice(0, idx + 1);
}
