/**
 * RecommendedActionsSection — per-kind card rendering, Dismiss wiring,
 * overflow reveal, and the busy/spinner state on the acting card's CTA.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import type { RecommendedAction } from '../../../utils/recommendedActions';
import { RecommendedActionsSection } from '../RecommendedActionsSection';

function reviewBlocked(): RecommendedAction {
  return {
    kind: 'review-blocked',
    id: 'review-blocked',
    title: 'Review the session needing your attention',
    description: '1 session is blocked on your answer — tidy-valley.',
    ctaLabel: 'Review now',
    dismissible: false,
    signature: 'tidy-valley',
    sessionIds: ['sess-1'],
  };
}

function mergeClean(id: string, signature: string): RecommendedAction {
  return {
    kind: 'merge-clean',
    id,
    title: 'Merge 1 clean session',
    description: 'busy-otter (↑3) is ready to merge with a clean tree.',
    ctaLabel: 'Review & merge',
    dismissible: true,
    signature,
    sessionIds: ['sess-2'],
  };
}

function launchSprint(id: string): RecommendedAction {
  return {
    kind: 'launch-sprint',
    id,
    title: 'Launch a sprint',
    description: '3 tasks are ready for development.',
    ctaLabel: 'Launch sprint',
    dismissible: true,
    signature: `${id}-sig`,
    projectId: 1,
    taskIds: ['t1', 't2', 't3'],
  };
}

describe('RecommendedActionsSection', () => {
  it('renders nothing when there are no visible cards', () => {
    const { container } = render(
      <RecommendedActionsSection visible={[]} hidden={[]} onAct={vi.fn()} onDismiss={vi.fn()} busyActionId={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a card per kind with the kind-scoped testid', () => {
    const actions = [reviewBlocked(), mergeClean('merge-clean', 'sig-1')];
    render(<RecommendedActionsSection visible={actions} hidden={[]} onAct={vi.fn()} onDismiss={vi.fn()} busyActionId={null} />);

    expect(screen.getByTestId('rq-action-card-review-blocked')).toBeInTheDocument();
    expect(screen.getByTestId('rq-action-card-merge-clean')).toBeInTheDocument();
  });

  it('fires onAct with the action when the CTA is clicked', async () => {
    const user = userEvent.setup();
    const onAct = vi.fn();
    const action = reviewBlocked();
    render(<RecommendedActionsSection visible={[action]} hidden={[]} onAct={onAct} onDismiss={vi.fn()} busyActionId={null} />);

    await user.click(screen.getByText('Review now'));
    expect(onAct).toHaveBeenCalledWith(action);
  });

  it('renders Dismiss only for dismissible cards and fires onDismiss for that card only', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const blocked = reviewBlocked(); // not dismissible
    const clean = mergeClean('merge-clean', 'sig-1'); // dismissible
    render(
      <RecommendedActionsSection visible={[blocked, clean]} hidden={[]} onAct={vi.fn()} onDismiss={onDismiss} busyActionId={null} />,
    );

    const blockedCard = screen.getByTestId('rq-action-card-review-blocked');
    const cleanCard = screen.getByTestId('rq-action-card-merge-clean');
    expect(blockedCard.querySelector('button')?.textContent).not.toMatch(/Dismiss/);
    const dismissButtons = screen.getAllByText('Dismiss');
    expect(dismissButtons).toHaveLength(1);

    await user.click(dismissButtons[0]);
    expect(onDismiss).toHaveBeenCalledWith(clean);
    expect(cleanCard).toBeInTheDocument();
  });

  it('reveals hidden cards behind "+N more" and can collapse again', async () => {
    const user = userEvent.setup();
    const visible = [reviewBlocked()];
    const hidden = [mergeClean('merge-clean', 'sig-1'), launchSprint('launch-sprint:1')];
    render(<RecommendedActionsSection visible={visible} hidden={hidden} onAct={vi.fn()} onDismiss={vi.fn()} busyActionId={null} />);

    expect(screen.queryByTestId('rq-action-card-merge-clean')).not.toBeInTheDocument();
    await user.click(screen.getByText('+2 more ▾'));
    expect(screen.getByTestId('rq-action-card-merge-clean')).toBeInTheDocument();
    expect(screen.getByTestId('rq-action-card-launch-sprint')).toBeInTheDocument();

    await user.click(screen.getByText('Show fewer ▴'));
    expect(screen.queryByTestId('rq-action-card-merge-clean')).not.toBeInTheDocument();
  });

  it('disables and labels the CTA "Launching…" only for the busy card', () => {
    const a = mergeClean('merge-clean', 'sig-1');
    const b = launchSprint('launch-sprint:1');
    render(
      <RecommendedActionsSection visible={[a, b]} hidden={[]} onAct={vi.fn()} onDismiss={vi.fn()} busyActionId={a.id} />,
    );

    const cardA = screen.getByTestId('rq-action-card-merge-clean');
    const cardB = screen.getByTestId('rq-action-card-launch-sprint');
    expect(cardA.querySelector('button')).toBeDisabled();
    expect(cardA.querySelector('button')?.textContent).toBe('Launching…');
    expect(cardB.querySelector('button')).not.toBeDisabled();
    expect(cardB.querySelector('button')?.textContent).toBe('Launch sprint');
  });
});
