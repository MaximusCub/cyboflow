import type { OmpModelOption } from '../../../shared/types/agentModels';
import {
  PROVIDER_MODEL_CATALOG_SLICES,
  useProviderModelCatalog,
} from './providerModelCatalogStore';

/**
 * The OMP view of the provider-keyed catalog store
 * ({@link providerModelCatalogStore}). Everything — the fetch, the one-shot
 * latch, the error handling — lives there; this module adds nothing OMP-specific
 * because there is nothing to add: unlike Codex's synthesized `'auto'` row, OMP
 * has no config value meaning "let the runtime pick" — the absence of a
 * selection already means that everywhere in the app, so there is no row to
 * prepend. See `OmpModelOption`/`OmpModelCatalog` for why the wire row composes
 * its `id` as the canonical `<ompProvider>/<wire id>` rather than the bare id.
 */

export interface OmpModelCatalogHook {
  options: OmpModelOption[];
  loading: boolean;
  error: string | null;
}

export function useOmpModelCatalog(enabled = true): OmpModelCatalogHook {
  const { catalog, loading, error } = useProviderModelCatalog('omp', enabled);
  return { options: catalog?.models ?? [], loading, error };
}

export const ompModelCatalogStoreForTests = PROVIDER_MODEL_CATALOG_SLICES.omp.store;

export function resetOmpModelCatalogStoreForTests(): void {
  PROVIDER_MODEL_CATALOG_SLICES.omp.reset();
}
