import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../types';
import { registerModelHandlers } from '../models';

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

  it('rejects an unknown provider rather than probing anything', async () => {
    const { services, getCodexModelCatalog, getCatalog } = servicesWith({});
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(ipcMain as never, services);

    const response = await handlers.get('models:get-catalog')?.({}, 'gemini');
    expect(response).toEqual({
      success: false,
      error: 'Unknown agent provider "gemini" (expected one of claude, codex).',
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
