/**
 * TrackerUnlinkDialog — the local-removal ruling.
 *
 * Same harness as the other tracker component tests: the real component over a
 * module mock of the tRPC client.
 *
 * Coverage: both design choices are offered and named after the provider; each
 * STAGES its own `cancelRemote` — and stages ONLY, never `unlinkEntity`, so
 * nothing is mutated while the delete confirm behind this dialog is still
 * dismissible — and only then hands control back; the copy says so, and says the
 * ruling covers synced children on a cascading delete; dismissing rules nothing;
 * a rejected staging keeps the dialog open and does NOT let the delete through.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerEntityLinkRef } from '../../../../../shared/types/trackerSync';

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tracker: {
        stageUnlinkRuling: { mutate: vi.fn() },
        // Present but never expected to fire — the pre-confirm unlink is exactly
        // what this design removed.
        unlinkEntity: { mutate: vi.fn() },
      },
    },
  },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerUnlinkDialog } from './TrackerUnlinkDialog';
import { trpc } from '../../../trpc/client';

const mockStage = vi.mocked(trpc.cyboflow.tracker.stageUnlinkRuling.mutate);
const mockUnlink = vi.mocked(trpc.cyboflow.tracker.unlinkEntity.mutate);

const LINK: TrackerEntityLinkRef = {
  provider: 'linear',
  externalIdentifier: 'CORE-142',
  externalUrl: 'https://linear.app/acme/issue/CORE-142',
};

const onClose = vi.fn();
const onResolved = vi.fn();

function renderDialog(props: Partial<Parameters<typeof TrackerUnlinkDialog>[0]> = {}) {
  return render(
    <TrackerUnlinkDialog
      entityType="task"
      entityId="tsk_1"
      entityRef="TASK-001"
      action="delete"
      link={LINK}
      isOpen
      onClose={onClose}
      onResolved={onResolved}
      {...props}
    />,
  );
}

beforeEach(() => {
  mockStage.mockReset().mockResolvedValue({ ok: true });
  mockUnlink.mockReset().mockResolvedValue({ unlinked: true });
  onClose.mockReset();
  onResolved.mockReset();
});

describe('TrackerUnlinkDialog', () => {
  it('renders nothing when closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByTestId('tracker-unlink-dialog')).not.toBeInTheDocument();
  });

  it('offers exactly the two design choices, named after the provider', () => {
    renderDialog();
    expect(screen.getByTestId('tracker-unlink-keep')).toHaveTextContent('Keep in Linear');
    expect(screen.getByTestId('tracker-unlink-cancel-remote')).toHaveTextContent(
      'Cancel in Linear',
    );
    // The promise the design makes: cyboflow never deletes the remote issue.
    expect(screen.getByTestId('tracker-unlink-dialog')).toHaveTextContent(
      /never deletes issues in your tracker/i,
    );
    expect(screen.getByTestId('tracker-unlink-dialog')).toHaveTextContent('CORE-142');
    // ...and the staging promise: this dialog changes nothing on its own.
    expect(screen.getByTestId('tracker-unlink-dialog')).toHaveTextContent(
      /Nothing happens until you confirm/i,
    );
  });

  it('"Keep in <provider>" STAGES without cancelling, then releases the delete', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('tracker-unlink-keep'));

    await waitFor(() => expect(mockStage).toHaveBeenCalledTimes(1));
    expect(mockStage).toHaveBeenCalledWith({
      entityType: 'task',
      entityId: 'tsk_1',
      cancelRemote: false,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    // The old design's pre-confirm mutation is gone for good.
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('"Cancel in <provider>" stages the remote cancel, then releases the delete', async () => {
    renderDialog({ action: 'archive', entityType: 'idea', entityId: 'ide_9' });
    fireEvent.click(screen.getByTestId('tracker-unlink-cancel-remote'));

    await waitFor(() => expect(mockStage).toHaveBeenCalledTimes(1));
    expect(mockStage).toHaveBeenCalledWith({
      entityType: 'idea',
      entityId: 'ide_9',
      cancelRemote: true,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('says the ruling covers synced children when the delete will cascade', () => {
    renderDialog({ entityType: 'idea', entityId: 'ide_9', hasLinkedDescendants: true });
    expect(screen.getByTestId('tracker-unlink-children-note')).toHaveTextContent(
      /applies to their issues too/i,
    );
  });

  it('says nothing about children on an ARCHIVE — archiving takes none with it', () => {
    renderDialog({
      action: 'archive',
      entityType: 'idea',
      entityId: 'ide_9',
      hasLinkedDescendants: true,
    });
    expect(screen.queryByTestId('tracker-unlink-children-note')).not.toBeInTheDocument();
  });

  it('dismissing rules nothing and lets no delete through', () => {
    renderDialog();
    fireEvent.click(screen.getByText('Cancel'));

    expect(mockStage).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and blocks the delete when staging fails', async () => {
    mockStage.mockRejectedValueOnce(new Error('tracker unreachable'));
    renderDialog();
    fireEvent.click(screen.getByTestId('tracker-unlink-cancel-remote'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not update Linear/i);
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByTestId('tracker-unlink-dialog')).toBeInTheDocument();
  });
});
