import { useEffect } from 'react';
import { create } from 'zustand';
import type { ClaudeModelCatalog, ClaudeModelOption } from '../../../shared/types/agentModels';
import { API } from '../utils/api';

/**
 * Lazy store for the DYNAMIC Claude model catalog — the "Other models" the
 * signed-in login can select, below the four curated/pinned families in the
 * picker. Fetched once (main-owned + cached over IPC; see ClaudeModelCatalogService)
 * on first use of a Claude picker, so multiple mounts / a renderer reload don't
 * re-probe. Mirrors codexModelCatalogStore. A failed fetch leaves an empty list —
 * the picker still shows the pinned four.
 */

interface ClaudeModelCatalogState {
  catalog: ClaudeModelCatalog | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
}

const useStore = create<ClaudeModelCatalogState>((set) => ({
  catalog: null,
  loading: false,
  error: null,
  async load() {
    set({ loading: true, error: null });
    try {
      const response = await API.models.getClaudeCatalog();
      if (!response.success || !response.data) {
        throw new Error(response.error ?? 'Claude model discovery failed');
      }
      set({ catalog: response.data, loading: false });
    } catch (error) {
      started = false; // allow a retry on a later mount
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));

let started = false;
function ensureStarted(enabled: boolean): void {
  if (!enabled || started) return;
  started = true;
  void useStore.getState().load();
}

export interface ClaudeModelCatalogHook {
  options: ClaudeModelOption[];
  loading: boolean;
  error: string | null;
}

/**
 * Subscribe to the dynamic Claude catalog. Pass `enabled` (true only for a Claude
 * picker) — the fetch is kicked off once on first enabled mount and shared. Returns
 * an empty `options` list until the fetch resolves, or permanently if it fails.
 */
export function useClaudeModelCatalog(enabled: boolean): ClaudeModelCatalogHook {
  const catalog = useStore((state) => state.catalog);
  const loading = useStore((state) => state.loading);
  const error = useStore((state) => state.error);

  useEffect(() => {
    ensureStarted(enabled);
  }, [enabled]);

  return { options: catalog?.models ?? [], loading, error };
}

/** Test-only: reset the module-level start latch + store between test cases. */
export function _resetClaudeModelCatalogForTesting(): void {
  started = false;
  useStore.setState({ catalog: null, loading: false, error: null });
}
