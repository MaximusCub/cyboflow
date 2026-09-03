/**
 * composerFocusStore — a one-slot mailbox letting a NON-RENDERING caller (the
 * global keyboard-shortcut handler) put the caret in a chat composer it has no
 * ref to.
 *
 * The composers are several layers down (RunChatView → ChatInput, and
 * ClaudePanel → QuickSessionComposer) and each owns its own textarea ref, so
 * the shortcut cannot focus one directly. Instead it POSTS a request here and
 * the composer that recognises the key consumes it.
 *
 * Key scheme (documented once, here, because two hosts share this store):
 *   • flow-run chat  → the RUN id (`ChatInput`'s `runId` prop)
 *   • quick-session  → the SESSION id (`QuickSessionComposer`'s
 *     `activeSession.id`)
 * i.e. exactly `cyboflowStore.activeRunId ?? cyboflowStore.selectedSessionId`,
 * which is what the shortcut handler resolves. Note this is deliberately NOT
 * the centerPaneStore key (a run's PARENT SESSION id) — that one addresses the
 * dock, this one addresses the composer inside it.
 *
 * `nonce` makes every request distinct, so pressing the shortcut twice with the
 * same key is two events rather than one idempotent state write.
 *
 * A request is consumed ONLY by a composer that actually had a textarea to
 * focus. That is what makes "open the collapsed dock, switch to the Chat tab,
 * then focus" work in one keystroke: the dock hosts unmount (RunBottomPane) or
 * display:none (the quick dock) their chat surface, so the request has to
 * SURVIVE until the composer is mounted and visible, and only then be cleared.
 */
import { useEffect } from 'react';
import { create } from 'zustand';

/** A pending "put the caret in this composer" request. */
export interface ComposerFocusRequest {
  key: string;
  /** Monotonic per-request id, so repeat requests for the same key are distinct. */
  nonce: number;
}

interface ComposerFocusState {
  /** The single outstanding request, or null when none is pending. */
  request: ComposerFocusRequest | null;
  /** Ask the composer registered under `key` to take focus. */
  requestFocus: (key: string) => void;
  /** Clear the pending request IFF it targets `key` (a later one is left alone). */
  consumeFocusRequest: (key: string) => void;
}

let nextNonce = 1;

export const useComposerFocusStore = create<ComposerFocusState>((set) => ({
  request: null,

  requestFocus: (key) => set({ request: { key, nonce: nextNonce++ } }),

  consumeFocusRequest: (key) =>
    set((s) => (s.request !== null && s.request.key === key ? { request: null } : s)),
}));

/**
 * Attribute stamped on a composer textarea by {@link useComposerFocusRequest},
 * so {@link isComposerFocused} can answer "is THAT composer the focused
 * element?" without the store having to hold DOM nodes (which would need their
 * own registration lifecycle and would leak across tests).
 */
export const COMPOSER_FOCUS_ATTR = 'data-composer-focus-key';

/**
 * Is the composer registered under `key` the document's focused element? Used
 * by the toggle-chat shortcut to distinguish "focus it" from "collapse the
 * dock" — pressing the shortcut while already typing in the composer closes the
 * dock, pressing it from anywhere else brings the caret here first.
 */
export function isComposerFocused(key: string): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return active.getAttribute(COMPOSER_FOCUS_ATTR) === key;
}

/**
 * Wire a composer's textarea into the focus mailbox.
 *
 * Stamps {@link COMPOSER_FOCUS_ATTR} on the element (so `isComposerFocused` can
 * recognise it) and focuses it whenever a matching request lands, consuming the
 * request afterwards. A null `key` (or a not-yet-rendered textarea) leaves the
 * request PENDING rather than swallowing it, so the request survives the render
 * in which the dock opens / the Chat tab remounts the composer, and is honoured
 * on that composer's very first effect.
 *
 * The attribute is stamped in TWO places, deliberately. The mount effect below
 * covers the ordinary case, but its deps are `[key, textareaRef]` and a ref
 * object is referentially STABLE — a host that renders `null` on its first
 * commit and the textarea later re-runs no effect, so that element would never
 * be stamped and `isComposerFocused` would answer false for it forever (which
 * is exactly the state the ⌘' collapse leg reads). The focus path therefore
 * re-stamps `textareaRef.current` immediately before focusing it.
 */
export function useComposerFocusRequest(
  key: string | null,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
): void {
  const request = useComposerFocusStore((s) => s.request);
  const consumeFocusRequest = useComposerFocusStore((s) => s.consumeFocusRequest);

  // Stamp/unstamp the identifying attribute alongside the element's lifetime.
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null || key === null) return;
    el.setAttribute(COMPOSER_FOCUS_ATTR, key);
    return () => {
      el.removeAttribute(COMPOSER_FOCUS_ATTR);
    };
  }, [key, textareaRef]);

  useEffect(() => {
    if (key === null || request === null || request.key !== key) return;
    const el = textareaRef.current;
    // No textarea yet (the host renders null in some modes) — leave the request
    // pending so the composer picks it up when it does mount.
    if (el === null) return;
    // Re-stamp: this element may have appeared AFTER the mount effect above ran
    // (a stable ref means that effect does not re-run), in which case this is
    // the only stamp it ever gets.
    el.setAttribute(COMPOSER_FOCUS_ATTR, key);
    el.focus();
    consumeFocusRequest(key);
  }, [request, key, textareaRef, consumeFocusRequest]);
}

/**
 * Companion for a dock TAB HOST (RunBottomPane, QuickSessionDockTabs): run
 * `showChat` whenever a focus request lands for `key`, so a composer hidden
 * behind another dock tab is revealed before it is asked to take focus.
 *
 * Deliberately does NOT consume the request — {@link useComposerFocusRequest}
 * owns that, and it must still be pending when the freshly-revealed composer
 * mounts.
 */
export function useChatTabFocusRequest(key: string | null, showChat: () => void): void {
  const request = useComposerFocusStore((s) => s.request);
  // Depend on the NONCE, not the callback: hosts pass an inline arrow, and a
  // callback dep would re-run this (re-forcing the Chat tab) on every render.
  const nonce = request !== null && key !== null && request.key === key ? request.nonce : null;
  useEffect(() => {
    if (nonce === null) return;
    showChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce]);
}
