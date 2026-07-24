import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ModelPill, MODEL_OPTIONS } from '../ModelPill';
import { _resetClaudeModelCatalogForTesting } from '../../../../stores/claudeModelCatalogStore';

const mockSetModel = vi.fn();
const mockGetCodexCatalog = vi.fn();
const mockGetClaudeCatalog = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: {
    claudePanels: { setModel: (...args: unknown[]) => mockSetModel(...args) },
    models: {
      getCodexCatalog: (...args: unknown[]) => mockGetCodexCatalog(...args),
      getClaudeCatalog: (...args: unknown[]) => mockGetClaudeCatalog(...args),
    },
  },
}));

describe('ModelPill', () => {
  beforeEach(() => {
    _resetClaudeModelCatalogForTesting();
    mockSetModel.mockReset();
    mockSetModel.mockResolvedValue({ success: true });
    // Default: no dynamic Claude models — pinned-only picker (existing tests).
    mockGetClaudeCatalog.mockReset();
    mockGetClaudeCatalog.mockResolvedValue({ success: true, data: { models: [], defaultModel: null } });
    mockGetCodexCatalog.mockResolvedValue({
      success: true,
      data: {
        models: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Frontier coding model', isDefault: true },
          { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced coding model', isDefault: false },
        ],
        defaultModel: 'gpt-5.6-sol',
      },
    });
  });

  it('renders the current model label with version + context', () => {
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={vi.fn()} />);
    expect(screen.getByText('Sonnet 5 · 1M')).toBeInTheDocument();
  });

  it('falls back to "Auto" when no model is set', () => {
    render(<ModelPill panelId="p1" currentModel={null} onModelChange={vi.fn()} />);
    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('persists a new model via setModel and notifies the host on select', async () => {
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M')); // open the dropdown
    fireEvent.click(await screen.findByText('Opus 5 · 1M'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'opus'));
    expect(onChange).toHaveBeenCalledWith('opus');
  });

  it('shows only Codex models for a Codex session and persists the selected id', async () => {
    const onChange = vi.fn();
    render(
      <ModelPill
        panelId="p1"
        agentProvider="codex"
        currentModel="gpt-5.6-sol"
        onModelChange={onChange}
      />,
    );

    fireEvent.click(await screen.findByText('GPT-5.6 Sol'));
    expect(await screen.findByText('GPT-5.6 Terra')).toBeInTheDocument();
    expect(screen.queryByText(/Fable 5/)).toBeNull();
    expect(screen.queryByText(/Opus 5/)).toBeNull();

    fireEvent.click(screen.getByText('GPT-5.6 Terra'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'gpt-5.6-terra'));
    expect(onChange).toHaveBeenCalledWith('gpt-5.6-terra');
  });
  it('does not re-persist when selecting the already-active model', async () => {
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M')); // open
    // The menu contains a second "Sonnet 5 · 1M" (the active item); click it.
    const items = await screen.findAllByText('Sonnet 5 · 1M');
    fireEvent.click(items[items.length - 1]);
    await waitFor(() => expect(mockSetModel).not.toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leads with frontier Fable 5, single-row Opus and Sonnet 5', () => {
    // Fable 5 leads (1M-native frontier); Sonnet 5 and Opus are both single 1M rows
    // (opus-250k removed from the picker, IDEA-017; alias still resolves for back-compat).
    expect(MODEL_OPTIONS.map((o) => o.id)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
      'auto',
    ]);
  });

  it('appends the dynamic "Other models" section below the pinned four and persists the concrete id', async () => {
    mockGetClaudeCatalog.mockResolvedValue({
      success: true,
      data: {
        models: [
          {
            id: 'claude-opus-4-7',
            resolvedModel: 'claude-opus-4-7',
            label: 'Opus 4.7',
            description: 'Previous-gen Opus',
          },
        ],
        defaultModel: null,
      },
    });
    const onChange = vi.fn();
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={onChange} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M')); // open the dropdown
    // The section header + the fetched row appear once the catalog resolves.
    expect(await screen.findByText('Other models')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Opus 4.7'));
    await waitFor(() => expect(mockSetModel).toHaveBeenCalledWith('p1', 'claude-opus-4-7'));
    expect(onChange).toHaveBeenCalledWith('claude-opus-4-7');
  });

  it('shows only the pinned four when the dynamic catalog is empty', async () => {
    render(<ModelPill panelId="p1" currentModel="sonnet" onModelChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Sonnet 5 · 1M'));
    // Let the (empty) catalog resolve, then assert no "Other models" divider.
    await waitFor(() => expect(mockGetClaudeCatalog).toHaveBeenCalled());
    expect(screen.queryByText('Other models')).toBeNull();
  });
});
