/**
 * TrackerUnlinkDialog — the local-removal ruling from
 * docs/proposals/tracker-sync-integration.md ("Deletes"): deleting or archiving
 * a LINKED backlog entity asks what should happen to the tracker issue before
 * the local delete runs. Exactly two answers, both of which drop the link:
 *
 *   Keep in <provider>   -> unlink only; the issue is left exactly as it is.
 *   Cancel in <provider> -> unlink AND queue the write that moves the issue into
 *                           the tracker's cancelled group.
 *
 * We never hard-delete on the remote side, so "cancel" is deliberately the
 * strongest option offered.
 *
 * THIS DIALOG ONLY COLLECTS THE ANSWER. Both buttons call
 * `cyboflow.tracker.stageUnlinkRuling`, which mutates NOTHING — it records the
 * ruling in the main process — and then hand control back through `onResolved`,
 * where the caller opens the ordinary archive/delete confirm. The ruling is
 * applied by that confirm's entity write when it commits, so backing out of it
 * leaves the entity, its link and the tracker issue all untouched and the unused
 * ruling simply expires. (The previous design unlinked here, up front: a user
 * who then cancelled the confirm kept the entity but had already lost the link
 * and possibly cancelled the remote issue.)
 *
 * `hasLinkedDescendants` says the delete will cascade into other synced entities
 * (an idea's epics/tasks, an epic's tasks); they inherit this same ruling, so
 * the copy says so before the user picks.
 *
 * Pure (no store reads) so it unit-tests with only the tRPC client mocked, and
 * mirrors the Backlog confirm dialogs' Modal/Header/Body/Footer shape.
 */
import { useEffect, useState } from 'react';
import { Link2Off, Ban } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../../ui/Modal';
import { trpc } from '../../../trpc/client';
import { providerMeta } from './trackerVocabulary';
import type {
  TrackerEntityLinkRef,
  TrackerEntityType,
} from '../../../../../shared/types/trackerSync';

interface TrackerUnlinkDialogProps {
  /** The entity the user is about to remove locally. */
  entityType: TrackerEntityType;
  entityId: string;
  /** Display ref of that entity ("TASK-001"), for the header. */
  entityRef: string;
  /** What happens once the ruling lands — only the copy differs. */
  action: 'delete' | 'archive';
  /** The live link, as read by `tracker.linkForEntity` on the delete intent. */
  link: TrackerEntityLinkRef;
  /**
   * The delete will also remove synced CHILDREN (`tracker.hasLinkedDescendants`).
   * Only ever true for an idea/epic delete; the ruling covers them too.
   */
  hasLinkedDescendants?: boolean;
  isOpen: boolean;
  /** Dismissed without a ruling — the caller aborts the delete/archive too. */
  onClose: () => void;
  /** The ruling is recorded; the caller opens its ordinary confirm dialog. */
  onResolved: () => void;
}

export function TrackerUnlinkDialog({
  entityType,
  entityId,
  entityRef,
  action,
  link,
  hasLinkedDescendants = false,
  isOpen,
  onClose,
  onResolved,
}: TrackerUnlinkDialogProps): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSubmitting(false);
    setError(null);
  }, [isOpen, entityId]);

  const providerName = providerMeta(link.provider).name;
  const issueLabel = link.externalIdentifier ?? 'the linked issue';
  const entityLabel = entityType === 'idea' ? 'idea' : entityType === 'epic' ? 'epic' : 'task';
  const actionLabel = action === 'archive' ? 'Archiving' : 'Deleting';
  // Children only ever go with a DELETE — archiving an idea leaves its epics and
  // tasks on the board, so the ruling has nothing to inherit it.
  const rulesChildren = action === 'delete' && hasLinkedDescendants;

  const rule = async (cancelRemote: boolean): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await trpc.cyboflow.tracker.stageUnlinkRuling.mutate({ entityType, entityId, cancelRemote });
      onResolved();
    } catch (err: unknown) {
      // Never fall through to the delete on a failed ruling: the user asked for
      // something to happen in the tracker, and silently skipping it is the one
      // outcome neither button offered.
      setError(
        err instanceof Error
          ? `Could not update ${providerName}: ${err.message}`
          : `Could not update ${providerName}.`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" showCloseButton={false}>
      <ModalHeader title={`${entityRef} is linked to ${providerName}`} onClose={onClose} />
      <ModalBody className="space-y-3">
        <div className="flex flex-col gap-2" data-testid="tracker-unlink-dialog">
          <p className="text-sm text-text-secondary">
            {actionLabel} this {entityLabel} does not delete{' '}
            <span className="font-semibold text-text-primary">{issueLabel}</span> in{' '}
            {providerName} — cyboflow never deletes issues in your tracker. Choose what happens to
            it:
          </p>
          {rulesChildren && (
            <p className="text-xs text-text-tertiary" data-testid="tracker-unlink-children-note">
              This {entityLabel}&apos;s synced sub-items are deleted with it, and your choice
              applies to their issues too.
            </p>
          )}
          <p className="text-xs text-text-tertiary">
            Either way the {entityLabel} stops syncing with {providerName}. Nothing happens until
            you confirm the {action} on the next step.
          </p>
          {error && (
            <p className="text-xs text-status-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={onClose}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void rule(false)}
          disabled={submitting}
          data-testid="tracker-unlink-keep"
          className="inline-flex items-center gap-1 rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Link2Off className="h-3.5 w-3.5" />
          Keep in {providerName}
        </button>
        <button
          type="button"
          onClick={() => void rule(true)}
          disabled={submitting}
          data-testid="tracker-unlink-cancel-remote"
          className="inline-flex items-center gap-1 rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Ban className="h-3.5 w-3.5" />
          Cancel in {providerName}
        </button>
      </ModalFooter>
    </Modal>
  );
}
