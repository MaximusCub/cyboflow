/**
 * LedgerExpand — the idea component ledger's inline detail strip, revealed by
 * TaskBody's `ledger-expand` toggle (ideas only; see TaskCard.tsx). One row
 * per tracked component (shared/types/ideaComponents.ts's IDEA_COMPONENT_KEYS,
 * in display order): its name, its resolved state, provenance text (when a
 * complete component was done; for a stale one, that prior work exists and
 * needs re-verification — the whole point of the staleness axis, see the
 * file's header comment), and a manual-override control wired to
 * `cyboflow.ideaComponents.setState`.
 *
 * Visual language mirrors WorkflowSummaryPanel's breakdown strip
 * (frontend/src/components/cyboflow/WorkflowSummaryPanel.tsx ~968-1042) — a
 * compact bordered per-row grid, not a modal.
 *
 * `setState` returns the full merged hybrid snapshot for the idea (mirrors
 * `IdeaComponentChangedEvent`'s payload), so a successful override updates
 * this strip immediately without waiting on a subscription round-trip. The
 * `components` prop still wins when its identity changes (a fresh task-list
 * fetch), via the sync effect below.
 */
import { useEffect, useState } from 'react';
import {
  IDEA_COMPONENT_KEYS,
  IDEA_COMPONENT_LABELS,
} from '../../../../shared/types/ideaComponents';
import type {
  IdeaComponentKey,
  IdeaComponentState,
  IdeaComponentStateValue,
} from '../../../../shared/types/ideaComponents';
import { trpc } from '../../trpc/client';
import { compactAgo } from './backlogSelectors';
import { ledgerChipVisualState, LEDGER_STATE_LABEL, type LedgerChipVisualState } from './markers';

interface LedgerExpandProps {
  ideaId: string;
  components: IdeaComponentState[];
  /** Compact "now" basis so all cards share one clock tick (mirrors TaskBody). */
  now: number;
}

/** A component with no ledger row yet — matches the 'derived'/not-started fallback (see resolveIdeaComponents.ts). */
function fallbackEntry(component: IdeaComponentKey): IdeaComponentState {
  return {
    component,
    state: 'incomplete',
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt: null,
    staleReason: null,
    updatedAt: null,
  };
}

function provenanceText(entry: IdeaComponentState, visual: LedgerChipVisualState, now: number): string {
  switch (visual) {
    case 'complete':
      return entry.updatedAt ? `Done ${compactAgo(entry.updatedAt, now)}` : 'Complete';
    case 'needs-review':
      // Explicit + legible: prior work exists, it just needs re-verification —
      // never let this read like "not started".
      return entry.staleReason
        ? `Needs review — ${entry.staleReason}`
        : 'Needs review — prior work exists, re-verify before trusting it';
    case 'skipped':
      return entry.updatedAt ? `Skipped ${compactAgo(entry.updatedAt, now)}` : 'Skipped';
    case 'not-started':
    default:
      return 'Not started';
  }
}

const OVERRIDE_OPTIONS: { value: IdeaComponentStateValue; label: string }[] = [
  { value: 'incomplete', label: 'Not started / needs review' },
  { value: 'complete', label: 'Complete' },
  { value: 'skipped', label: 'Skipped' },
];

export function LedgerExpand({ ideaId, components, now }: LedgerExpandProps): React.JSX.Element {
  const [rows, setRows] = useState<IdeaComponentState[]>(components);
  const [pending, setPending] = useState<IdeaComponentKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The incoming prop wins on identity change (a fresh task fetch) — an
  // in-flight local override still shows immediately via the mutation's own
  // returned snapshot below.
  useEffect(() => {
    setRows(components);
  }, [components]);

  const handleOverride = async (component: IdeaComponentKey, state: IdeaComponentStateValue): Promise<void> => {
    setPending(component);
    setError(null);
    try {
      const updated = await trpc.cyboflow.ideaComponents.setState.mutate({ ideaId, component, state });
      setRows(updated);
    } catch {
      setError('Could not update — try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className="mt-1.5 rounded-card border border-border-tertiary bg-bg-tertiary/50 px-2 py-1"
      data-testid="ledger-expand-content"
      // stopPropagation: this strip sits inside draggable/clickable card ancestors.
      onClick={(e) => e.stopPropagation()}
    >
      {IDEA_COMPONENT_KEYS.map((key) => {
        const entry = rows.find((r) => r.component === key) ?? fallbackEntry(key);
        const visual = ledgerChipVisualState(entry);
        return (
          <div
            key={key}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border-tertiary/50 py-1 last:border-b-0"
            data-testid={`ledger-row-${key}`}
          >
            <div className="min-w-0">
              <div className="truncate text-[11px] font-medium text-text-primary">{IDEA_COMPONENT_LABELS[key]}</div>
              <div className="truncate text-[10px] text-text-tertiary">{provenanceText(entry, visual, now)}</div>
            </div>
            <span className="eyebrow whitespace-nowrap text-[9.5px] text-text-tertiary">
              {LEDGER_STATE_LABEL[visual]}
            </span>
            <select
              value={entry.state}
              disabled={pending === key}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => void handleOverride(key, e.target.value as IdeaComponentStateValue)}
              aria-label={`Override ${IDEA_COMPONENT_LABELS[key]} state`}
              data-testid={`ledger-override-${key}`}
              className="rounded-button border border-border-primary bg-surface-primary px-1 py-0.5 text-[10px] text-text-secondary disabled:opacity-50"
            >
              {OVERRIDE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {error !== null && (
        <p role="alert" className="mt-1 text-[10px] text-status-error">
          {error}
        </p>
      )}
    </div>
  );
}
