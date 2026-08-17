/**
 * Unit tests for SubstrateSelector's global-lock behavior.
 *
 * useForcedSubstrate is mocked to drive the three precedence states the backend
 * pin can produce (null / 'interactive' / 'sdk').
 *
 * Behaviors verified:
 *   1. No pin (null) → normal <select> with scope-aware Codex availability;
 *      value NOT force-synced.
 *   2. interactivePtyOnly lock ('interactive') → read-only locked UI + caveats,
 *      and the controlled value is synced to 'interactive' via onChange.
 *   3. Demo pin ('sdk') → normal <select> (NOT the "interactive locked" UI) and
 *      the value is left alone, so demo never falsely claims interactive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const { mockUseForcedSubstrate } = vi.hoisted(() => ({
  mockUseForcedSubstrate: vi.fn<() => 'sdk' | 'interactive' | null>(() => null),
}));

vi.mock('../../../hooks/useForcedSubstrate', () => ({
  useForcedSubstrate: mockUseForcedSubstrate,
}));

const { mockUseOmpAvailability } = vi.hoisted(() => ({
  mockUseOmpAvailability: vi.fn<() => boolean>(() => false),
}));

vi.mock('../../../hooks/useOmpAvailability', () => ({
  useOmpAvailability: mockUseOmpAvailability,
}));

import { SubstrateSelector } from '../SubstrateSelector';
import { useConfigStore } from '../../../stores/configStore';
import type { AppConfig } from '../../../types/config';
import type { AgentProviderAccess } from '../../../../../shared/types/agentRuntime';

/** Drive the picker's provider gate through the real config store. */
function setProviderAccess(access: AgentProviderAccess | undefined): void {
  useConfigStore.setState({
    config: { gitRepoPath: '/repo', agentProviderAccess: access } as AppConfig,
  });
}

beforeEach(() => {
  mockUseForcedSubstrate.mockReset();
  mockUseForcedSubstrate.mockReturnValue(null);
  mockUseOmpAvailability.mockReset();
  mockUseOmpAvailability.mockReturnValue(false);
  useConfigStore.setState({ config: null });
});

describe('SubstrateSelector — no forced pin', () => {
  it('renders workflow runtimes with Codex SDK enabled and Codex PTY disabled', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} />);

    expect(screen.getByRole('combobox', { name: /select agent runtime/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude SDK/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Claude interactive/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex PTY/i })).toBeDisabled();
    expect(screen.getByText(/Workflows can run on Claude or Codex SDK/i)).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders quick-session runtimes with both Codex runtimes enabled', () => {
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex PTY/i })).not.toBeDisabled();
    expect(screen.getByText(/Codex SDK runs structured quick-session chat/i)).toBeInTheDocument();
  });

  it('keeps both Codex runtimes available on the mixed launcher', () => {
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Codex PTY/i })).not.toBeDisabled();
    expect(screen.getByText(/Codex SDK can run workflows or quick sessions/i)).toBeInTheDocument();
  });

  it('ignores programmatic changes to a runtime disabled for the current scope', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="workflow" />);

    fireEvent.change(screen.getByRole('combobox', { name: /select agent runtime/i }), {
      target: { value: 'codex-pty' },
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SubstrateSelector — interactive PTY-only lock', () => {
  beforeEach(() => mockUseForcedSubstrate.mockReturnValue('interactive'));

  it('renders the read-only locked state with caveats and no <select>', () => {
    render(<SubstrateSelector value="claude-interactive" onChange={vi.fn()} />);

    expect(screen.getByTestId('substrate-locked')).toBeInTheDocument();
    expect(screen.getByTestId('substrate-caveats')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('syncs the controlled value to interactive when it was sdk', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} />);

    expect(onChange).toHaveBeenCalledWith('claude-interactive');
  });

  it('does not re-fire onChange once the value is already interactive', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-interactive" onChange={onChange} />);

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SubstrateSelector — provider access toggles', () => {
  it('hides both Codex runtimes when the Codex provider is switched off', () => {
    setProviderAccess({ claude: true, codex: false });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByRole('option', { name: /Claude SDK/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Codex/i })).not.toBeInTheDocument();
    expect(screen.getByText(/turned off in Settings → Integrations are hidden/i)).toBeInTheDocument();
  });

  it('hides both Claude runtimes when the Claude provider is switched off', () => {
    setProviderAccess({ claude: false, codex: true });
    render(<SubstrateSelector value="codex-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.queryByRole('option', { name: /Claude/i })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).toBeInTheDocument();
  });

  it('snaps a selection whose provider was just switched off back to an available runtime', () => {
    const onChange = vi.fn();
    setProviderAccess({ claude: true, codex: false });
    render(<SubstrateSelector value="codex-sdk" onChange={onChange} runtimeScope="mixed" />);

    expect(onChange).toHaveBeenCalledWith('claude-sdk');
  });

  it('refuses a programmatic change to a runtime whose provider is switched off', () => {
    const onChange = vi.fn();
    setProviderAccess({ claude: true, codex: false });
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="mixed" />);

    fireEvent.change(screen.getByRole('combobox', { name: /select agent runtime/i }), {
      target: { value: 'codex-sdk' },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('offers everything when the toggles were never touched (absent config field)', () => {
    setProviderAccess(undefined);
    mockUseOmpAvailability.mockReturnValue(true);
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="mixed" />);

    expect(screen.getByRole('option', { name: /^Codex SDK$/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude SDK/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /OMP Fleet/i })).toBeInTheDocument();
    expect(screen.queryByText(/are hidden/i)).not.toBeInTheDocument();
  });

  it('hides OMP Fleet when the bridge is not configured (availability false)', () => {
    setProviderAccess(undefined);
    mockUseOmpAvailability.mockReturnValue(false);
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByRole('option', { name: /OMP Fleet/i })).not.toBeInTheDocument();
  });

  it('offers OMP Fleet when available and the omp provider is enabled', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    mockUseOmpAvailability.mockReturnValue(true);
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByRole('option', { name: /OMP Fleet/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /OMP Fleet/i })).not.toBeDisabled();
  });

  it('hides OMP Fleet when the omp provider toggle is off even if the bridge is configured', () => {
    setProviderAccess({ claude: true, codex: true, omp: false });
    mockUseOmpAvailability.mockReturnValue(true);
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByRole('option', { name: /OMP Fleet/i })).not.toBeInTheDocument();
  });

  it('surfaces the PTY-only ⨯ Claude-off conflict instead of a picker with no options', () => {
    mockUseForcedSubstrate.mockReturnValue('interactive');
    const onChange = vi.fn();
    setProviderAccess({ claude: false, codex: true });
    render(<SubstrateSelector value="codex-sdk" onChange={onChange} />);

    expect(screen.getByTestId('substrate-provider-conflict')).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    // The lock's claude-interactive sync must NOT fire onto a disabled provider.
    expect(onChange).not.toHaveBeenCalledWith('claude-interactive');
  });
});

describe('SubstrateSelector — demo pin (sdk wins)', () => {
  beforeEach(() => mockUseForcedSubstrate.mockReturnValue('sdk'));

  it('renders the normal select (not the interactive-locked UI) and leaves the value alone', () => {
    const onChange = vi.fn();
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} />);

    expect(screen.getByRole('combobox', { name: /select agent runtime/i })).toBeInTheDocument();
    expect(screen.queryByTestId('substrate-locked')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
