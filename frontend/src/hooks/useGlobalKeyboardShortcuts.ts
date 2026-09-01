/**
 * useGlobalKeyboardShortcuts — THE single window-level keydown listener for the
 * six remappable app shortcuts (shared/types/keyboardShortcuts.ts).
 *
 * Mounted once, at the app shell (App.tsx). Bubble phase, so anything that
 * genuinely owns a keystroke (a modal's own handler, xterm, a composer's
 * ⌘↵ send) can call `preventDefault()` first and we stand down — the handler
 * skips any event whose `defaultPrevented` is already set.
 *
 * On a match we call `preventDefault()` — and ONLY that:
 *   - It is load-bearing, not cosmetic. Chromium maps ⌘[ / ⌘] to history
 *     back/forward, and ⌘R to a reload the custom application menu has already
 *     re-accelerated to ⇧⌘R (main/src/menu.ts) — without it, the browser default
 *     fires alongside our action.
 *   - It is also the ONLY cross-listener coordination signal available here.
 *     `stopPropagation()` would be inert: every other app listener is likewise a
 *     bubble-phase listener on `window`, and stopPropagation does not stop
 *     same-target siblings (only `stopImmediatePropagation()` would, and that
 *     depends on registration order we do not control).
 *   - KNOWN LIMITATION: the legacy per-view `useAdd*Shortcut` hooks do NOT check
 *     `defaultPrevented` today, so a user remap onto a chord one of them also
 *     claims (e.g. ⌘P) double-fires — both handlers run. Fixing that means
 *     teaching those hooks the same `defaultPrevented` guard this one honours.
 *
 * Deliberately NO input/textarea/contentEditable guard — unlike the legacy
 * `useAdd*Shortcut` hooks these are all mod-combos, and the user expects them to
 * work from inside the composer exactly as ⌘R or ⌘L do in a browser. (⌘' to
 * toggle the chat in particular is USELESS if it stops working the moment the
 * caret is in the chat: that is the keystroke that closes the dock again.)
 */
import { useEffect } from 'react';
import {
  eventMatchesBinding,
  resolveAllShortcuts,
  type ShortcutAction,
} from '../../../shared/types/keyboardShortcuts';
import { getShortcutPlatform } from '../utils/shortcutPlatform';
import { useKeyboardShortcutsStore } from '../stores/keyboardShortcutsStore';
import { useLayoutStore } from '../stores/layoutStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useConfigStore } from '../stores/configStore';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { useActiveRunsStore } from '../stores/activeRunsStore';
import { useCenterPaneStore, FALLBACK_SESSION } from '../stores/centerPaneStore';
import { useComposerFocusStore, isComposerFocused } from '../stores/composerFocusStore';

/**
 * The key the CHAT COMPOSER is registered under (composerFocusStore): the run id
 * for a flow-run chat, else the session id for a quick session. Null when no
 * session workspace is on screen — the dock only exists under the 'session'
 * center surface, so toggling it from the home/wizard surfaces would be an
 * invisible state change.
 */
function resolveComposerKey(): string | null {
  if (useNavigationStore.getState().view !== 'session') return null;
  const { activeRunId, selectedSessionId } = useCyboflowStore.getState();
  return activeRunId ?? selectedSessionId;
}

/**
 * The key the DOCK is registered under (centerPaneStore) — a DIFFERENT key from
 * the composer's: RunCenterPane keys its pane state by the run's PARENT SESSION
 * when known (else the run id, for legacy parentless runs), and
 * QuickSessionCenterPane keys it by the session id. Mirrored here exactly, or a
 * toggle would flip a pane-state entry nothing renders.
 */
function resolveCenterPaneKey(): string | null {
  if (useNavigationStore.getState().view !== 'session') return null;
  const { activeRunId, selectedSessionId } = useCyboflowStore.getState();
  if (activeRunId !== null) {
    for (const rows of Object.values(useActiveRunsStore.getState().runsByProject)) {
      const found = rows.find((r) => r.id === activeRunId);
      if (found) return found.session_id ?? activeRunId;
    }
    // Row not resolved yet: CyboflowRoot mirrors the run's session_id into
    // selectedSessionId, so that is the same value RunCenterPane will settle on.
    return selectedSessionId ?? activeRunId;
  }
  return selectedSessionId;
}

