import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../types';
import { registerModelHandlers } from '../models';
import { AGENT_PROVIDERS } from '../../../../shared/types/agentRuntime';

function captureHandlers() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
  return { handlers, ipcMain };
}

const CODEX_CATALOG = {
  models: [{
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    description: 'Frontier coding model',
    isDefault: true,
  }],
  defaultModel: 'gpt-5.6-sol',
};

const CLAUDE_CATALOG = {
  models: [{ id: 'claude-opus-5', label: 'Opus 5', description: 'Frontier' }],
  defaultModel: null,
};

function servicesWith(overrides: {
  codex?: () => Promise<typeof CODEX_CATALOG>;
  claude?: () => Promise<typeof CLAUDE_CATALOG>;
}) {
  const getCodexModelCatalog = vi.fn(overrides.codex ?? (async () => CODEX_CATALOG));
  const getCatalog = vi.fn(overrides.claude ?? (async () => CLAUDE_CATALOG));
  const services = {
    codexSdkManager: { getCodexModelCatalog },
    claudeModelCatalogService: { getCatalog },
  } as unknown as AppServices;
  return { services, getCodexModelCatalog, getCatalog };
}

describe('registerModelHandlers', () => {
  it('dispatches models:get-catalog to the requested provider', async () => {
    const { services, getCodexModelCatalog, getCatalog } = servicesWith({});
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(ipcMain as never, services);

    await expect(handlers.get('models:get-catalog')?.({}, 'codex')).resolves.toEqual({
      success: true,
      data: CODEX_CATALOG,
    });
    await expect(handlers.get('models:get-catalog')?.({}, 'claude')).resolves.toEqual({
      success: true,
      data: CLAUDE_CATALOG,
    });
    expect(getCodexModelCatalog).toHaveBeenCalledOnce();
    expect(getCatalog).toHaveBeenCalledOnce();
  });

  it('returns an empty catalog for a provider whose fetcher has not been built yet', async () => {
    // OMP's real catalog comes from an RPC call this build cannot make (no
    // manager yet). Empty is the honest degradation, and it must not throw — the
    // registry being exhaustive is what guarantees SOME answer exists.
    const { services } = servicesWith({});
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(ipcMain as never, services);

    await expect(handlers.get('models:get-catalog')?.({}, 'omp')).resolves.toEqual({
      success: true,
      data: { models: [] },
    });
  });

  it('rejects an unknown provider rather than probing anything', async () => {
    const { services, getCodexModelCatalog, getCatalog } = servicesWith({});
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(ipcMain as never, services);

    const response = await handlers.get('models:get-catalog')?.({}, 'gemini');
    // The accepted list is built from AGENT_PROVIDERS, so it is spelled from the
    // registry here too rather than frozen — a provider added to the union
    // should not fail this test for saying so.
    expect(response).toEqual({
      success: false,
      error: `Unknown agent provider "gemini" (expected one of ${AGENT_PROVIDERS.join(', ')}).`,
    });
    expect(getCodexModelCatalog).not.toHaveBeenCalled();
    expect(getCatalog).not.toHaveBeenCalled();
  });

  it('returns a typed failure when discovery throws', async () => {
    const { services } = servicesWith({
      codex: async () => { throw new Error('Codex unavailable'); },
    });
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(ipcMain as never, services);

    await expect(handlers.get('models:get-catalog')?.({}, 'codex')).resolves.toEqual({
      success: false,
      error: 'Codex unavailable',
    });
  });

  it('keeps the provider-named channels as delegates of the same registry', async () => {
    const { services, getCodexModelCatalog, getCatalog } = servicesWith({});
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(ipcMain as never, services);

    await expect(handlers.get('models:get-codex-catalog')?.({})).resolves.toEqual({
      success: true,
      data: CODEX_CATALOG,
    });
    await expect(handlers.get('models:get-claude-catalog')?.({})).resolves.toEqual({
      success: true,
      data: CLAUDE_CATALOG,
    });
    expect(getCodexModelCatalog).toHaveBeenCalledOnce();
    expect(getCatalog).toHaveBeenCalledOnce();
  });
});
