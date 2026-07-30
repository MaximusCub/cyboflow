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

/**
 * The post-approve "start the planner?" prompt payload. Set by the design
 * surface when Approve succeeds (right as it exits design mode), consumed by
 * the App-level <DesignPlannerPrompt/> modal, cleared on launch or dismiss.
 */
export interface PlannerPromptState {
  projectId: number;
  ideaId: string;
  ideaTitle: string | null;
  /**
   * The design session that produced the approve. Feeds the modal's
   * "start in this session" option — the modal resolves this session's
   * worktree/busy status to decide whether same-session hosting is offered.
   */
  sessionId: string;
}

interface DesignModeStore {
  /** The session whose fullscreen design surface is active, or null. */
  activeDesignSessionId: string | null;
  /** Pending post-approve planner prompt (survives the surface unmount), or null. */
  plannerPrompt: PlannerPromptState | null;
  /** Activate the fullscreen design surface for a session (idempotent). */
  enterDesignMode: (sessionId: string) => void;
  /** Leave the fullscreen design surface (clears to null; idempotent). */
  exitDesignMode: () => void;
  /** Arm the post-approve planner prompt. */
  showPlannerPrompt: (prompt: PlannerPromptState) => void;
  /** Clear the planner prompt (launched or dismissed). */
  dismissPlannerPrompt: () => void;
}

export const useDesignModeStore = create<DesignModeStore>((set) => ({
  activeDesignSessionId: null,
  plannerPrompt: null,
  enterDesignMode: (sessionId) =>
    set((s) => (s.activeDesignSessionId === sessionId ? s : { activeDesignSessionId: sessionId })),
  exitDesignMode: () =>
    set((s) => (s.activeDesignSessionId === null ? s : { activeDesignSessionId: null })),
  showPlannerPrompt: (prompt) => set({ plannerPrompt: prompt }),
  dismissPlannerPrompt: () =>
    set((s) => (s.plannerPrompt === null ? s : { plannerPrompt: null })),
}));
