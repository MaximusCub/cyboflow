/**
 * posixPath — the one idiom for "normalize a path to forward slashes so a
 * match/comparison is platform-blind".
 *
 * Windows paths carry backslashes; POSIX paths cannot contain them, so
 * replacing `\` with `/` is an identity operation on macOS/Linux and a
 * normalization on Windows. The windows-build stack grew one ad-hoc
 * `.replace(/\\/g, '/')` per match site (quick-session matchers, file-listing
 * filters, timer-census frame labels, reaper command-line matching, rung-1
 * path validation) — same idiom, five files, no shared name to grep for.
 * This module names it.
 *
 * Matching-only by convention: normalize a COPY for comparison (git output,
 * command lines, stack frames are already '/'-shaped on POSIX); report or
 * store the platform-native path untouched unless the consumer is itself a
 * matcher. NOT a general path normalizer — no `..` collapsing, no case
 * folding, no UNC handling.
 */

/**
 * Replace backslashes with forward slashes (identity on POSIX input).
 */
export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}
