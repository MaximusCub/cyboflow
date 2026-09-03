/**
 * Platform sniff for the keyboard-shortcuts feature — decides whether 'mod'
 * (shared/types/keyboardShortcuts.ts) resolves to Cmd (mac) or Ctrl
 * (everywhere else), for both matching a live KeyboardEvent and formatting a
 * binding for display.
 */
import type { ShortcutPlatform } from '../../../shared/types/keyboardShortcuts';

/**
 * Detect the current platform for shortcut purposes. Sniffs
 * `navigator.platform` (still populated by Chromium/Electron despite being
 * formally deprecated) and falls back to `navigator.userAgent`; defaults to
 * `'other'` when neither is available (e.g. a non-browser test environment)
 * or neither string mentions "Mac".
 */
export function getShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'other';
  const platform = navigator.platform ?? '';
  const userAgent = navigator.userAgent ?? '';
  return /mac/i.test(platform) || /mac/i.test(userAgent) ? 'mac' : 'other';
}
