/**
 * Unit tests for EffortPill's provider-scoped effort levels
 * (shared/types/reasoningEffort.ts effortLevelsForProvider) — added alongside
 * the OMP provider (Phase 1G): the control already worked generically for any
 * registered provider, this proves the OMP scale (off..max) actually renders.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EffortPill } from '../EffortPill';

const mockSetEffort = vi.fn();
vi.mock('../../../../utils/api', () => ({
  API: {
    claudePanels: { setEffort: (...args: unknown[]) => mockSetEffort(...args) },
  },
}));

beforeEach(() => {
  mockSetEffort.mockReset();
  mockSetEffort.mockResolvedValue({ success: true });
});

describe('EffortPill — OMP effort scale', () => {
  it('renders the full off..max OMP scale, including the OMP-only "Off" and "Minimal" rungs', () => {
    render(
      <EffortPill panelId="p1" agentProvider="omp" currentEffort={null} onEffortChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Default')); // open the dropdown

    for (const level of ['Off', 'Minimal', 'Low', 'Medium', 'High', 'Xhigh', 'Max']) {
      expect(screen.getByText(level)).toBeInTheDocument();
    }
    // Codex's floor ('None') and Claude's absence of 'off'/'minimal' both do
    // NOT apply to the OMP scale.
    expect(screen.queryByText('None')).not.toBeInTheDocument();
  });

  it('persists an OMP effort selection via setEffort and notifies the host', async () => {
    const onChange = vi.fn();
    render(
      <EffortPill panelId="p1" agentProvider="omp" currentEffort={null} onEffortChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Default'));
    fireEvent.click(await screen.findByText('Off'));

    await waitFor(() => expect(mockSetEffort).toHaveBeenCalledWith('p1', 'off'));
    expect(onChange).toHaveBeenCalledWith('off');
  });

  it("shows the OMP provider's name in the trigger tooltip", () => {
    render(
      <EffortPill panelId="p1" agentProvider="omp" currentEffort="high" onEffortChange={vi.fn()} />,
    );
    expect(screen.getByTitle(/reasoning effort/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText('High'));
    expect(screen.getByText(/Let OMP pick the effort/)).toBeInTheDocument();
  });
});

describe('EffortPill — Claude/Codex scales still render (regression)', () => {
  it("Claude's scale excludes 'off'/'minimal'/'none'", () => {
    render(<EffortPill panelId="p1" currentEffort={null} onEffortChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Default'));

    for (const level of ['Low', 'Medium', 'High', 'Xhigh', 'Max']) {
      expect(screen.getByText(level)).toBeInTheDocument();
    }
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
    expect(screen.queryByText('Minimal')).not.toBeInTheDocument();
    expect(screen.queryByText('None')).not.toBeInTheDocument();
  });

  it("Codex's scale includes 'None' but not 'off'", () => {
    render(
      <EffortPill panelId="p1" agentProvider="codex" currentEffort={null} onEffortChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Default'));

    expect(screen.getByText('None')).toBeInTheDocument();
    expect(screen.getByText('Minimal')).toBeInTheDocument();
    expect(screen.queryByText('Off')).not.toBeInTheDocument();
  });
});
