/**
 * Coachmark — the skip controls. Regression cover for the reported ambiguity:
 * the popover's "Skip" button quit the ENTIRE tour, indistinguishable from a
 * per-step skip. Now the quit control reads "Skip tour" on every surface, and
 * the advance-by-doing steps (6/10/11) get a secondary "Skip step" that moves
 * past just that step. The pointer steps (7-9) keep plain Next and must NOT
 * offer "Skip step" — a pointer skip would strand its anchor beat.
 *
 * Store-level skipStep() semantics live in onboardingStore.test.ts.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Coachmark } from './Coachmark';
import { ONBOARDING_ANCHOR_ATTR, ONBOARDING_ANCHORS } from '../../utils/onboarding';

const noop = (): void => {};

function mountAnchor(anchorId: string): void {
  const anchor = document.createElement('div');
  anchor.setAttribute(ONBOARDING_ANCHOR_ATTR, anchorId);
  document.body.appendChild(anchor);
}

describe('Coachmark skip controls', () => {
  beforeEach(() => {
    // jsdom does not implement scrollIntoView; the component feature-detects it.
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('offers "Skip step" on a do-step (6) next to the relabelled "Skip tour"', async () => {
    mountAnchor(ONBOARDING_ANCHORS.quickSessionCard);
    const onSkip = vi.fn();
    const onSkipStep = vi.fn();
    render(
      <Coachmark
        step={6}
        maxVisitedStep={6}
        onBack={noop}
        onSkip={onSkip}
        onSkipStep={onSkipStep}
        onGoTo={noop}
        onAnchorActioned={noop}
        onNext={noop}
        onForward={noop}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Skip step' }));
    expect(onSkipStep).toHaveBeenCalledTimes(1);
    expect(onSkip).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSkipStep).toHaveBeenCalledTimes(1); // the two controls stay distinct
  });

  it('keeps plain Next on a pointer step (7) and never renders "Skip step" there', async () => {
    mountAnchor(ONBOARDING_ANCHORS.substrateSelect);
    const onSkipStep = vi.fn();
    render(
      <Coachmark
        step={7}
        maxVisitedStep={7}
        onBack={noop}
        onSkip={noop}
        onSkipStep={onSkipStep}
        onGoTo={noop}
        onAnchorActioned={noop}
        onNext={noop}
        onForward={noop}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Skip tour' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip step' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next →' })).toBeInTheDocument();
  });

  it('carries both skip controls into the anchor-lost fallback (do-step 11)', async () => {
    // No anchor mounted: after the grace period the centered fallback appears.
    const onSkipStep = vi.fn();
    render(
      <Coachmark
        step={11}
        maxVisitedStep={11}
        onBack={noop}
        onSkip={noop}
        onSkipStep={onSkipStep}
        onGoTo={noop}
        onAnchorActioned={noop}
        onNext={noop}
        onForward={noop}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Skip step' }, { timeout: 3000 }));
    expect(onSkipStep).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeInTheDocument();
    // The fallback's forward escape is still the Continue force-advance.
    expect(screen.getByRole('button', { name: 'Continue →' })).toBeInTheDocument();
  });
});
