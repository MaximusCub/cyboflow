import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCatalog } = vi.hoisted(() => ({ getCatalog: vi.fn() }));
vi.mock('../../utils/api', () => ({
  API: { models: { getCatalog } },
}));

import {
  ompModelCatalogStoreForTests,
  resetOmpModelCatalogStoreForTests,
  useOmpModelCatalog,
} from '../ompModelCatalogStore';

describe('useOmpModelCatalog', () => {
  beforeEach(() => {
    getCatalog.mockReset();
    resetOmpModelCatalogStoreForTests();
  });

  it('loads the OMP catalog verbatim — no synthesized "auto" row (OMP has none of its own)', async () => {
    getCatalog.mockResolvedValue({
      success: true,
      data: {
        models: [
          { id: 'anthropic/claude-3-5-sonnet-20240620', label: 'Claude Sonnet 3.5', ompProvider: 'anthropic' },
          { id: 'openai/gpt-5.4', label: 'GPT-5.4', ompProvider: 'openai' },
        ],
      },
    });

    const { result } = renderHook(() => useOmpModelCatalog());
    await waitFor(() => expect(result.current.options).toHaveLength(2));

    expect(result.current.options.map((option) => option.id)).toEqual([
      'anthropic/claude-3-5-sonnet-20240620',
      'openai/gpt-5.4',
    ]);
    expect(getCatalog).toHaveBeenCalledOnce();
    expect(getCatalog).toHaveBeenCalledWith('omp');
  });

  it('degrades to an empty list (not a fabricated default) when discovery fails', async () => {
    getCatalog.mockRejectedValue(new Error('omp not found on PATH'));
    const { result } = renderHook(() => useOmpModelCatalog());
    await waitFor(() => expect(result.current.error).toBe('omp not found on PATH'));

    expect(result.current.options).toEqual([]);
  });

  it('does not load while the OMP picker is disabled', async () => {
    renderHook(() => useOmpModelCatalog(false));
    await act(async () => undefined);
    expect(getCatalog).not.toHaveBeenCalled();
    expect(ompModelCatalogStoreForTests.getState().catalog).toBeNull();
  });
});
