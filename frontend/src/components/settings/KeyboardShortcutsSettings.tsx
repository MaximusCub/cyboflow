import { useState } from 'react';
import { Keyboard, RotateCcw } from 'lucide-react';
import { SettingsSection } from '../ui/SettingsSection';
import { getShortcutPlatform } from '../../utils/shortcutPlatform';
import {
  KEYBOARD_SHORTCUT_DEFAULTS,
  SHORTCUT_ACTIONS,
  formatKeybinding,
  isBindableKeybinding,
  resolveShortcut,
  type KeyboardShortcutOverrides,
  type ShortcutAction,
} from '../../../../shared/types/keyboardShortcuts';

/** Human-readable label for each {@link ShortcutAction}, in display order. */
const ACTION_LABELS: Readonly<Record<ShortcutAction, string>> = {
  newSession: 'New session',
  toggleLeftRail: 'Toggle left sidebar',
  toggleRightRail: 'Toggle right rail',
  toggleChat: 'Toggle chat',
  toggleReviewQueue: 'Human review queue',
  toggleBacklog: 'Task backlog',
};

/** `event.key` values a bare modifier press reports — never a real binding on its own. */
const MODIFIER_KEY_NAMES = new Set(['Meta', 'Control', 'Shift', 'Alt', 'AltGraph', 'OS']);

/**
 * The "Shortcuts" tab's content — one row per {@link ShortcutAction} showing
 * its effective binding (override, else the built-in default) with a Record
 * affordance to remap it and a per-row reset.
 *
 * Props-in / callback-out only, mirroring `FeatureControlsSettings`: the map
 * lives as lifted state in `Settings.tsx` and is persisted by its shared
 * `handleSubmit` — this component never touches `API.config.*` itself.
 */
export interface KeyboardShortcutsSettingsProps {
  shortcuts: KeyboardShortcutOverrides;
  onShortcutsChange: (next: KeyboardShortcutOverrides) => void;
}

