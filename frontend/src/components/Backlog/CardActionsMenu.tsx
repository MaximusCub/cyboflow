/**
 * CardActionsMenu — the per-card "⋯" overflow menu on backlog cards.
 *
 * Holds the secondary actions (kept out of the footer's primary Edit / Run
 * row): "Change stage…" (opens the warned {@link StageChangeDialog}),
 * "Archive" / "Unarchive" (archive-in-place — Archive confirms via
 * {@link ArchiveConfirmDialog}; Unarchive mutates `tasks.archive
 * {archived:false}` directly, no dialog), and the danger "Delete" (opens
 * {@link DeleteConfirmDialog}). Reads the boards (cross-project store) so it
 * stays a leaf with a single `task` prop — no board prop-drilling through the
 * Kanban/List card tree.
 *
 * Change stage / Archive / Delete are disabled while the card has an active
 * run (the chokepoint rejects each with `active_runs`); Unarchive is never
 * guarded. `isArchived` reads the `archived_at` stamp — archiving no longer
 * moves the item to a terminal stage.
 *
 * THE TRACKER RULING. Archive and Delete are the app's user-initiated removal
 * chokepoint (every board surface funnels its ⋯ menu through here), so this is
 * also where the tracker-sync local-removal prompt lives: the click first asks
 * `tracker.linkForEntity`, and a LINKED entity gets {@link TrackerUnlinkDialog}
 * — keep the issue as it is, or cancel it in the tracker — before the ordinary
 * confirm dialog opens. An unlinked entity (the overwhelmingly common case) is
 * unchanged apart from that one query.
 *
 * The ruling dialog only RECORDS the answer; it is applied by the delete/archive
 * the confirm dialog then performs. So the two dialogs compose the obvious way:
 * dismissing either one leaves the entity, its link and the tracker issue
 * exactly as they were. A linked idea/epic additionally asks
 * `tracker.hasLinkedDescendants` so the ruling dialog can say the answer covers
 * the synced children the delete cascade takes with it.
 *
 * When `onReorder` is wired (Kanban board cards only), the menu also exposes
 * "Move up" / "Move down" / "Move to top" — the keyboard / single-pointer
 * alternative to drag-reorder (WCAG 2.5.7), driving the SAME reorder core as
 * DnD. Without it (ListView, epic children) the Move items are hidden and the
 * menu renders exactly as before.
 */
import { useState } from 'react';
import {
  MoreHorizontal,
  ArrowRightLeft,
  Archive,
  ArchiveRestore,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowUpToLine,
} from 'lucide-react';
import { Dropdown, type DropdownItem } from '../ui/Dropdown';
import { useBacklogStore } from '../../stores/backlogStore';
import { trpc } from '../../trpc/client';
import { pickDefaultBoard, friendlyStageError } from './backlogSelectors';
import { StageChangeDialog } from './StageChangeDialog';
import { ArchiveConfirmDialog } from './ArchiveConfirmDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { TrackerUnlinkDialog } from '../settings/tracker/TrackerUnlinkDialog';
import type { BacklogTaskItem } from '../../../../shared/types/tasks';
import type { TrackerEntityLinkRef } from '../../../../shared/types/trackerSync';

/** Context-menu reorder direction (translated to a post-move index upstream). */
export type ReorderDirection = 'up' | 'down' | 'top';

/** The two actions that remove a card from the board and so need the tracker ruling. */
type DestructiveIntent = 'archive' | 'delete';

interface CardActionsMenuProps {
  task: BacklogTaskItem;
  /**
   * Re-rank the card within its rendered stage column — the keyboard /
   * single-pointer alternative to drag-reorder (WCAG 2.5.7). Direction→index
   * translation lives in the caller (KanbanView, which holds the bucket index);
   * all paths funnel into BacklogPane's shared `reorderTask` core. Omitted in
   * contexts without reorder — the Move items are then hidden entirely.
   */
  onReorder?: (task: BacklogTaskItem, dir: ReorderDirection) => void;
  /** False on the column's first card — disables Move up / Move to top. */
  canMoveUp?: boolean;
  /** False on the column's last card — disables Move down. */
  canMoveDown?: boolean;
}

