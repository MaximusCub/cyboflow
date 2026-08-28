/**
 * WorkflowListRow's "used X ago" label.
 *
 * The row's local formatRelative parsed `meta.lastUsedAt` with a bare
 * `new Date()`. That value is folded straight from `workflow_runs.created_at`,
 * which SQLite stores space-separated and unzoned — read as LOCAL it lands the
 * host's UTC offset in the future, and formatRelative's `Math.max(0, …)` clamp
 * floors the negative interval to zero. Result: every flow run in the preceding
 * offset-many hours rendered a confident "just now".
 *
 * Timezone-independent: builds its fixtures relative to now and asserts the
 * bucket, so it holds on a UTC CI host too.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkflowListRow } from '../WorkflowListRow';
import type { WorkflowCardMeta } from '../workflowMeta';

/** A SQLite-shaped ("YYYY-MM-DD HH:MM:SS", UTC, unzoned) stamp N ms in the past. */
function sqliteStampAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

function meta(lastUsedAt: string | null): WorkflowCardMeta {
  return {
    id: 'wf-1',
    name: 'sprint',
    title: 'Sprint',
    subtitle: 'Execute the task batch',
    slashCommand: '/sprint',
    isDefault: true,
    hiddenFromLauncher: false,
    stepCount: 6,
    phaseCount: 2,
    lastUsedAt,
    tuningLevel: 'standard',
    runtimeMix: 'claude',
    hasCustomSlot: false,
    isBuiltIn: true,
  };
}

function renderRow(lastUsedAt: string | null) {
  return render(<WorkflowListRow meta={meta(lastUsedAt)} selected={false} onSelect={() => {}} />);
}

describe('WorkflowListRow "used X ago"', () => {
  it('reports real elapsed hours for a raw SQLite timestamp', () => {
    renderRow(sqliteStampAgo(3 * 60 * 60_000));
    expect(screen.getByText(/3h ago/)).toBeTruthy();
  });

  it('reports minutes rather than collapsing to "just now"', () => {
    renderRow(sqliteStampAgo(42 * 60_000));
    expect(screen.getByText(/42m ago/)).toBeTruthy();
  });

  it('still says "just now" for something that genuinely just ran', () => {
    renderRow(sqliteStampAgo(2_000));
    expect(screen.getByText(/just now/)).toBeTruthy();
  });

  it('handles an already-zoned ISO value unchanged', () => {
    renderRow(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    expect(screen.getByText(/2h ago/)).toBeTruthy();
  });

  it('renders no label when the flow has never run', () => {
    const { container } = renderRow(null);
    expect(container.textContent).not.toMatch(/ago|just now/);
  });
});
