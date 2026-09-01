/**
 * shared/types/keyboardShortcuts.ts — the parser/matcher/formatter/resolver
 * helpers backing the six global shortcut actions. Pinned here:
 *   - parseKeybinding's strict validation (empty key, unknown modifier
 *     tokens, modifier-only strings, duplicate tokens all rejected);
 *   - isValidKeybinding narrows `unknown` correctly;
 *   - isBindableKeybinding additionally REQUIRES the 'mod' token, so a
 *     modifier-less / shift-only / alt-only binding can never be stored or
 *     resolved (it would make that character untypeable app-wide);
 *   - eventMatchesBinding's mod-exclusivity (Cmd+T must not match Ctrl+T on
 *     mac, and vice versa on 'other'), shift/alt exactness, case-insensitive
 *     key compare;
 *   - formatKeybinding's mac glyph form vs. the '+'-joined 'other' form,
 *     including the apostrophe key;
 *   - resolveShortcut / resolveAllShortcuts falling back to the built-in
 *     default for an absent or invalid override.
 */
import { describe, it, expect } from 'vitest';
import {
  KEYBOARD_SHORTCUT_DEFAULTS,
  SHORTCUT_ACTIONS,
  isShortcutAction,
  parseKeybinding,
  isValidKeybinding,
  isBindableKeybinding,
  eventMatchesBinding,
  formatKeybinding,
  resolveShortcut,
  resolveAllShortcuts,
  type ShortcutMatchEvent,
} from '../keyboardShortcuts';

/** A "nothing pressed" baseline event — tests override only what they need. */
function baseEvent(overrides: Partial<ShortcutMatchEvent> = {}): ShortcutMatchEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe('KEYBOARD_SHORTCUT_DEFAULTS / SHORTCUT_ACTIONS', () => {
  it('declares exactly the six spec\'d actions with their spec\'d default bindings', () => {
    expect(KEYBOARD_SHORTCUT_DEFAULTS).toEqual({
      newSession: 'mod+n',
      toggleLeftRail: 'mod+[',
      toggleRightRail: 'mod+]',
      toggleChat: "mod+'",
      toggleReviewQueue: 'mod+r',
      toggleBacklog: 'mod+l',
    });
    expect(SHORTCUT_ACTIONS).toHaveLength(6);
    expect(new Set(SHORTCUT_ACTIONS)).toEqual(new Set(Object.keys(KEYBOARD_SHORTCUT_DEFAULTS)));
  });

  it('every default binding is itself a valid keybinding', () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(isValidKeybinding(KEYBOARD_SHORTCUT_DEFAULTS[action])).toBe(true);
    }
  });

  it('isShortcutAction narrows only real actions', () => {
    expect(isShortcutAction('newSession')).toBe(true);
    expect(isShortcutAction('toggleBacklog')).toBe(true);
    expect(isShortcutAction('bogusAction')).toBe(false);
    expect(isShortcutAction(42)).toBe(false);
    expect(isShortcutAction(undefined)).toBe(false);
  });
});

describe('parseKeybinding', () => {
  it('parses a plain mod binding', () => {
    expect(parseKeybinding('mod+n')).toEqual({ mod: true, shift: false, alt: false, key: 'n' });
  });

  it('parses every modifier combined, in any input order', () => {
    expect(parseKeybinding('mod+shift+alt+r')).toEqual({
      mod: true,
      shift: true,
      alt: true,
      key: 'r',
    });
    expect(parseKeybinding('alt+shift+mod+r')).toEqual({
      mod: true,
      shift: true,
      alt: true,
      key: 'r',
    });
  });

  it('parses a punctuation key (the quote binding)', () => {
    expect(parseKeybinding("mod+'")).toEqual({ mod: true, shift: false, alt: false, key: "'" });
  });

  it('parses bracket keys', () => {
    expect(parseKeybinding('mod+[')).toEqual({ mod: true, shift: false, alt: false, key: '[' });
    expect(parseKeybinding('mod+]')).toEqual({ mod: true, shift: false, alt: false, key: ']' });
  });

  it('allows a modifier-free binding (a bare key)', () => {
    expect(parseKeybinding('n')).toEqual({ mod: false, shift: false, alt: false, key: 'n' });
  });

  it('rejects an empty string', () => {
    expect(parseKeybinding('')).toBeNull();
  });

  it('rejects an empty key (trailing +)', () => {
    expect(parseKeybinding('mod+')).toBeNull();
  });

  it('rejects an empty token (leading / doubled +)', () => {
    expect(parseKeybinding('+n')).toBeNull();
    expect(parseKeybinding('mod++n')).toBeNull();
  });

  it('rejects an unknown modifier token', () => {
    expect(parseKeybinding('cmd+n')).toBeNull();
    expect(parseKeybinding('ctrl+n')).toBeNull();
    expect(parseKeybinding('mod+meta+n')).toBeNull();
  });

  it('rejects a modifier-only string (no actual key follows)', () => {
    expect(parseKeybinding('mod+shift')).toBeNull();
    expect(parseKeybinding('mod')).toBeNull();
    expect(parseKeybinding('shift+alt')).toBeNull();
  });

  it('rejects a duplicate modifier token', () => {
    expect(parseKeybinding('mod+mod+n')).toBeNull();
    expect(parseKeybinding('shift+shift+r')).toBeNull();
  });

  it('rejects a non-lowercase binding', () => {
    expect(parseKeybinding('Mod+N')).toBeNull();
    expect(parseKeybinding('mod+N')).toBeNull();
  });
});

