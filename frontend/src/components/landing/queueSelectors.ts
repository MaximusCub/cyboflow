/**
 * queueSelectors — the Human Review Queue's pure helpers.
 *
 * Kept out of the section components so they stay unit-testable and so those
 * files export components only (a mixed module breaks Fast Refresh).
 */
import type { ReviewItem } from '../../../../shared/types/reviews';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import { parseDbTimestampMs } from '../../utils/homeClassify';

/**
 * Select runs that are genuinely ready for post-workflow review.
 *
 * Moved here verbatim from the retired TypeGroupedQueue. `awaiting_review` is
 * also used while a programmatic workflow is parked at an intermediate human
 * gate; those runs already have a blocking decision (or permission) in the
 * queue and must not be duplicated as finished work.
 */
export function selectReadyToReviewRuns(
  runs: ActiveRunRow[],
  reviewItems: ReviewItem[],
  permissionItems: QueueItem[],
  landingBlockingRunIds: ReadonlySet<string> = new Set(),
): ActiveRunRow[] {
  const blockedRunIds = new Set(landingBlockingRunIds);
  for (const item of permissionItems) {
    blockedRunIds.add(item.kind === 'single' ? item.approval.runId : item.runId);
  }
  for (const item of reviewItems) {
    if (item.blocking && item.run_id !== null) blockedRunIds.add(item.run_id);
  }
  return runs.filter((run) => run.status === 'awaiting_review' && !blockedRunIds.has(run.id));
}

/**
 * Coarse age for a row that can legitimately be days old ("3h", "2d").
 *
 * `formatElapsedMinutes` tops out at hours, which reads badly past a day. Uses
 * the same UTC-normalizing {@link parseDbTimestampMs} parse so a zone-less
 * SQLite stamp is not read as local time.
 */
export function compactAge(timestamp: string, nowMs: number): string {
  const startMs = parseDbTimestampMs(timestamp);
  if (Number.isNaN(startMs)) return '—';
  const minutes = Math.floor(Math.max(0, nowMs - startMs) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Count the underlying approvals represented by a list of grouped queue items. */
export function countApprovals(items: QueueItem[]): number {
  let total = 0;
  for (const item of items) {
    total += item.kind === 'single' ? 1 : item.items.length;
  }
  return total;
}
