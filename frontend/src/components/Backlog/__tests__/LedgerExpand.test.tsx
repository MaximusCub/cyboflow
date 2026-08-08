/**
 * LedgerExpand — dedicated coverage for the manual-override control (FIND:
 * the "Not started / needs review" option conflated two states and silently
 * destroyed a stale marker). TaskCard.test.tsx covers the surrounding chip/
 * expand-toggle behavior end-to-end via BoardCard; this file drives
 * LedgerExpand directly so the override-label and destructive-confirm
 * assertions don't ride on that larger fixture.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDEA_COMPONENT_KEYS } from '../../../../../shared/types/ideaComponents';
import type { IdeaComponentState } from '../../../../../shared/types/ideaComponents';

const { setStateMock } = vi.hoisted(() => ({ setStateMock: vi.fn() }));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      ideaComponents: {
        setState: { mutate: setStateMock },
      },
    },
  },
}));

import { LedgerExpand } from '../LedgerExpand';

beforeEach(() => {
  setStateMock.mockReset();
});

/** All five ledger components, each defaulted to 'not started' unless overridden by key. */
function makeComponents(
  overrides: Partial<Record<(typeof IDEA_COMPONENT_KEYS)[number], Partial<IdeaComponentState>>> = {},
): IdeaComponentState[] {
  return IDEA_COMPONENT_KEYS.map((component) => ({
    component,
    state: 'incomplete',
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt: null,
    staleReason: null,
    updatedAt: null,
    ...overrides[component],
  }));
}

describe('LedgerExpand override options', () => {
  it('labels the incomplete option for what it actually does ("Not started"), never claiming a manual "needs review"', () => {
    render(<LedgerExpand ideaId="idea_1" components={makeComponents()} now={Date.now()} />);
    const select = screen.getByTestId('ledger-override-prototype') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.text);
    expect(optionLabels).toEqual(['Not started', 'Complete', 'Skipped']);
    expect(optionLabels).not.toContain('Not started / needs review');
  });

  it('commits immediately when overriding a not-started (never-stale) row', async () => {
    setStateMock.mockResolvedValueOnce(makeComponents({ prototype: { state: 'complete' } }));
    render(<LedgerExpand ideaId="idea_1" components={makeComponents()} now={Date.now()} />);

    fireEvent.change(screen.getByTestId('ledger-override-prototype'), { target: { value: 'complete' } });

    await waitFor(() =>
      expect(setStateMock).toHaveBeenCalledWith({ ideaId: 'idea_1', component: 'prototype', state: 'complete' }),
    );
  });
});

describe('LedgerExpand destructive-demote confirm', () => {
  function staleComponents(): IdeaComponentState[] {
    return makeComponents({
      prototype: { state: 'incomplete', staleAt: '2026-08-01T00:00:00Z', staleReason: 'idea body changed' },
    });
  }

  it('does NOT commit immediately when demoting a currently needs-review row to Not started — it stages a confirm', () => {
    render(<LedgerExpand ideaId="idea_1" components={staleComponents()} now={Date.now()} />);

    fireEvent.change(screen.getByTestId('ledger-override-prototype'), { target: { value: 'incomplete' } });

    expect(setStateMock).not.toHaveBeenCalled();
    expect(screen.getByText('Mark Prototype as not started?')).toBeInTheDocument();
    expect(screen.getByText(/currently needs review/)).toHaveTextContent('idea body changed');
  });

  it('Cancel on the confirm leaves the row untouched — no mutation fires, the stale marker survives', () => {
    render(<LedgerExpand ideaId="idea_1" components={staleComponents()} now={Date.now()} />);

    fireEvent.change(screen.getByTestId('ledger-override-prototype'), { target: { value: 'incomplete' } });
    fireEvent.click(screen.getByText('Cancel'));

    expect(setStateMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Mark Prototype as not started?')).not.toBeInTheDocument();
    // Row still reads "needs review" — the select reverts to the untouched entry.state.
    expect(screen.getByTestId('ledger-row-prototype')).toHaveTextContent('Needs review');
  });

  it('confirming commits the override with the chosen (incomplete) state', async () => {
    setStateMock.mockResolvedValueOnce(makeComponents({ prototype: { state: 'incomplete' } }));
    render(<LedgerExpand ideaId="idea_1" components={staleComponents()} now={Date.now()} />);

    fireEvent.change(screen.getByTestId('ledger-override-prototype'), { target: { value: 'incomplete' } });
    fireEvent.click(screen.getByText('Mark not started'));

    await waitFor(() =>
      expect(setStateMock).toHaveBeenCalledWith({ ideaId: 'idea_1', component: 'prototype', state: 'incomplete' }),
    );
  });

  it('does NOT stage a confirm for complete/skipped overrides on a needs-review row — only the demote-to-incomplete transition is guarded', async () => {
    setStateMock.mockResolvedValueOnce(makeComponents({ prototype: { state: 'complete' } }));
    render(<LedgerExpand ideaId="idea_1" components={staleComponents()} now={Date.now()} />);

    fireEvent.change(screen.getByTestId('ledger-override-prototype'), { target: { value: 'complete' } });

    await waitFor(() =>
      expect(setStateMock).toHaveBeenCalledWith({ ideaId: 'idea_1', component: 'prototype', state: 'complete' }),
    );
    expect(screen.queryByText('Mark Prototype as not started?')).not.toBeInTheDocument();
  });

  it('does NOT stage a confirm when demoting a row that is not-started already (no stale marker to lose)', async () => {
    setStateMock.mockResolvedValueOnce(makeComponents());
    render(<LedgerExpand ideaId="idea_1" components={makeComponents()} now={Date.now()} />);

    fireEvent.change(screen.getByTestId('ledger-override-prototype'), { target: { value: 'incomplete' } });

    await waitFor(() =>
      expect(setStateMock).toHaveBeenCalledWith({ ideaId: 'idea_1', component: 'prototype', state: 'incomplete' }),
    );
  });
});
