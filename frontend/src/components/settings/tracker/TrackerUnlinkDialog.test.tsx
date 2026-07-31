/**
 * TrackerUnlinkDialog — the local-delete ruling.
 *
 * Same harness as the other tracker component tests: the real component over a
 * module mock of the tRPC client.
 *
 * Coverage: both design choices are offered and named after the provider; each
 * fires `unlinkEntity` with its own `cancelRemote` and only then hands control
 * back for the delete/archive; dismissing rules nothing; a rejected ruling keeps
 * the dialog open and does NOT let the delete through.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerEntityLinkRef } from '../../../../../shared/types/trackerSync';

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { tracker: { unlinkEntity: { mutate: vi.fn() } } } },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerUnlinkDialog } from './TrackerUnlinkDialog';
import { trpc } from '../../../trpc/client';

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
  });

  it('"Keep in <provider>" unlinks WITHOUT cancelling, then releases the delete', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('tracker-unlink-keep'));

    await waitFor(() => expect(mockUnlink).toHaveBeenCalledTimes(1));
    expect(mockUnlink).toHaveBeenCalledWith({
      entityType: 'task',
      entityId: 'tsk_1',
      cancelRemote: false,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('"Cancel in <provider>" unlinks WITH the remote cancel, then releases the delete', async () => {
    renderDialog({ action: 'archive', entityType: 'idea', entityId: 'ide_9' });
    fireEvent.click(screen.getByTestId('tracker-unlink-cancel-remote'));

    await waitFor(() => expect(mockUnlink).toHaveBeenCalledTimes(1));
    expect(mockUnlink).toHaveBeenCalledWith({
      entityType: 'idea',
      entityId: 'ide_9',
      cancelRemote: true,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it('dismissing rules nothing and lets no delete through', () => {
    renderDialog();
    fireEvent.click(screen.getByText('Cancel'));

    expect(mockUnlink).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and blocks the delete when the ruling fails', async () => {
    mockUnlink.mockRejectedValueOnce(new Error('tracker unreachable'));
    renderDialog();
    fireEvent.click(screen.getByTestId('tracker-unlink-cancel-remote'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not update Linear/i);
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByTestId('tracker-unlink-dialog')).toBeInTheDocument();
  });
});
