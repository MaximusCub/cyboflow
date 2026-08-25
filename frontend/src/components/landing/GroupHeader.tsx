/**
 * GroupHeader — sticky group-title bar shared by every review-home group:
 * a color swatch + name + count + right-aligned descriptor.
 *
 * Extracted out of TypeGroupedQueue.tsx (which still renders its own type
 * groups with it) so SessionTriageGroups can reuse the exact same chrome
 * without importing from TypeGroupedQueue (which would be circular — that
 * file mounts SessionTriageGroups).
 */
import React from 'react';

export function GroupHeader({
  swatchClass,
  name,
  count,
  descriptor,
}: {
  swatchClass: string;
  name: string;
  count: number;
  descriptor: string;
}): React.JSX.Element {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2.5 bg-bg-primary px-4 py-2 border-b border-border-primary">
      <span
        aria-hidden="true"
        className={`inline-block h-[14px] w-[8px] flex-shrink-0 ${swatchClass}`}
      />
      <span className="text-[12px] font-bold text-text-primary">{name}</span>
      <span className="eyebrow text-text-tertiary">{count} pending</span>
      <span className="ml-auto text-[11px] text-text-muted">{descriptor}</span>
    </div>
  );
}