describe('isValidKeybinding', () => {
  it('accepts a well-formed string', () => {
    expect(isValidKeybinding('mod+n')).toBe(true);
  });

  it('rejects a malformed string', () => {
    expect(isValidKeybinding('mod+shift')).toBe(false);
    expect(isValidKeybinding('')).toBe(false);
  });

  it('rejects non-string values without throwing', () => {
    expect(isValidKeybinding(undefined)).toBe(false);
    expect(isValidKeybinding(null)).toBe(false);
    expect(isValidKeybinding(42)).toBe(false);
    expect(isValidKeybinding({ mod: true })).toBe(false);
  });

  it('still ACCEPTS a modifier-less binding — parseability is all it answers', () => {
    expect(isValidKeybinding('b')).toBe(true);
    expect(isValidKeybinding('shift+b')).toBe(true);
  });
});

describe('isBindableKeybinding', () => {
  it('accepts a mod-carrying binding, with or without extra modifiers', () => {
    expect(isBindableKeybinding('mod+x')).toBe(true);
    expect(isBindableKeybinding('mod+shift+x')).toBe(true);
    expect(isBindableKeybinding('mod+alt+x')).toBe(true);
    expect(isBindableKeybinding('mod+shift+alt+x')).toBe(true);
  });

  it('REJECTS a bare key — it would make that character untypeable app-wide', () => {
    expect(isBindableKeybinding('b')).toBe(false);
    expect(isBindableKeybinding("'")).toBe(false);
  });

  it('REJECTS shift-only — that is just typing a capital letter', () => {
    expect(isBindableKeybinding('shift+b')).toBe(false);
  });

  it('REJECTS alt-only — on mac that composes glyphs', () => {
    expect(isBindableKeybinding('alt+b')).toBe(false);
    expect(isBindableKeybinding('shift+alt+b')).toBe(false);
  });

  it('rejects everything parseKeybinding rejects', () => {
    expect(isBindableKeybinding('mod+shift')).toBe(false);
    expect(isBindableKeybinding('mod+')).toBe(false);
    expect(isBindableKeybinding('Mod+N')).toBe(false);
    expect(isBindableKeybinding('')).toBe(false);
  });

  it('rejects non-string values without throwing', () => {
    expect(isBindableKeybinding(undefined)).toBe(false);
    expect(isBindableKeybinding(null)).toBe(false);
    expect(isBindableKeybinding(42)).toBe(false);
    expect(isBindableKeybinding({ mod: true })).toBe(false);
  });

  it('every built-in default is bindable', () => {
    for (const action of SHORTCUT_ACTIONS) {
      expect(isBindableKeybinding(KEYBOARD_SHORTCUT_DEFAULTS[action])).toBe(true);
    }
  });
});

describe('eventMatchesBinding', () => {
  it('matches Cmd+N on mac for mod+n', () => {
    const ev = baseEvent({ key: 'n', metaKey: true });
    expect(eventMatchesBinding(ev, 'mod+n', 'mac')).toBe(true);
  });

  it('does NOT match Ctrl+N on mac for mod+n — mod-exclusivity', () => {
    const ev = baseEvent({ key: 'n', ctrlKey: true });
    expect(eventMatchesBinding(ev, 'mod+n', 'mac')).toBe(false);
  });

  it('does NOT match when BOTH metaKey and ctrlKey are held on mac', () => {
    const ev = baseEvent({ key: 'n', metaKey: true, ctrlKey: true });
    expect(eventMatchesBinding(ev, 'mod+n', 'mac')).toBe(false);
  });

  it('matches Ctrl+N on other for mod+n', () => {
    const ev = baseEvent({ key: 'n', ctrlKey: true });
    expect(eventMatchesBinding(ev, 'mod+n', 'other')).toBe(true);
  });

  it('does NOT match Cmd+N on other for mod+n — mod-exclusivity mirrored', () => {
    const ev = baseEvent({ key: 'n', metaKey: true });
    expect(eventMatchesBinding(ev, 'mod+n', 'other')).toBe(false);
  });

  it('requires an exact shift match', () => {
    const withShift = baseEvent({ key: 'r', metaKey: true, shiftKey: true });
    const withoutShift = baseEvent({ key: 'r', metaKey: true });
    expect(eventMatchesBinding(withShift, 'mod+shift+r', 'mac')).toBe(true);
    expect(eventMatchesBinding(withoutShift, 'mod+shift+r', 'mac')).toBe(false);
    expect(eventMatchesBinding(withShift, 'mod+r', 'mac')).toBe(false);
  });

  it('requires an exact alt match', () => {
    const withAlt = baseEvent({ key: 'r', metaKey: true, altKey: true });
    expect(eventMatchesBinding(withAlt, 'mod+alt+r', 'mac')).toBe(true);
    expect(eventMatchesBinding(withAlt, 'mod+r', 'mac')).toBe(false);
  });

  it('compares the key case-insensitively', () => {
    const upper = baseEvent({ key: 'N', metaKey: true });
    expect(eventMatchesBinding(upper, 'mod+n', 'mac')).toBe(true);
  });

  it('matches the quote-key binding', () => {
    const ev = baseEvent({ key: "'", metaKey: true });
    expect(eventMatchesBinding(ev, "mod+'", 'mac')).toBe(true);
  });

  it('returns false for an unparsable binding instead of throwing', () => {
    const ev = baseEvent({ key: 'n', metaKey: true });
    expect(eventMatchesBinding(ev, 'mod+shift', 'mac')).toBe(false);
  });
});

