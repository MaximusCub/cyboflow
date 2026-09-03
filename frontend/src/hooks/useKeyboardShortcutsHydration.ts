/**
 * useKeyboardShortcutsHydration — seed `keyboardShortcutsStore` from
 * `config.json` once, at app mount.
 *
 * `config.json` (via the main process) is the single source of truth for the
 * user's shortcut overrides; the store is only the renderer's live mirror of it
 * (see keyboardShortcutsStore's own header). Until this runs, every consumer
 * resolves the BUILT-IN defaults — which is the correct behaviour for an install
 * that has never remapped anything, and `hydrated` is what lets a consumer that
 * cares (the Settings remap UI) tell that state apart from "loaded, and empty".
 *
 * Fail-soft by design: a config read that fails still calls `markHydrated`, so
 * the app runs on the defaults rather than waiting forever on a load that will
 * not arrive.
 */
import { useEffect } from 'react';
import { API } from '../utils/api';
import { useKeyboardShortcutsStore } from '../stores/keyboardShortcutsStore';

export function useKeyboardShortcutsHydration(): void {
  useEffect(() => {
    let cancelled = false;
    void API.config
      .get()
      .then((response) => {
        if (cancelled) return;
        const store = useKeyboardShortcutsStore.getState();
        if (response.success && response.data) {
          store.setOverrides(response.data.keyboardShortcuts ?? {});
        } else {
          store.markHydrated();
        }
      })
      .catch(() => {
        if (!cancelled) useKeyboardShortcutsStore.getState().markHydrated();
      });
    return () => {
      cancelled = true;
    };
  }, []);
}
