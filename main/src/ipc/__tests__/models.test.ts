import { describe, expect, it, vi } from 'vitest';
import type { AppServices } from '../types';
import { registerModelHandlers } from '../models';
import { AGENT_PROVIDERS } from '../../../../shared/types/agentRuntime';

// OMP's catalog is not a service field — it comes from a short-lived
// `omp --mode rpc` probe behind a process-wide instance. Unmocked, this test
// really would spawn the machine's `omp`.
const getOmpCatalog = vi.fn(async () => OMP_CATALOG);
vi.mock('../../services/panels/omp/ompModelCatalog', () => ({
  getSharedOmpModelCatalogProbe: () => ({ getCatalog: getOmpCatalog }),
}));

const OMP_CATALOG = {
  models: [
    { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', ompProvider: 'anthropic' },
  ],
};

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

  it('dispatches the omp catalog to the shared RPC probe, not to a service field', async () => {
    // OMP's catalog is a property of the machine's `omp` install rather than of
    // any session, so its fetcher reaches the process-wide probe instead of
    // `services`. Rows arrive in the canonical `<provider>/<id>` form.
    getOmpCatalog.mockClear();
    const { services } = servicesWith({});
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(ipcMain as never, services);

    await expect(handlers.get('models:get-catalog')?.({}, 'omp')).resolves.toEqual({
      success: true,
      data: OMP_CATALOG,
    });
    expect(getOmpCatalog).toHaveBeenCalledOnce();
  });

  it('wraps an omp probe failure in the error envelope rather than throwing', async () => {
    getOmpCatalog.mockRejectedValueOnce(new Error('omp executable not found in PATH'));
    const { services } = servicesWith({});
    const { handlers, ipcMain } = captureHandlers();
    registerModelHandlers(ipcMain as never, services);

    await expect(handlers.get('models:get-catalog')?.({}, 'omp')).resolves.toEqual({
      success: false,
      error: 'omp executable not found in PATH',
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
