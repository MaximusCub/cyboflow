/**
 * QueueHeader — the page title band: an eyebrow kicker over "<N> waiting on you".
 *
 * There is deliberately NO header-right block. An earlier revision carried a
 * "N blocking a sprint | Project overview →" cluster there; it was removed
 * because the count it repeated is already the headline and the link belonged
 * to a different surface.
 *
 * The count's color is the page's one-glance signal, so it tracks the derived
 * {@link QueuePageState} rather than the number alone:
 *   - accent   — the normal "here is your pile" state,
 *   - green    — caught up (a zero worth celebrating),
 *   - muted    — a bootstrap zero (no sessions/projects/accounts) that means
 *                "nothing exists yet", not "you cleared it",
 *   - em dash  — the load failed, so no count is knowable. Rendering `0` there
 *                would assert something we cannot see.
 */
import React from 'react';
import type { QueuePageState } from '../../utils/reviewQueuePageState';

export interface QueueHeaderProps {
  waitingCount: number;
  state: QueuePageState;
}

/** QueueHeader — see {@link QueueHeaderProps}. */
export function QueueHeader({ waitingCount, state }: QueueHeaderProps): React.JSX.Element {
  const isBootstrapZero =
    state === 'no-sessions' || state === 'no-projects' || state === 'no-accounts';
  const countClass =
    state === 'error' || isBootstrapZero
      ? 'text-text-muted'
      : state === 'caught-up'
        ? 'text-status-success'
        : 'text-interactive';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="eyebrow text-text-tertiary">Human review queue</div>
      <h1 className="text-[24px] font-bold tracking-[-0.01em] text-text-primary">
        <span className={`tabular-nums ${countClass}`} data-testid="rq-header-count">
          {state === 'error' ? '—' : waitingCount}
        </span>{' '}
        waiting on you
      </h1>
    </div>
  );
}
