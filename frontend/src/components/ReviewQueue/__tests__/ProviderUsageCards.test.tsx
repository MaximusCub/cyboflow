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

const mockRefresh = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../stores/providerUsageSlice', () => ({
  useProviderUsageSlice: (selector: (s: unknown) => unknown) =>
    selector({ usage: mockUsage.current, init: () => () => {}, refresh: mockRefresh }),
}));

vi.mock('../../../hooks/useAgentProviderAccess', () => ({
  useAgentProviderAccess: () => mockAccess.current,
}));

import { ProviderUsageCards } from '../ProviderUsageCards';

const NOW = 1_800_000_000_000;
const IN_AN_HOUR = NOW + 60 * 60 * 1_000;

function claudeState(
  usedPercent: number | null,
  percentSource: 'poll' | 'stream' = 'poll',
): ProviderUsageState {
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
        percentSource: usedPercent === null ? null : percentSource,
        percentObservedAtMs: usedPercent === null ? null : NOW,
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
  mockRefresh.mockClear();
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

  it('leads with the time left in the window, NAMING the window', () => {
    mockUsage.current = claudeState(91);
    render(<ProviderUsageCards />);
    const card = screen.getByTestId('usage-card-claude');
    expect(card).toHaveTextContent('1h 0m');
    // The lead is the most-CONSTRAINED window, not necessarily the session one —
    // labelling a weekly window "of session left" was simply wrong.
    expect(card).toHaveTextContent('left in 5-hour session');
  });

  it('names the leading window when it is the weekly one, not "session"', () => {
    mockUsage.current = {
      claude: {
        provider: 'claude',
        planType: 'max',
        observedAtMs: NOW,
        windows: [
          {
            kind: 'claude_seven_day', label: 'Weekly', status: 'ok', usedPercent: 13,
            percentSource: 'poll', percentObservedAtMs: NOW,
            resetsAtMs: NOW + 5 * 24 * 60 * 60 * 1_000, windowMinutes: null, observedAtMs: NOW,
          },
          {
            kind: 'claude_five_hour', label: '5-hour session', status: 'ok', usedPercent: 3,
            percentSource: 'poll', percentObservedAtMs: NOW,
            resetsAtMs: IN_AN_HOUR, windowMinutes: null, observedAtMs: NOW,
          },
        ],
      },
    };
    render(<ProviderUsageCards />);
    const card = screen.getByTestId('usage-card-claude');
    expect(card).toHaveTextContent('left in Weekly');
    expect(card).not.toHaveTextContent('of session left');
  });

  it('includes a weekday for a reset more than a day out', () => {
    const resetsAtMs = NOW + 5 * 24 * 60 * 60 * 1_000;
    mockUsage.current = {
      claude: {
        provider: 'claude', planType: 'max', observedAtMs: NOW,
        windows: [{
          kind: 'claude_seven_day', label: 'Weekly', status: 'ok', usedPercent: 13,
          percentSource: 'poll', percentObservedAtMs: NOW,
          resetsAtMs, windowMinutes: null, observedAtMs: NOW,
        }],
      },
    };
    render(<ProviderUsageCards />);
    // A bare "resets 9:00 AM" for a window five days out reads as this morning.
    const weekday = new Date(resetsAtMs).toLocaleDateString([], { weekday: 'short' });
    expect(screen.getByTestId('usage-card-claude')).toHaveTextContent(`resets ${weekday}`);
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

  it('asks the providers directly on mount', () => {
    mockUsage.current = claudeState(91);
    render(<ProviderUsageCards />);
    // Without a poll the meters would show only what a turn happened to mention.
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('flags a STREAM-sourced percentage as possibly stale', () => {
    mockUsage.current = claudeState(91, 'stream');
    render(<ProviderUsageCards />);
    expect(screen.getByTestId('usage-stale-flag')).toHaveTextContent('may be stale');
  });

  it('does NOT flag a polled percentage', () => {
    mockUsage.current = claudeState(91, 'poll');
    render(<ProviderUsageCards />);
    expect(screen.queryByTestId('usage-stale-flag')).not.toBeInTheDocument();
  });

  it('does not flag a window that has no percentage at all', () => {
    // "Unknown" is a different statement from "possibly out of date".
    mockUsage.current = claudeState(null, 'stream');
    render(<ProviderUsageCards />);
    expect(screen.queryByTestId('usage-stale-flag')).not.toBeInTheDocument();
    expect(screen.getByTestId('usage-no-percent')).toBeInTheDocument();
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
          percentSource: 'poll',
          percentObservedAtMs: NOW,
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