export function KeyboardShortcutsSettings({
  shortcuts,
  onShortcutsChange,
}: KeyboardShortcutsSettingsProps): React.JSX.Element {
  // Which action's row is currently capturing a keystroke, if any.
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  // Set when the recorder rejected a chord for lacking 'mod' — drives the
  // inline "needs ⌘/Ctrl" hint while recording continues.
  const [needsModHint, setNeedsModHint] = useState(false);
  const platform = getShortcutPlatform();

  const startRecording = (action: ShortcutAction) => {
    setRecordingAction(action);
    setNeedsModHint(false);
  };

  const stopRecording = () => {
    setRecordingAction(null);
    setNeedsModHint(false);
  };

  const effective = {} as Record<ShortcutAction, string>;
  for (const action of SHORTCUT_ACTIONS) {
    effective[action] = resolveShortcut(shortcuts, action);
  }

  // An action is a duplicate iff its EFFECTIVE binding is shared by another
  // action's effective binding — a remap can collide with another action's
  // still-default binding just as easily as with another remap.
  const bindingCounts = new Map<string, number>();
  for (const action of SHORTCUT_ACTIONS) {
    const binding = effective[action];
    bindingCounts.set(binding, (bindingCounts.get(binding) ?? 0) + 1);
  }
  const isDuplicate = (action: ShortcutAction) => (bindingCounts.get(effective[action]) ?? 0) > 1;

  const commitBinding = (action: ShortcutAction, binding: string) => {
    const next = { ...shortcuts };
    // A recorded binding that matches the built-in default is not an
    // override — drop the key so config.json stays sparse rather than
    // storing a value identical to what an absent key would already resolve to.
    if (binding === KEYBOARD_SHORTCUT_DEFAULTS[action]) {
      delete next[action];
    } else {
      next[action] = binding;
    }
    onShortcutsChange(next);
  };

  const resetToDefault = (action: ShortcutAction) => {
    if (shortcuts[action] === undefined) return;
    const next = { ...shortcuts };
    delete next[action];
    onShortcutsChange(next);
  };

  const handleRecordKeyDown = (action: ShortcutAction, e: React.KeyboardEvent<HTMLButtonElement>) => {
    // NOT recording this row → this is an ordinary keystroke on a focused
    // button, not a capture. Bail BEFORE preventDefault so Space/Enter still
    // activate the button (that is how a keyboard user starts recording), Tab
    // still moves focus, and a keystroke after an Escape-cancel is not silently
    // committed as a new binding.
    if (recordingAction !== action) return;

    // From here on we ARE capturing: swallow every keystroke, or the live
    // global shortcut engine's bubble-phase window listener (which skips
    // defaultPrevented events) would also react to the keys being captured.
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      stopRecording();
      return;
    }

    // A bare modifier press isn't a binding yet — wait for the real key.
    if (MODIFIER_KEY_NAMES.has(e.key)) return;

    const tokens: string[] = [];
    if (platform === 'mac' ? e.metaKey : e.ctrlKey) tokens.push('mod');
    if (e.shiftKey) tokens.push('shift');
    if (e.altKey) tokens.push('alt');
    tokens.push(e.key.toLowerCase());
    const binding = tokens.join('+');

    // Reject anything not safe to bind globally — in practice a chord with no
    // Cmd/Ctrl (a bare letter, Shift+letter, Alt+letter), which the engine would
    // happily swallow app-wide and make that character untypeable. Stay in
    // recording mode and show the hint rather than committing or cancelling.
    if (!isBindableKeybinding(binding)) {
      setNeedsModHint(true);
      return;
    }

    commitBinding(action, binding);
    stopRecording();
  };

  return (
    <SettingsSection
      title="Keyboard shortcuts"
      description={`Remap the global shortcuts used throughout Cyboflow. Click a binding, then press the new key combination — it must include ${
        platform === 'mac' ? '⌘' : 'Ctrl'
      }. Escape cancels.`}
      icon={<Keyboard className="w-4 h-4" />}
    >
      <div className="flex flex-col divide-y divide-border-secondary rounded-button border border-border-secondary">
        {SHORTCUT_ACTIONS.map((action) => {
          const binding = effective[action];
          const recording = recordingAction === action;
          const overridden = shortcuts[action] !== undefined;
          const duplicate = isDuplicate(action);
          return (
            <div key={action} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm text-text-primary font-medium truncate">
                  {ACTION_LABELS[action]}
                </div>
                {duplicate && (
                  <div className="text-xs text-status-error mt-0.5">
                    Conflicts with another shortcut below
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  data-testid={`shortcut-record-${action}`}
                  onClick={() => startRecording(action)}
                  onKeyDown={(e) => handleRecordKeyDown(action, e)}
                  onBlur={() => {
                    if (recordingAction === action) stopRecording();
                  }}
                  aria-label={`Record shortcut for ${ACTION_LABELS[action]}`}
                  className={`min-w-[110px] px-3 py-1.5 rounded-button border text-sm font-mono text-center transition-colors ${
                    recording
                      ? 'border-interactive bg-interactive-surface text-interactive'
                      : duplicate
                        ? 'border-status-error/50 bg-surface-secondary text-text-primary hover:bg-surface-hover'
                        : 'border-border-secondary bg-surface-secondary text-text-primary hover:bg-surface-hover'
                  }`}
                >
                  {recording
                    ? needsModHint
                      ? `Needs ${platform === 'mac' ? '⌘' : 'Ctrl'}…`
                      : 'Press a key…'
                    : formatKeybinding(binding, platform)}
                </button>
                {overridden && (
                  <button
                    type="button"
                    onClick={() => resetToDefault(action)}
                    className="p-1.5 rounded-button text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors"
                    aria-label={`Reset ${ACTION_LABELS[action]} to default`}
                    title={`Reset to default (${formatKeybinding(KEYBOARD_SHORTCUT_DEFAULTS[action], platform)})`}
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}
