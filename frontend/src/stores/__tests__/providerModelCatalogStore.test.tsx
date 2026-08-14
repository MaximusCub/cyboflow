/**
 * The provider-keyed catalog store — the shared machinery behind the Claude and
 * Codex catalog views.
 *
 * What matters here is the KEYING: every provider must have a slice (so a
 * provider added to the union gets a working store from one registry entry), and
 * the slices must be INDEPENDENT — one provider's one-shot latch, in-flight
 * fetch and failure must not suppress or corrupt another's, which is precisely
 * what a single shared store would have done once a third provider existed.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCatalog } = vi.hoisted(() => ({ getCatalog: vi.fn() }));
vi.mock('../../utils/api', () => ({
  API: { models: { getCatalog } },
}));

import { AGENT_PROVIDERS } from '../../../../shared/types/agentRuntime';
import {
  PROVIDER_MODEL_CATALOG_SLICES,
  resetProviderModelCatalogsForTests,
  useProviderModelCatalog,
} from '../providerModelCatalogStore';

describe('providerModelCatalogStore', () => {
  beforeEach(() => {
    getCatalog.mockReset();
    resetProviderModelCatalogsForTests();
  });

  it('has a slice for every registered provider', () => {
    expect(Object.keys(PROVIDER_MODEL_CATALOG_SLICES).sort()).toEqual([...AGENT_PROVIDERS].sort());
  });

  it('fetches the catalog for the requested provider only', async () => {
    getCatalog.mockResolvedValue({ success: true, data: { models: [], defaultModel: null } });

    const { result } = renderHook(() => useProviderModelCatalog('claude'));
    await waitFor(() => expect(result.current.catalog).not.toBeNull());

    expect(getCatalog).toHaveBeenCalledOnce();
    expect(getCatalog).toHaveBeenCalledWith('claude');
    expect(PROVIDER_MODEL_CATALOG_SLICES.codex.store.getState().catalog).toBeNull();
  });

  it('keeps each provider on its own one-shot latch', async () => {
    getCatalog.mockImplementation(async (provider: string) => ({
      success: true,
      data: { models: [], defaultModel: `${provider}-default` },
    }));

    const claude = renderHook(() => useProviderModelCatalog('claude'));
    await waitFor(() => expect(claude.result.current.catalog).not.toBeNull());
    const codex = renderHook(() => useProviderModelCatalog('codex'));
    await waitFor(() => expect(codex.result.current.catalog).not.toBeNull());

    expect(getCatalog.mock.calls.map(([provider]) => provider)).toEqual(['claude', 'codex']);
    expect(claude.result.current.catalog?.defaultModel).toBe('claude-default');
    expect(codex.result.current.catalog?.defaultModel).toBe('codex-default');
  });

  it('does not fetch while the picker is disabled', async () => {
    renderHook(() => useProviderModelCatalog('claude', false));
    await act(async () => undefined);
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it('releases the latch on failure so a later mount retries', async () => {
    getCatalog.mockRejectedValueOnce(new Error('discovery failed'));
    const first = renderHook(() => useProviderModelCatalog('claude'));
    await waitFor(() => expect(first.result.current.error).toBe('discovery failed'));

    getCatalog.mockResolvedValueOnce({ success: true, data: { models: [], defaultModel: null } });
    const second = renderHook(() => useProviderModelCatalog('claude'));
    await waitFor(() => expect(second.result.current.catalog).not.toBeNull());
    expect(getCatalog).toHaveBeenCalledTimes(2);
  });
});
