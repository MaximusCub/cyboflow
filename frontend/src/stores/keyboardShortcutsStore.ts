/**
 * keyboardShortcutsStore — in-memory holder for the user's keyboard-shortcut
 * overrides (`AppConfig.keyboardShortcuts`).
 *
 * NO persistence lives here — `config.json` (via the main process) is the
 * single source of truth, mirroring `configStore`'s split: a LATER stage
 * hydrates this store from `API.config.get()` on boot and writes back through
 * `API.config.update()` on a remap, calling `setOverrides` either way so every
 * consumer (the global key-handler, the Settings remap UI, formatted-hint
 * displays) reads one live value. `hydrated` lets a consumer distinguish "no
 * overrides yet because none are set" from "no overrides yet because we
 * haven't loaded config.json" — mirrors the seeded/unseeded distinction in
 * `centerPaneStore`.
 */
import { create } from 'zustand';
import type { KeyboardShortcutOverrides } from '../../../shared/types/keyboardShortcuts';

interface KeyboardShortcutsState {
  overrides: KeyboardShortcutOverrides;
  /** True once the store has been seeded from config.json at least once. */
  hydrated: boolean;
  /** Replace the overrides map wholesale (a config.json load or a successful remap). */
  setOverrides: (next: KeyboardShortcutOverrides) => void;
  /** Mark the store hydrated without changing `overrides` (e.g. config.json had none). */
  markHydrated: () => void;
}

export const useKeyboardShortcutsStore = create<KeyboardShortcutsState>((set) => ({
  overrides: {},
  hydrated: false,

  setOverrides: (next) => set({ overrides: next, hydrated: true }),

  markHydrated: () => set({ hydrated: true }),
}));
