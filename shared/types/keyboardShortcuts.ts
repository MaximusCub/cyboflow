/**
 * Shared types for the global keyboard-shortcuts feature.
 *
 * Eight actions are bound to a fixed default keybinding, user-remappable via
 * Settings and stored SPARSE (only non-default entries) as
 * `AppConfig.keyboardShortcuts` — mirrors the `sprintMaxTasks` override
 * pattern in `shared/types/sprintBatch.ts`: an install that never touches the
 * setting stays byte-identical, and every consumer resolves through
 * {@link resolveShortcut} / {@link resolveAllShortcuts} rather than reading
 * the override map directly, so the renderer's key-handler, the Settings
 * remap UI, and the formatted hint shown in menus can never disagree.
 *
 * Binding format (the ONE string shape every layer stores/compares):
 * lowercase, '+'-joined, zero or more modifier tokens from
 * {'mod','shift','alt'} (each at most once) followed by exactly one final
 * token — a lowercased `KeyboardEvent.key` value (e.g. 'n', "'", '[').
 * 'mod' is the platform abstraction: Cmd on macOS, Ctrl elsewhere — see
 * {@link eventMatchesBinding}.
 *
 * A binding is only SAFE TO BIND if it carries the 'mod' token — see
 * {@link isBindableKeybinding}, which is what the config:update boundary and
 * the Settings recorder enforce. {@link parseKeybinding} stays deliberately
 * permissive (it accepts a bare key) because it is also the display/compare
 * parser, but a modifier-less binding, or a shift-only / alt-only one, would
 * make that character untypeable app-wide: the global key handler has NO
 * input/textarea guard, so every press of it would fire the action and
 * `preventDefault()` the keystroke ('shift+b' is just typing a capital B, and
 * alt composes glyphs on macOS).
 *
 * This file is consumed by both the main process (the custom application
 * menu, config validation) and the renderer (the global key-handler, the
 * Settings remap UI), so it stays free of Node.js AND DOM lib built-ins —
 * {@link eventMatchesBinding} takes a structural event shape rather than the
 * DOM `KeyboardEvent` type for that reason.
 *
 * Two known sharp edges in the default bindings, documented rather than
 * silently carried:
 *
 *  1. On NON-MAC, 'mod' is Ctrl, which puts the defaults on Ctrl+N / Ctrl+L /
 *     Ctrl+R — all readline/terminal keys (next-line, clear-screen,
 *     reverse-search). The interactive PTY panel survives this only because
 *     xterm.js calls `preventDefault()` on the keys it consumes and the global
 *     engine skips `defaultPrevented` events. That mitigation is LOAD-BEARING:
 *     if the engine ever stops honouring `defaultPrevented`, or a terminal
 *     surface stops preventing, those three shortcuts start stealing
 *     keystrokes from the shell on Linux/Windows.
 *
 *  2. {@link eventMatchesBinding} requires EXACT shift equality, so the
 *     `toggleChat` default "mod+'" is unreachable on any layout where the
 *     apostrophe is a shifted key (German, for instance, where it is Shift+#):
 *     the event arrives with `shiftKey: true` and can never match a
 *     shift-less binding. The recourse is remapping the action in
 *     Settings → Keyboard shortcuts; loosening the shift compare is not, since
 *     it would collapse 'mod+r' and 'mod+shift+r' into one binding.
 */

/** The shortcut-bindable actions. */
export type ShortcutAction =
  | 'newSession'
  | 'toggleLeftRail'
  | 'toggleRightRail'
  | 'toggleChat'
  | 'toggleReviewQueue'
  | 'toggleBacklog'
  | 'openSettings'
  | 'openShortcuts';

/**
 * Every {@link ShortcutAction}, for callers that need to iterate the full set
 * (config validation, {@link resolveAllShortcuts}) without hand-maintaining a
 * second list that could drift from the union above.
 */
export const SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  'newSession',
  'toggleLeftRail',
  'toggleRightRail',
  'toggleChat',
  'toggleReviewQueue',
  'toggleBacklog',
  'openSettings',
  'openShortcuts',
] as const;

/** Runtime guard for an unknown key — true only for a real {@link ShortcutAction}. */
export function isShortcutAction(v: unknown): v is ShortcutAction {
  return typeof v === 'string' && (SHORTCUT_ACTIONS as readonly string[]).includes(v);
}

