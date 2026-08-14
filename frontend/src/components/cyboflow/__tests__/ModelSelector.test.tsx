/**
 * Unit tests for ModelSelector's provider arms — focused on the OMP addition
 * (Phase 1G, docs/proposals/omp-provider-integration.md §5.5): a grouped
 * catalog rendered via <optgroup>, no synthesized 'auto' option, and the
 * loading/error/empty states mirroring Codex's.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelSelector } from '../ModelSelector';
import { resetProviderModelCatalogsForTests } from '../../../stores/providerModelCatalogStore';

const mockGetCatalog = vi.fn();
const mockGetAvailability = vi.fn();
const mockOnAvailabilityChanged = vi.fn();

vi.mock('../../../utils/api', () => ({
  API: {
    models: {
      getCatalog: (provider: string) => mockGetCatalog(provider),
      getAvailability: (...args: unknown[]) => mockGetAvailability(...args),
      onAvailabilityChanged: (...args: unknown[]) => mockOnAvailabilityChanged(...args),
    },
  },
}));

beforeEach(() => {
  resetProviderModelCatalogsForTests();
  mockGetCatalog.mockReset();
  mockGetAvailability.mockReset().mockResolvedValue({ success: true, data: {} });
  mockOnAvailabilityChanged.mockReset().mockReturnValue(() => {});
  mockGetCatalog.mockImplementation((provider: string) => {
    if (provider === 'claude') return Promise.resolve({ success: true, data: { models: [], defaultModel: null } });
    if (provider === 'codex') return Promise.resolve({ success: true, data: { models: [], defaultModel: null } });
    return Promise.resolve({ success: true, data: { models: [] } });
  });
});

describe('ModelSelector — OMP arm', () => {
  it('renders the OMP catalog grouped into one <optgroup> per ompProvider', async () => {
    mockGetCatalog.mockImplementation((provider: string) =>
      provider === 'omp'
        ? Promise.resolve({
            success: true,
            data: {
              models: [
                { id: 'anthropic/claude-3-5-sonnet-20240620', label: 'Claude Sonnet 3.5', ompProvider: 'anthropic' },
                { id: 'anthropic/claude-3-opus', label: 'Claude Opus 3', ompProvider: 'anthropic' },
                { id: 'openai/gpt-5.4', label: 'GPT-5.4', ompProvider: 'openai' },
              ],
            },
          })
        : Promise.resolve({ success: true, data: { models: [], defaultModel: null } }),
    );

    render(
      <ModelSelector
        value="anthropic/claude-3-5-sonnet-20240620"
        onChange={vi.fn()}
        agentProvider="omp"
        agentRuntime="omp-sdk"
      />,
    );

    expect(screen.getByRole('combobox', { name: /select omp model/i })).toBeInTheDocument();

    const anthropicGroup = (await screen.findByText('Claude Sonnet 3.5')).closest('optgroup');
    expect(anthropicGroup).toHaveAttribute('label', 'anthropic');
    expect(screen.getByText('GPT-5.4').closest('optgroup')).toHaveAttribute('label', 'openai');
  });

  it('persists the canonical <ompProvider>/<id> value verbatim, with no synthesized "auto" option', async () => {
    mockGetCatalog.mockImplementation((provider: string) =>
      provider === 'omp'
        ? Promise.resolve({
            success: true,
            data: { models: [{ id: 'openai/gpt-5.4', label: 'GPT-5.4', ompProvider: 'openai' }] },
          })
        : Promise.resolve({ success: true, data: { models: [], defaultModel: null } }),
    );

    render(
      <ModelSelector value="openai/gpt-5.4" onChange={vi.fn()} agentProvider="omp" agentRuntime="omp-sdk" />,
    );

    await screen.findByText('GPT-5.4');
    expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /auto/i })).not.toBeInTheDocument();
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('openai/gpt-5.4');
  });

  it('shows a loading placeholder before the OMP catalog resolves, then an empty-state one if it resolves empty', async () => {
    let resolveCatalog!: (value: unknown) => void;
    mockGetCatalog.mockImplementation((provider: string) => {
      if (provider !== 'omp') return Promise.resolve({ success: true, data: { models: [], defaultModel: null } });
      return new Promise((resolve) => {
        resolveCatalog = resolve;
      });
    });

    render(<ModelSelector value="" onChange={vi.fn()} agentProvider="omp" agentRuntime="omp-sdk" />);
    expect(screen.getByText('Loading OMP models…')).toBeInTheDocument();

    resolveCatalog({ success: true, data: { models: [] } });
    await waitFor(() => expect(screen.getByText('No OMP models available')).toBeInTheDocument());
  });

  it('derives the OMP arm from agentRuntime alone when agentProvider is left at its default', async () => {
    mockGetCatalog.mockImplementation((provider: string) =>
      provider === 'omp'
        ? Promise.resolve({
            success: true,
            data: { models: [{ id: 'openai/gpt-5.4', label: 'GPT-5.4', ompProvider: 'openai' }] },
          })
        : Promise.resolve({ success: true, data: { models: [], defaultModel: null } }),
    );

    render(<ModelSelector value="openai/gpt-5.4" onChange={vi.fn()} agentRuntime="omp-sdk" />);

    expect(screen.getByRole('combobox', { name: /select omp model/i })).toBeInTheDocument();
    expect(await screen.findByText('GPT-5.4')).toBeInTheDocument();
  });
});

describe('ModelSelector — Claude/Codex arms still render (regression)', () => {
  it('defaults to the Claude picker', () => {
    render(<ModelSelector value="opus" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /select claude model/i })).toBeInTheDocument();
  });

  it('renders the Codex picker for a codex runtime', async () => {
    mockGetCatalog.mockImplementation((provider: string) =>
      provider === 'codex'
        ? Promise.resolve({
            success: true,
            data: { models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Frontier', isDefault: true }], defaultModel: 'gpt-5.6-sol' },
          })
        : Promise.resolve({ success: true, data: { models: [], defaultModel: null } }),
    );

    render(<ModelSelector value="gpt-5.6-sol" onChange={vi.fn()} agentProvider="codex" agentRuntime="codex-sdk" />);
    expect(screen.getByRole('combobox', { name: /select codex model/i })).toBeInTheDocument();
    expect(await screen.findByRole('option', { name: /^GPT-5\.6 Sol/ })).toBeInTheDocument();
  });
});