export function CardActionsMenu({
  task,
  onReorder,
  canMoveUp = false,
  canMoveDown = false,
}: CardActionsMenuProps): React.JSX.Element | null {
  const boards = useBacklogStore((s) => s.boards);
  const [stageOpen, setStageOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Dialog-less Unarchive surfaces failures inline next to the trigger.
  const [actionError, setActionError] = useState<string | null>(null);
  const [unarchiving, setUnarchiving] = useState(false);
  /**
   * The tracker ruling in front of the confirm dialog: which destructive intent
   * is parked, and the link it is parked on. Both are null in the ordinary case
   * — an entity that is not synced to any tracker never sees this step.
   */
  const [parkedIntent, setParkedIntent] = useState<DestructiveIntent | null>(null);
  const [trackerLink, setTrackerLink] = useState<TrackerEntityLinkRef | null>(null);
  /** Does the delete cascade take synced children with it? Ideas/epics only. */
  const [trackerChildren, setTrackerChildren] = useState(false);

  // Prefer the task's own board; the fallback narrows to the task's PROJECT
  // before picking a default — the store now holds boards for ALL projects, and
  // offering another project's stage ids to StageChangeDialog would be wrong.
  const board =
    boards.find((b) => b.id === task.board_id) ??
    pickDefaultBoard(boards.filter((b) => b.project_id === task.project_id));
  if (board === null) return null;

  const isArchived = task.archived_at !== null;
  // The chokepoint rejects USER stage moves / archive / delete on a task with ANY
  // non-terminal run (active_runs). BacklogTaskItem only exposes `inFlow` (running)
  // + `awaitingReview` (awaiting_review / pr_open / pending approvals) overlays, so
  // we gate on both to cover the common run + review window; rarer transient states
  // (queued / stuck / awaiting_input) still degrade gracefully via the server
  // rejection + friendly error.
  const hasActiveRun = task.inFlow.length > 0 || task.awaitingReview;
  const runHint = hasActiveRun ? 'Finish or cancel the active run first.' : undefined;

  const handleUnarchive = async (): Promise<void> => {
    if (unarchiving) return;
    setUnarchiving(true);
    setActionError(null);
    try {
      await trpc.cyboflow.tasks.archive.mutate({
        projectId: task.project_id,
        taskId: task.id,
        archived: false,
        expectedVersion: task.version,
      });
    } catch (err: unknown) {
      setActionError(friendlyStageError(err));
    } finally {
      setUnarchiving(false);
    }
  };

  const openConfirm = (intent: DestructiveIntent): void => {
    if (intent === 'archive') setArchiveOpen(true);
    else setDeleteOpen(true);
  };

  /**
   * Archive / Delete INTENT. Before the confirm dialog, ask whether this entity
   * is linked to a tracker — a linked one owes the user the design's ruling
   * (leave the issue alone, or cancel it) rather than silently stranding it.
   *
   * ON INTENT, never on render: the query fires from the menu click, so the
   * common unlinked card pays exactly one round trip at the moment it is being
   * deleted and nothing at all while it just sits on the board. A FAILING query
   * (no tracker wired, main mid-restart) falls through to the normal confirm —
   * the sync feature must never be able to block a local delete.
   */
  const beginDestructive = async (intent: DestructiveIntent): Promise<void> => {
    setActionError(null);
    let link: TrackerEntityLinkRef | null = null;
    try {
      link = await trpc.cyboflow.tracker.linkForEntity.query({
        entityType: task.type,
        entityId: task.id,
      });
    } catch {
      link = null;
    }
    if (link === null) {
      openConfirm(intent);
      return;
    }
    // Only a DELETE cascades, and only an idea/epic has anything under it — a
    // task never pays for this second query.
    let children = false;
    if (intent === 'delete' && task.type !== 'task') {
      try {
        children = await trpc.cyboflow.tracker.hasLinkedDescendants.query({
          entityType: task.type,
          entityId: task.id,
        });
      } catch {
        // Same fail-soft stance as the link lookup: a missing sentence in the
        // dialog copy must never be able to block a local delete.
        children = false;
      }
    }
    setTrackerLink(link);
    setTrackerChildren(children);
    setParkedIntent(intent);
  };

  /** The ruling is recorded — carry on to the confirm for what was clicked. */
  const handleUnlinkResolved = (): void => {
    const intent = parkedIntent;
    setParkedIntent(null);
    setTrackerLink(null);
    setTrackerChildren(false);
    if (intent !== null) openConfirm(intent);
  };

  const items: DropdownItem[] = [];
  if (onReorder !== undefined) {
    // Reorder is rank-only (no stage write) — deliberately NOT gated on
    // hasActiveRun; only first/last position disables the inapplicable moves.
    items.push(
      {
        id: 'move-up',
        label: 'Move up',
        icon: ArrowUp,
        disabled: !canMoveUp,
        onClick: () => onReorder(task, 'up'),
      },
      {
        id: 'move-down',
        label: 'Move down',
        icon: ArrowDown,
        disabled: !canMoveDown,
        onClick: () => onReorder(task, 'down'),
      },
      {
        id: 'move-to-top',
        label: 'Move to top',
        icon: ArrowUpToLine,
        disabled: !canMoveUp,
        onClick: () => onReorder(task, 'top'),
      },
    );
  }
  items.push(
    {
      id: 'change-stage',
      label: 'Change stage…',
      icon: ArrowRightLeft,
      disabled: hasActiveRun,
      ...(runHint ? { description: runHint } : {}),
      onClick: () => setStageOpen(true),
    },
  );
  if (isArchived) {
    // Unarchive is never guarded server-side — no dialog, no active-run gate.
    items.push({
      id: 'unarchive',
      label: 'Unarchive',
      icon: ArchiveRestore,
      disabled: unarchiving,
      onClick: () => void handleUnarchive(),
    });
  } else {
    items.push({
      id: 'archive',
      label: 'Archive',
      icon: Archive,
      variant: 'warning',
      disabled: hasActiveRun,
      ...(runHint ? { description: runHint } : {}),
      onClick: () => void beginDestructive('archive'),
    });
  }
  items.push({
    id: 'delete',
    label: 'Delete',
    icon: Trash2,
    variant: 'danger',
    disabled: hasActiveRun,
    ...(runHint ? { description: runHint } : {}),
    onClick: () => void beginDestructive('delete'),
  });

  return (
    // Stop clicks from bubbling into the epic-expand toggle / card body (mirrors
    // the dedicated Edit affordance's stopPropagation guard).
    <span onClick={(e) => e.stopPropagation()} className="inline-flex items-center">
      <Dropdown
        position="auto"
        width="sm"
        items={items}
        trigger={
          <button
            type="button"
            data-testid="task-actions-trigger"
            aria-haspopup="menu"
            aria-label={`Actions for ${task.ref}`}
            className="inline-flex items-center rounded-button border border-border-primary px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        }
      />
      {actionError !== null && (
        <span role="alert" className="ml-1.5 text-[10px] leading-tight text-status-error">
          {actionError}
        </span>
      )}
      <StageChangeDialog
        task={task}
        board={board}
        isOpen={stageOpen}
        onClose={() => setStageOpen(false)}
      />
      <ArchiveConfirmDialog
        task={task}
        isOpen={archiveOpen}
        onClose={() => setArchiveOpen(false)}
      />
      <DeleteConfirmDialog
        task={task}
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
      />
      {trackerLink !== null && parkedIntent !== null && (
        <TrackerUnlinkDialog
          entityType={task.type}
          entityId={task.id}
          entityRef={task.ref}
          action={parkedIntent}
          link={trackerLink}
          hasLinkedDescendants={trackerChildren}
          isOpen
          onClose={() => {
            // Dismissed without a ruling: the destructive action is abandoned
            // too, so nothing is deleted and the link stays live.
            setParkedIntent(null);
            setTrackerLink(null);
            setTrackerChildren(false);
          }}
          onResolved={handleUnlinkResolved}
        />
      )}
    </span>
  );
}
