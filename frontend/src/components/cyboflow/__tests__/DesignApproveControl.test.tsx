/**
 * DesignApproveControl tests — the canvas-header Approve button + draft-
 * freshness indicator for a design session's ui-prototype artifact.
 *
 * Mocks trpc.cyboflow.design (draftStatus query + approve mutate) the same
 * way ArtifactTabRenderer.test.tsx mocks the trpc client — a module-level
 * vi.fn() per procedure, reset in beforeEach.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesignApproveControl } from '../DesignApproveControl';

const draftStatusQuery = vi.fn();
const approveMutate = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      design: {
        draftStatus: { query: (...args: unknown[]) => draftStatusQuery(...args) },
        approve: { mutate: (...args: unknown[]) => approveMutate(...args) },
      },
    },
  },
}));

function makeStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    latestDraftRevision: 4,
    boundArtifactRevision: 5,
    currentPrototypeRevision: 5,
    prototypeArtifactId: 'art-9',
    ideaVersion: 7,
    ideaTitle: 'Nice Idea',
    linkBroken: false,
    ...overrides,
  };
}

describe('DesignApproveControl', () => {
  beforeEach(() => {
    draftStatusQuery.mockReset();
    approveMutate.mockReset();
  });

  it('(a) renders the no-draft hint and no button when status is null', async () => {
    draftStatusQuery.mockResolvedValue(null);
    render(<DesignApproveControl sessionId="sess-1" />);

    expect(await screen.findByTestId('design-approve-no-draft')).toHaveTextContent('No design-spec draft yet');
    expect(screen.queryByTestId('design-approve-button')).not.toBeInTheDocument();
    expect(draftStatusQuery).toHaveBeenCalledWith({ sessionId: 'sess-1' });
  });

  it('(b) disables Approve with the stale freshness message when revisions differ', async () => {
    draftStatusQuery.mockResolvedValue(
      makeStatus({ latestDraftRevision: 3, boundArtifactRevision: 3, currentPrototypeRevision: 5 }),
    );
    render(<DesignApproveControl sessionId="sess-1" />);

    const freshness = await screen.findByTestId('design-approve-freshness');
    expect(freshness).toHaveTextContent('Draft r3 · prototype at r5 — ask the agent to refresh the draft');
    expect(screen.getByTestId('design-approve-button')).toBeDisabled();
  });

  it('(b2) disables Approve when no prototype is bound yet', async () => {
    draftStatusQuery.mockResolvedValue(
      makeStatus({ latestDraftRevision: 1, boundArtifactRevision: null, currentPrototypeRevision: null }),
    );
    render(<DesignApproveControl sessionId="sess-1" />);

    const freshness = await screen.findByTestId('design-approve-freshness');
    expect(freshness).toHaveTextContent('Draft r1 · no prototype bound yet — ask the agent to report one');
    expect(screen.getByTestId('design-approve-button')).toBeDisabled();
  });

  it('(c) in-sync enables Approve; confirm flow calls approve with the exact payload', async () => {
    draftStatusQuery.mockResolvedValue(makeStatus());
    approveMutate.mockResolvedValue({ ok: true, handoffId: 'handoff-1' });
    render(<DesignApproveControl sessionId="sess-1" artifactRevision={5} />);

    expect(await screen.findByTestId('design-approve-freshness')).toHaveTextContent('Draft r4 · in sync');
    const approveBtn = screen.getByTestId('design-approve-button');
    expect(approveBtn).not.toBeDisabled();

    fireEvent.click(approveBtn);
    expect(screen.getByTestId('design-approve-confirm-prompt')).toHaveTextContent('Confirm fold into Nice Idea?');

    fireEvent.click(screen.getByTestId('design-approve-confirm-yes'));

    await waitFor(() =>
      expect(approveMutate).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        draftRevision: 4,
        expectedIdeaVersion: 7,
      }),
    );

    expect(await screen.findByTestId('design-approve-success')).toHaveTextContent(
      'Approved ✓ — spec folded into the idea',
    );
    // Refetched after the approve attempt.
    await waitFor(() => expect(draftStatusQuery).toHaveBeenCalledTimes(2));
  });

  it('cancel backs out of the confirm step without calling approve', async () => {
    draftStatusQuery.mockResolvedValue(makeStatus());
    render(<DesignApproveControl sessionId="sess-1" />);

    fireEvent.click(await screen.findByTestId('design-approve-button'));
    expect(screen.getByTestId('design-approve-confirm-prompt')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('design-approve-confirm-cancel'));
    expect(screen.queryByTestId('design-approve-confirm-prompt')).not.toBeInTheDocument();
    expect(screen.getByTestId('design-approve-button')).toBeInTheDocument();
    expect(approveMutate).not.toHaveBeenCalled();
  });

  it('(d) surfaces result.message inline on { ok: false } and refetches', async () => {
    draftStatusQuery.mockResolvedValue(makeStatus());
    approveMutate.mockResolvedValue({
      ok: false,
      code: 'stale-draft',
      message: 'The prototype has advanced past this draft — refresh and try again.',
    });
    render(<DesignApproveControl sessionId="sess-1" />);

    fireEvent.click(await screen.findByTestId('design-approve-button'));
    fireEvent.click(screen.getByTestId('design-approve-confirm-yes'));

    expect(
      await screen.findByTestId('design-approve-result'),
    ).toHaveTextContent('The prototype has advanced past this draft — refresh and try again.');
    // No success line, and the button is re-enabled (not stuck pending).
    expect(screen.queryByTestId('design-approve-success')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('design-approve-button')).not.toBeDisabled());
    await waitFor(() => expect(draftStatusQuery).toHaveBeenCalledTimes(2));
  });

  it('(e) shows the link-broken chip with Approve disabled', async () => {
    draftStatusQuery.mockResolvedValue(
      makeStatus({ linkBroken: true, ideaVersion: null, ideaTitle: null }),
    );
    render(<DesignApproveControl sessionId="sess-1" />);

    expect(await screen.findByTestId('design-link-broken-chip')).toHaveTextContent(
      'Idea link broken — relink or end session',
    );
    expect(screen.getByTestId('design-approve-button')).toBeDisabled();
  });

  it('refetches when the artifactRevision prop changes', async () => {
    draftStatusQuery.mockResolvedValue(makeStatus());
    const { rerender } = render(<DesignApproveControl sessionId="sess-1" artifactRevision={5} />);
    await screen.findByTestId('design-approve-freshness');
    expect(draftStatusQuery).toHaveBeenCalledTimes(1);

    rerender(<DesignApproveControl sessionId="sess-1" artifactRevision={6} />);
    await waitFor(() => expect(draftStatusQuery).toHaveBeenCalledTimes(2));
  });
});