/**
 * ⌘' — the three-state chat toggle:
 *   dock closed                    → open it, reveal the Chat tab, focus the composer
 *   dock open, composer focused    → collapse the dock (the "put it away" press)
 *   dock open, composer NOT focused→ just focus the composer (no collapse)
 *
 * …with one escape hatch on that last leg. A focus request is consumed ONLY by a
 * composer that actually mounted (composerFocusStore), and some surfaces have no
 * composer at all — a quick session showing a non-chat panel, a dock host that
 * never renders the chat tab. Without the escape hatch every press there would
 * re-post a request nobody answers and the collapse leg would be unreachable
 * forever. So: if OUR previous press's request for this same key is still
 * sitting unconsumed, take that as proof no composer will answer, clear the
 * stale request, and collapse the dock instead of asking again.
 */
function toggleChat(): void {
  const composerKey = resolveComposerKey();
  const paneKey = resolveCenterPaneKey();
  if (composerKey === null || paneKey === null) return;

  const centerPane = useCenterPaneStore.getState();
  const open = (centerPane.bySession[paneKey] ?? FALLBACK_SESSION).terminalOpen;
  const focusStore = useComposerFocusStore.getState();

  if (!open) {
    // Opening and focusing in ONE batch: the dock's display flips in the same
    // commit, so the composer is visible by the time its focus effect runs. The
    // Chat tab is revealed by the dock hosts' useChatTabFocusRequest, and the
    // request survives until a mounted composer actually consumes it.
    centerPane.setTerminalOpen(paneKey, true);
    focusStore.requestFocus(composerKey);
    return;
  }

  if (isComposerFocused(composerKey)) {
    centerPane.setTerminalOpen(paneKey, false);
    return;
  }

  const pending = focusStore.request;
  if (pending !== null && pending.key === composerKey) {
    // Unanswered request from a previous press — no composer is listening here.
    focusStore.consumeFocusRequest(composerKey);
    centerPane.setTerminalOpen(paneKey, false);
    return;
  }

  focusStore.requestFocus(composerKey);
}

/** Run the app-level behaviour bound to `action`. */
function dispatchShortcut(action: ShortcutAction): void {
  switch (action) {
    case 'newSession':
      // Generic new-session wizard — deliberately WITHOUT lockProjectId, which
      // would pin the wizard to whatever project happens to be selected.
      useNavigationStore.getState().goToWizard();
      return;
    case 'toggleLeftRail':
      useLayoutStore.getState().toggleLeftRail();
      return;
    case 'toggleRightRail': {
      // ⌘] toggles whichever right-side rail is actually on screen: the run
      // right rail in the session workspace, else the global-assistant rail on
      // the landing surfaces (mirrors App.tsx's mount gate — shouldShowAgentRail
      // excludes 'session'/'wizard', and the rail is absent entirely when the
      // assistant is disabled in Settings, where toggling would be invisible).
      const view = useNavigationStore.getState().view;
      if (view === 'session') {
        useLayoutStore.getState().toggleRightRail();
        return;
      }
      if (view === 'wizard') return;
      if (useConfigStore.getState().config?.assistantEnabled === false) return;
      useLayoutStore.getState().toggleAgentRail();
      return;
    }
    case 'toggleChat':
      toggleChat();
      return;
    case 'toggleReviewQueue':
      useNavigationStore.getState().toggleHumanReview();
      return;
    case 'toggleBacklog':
      useNavigationStore.getState().toggleBacklog();
      return;
    case 'openSettings':
      useNavigationStore.getState().openSettings('general');
      return;
    case 'openShortcuts':
      useNavigationStore.getState().openSettings('shortcuts');
      return;
  }
}

export function useGlobalKeyboardShortcuts(): void {
  // Reactive: a remap in Settings rewrites the override map, and the listener
  // must be rebound against the new bindings without an app restart.
  const overrides = useKeyboardShortcutsStore((s) => s.overrides);

  useEffect(() => {
    const bindings = resolveAllShortcuts(overrides);
    const platform = getShortcutPlatform();

    function handleKeyDown(event: KeyboardEvent): void {
      // Someone closer to the keystroke already claimed it.
      if (event.defaultPrevented) return;

      for (const [action, binding] of Object.entries(bindings) as [ShortcutAction, string][]) {
        if (!eventMatchesBinding(event, binding, platform)) continue;
        event.preventDefault();
        dispatchShortcut(action);
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [overrides]);
}
