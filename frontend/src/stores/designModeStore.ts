/**
 * designModeStore — the single "which session's fullscreen design surface is
 * active" flag backing the v0.5 fullscreen design takeover (design-mode.md
 * "Fullscreen design surface (v0.5)").
 *
 * A renderer-level takeover, not a window/route change: App swaps the normal
 * shell for <DesignModeSurface /> whenever `activeDesignSessionId` is non-null.
 * Entering sets it (from the wizard's Design arm or the ui-prototype artifact's
 * "Enter design mode" CTA), the surface's top-left Exit clears it.
 *
 * IN-MEMORY only (no DB, no localStorage), mirroring runSummaryDismissStore:
 * fullscreen state is deliberately NOT restored across app restart — re-entry is
 * always explicit (spec: "Fullscreen state is not restored across app restart —
 * re-entry is always explicit"). A fresh load starts with no active surface.
 */
import { create } from 'zustand';

interface DesignModeStore {
  /** The session whose fullscreen design surface is active, or null. */
  activeDesignSessionId: string | null;
  /** Activate the fullscreen design surface for a session (idempotent). */
  enterDesignMode: (sessionId: string) => void;
  /** Leave the fullscreen design surface (clears to null; idempotent). */
  exitDesignMode: () => void;
}

export const useDesignModeStore = create<DesignModeStore>((set) => ({
  activeDesignSessionId: null,
  enterDesignMode: (sessionId) =>
    set((s) => (s.activeDesignSessionId === sessionId ? s : { activeDesignSessionId: sessionId })),
  exitDesignMode: () =>
    set((s) => (s.activeDesignSessionId === null ? s : { activeDesignSessionId: null })),
}));
