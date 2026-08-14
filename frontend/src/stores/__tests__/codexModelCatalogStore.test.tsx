import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCatalog } = vi.hoisted(() => ({ getCatalog: vi.fn() }));
vi.mock('../../utils/api', () => ({
  API: { models: { getCatalog } },
}));

import {
  codexModelCatalogStoreForTests,
  resetCodexModelCatalogStoreForTests,
  useCodexModelCatalog,
} from '../codexModelCatalogStore';

describe('useCodexModelCatalog', () => {
  beforeEach(() => {
    getCatalog.mockReset();
    resetCodexModelCatalogStoreForTests();
  });

  it('loads runtime-advertised models and labels Auto with the runtime default', async () => {
    getCatalog.mockResolvedValue({
      success: true,
      data: {
        models: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Frontier', isDefault: true },
          { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced', isDefault: false },
        ],
        defaultModel: 'gpt-5.6-sol',
      },
    });

    const { result } = renderHook(() => useCodexModelCatalog());
    await waitFor(() => expect(result.current.options).toHaveLength(3));

    expect(result.current.options.map((option) => option.id)).toEqual([
      'auto',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
    ]);
    expect(result.current.options[0].description).toContain('GPT-5.6 Sol');
    expect(getCatalog).toHaveBeenCalledOnce();
    expect(getCatalog).toHaveBeenCalledWith('codex');
  });

  it('keeps Auto available when discovery fails', async () => {
    getCatalog.mockRejectedValue(new Error('runtime unavailable'));
    const { result } = renderHook(() => useCodexModelCatalog());
    await waitFor(() => expect(result.current.error).toBe('runtime unavailable'));

    expect(result.current.options.map((option) => option.id)).toEqual(['auto']);
  });

  it('does not load while the Codex picker is disabled', async () => {
    renderHook(() => useCodexModelCatalog(false));
    await act(async () => undefined);
    expect(getCatalog).not.toHaveBeenCalled();
    expect(codexModelCatalogStoreForTests.getState().catalog).toBeNull();
  });
});
