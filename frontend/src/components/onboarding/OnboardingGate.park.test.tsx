/**
 * OnboardingGate — the parked state (status 'pending'). Regression cover: the
 * overlay used to vanish when the tour parked, reading as the tour having
 * ended. Pins that the paused card appears for both park sites (copy keyed off
 * the parked step), that a real event clears it immediately, and that its
 * "Skip tour" button quits the tour. Store-level pending semantics live in
 * onboardingStore.test.ts; this file exercises the gate's rendering of them.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OnboardingGate } from './OnboardingGate';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { ONBOARDING_EVENTS } from '../../utils/onboarding';

const trackEvent = vi.fn();
const projectsGetAll = vi.fn();

vi.mock('../../utils/telemetry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/telemetry')>();
  return { ...actual, trackEvent: (...a: unknown[]) => trackEvent(...a) };
});

vi.mock('../../utils/api', () => ({
  API: {
    projects: { getAll: (...a: unknown[]) => projectsGetAll(...a) },
    dialog: { openFile: vi.fn(), openDirectory: vi.fn() },
  },
}));

const INITIAL_ONBOARDING_STATE = {
  status: 'idle' as const,
  step: 0,
  maxVisitedStep: 0,
  replay: false,
  detection: null,
  connected: false,
  codexDetection: null,
  codexConnected: false,
  permMode: 'auto' as const,
  defaultProvider: null,
  multiRuntime: true,
  skippedDoSteps: new Set<number>(),
  hydrated: false,
};

beforeEach(() => {
  trackEvent.mockReset();
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  useOnboardingStore.setState(INITIAL_ONBOARDING_STATE);
});

/** Renders the gate, waits for boot hydration, then parks the tour at `step`. */
async function mountParkedAtStep(step: number): Promise<void> {
  render(<OnboardingGate />);
  await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
  act(() => {
    useOnboardingStore.setState({ status: 'pending', step, maxVisitedStep: step });
  });
}

describe('OnboardingGate — the parked card (status pending)', () => {
  it('renders the paused card after step 9 parks, instead of vanishing', async () => {
    await mountParkedAtStep(9);

    const card = await screen.findByTestId('onboarding-paused-card');
    expect(card).toHaveTextContent('Tour paused');
    // Copy keyed off the parked step: 9 waits on the quick session.
    expect(card).toHaveTextContent(/quick session/i);
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeInTheDocument();
  });

  it('clears the moment quick-session-created lands, advancing to step 10', async () => {
    await mountParkedAtStep(9);
    await screen.findByTestId('onboarding-paused-card');

    act(() => {
      window.dispatchEvent(new CustomEvent(ONBOARDING_EVENTS.quickSessionCreated));
    });

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(10));
    expect(useOnboardingStore.getState().status).toBe('active');
    await waitFor(() =>
      expect(screen.queryByTestId('onboarding-paused-card')).not.toBeInTheDocument(),
    );
  });

  it('keys the copy off step 10’s park (waiting on the workflow run)', async () => {
    await mountParkedAtStep(10);

    const card = await screen.findByTestId('onboarding-paused-card');
    expect(card).toHaveTextContent(/workflow/i);
    expect(card).not.toHaveTextContent(/quick session/i);
  });

  it('Skip tour on the parked card quits the tour (status → skipped)', async () => {
    await mountParkedAtStep(9);
    await screen.findByTestId('onboarding-paused-card');

    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));

    expect(useOnboardingStore.getState().status).toBe('skipped');
    expect(useOnboardingStore.getState().step).toBe(9); // kept for the resume card
    await waitFor(() =>
      expect(screen.queryByTestId('onboarding-paused-card')).not.toBeInTheDocument(),
    );
  });
});
