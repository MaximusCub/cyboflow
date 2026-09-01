/**
 * HumanTasksSection — the blue band: work assigned to a person rather than an
 * agent. Nothing is halted, so these rows are single-line with the body behind
 * "Details ▸" and one verdict, "Mark done".
 *
 * The section is omitted entirely when empty — an empty well here would imply
 * the queue expects you to have chores, which it does not.
 */
import React from 'react';
import type { ReviewItem } from '../../../../shared/types/reviews';
import { useReviewItemActions } from '../../hooks/useReviewItemActions';
import { Chip, GhostButton, SecondaryButton, SectionHeader } from './QueuePrimitives';
import { compactAge } from './queueSelectors';

function HumanTaskRow({
  item,
  projectName,
  nowMs,
  onResolved,
}: {
  item: ReviewItem;
  projectName: string | null;
  nowMs: number;
  onResolved: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = React.useState(false);
  const { resolve, pendingItemId } = useReviewItemActions();
  const hasBody = item.body !== null && item.body !== '';
  const busy = pendingItemId === item.id;

  const markDone = (): void => {
    void resolve(item.project_id, item.id).then((result) => {
      if (result !== null) onResolved();
    });
  };

  return (
    <div className="flex flex-col gap-1.5 border border-border-primary bg-surface-raised px-3.5 py-2.5 shadow-[inset_3px_0_0_var(--color-status-info)]">
      <div className="flex items-center gap-2">
        <span className="eyebrow shrink-0 text-status-info">Action</span>
        <span className="min-w-0 truncate text-[12.5px] font-bold text-text-primary" title={item.title}>
          {item.title}
        </span>
        {projectName !== null && <Chip title={projectName}>{projectName}</Chip>}
        <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">
          {compactAge(item.created_at, nowMs)}
        </span>
      </div>
      <div className="flex items-center gap-2.5 text-[11px]">
        {hasBody && !expanded && (
          <span className="min-w-0 flex-1 truncate text-text-secondary" title={item.body ?? undefined}>
            {item.body}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          {hasBody && (
            <GhostButton className="text-[11px]" onClick={() => setExpanded((v) => !v)}>
              Details {expanded ? '▾' : '▸'}
            </GhostButton>
          )}
          <SecondaryButton onClick={markDone} disabled={busy}>
            {busy ? 'Marking…' : 'Mark done'}
          </SecondaryButton>
        </span>
      </div>
      {expanded && hasBody && (
        <p className="whitespace-pre-wrap border-t border-dashed border-border-primary pt-2 text-[11px] leading-relaxed text-text-secondary">
          {item.body}
        </p>
      )}
    </div>
  );
}

export interface HumanTasksSectionProps {
  items: ReviewItem[];
  projectNameById: Record<number, string>;
  nowMs: number;
  /** Called after a successful resolve so the page can re-derive its counts. */
  onResolved: () => void;
}

/** HumanTasksSection — see {@link HumanTasksSectionProps}. */
export function HumanTasksSection({
  items,
  projectNameById,
  nowMs,
  onResolved,
}: HumanTasksSectionProps): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section data-testid="rq-human-tasks-section" className="flex flex-col gap-2">
      <SectionHeader dotClass="bg-status-info" title="Human tasks" count={items.length} />
      {items.map((item) => (
        <HumanTaskRow
          key={item.id}
          item={item}
          projectName={projectNameById[item.project_id] ?? null}
          nowMs={nowMs}
          onResolved={onResolved}
        />
      ))}
    </section>
  );
}
