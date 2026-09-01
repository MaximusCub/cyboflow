/**
 * layoutStore — collapse state for the two app-shell rails.
 *
 * The keyboard-shortcuts feature needs `toggleLeftRail` / `toggleRightRail` to
 * be reachable from ONE global key handler, which cannot call a `useState`
 * setter buried inside a component. Both flags therefore live here:
 *
 *   • rightRailCollapsed — LIFTED out of CyboflowRoot's local useState. It keeps
 *     the SAME localStorage key (`cyboflow.runRightRail.collapsed`) and the same
 *     'true'/'false' read/write semantics, so an existing install keeps whatever
 *     collapse state it already had — no migration, no reset.
 *   • leftRailCollapsed — brand-new (the sidebar was not collapsible before), on
 *     a brand-new key. Brand-new keys need NO migrateLocalStorageKey call (same
 *     convention as AgentRail's collapse/width keys).
 *
 * Persistence is deliberately hand-rolled (read at module init, write on every
 * mutation) rather than zustand/middleware `persist`: it matches the read/write
 * shape the right rail already had on disk, and keeps the seeded value
 * synchronous so the first paint never flashes the wrong geometry.
 */
import { create } from 'zustand';

/** Right rail — the EXISTING key CyboflowRoot wrote, preserved verbatim. */
export const RIGHT_RAIL_COLLAPSED_KEY = 'cyboflow.runRightRail.collapsed';
/** Left rail (app sidebar) — brand-new key, so no migrateLocalStorageKey. */
export const LEFT_RAIL_COLLAPSED_KEY = 'cyboflow-sidebar-collapsed';
/** Agent rail (global assistant) — the EXISTING key AgentRail wrote, preserved
 *  verbatim when its collapse state was lifted here (so ⌘] can reach it). */
export const AGENT_RAIL_COLLAPSED_KEY = 'cyboflow.agentRail.collapsed';

/**
 * Read one persisted flag. Only the literal 'true' collapses — anything else
 * (absent, malformed, a legacy value) reads as expanded. Wrapped in try/catch
 * because localStorage can throw outright in a restricted context.
 */
function readFlag(key: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/** Persist one flag using the same 'true'/'false' encoding the rail already used. */
function writeFlag(key: string, value: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    // Persistence is best-effort — a failed write must never break the toggle.
  }
}

interface LayoutState {
  /** Whether the app sidebar (left rail) is collapsed to its thin strip. */
  leftRailCollapsed: boolean;
  /** Whether the session workspace's right rail is collapsed to its thin strip. */
  rightRailCollapsed: boolean;
  /** Whether the global-assistant rail (landing surfaces) is collapsed. */
  agentRailCollapsed: boolean;
  toggleLeftRail: () => void;
  toggleRightRail: () => void;
  toggleAgentRail: () => void;
  setLeftRailCollapsed: (collapsed: boolean) => void;
  setRightRailCollapsed: (collapsed: boolean) => void;
}

export const useLayoutStore = create<LayoutState>((set) => ({
  leftRailCollapsed: readFlag(LEFT_RAIL_COLLAPSED_KEY),
  rightRailCollapsed: readFlag(RIGHT_RAIL_COLLAPSED_KEY),
  agentRailCollapsed: readFlag(AGENT_RAIL_COLLAPSED_KEY),

  toggleLeftRail: () =>
    set((s) => {
      const next = !s.leftRailCollapsed;
      writeFlag(LEFT_RAIL_COLLAPSED_KEY, next);
      return { leftRailCollapsed: next };
    }),

  toggleRightRail: () =>
    set((s) => {
      const next = !s.rightRailCollapsed;
      writeFlag(RIGHT_RAIL_COLLAPSED_KEY, next);
      return { rightRailCollapsed: next };
    }),

  toggleAgentRail: () =>
    set((s) => {
      const next = !s.agentRailCollapsed;
      writeFlag(AGENT_RAIL_COLLAPSED_KEY, next);
      return { agentRailCollapsed: next };
    }),

  setLeftRailCollapsed: (collapsed) => {
    writeFlag(LEFT_RAIL_COLLAPSED_KEY, collapsed);
    set({ leftRailCollapsed: collapsed });
  },

  setRightRailCollapsed: (collapsed) => {
    writeFlag(RIGHT_RAIL_COLLAPSED_KEY, collapsed);
    set({ rightRailCollapsed: collapsed });
  },
}));
