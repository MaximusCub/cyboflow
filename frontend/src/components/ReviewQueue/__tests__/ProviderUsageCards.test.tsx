/**
 * ProviderUsageCards — the subscription-headroom cards above the review queue.
 *
 * The behaviours worth locking are the ones that would otherwise MISLEAD:
 *   - a window the provider gave no percentage for must not render as 0%;
 *   - a card must disappear once its window's reset passes, even while mounted;
 *   - a provider switched off in Settings gets no card at all;
 *   - a stale reading is labelled stale rather than shown as current.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ProviderUsageState } from '../../../../../shared/types/providerUsage';

const mockUsage = { current: {} as ProviderUsageState };
const mockAccess = { current: undefined as unknown };

vi.mock('../../../stores/providerUsageSlice', () => ({
  useProviderUsageSlice: (selector: (s: unknown) => unknown) =>
    selector({ usage: mockUsage.current, init: () => () => {} }),
}));

vi.mock('../../../hooks/useAgentProviderAccess', () => ({
  useAgentProviderAccess: () => mockAccess.current,
}));

import { ProviderUsageCards } from '../ProviderUsageCards';

const NOW = 1_800_000_000_000;
const IN_AN_HOUR = NOW + 60 * 60 * 1_000;

function claudeState(usedPercent: number | null): ProviderUsageState {
  return {
    claude: {
      provider: 'claude',
      planType: null,
      observedAtMs: NOW,
      windows: [{
        kind: 'claude_five_hour',
        label: '5-hour session',
        status: usedPercent === null ? 'ok' : 'critical',
        usedPercent,
        resetsAtMs: IN_AN_HOUR,
        windowMinutes: null,
        observedAtMs: NOW,
      }],
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockUsage.current = {};
  mockAccess.current = undefined; // absent access config ⇒ claude/codex default ON
});

afterEach(() => { vi.useRealTimers(); });

describe('ProviderUsageCards', () => {
  it('renders nothing when no provider has reported', () => {
    const { container } = render(<ProviderUsageCards />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a status word, NOT 0%, when the provider reported no percentage', () => {
    mockUsage.current = claudeState(null);
    render(<ProviderUsageCards />);
    expect(screen.getByTestId('usage-no-percent')).toHaveTextContent('OK');
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('renders the percentage when the provider reported one', () => {
    mockUsage.current = claudeState(91);
    render(<ProviderUsageCards />);
    expect(screen.getByText('91%')).toBeInTheDocument();
    expect(screen.queryByTestId('usage-no-percent')).not.toBeInTheDocument();
  });

  it('leads with the time left in the window', () => {
    mockUsage.current = claudeState(91);
    render(<ProviderUsageCards />);
    expect(screen.getByTestId('usage-card-claude')).toHaveTextContent('1h 0m');
  });

  it('drops a card whose window resets while it stays mounted', () => {
    mockUsage.current = claudeState(91);
    render(<ProviderUsageCards />);
    expect(screen.getByTestId('usage-card-claude')).toBeInTheDocument();

    // No new push arrives — only the clock moves past the reset.
    act(() => { vi.setSystemTime(IN_AN_HOUR + 1_000); vi.advanceTimersByTime(30_000); });
    expect(screen.queryByTestId('usage-card-claude')).not.toBeInTheDocument();
  });

  it('flags a reading older than the stale threshold', () => {
    mockUsage.current = claudeState(91);
    render(<ProviderUsageCards />);
    expect(screen.getByTestId('usage-card-claude')).not.toHaveTextContent('no recent reading');

    act(() => { vi.setSystemTime(NOW + 31 * 60 * 1_000); vi.advanceTimersByTime(30_000); });
    expect(screen.getByTestId('usage-card-claude')).toHaveTextContent('no recent reading');
  });

  it('omits the card for a provider switched off in settings', () => {
    mockUsage.current = claudeState(91);
    mockAccess.current = { claude: false, codex: true };
    render(<ProviderUsageCards />);
    expect(screen.queryByTestId('usage-card-claude')).not.toBeInTheDocument();
  });

  it('renders both providers side by side, plan label included', () => {
    mockUsage.current = {
      ...claudeState(20),
      codex: {
        provider: 'codex',
        planType: 'prolite',
        observedAtMs: NOW,
        windows: [{
          kind: 'codex_primary',
          label: 'Weekly',
          status: 'warning',
          usedPercent: 59,
          resetsAtMs: IN_AN_HOUR,
          windowMinutes: 10080,
          observedAtMs: NOW,
        }],
      },
    };
    render(<ProviderUsageCards />);
    expect(screen.getByTestId('usage-card-claude')).toBeInTheDocument();
    expect(screen.getByTestId('usage-card-codex')).toHaveTextContent('prolite');
    expect(screen.getByText('59%')).toBeInTheDocument();
  });
});