/** The built-in default binding for every action. */
export const KEYBOARD_SHORTCUT_DEFAULTS: Readonly<Record<ShortcutAction, string>> = {
  newSession: 'mod+n',
  toggleLeftRail: 'mod+[',
  toggleRightRail: 'mod+]',
  toggleChat: "mod+'",
  toggleReviewQueue: 'mod+r',
  toggleBacklog: 'mod+l',
  // The macOS-standard Preferences chord; free here because the custom
  // application menu's 'appMenu' role carries no Preferences item.
  openSettings: 'mod+,',
  // The Slack/Linear/GitHub-conventional "show keyboard shortcuts" chord —
  // opens Settings directly on the Shortcuts tab.
  openShortcuts: 'mod+/',
};

/**
 * The user's per-action override map (`AppConfig.keyboardShortcuts`). SPARSE
 * by design: an absent member means "use the built-in default for that
 * action" — see {@link KEYBOARD_SHORTCUT_DEFAULTS}.
 */
export type KeyboardShortcutOverrides = Partial<Record<ShortcutAction, string>>;

/** Which physical modifier key 'mod' resolves to. */
export type ShortcutPlatform = 'mac' | 'other';

/** A parsed keybinding — the three modifier flags plus the lowercased final key. */
export interface ParsedKeybinding {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** The three recognized modifier tokens a binding string may combine. */
const MODIFIER_TOKENS = new Set(['mod', 'shift', 'alt']);

/**
 * Parse a keybinding string, or return `null` if it does not match the
 * documented format. Strict on purpose — `config.json` is hand-editable and a
 * malformed stored override must degrade to "no override" (via
 * {@link resolveShortcut}), never crash a reader:
 *   - rejects a non-lowercase string (the format is defined as lowercase);
 *   - rejects an empty string, an empty key, or an empty token (e.g. a
 *     leading/trailing/doubled '+');
 *   - rejects an unknown modifier token (anything outside {mod,shift,alt});
 *   - rejects a duplicate modifier token (e.g. 'mod+mod+n');
 *   - rejects a "modifier-only" string whose final token is itself a
 *     modifier word (e.g. 'mod+shift' — no actual key follows).
 */
export function parseKeybinding(value: string): ParsedKeybinding | null {
  if (value.length === 0) return null;
  if (value !== value.toLowerCase()) return null;

  const tokens = value.split('+');
  if (tokens.some((t) => t.length === 0)) return null;

  const key = tokens[tokens.length - 1];
  if (MODIFIER_TOKENS.has(key)) return null; // modifier-only string

  const modifierTokens = tokens.slice(0, -1);
  const seen = new Set<string>();
  let mod = false;
  let shift = false;
  let alt = false;
  for (const token of modifierTokens) {
    if (!MODIFIER_TOKENS.has(token)) return null; // unknown modifier token
    if (seen.has(token)) return null; // duplicate token
    seen.add(token);
    if (token === 'mod') mod = true;
    else if (token === 'shift') shift = true;
    else alt = true;
  }

  return { mod, shift, alt, key };
}

/** Runtime guard: true only for a string {@link parseKeybinding} accepts. */
export function isValidKeybinding(v: unknown): v is string {
  return typeof v === 'string' && parseKeybinding(v) !== null;
}

/**
 * True for a binding the custom application menu reserves for itself
 * (main/src/menu.ts): reload lives on Shift+Cmd+R ('mod+shift+r') and
 * forceReload on Alt+Cmd+R ('mod+alt+r'). Electron delivers a menu
 * accelerator's keydown to the MENU, never the renderer, so a remap onto
 * either chord would be silently swallowed — it must be rejected at bind
 * time, not discovered by a dead shortcut. Compared on the PARSED shape so
 * token order ('mod+shift+r' vs a hand-edited 'shift+mod+r') can't dodge it.
 * If menu.ts's accelerators ever change, change this predicate with them.
 */
export function isReservedKeybinding(v: string): boolean {
  const parsed = parseKeybinding(v);
  if (parsed === null) return false;
  return parsed.mod && parsed.key === 'r' && parsed.shift !== parsed.alt;
}

/**
 * Runtime guard: true only for a binding that is BOTH well-formed AND safe to
 * bind globally — i.e. it carries the 'mod' token (Cmd on mac, Ctrl
 * elsewhere) and is not {@link isReservedKeybinding reserved} by the
 * application menu.
 *
 * THE guard every writer must use ({@link resolveShortcut}, the config:update
 * boundary, the Settings recorder); {@link isValidKeybinding} answers only
 * "does this parse?" and is for display/compare paths. The global key handler
 * deliberately has no input/textarea guard, so a stored binding without 'mod'
 * makes its key untypeable everywhere in the app:
 *   - a bare key ('b') fires on every press of 'b' and preventDefaults it;
 *   - shift-only ('shift+b') is just typing a capital B;
 *   - alt-only ('alt+b') is a glyph-composing keystroke on macOS.
 * Shift and Alt are therefore accepted only ALONGSIDE 'mod', never instead
 * of it.
 */
export function isBindableKeybinding(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const parsed = parseKeybinding(v);
  return parsed !== null && parsed.mod && !isReservedKeybinding(v);
}

/**
 * Structural shape of the subset of a DOM `KeyboardEvent` shortcut matching
 * needs. Deliberately NOT the DOM `KeyboardEvent` type — this file is
 * imported by the main process, which has no `window`/DOM globals live at
 * runtime, so the type surface must stay lib-free even though it happens to
 * structurally match `KeyboardEvent`.
 */
export interface ShortcutMatchEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Does `ev` fire `binding` on `platform`? 'mod' maps to `metaKey` on mac and
 * `ctrlKey` elsewhere; the OTHER member of that physical pair must be held
 * false for a match, on both platforms — so Cmd+T never matches a `mod+t`
 * binding while Ctrl is also down, and (mirrored) Ctrl+T never matches it on
 * mac just because `ctrlKey` happens to be true. `shift`/`alt` must match the
 * binding exactly (present in the binding iff the corresponding flag is
 * true). The event's `key` is compared case-insensitively against the
 * (already-lowercase) parsed key.
 */
export function eventMatchesBinding(
  ev: ShortcutMatchEvent,
  binding: string,
  platform: ShortcutPlatform,
): boolean {
  const parsed = parseKeybinding(binding);
  if (!parsed) return false;

  const modKeyDown = platform === 'mac' ? ev.metaKey : ev.ctrlKey;
  const otherModKeyDown = platform === 'mac' ? ev.ctrlKey : ev.metaKey;
  if (otherModKeyDown) return false;
  if (modKeyDown !== parsed.mod) return false;
  if (ev.shiftKey !== parsed.shift) return false;
  if (ev.altKey !== parsed.alt) return false;
  if (ev.key.toLowerCase() !== parsed.key) return false;
  return true;
}

/** Display form of a parsed key: single chars uppercase; longer names Capitalized. */
function displayKey(key: string): string {
  if (key.length <= 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Human-readable form of a binding for the given platform — mac renders the
 * symbol glyphs with no separator (`'⌘T'`, `'⌘⇧R'`, `"⌘'"`); every other
 * platform joins named modifiers with '+' (`'Ctrl+T'`, `'Ctrl+Shift+R'`). An
 * unparsable binding is returned verbatim rather than thrown on, since this
 * is a display helper fed by (potentially hand-edited) stored config.
 */
export function formatKeybinding(binding: string, platform: ShortcutPlatform): string {
  const parsed = parseKeybinding(binding);
  if (!parsed) return binding;

  const key = displayKey(parsed.key);
  if (platform === 'mac') {
    let out = '';
    if (parsed.mod) out += '⌘';
    if (parsed.shift) out += '⇧';
    if (parsed.alt) out += '⌥';
    return out + key;
  }

  const parts: string[] = [];
  if (parsed.mod) parts.push('Ctrl');
  if (parsed.shift) parts.push('Shift');
  if (parsed.alt) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}

/**
 * THE effective binding for one action: the user's override when it is a
 * BINDABLE keybinding, else the built-in default. Never trusts a stored
 * override blindly — a hand-edited `config.json` degrades to the default
 * rather than handing every consumer an unparsable string, and the
 * {@link isBindableKeybinding} (not {@link isValidKeybinding}) check is the
 * belt-and-braces mirror of the config:update boundary's own validation: a
 * modifier-less override that reached disk some other way still cannot make a
 * character untypeable, because no consumer ever resolves to it.
 */
export function resolveShortcut(
  overrides: KeyboardShortcutOverrides | undefined,
  action: ShortcutAction,
): string {
  const override = overrides?.[action];
  if (override !== undefined && isBindableKeybinding(override)) return override;
  return KEYBOARD_SHORTCUT_DEFAULTS[action];
}

/** {@link resolveShortcut} applied to every action at once. */
export function resolveAllShortcuts(
  overrides: KeyboardShortcutOverrides | undefined,
): Record<ShortcutAction, string> {
  const result = {} as Record<ShortcutAction, string>;
  for (const action of SHORTCUT_ACTIONS) {
    result[action] = resolveShortcut(overrides, action);
  }
  return result;
}
