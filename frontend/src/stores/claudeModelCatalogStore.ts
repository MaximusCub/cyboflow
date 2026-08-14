import type { ClaudeModelOption } from '../../../shared/types/agentModels';
import {
  PROVIDER_MODEL_CATALOG_SLICES,
  useProviderModelCatalog,
} from './providerModelCatalogStore';

/**
 * The CLAUDE view of the provider-keyed catalog store
 * ({@link providerModelCatalogStore}) — the DYNAMIC catalog the signed-in login
 * can select from, rendered as "Other models" BELOW the four curated/pinned
 * families in the picker. A failed fetch leaves an empty list; the picker still
 * shows the pinned four, which is why this provider tolerates an empty catalog
 * where Codex does not.
 */

export interface ClaudeModelCatalogHook {
  options: ClaudeModelOption[];
  loading: boolean;
  error: string | null;
}

/**
 * Subscribe to the dynamic Claude catalog. Pass `enabled` (true only for a
 * Claude picker) — the fetch is kicked off once on first enabled mount and
 * shared. Returns an empty `options` list until the fetch resolves, or
 * permanently if it fails.
 */
export function useClaudeModelCatalog(enabled: boolean): ClaudeModelCatalogHook {
  const { catalog, loading, error } = useProviderModelCatalog('claude', enabled);
  return { options: catalog?.models ?? [], loading, error };
}

/** Test-only: reset the module-level start latch + store between test cases. */
export function _resetClaudeModelCatalogForTesting(): void {
  PROVIDER_MODEL_CATALOG_SLICES.claude.reset();
}