describe('formatKeybinding', () => {
  it('formats a plain mod binding for mac and other', () => {
    expect(formatKeybinding('mod+n', 'mac')).toBe('⌘N');
    expect(formatKeybinding('mod+n', 'other')).toBe('Ctrl+N');
  });

  it('formats mod+shift for mac and other', () => {
    expect(formatKeybinding('mod+shift+r', 'mac')).toBe('⌘⇧R');
    expect(formatKeybinding('mod+shift+r', 'other')).toBe('Ctrl+Shift+R');
  });

  it('formats mod+alt for mac and other', () => {
    expect(formatKeybinding('mod+alt+r', 'mac')).toBe('⌘⌥R');
    expect(formatKeybinding('mod+alt+r', 'other')).toBe('Ctrl+Alt+R');
  });

  it('formats the quote-key binding', () => {
    expect(formatKeybinding("mod+'", 'mac')).toBe("⌘'");
    expect(formatKeybinding("mod+'", 'other')).toBe("Ctrl+'");
  });

  it('formats bracket-key bindings', () => {
    expect(formatKeybinding('mod+[', 'mac')).toBe('⌘[');
    expect(formatKeybinding('mod+]', 'mac')).toBe('⌘]');
  });

  it('returns the raw string verbatim for an unparsable binding', () => {
    expect(formatKeybinding('mod+shift', 'mac')).toBe('mod+shift');
    expect(formatKeybinding('mod+shift', 'other')).toBe('mod+shift');
  });
});

describe('resolveShortcut / resolveAllShortcuts', () => {
  it('falls back to the default when overrides is undefined', () => {
    expect(resolveShortcut(undefined, 'newSession')).toBe('mod+n');
  });

  it('falls back to the default when the action has no override', () => {
    expect(resolveShortcut({ toggleBacklog: 'mod+shift+l' }, 'newSession')).toBe('mod+n');
  });

  it('uses a valid override', () => {
    expect(resolveShortcut({ newSession: 'mod+shift+n' }, 'newSession')).toBe('mod+shift+n');
  });

  it('falls back to the default when the stored override is malformed (hand-edited config.json)', () => {
    expect(
      resolveShortcut({ newSession: 'mod+shift' } as unknown as Record<string, string>, 'newSession'),
    ).toBe('mod+n');
  });

  it('IGNORES a modifier-less override that reached storage some other way', () => {
    // Belt-and-braces mirror of the config:update boundary: a hand-edited
    // config.json holding a bare key must not make that character untypeable.
    expect(
      resolveShortcut({ newSession: 'b' } as unknown as Record<string, string>, 'newSession'),
    ).toBe('mod+n');
    expect(
      resolveShortcut({ newSession: 'shift+b' } as unknown as Record<string, string>, 'newSession'),
    ).toBe('mod+n');
    expect(
      resolveShortcut({ newSession: 'alt+b' } as unknown as Record<string, string>, 'newSession'),
    ).toBe('mod+n');
  });

  it('resolveAllShortcuts layers overrides over the defaults for every action', () => {
    const resolved = resolveAllShortcuts({ newSession: 'mod+shift+n', toggleBacklog: 'mod+shift' } as unknown as Record<string, string>);
    expect(resolved).toEqual({
      newSession: 'mod+shift+n',
      toggleLeftRail: 'mod+[',
      toggleRightRail: 'mod+]',
      toggleChat: "mod+'",
      toggleReviewQueue: 'mod+r',
      toggleBacklog: 'mod+l', // malformed override degrades to the default
    });
  });

  it('resolveAllShortcuts degrades a modifier-less override to the default too', () => {
    const resolved = resolveAllShortcuts({ toggleBacklog: 'b' } as unknown as Record<string, string>);
    expect(resolved.toggleBacklog).toBe('mod+l');
  });

  it('resolveAllShortcuts(undefined) returns exactly the defaults', () => {
    expect(resolveAllShortcuts(undefined)).toEqual(KEYBOARD_SHORTCUT_DEFAULTS);
  });
});
