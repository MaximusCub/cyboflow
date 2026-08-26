/**
 * SessionTriageGroups — the live quick-session triage board on the review home.
 *
 * Replaces the old flat QuickSessionsTable (compact board) + TypeGroupedQueue's
 * separate "blocked quick session" full-width cards with THREE always-in-order
 * groups, each rendered only when non-empty:
 *   1. Needs your input — blocked, or idle with a `needs_input` summarizer
 *      verdict. Full-width cards (highest attention).
 *   2. Ready for review  — rested, not waiting on an answer. Compact rows.
 *   3. Working            — actively running (post grace-window/dynamic-workflow
 *      overlay). Compact rows.
 *
 * Classification + sorting is pure and lives in `utils/quickSessionTriage.ts`
 * ({@link deriveQuickSessionTriage}); this component owns the store wiring, the
 * shared "quiet for N" clock (mirrors the old QuickSessionsTable's pattern), a
 * best-effort git-cache warm on the non-running rows, the row opener, and the
 * per-row expandable "details" history panel (backed by `sessions:get-summary`).
 *
 * Self-contained (no props) — mirrors the old QuickSessionsTable's store wiring:
 * `useQuickSessionRows()`, `useQuickSessionsStore.getState().init()`, and
 * `useActiveDynamicWorkflows()`. Renders null when there are zero quick sessions.
 */
import React from 'react';
import { Pencil } from 'lucide-react';
import { useQuickSessionRows, useQuickSessionsStore } from '../../stores/quickSessionsStore';
import { useActiveDynamicWorkflows } from '../../stores/dynamicWorkflowStore';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useSessionStore } from '../../stores/sessionStore';
import { API } from '../../utils/api';
import { formatElapsed, formatElapsedMinutes } from '../../utils/homeClassify';
import { deriveQuickSessionTriage, describeReadyState } from '../../utils/quickSessionTriage';
import { GroupHeader } from './GroupHeader';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { SessionSummaryPayload } from '../../../../shared/types/sessionSummary';

/** Wall-clock refresh cadence for the "quiet for N" labels (shared across rows).
 *  The label is minutes-resolution ({@link formatElapsedMinutes}), so 30s keeps
 *  it at most half a minute stale without a per-second interval. */
const ELAPSED_TICK_MS = 30_000;

/** Open a quick session AND mark it viewed, then refresh so its row updates promptly. */
function openQuickSession(row: QuickSessionRow): void {
  useCyboflowStore.getState().setActiveQuickSession(row.sessionId, row.runId ?? undefined);
  useNavigationStore.getState().setActiveProjectId(row.projectId);
  useNavigationStore.getState().goToSession();
  // Stamp last_viewed_at (clears the unviewed/attention state), then refresh so
  // the triage updates without waiting for the poll.
  void useSessionStore
    .getState()
    .markSessionAsViewed(row.sessionId)
    .finally(() => {
      void useQuickSessionsStore.getState().refresh();
    });
}

/** Cached state for a row's expanded "details" panel — undefined until first expand. */
type SummaryCacheEntry = SessionSummaryPayload | 'loading';

/** The summary-slot rules shared by every row: unsupported / empty / present. */
function SummaryLine({ row }: { row: QuickSessionRow }): React.JSX.Element {
  if (!row.summarySupported) {
    return (
      <div className="italic text-text-muted" style={{ fontSize: '12px' }}>
        no summaries for this session type
      </div>
    );
  }
  if (row.summary === null) {
    return (
      <div className="text-text-muted" style={{ fontSize: '12px' }}>
        no summary yet
      </div>
    );
  }
  return (
    <div className="truncate text-text-tertiary" style={{ fontSize: '12px' }} title={row.summary}>
      {row.summary}
    </div>
  );
}

/** The expandable "details" panel — session history + branch/git meta. */
function DetailsPanel({
  row,
  payload,
  nowMs,
}: {
  row: QuickSessionRow;
  payload: SummaryCacheEntry | undefined;
  nowMs: number;
}): React.JSX.Element {
  if (payload === undefined || payload === 'loading') {
    return (
      <div className="border-t border-dashed border-border-primary pt-2 text-text-muted" style={{ fontSize: '11px' }}>
        loading…
      </div>
    );
  }
  if (!payload.enabled) {
    return (
      <div className="border-t border-dashed border-border-primary pt-2 text-text-muted" style={{ fontSize: '11px' }}>
        summaries are disabled in settings
      </div>
    );
  }
  // Entries are stored oldest-first; show the newest 5.
  const recent = [...payload.entries].reverse().slice(0, 5);
  return (
    <div className="border-t border-dashed border-border-primary pt-2">
      <div className="eyebrow mb-1 text-text-tertiary">History ({payload.entries.length})</div>
      {recent.map((entry) => (
        <div key={entry.id} className="flex items-baseline justify-between gap-2 py-0.5" style={{ fontSize: '11.5px' }}>
          <span className="truncate text-text-secondary">{entry.entry}</span>
          <span className="shrink-0 text-text-tertiary">{formatElapsed(entry.createdAt, nowMs)}</span>
        </div>
      ))}
      <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-text-tertiary">
        {row.worktreeName !== null && <span>branch {row.worktreeName}</span>}
        {row.git !== null && <span>↑{row.git.ahead}</span>}
        {row.git !== null && (row.git.hasUncommittedChanges || row.git.hasUntrackedFiles) && (
          <span>uncommitted</span>
        )}
      </div>
    </div>
  );
}

type ToggleDetails = (sessionId: string, e: React.MouseEvent<HTMLButtonElement>) => void;

/** The details toggle — shared eyebrow button. Callers own placement + stopPropagation. */
function DetailsToggle({ expanded, onClick }: { expanded: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="eyebrow shrink-0 text-text-tertiary hover:text-interactive">
      details {expanded ? '▾' : '▸'}
    </button>
  );
}

/**
 * Shared inline-rename state for one row. Ported from the old QuickSessionsTable
 * row (commit 26d811841) with the click-away fix (083695a6c): a native
 * click-away dismiss dispatches blur BEFORE click, so by the time the row's
 * onClick runs, saveEdit() has already flipped isEditing to false and a plain
 * `if (isEditing) return` guard would be bypassed — the dismissing click would
 * still open the session and stamp last_viewed_at. `handleRowMouseDown` arms
 * `suppressClickRef` instead (mousedown fires before blur, while isEditing is
 * still true); a later genuine click re-runs mousedown with isEditing false and
 * disarms it. Callers wire `handleRowMouseDown` onto the row and check
 * `suppressClickRef.current` first in the row's onClick.
 */
function useInlineRename(row: QuickSessionRow): {
  isEditing: boolean;
  editName: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  suppressClickRef: React.MutableRefObject<boolean>;
  startEdit: () => void;
  handleInputChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleInputKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleInputBlur: () => void;
  handleRowMouseDown: () => void;
} {
  const [isEditing, setIsEditing] = React.useState(false);
  const [editName, setEditName] = React.useState(row.name);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const suppressClickRef = React.useRef(false);

  React.useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startEdit = (): void => {
    setEditName(row.name);
    setIsEditing(true);
  };

  const saveEdit = (): void => {
    const trimmed = editName.trim();
    setIsEditing(false);
    if (trimmed === '' || trimmed === row.name) {
      setEditName(row.name);
      return;
    }
    API.sessions
      .rename(row.sessionId, trimmed)
      .then((response) => {
        if (!response.success) {
          throw new Error(response.error || 'Failed to rename session');
        }
      })
      .catch((error) => {
        console.error('Error renaming session:', error);
        alert('Failed to rename session');
        setEditName(row.name);
      })
      .finally(() => {
        void useQuickSessionsStore.getState().refresh();
      });
  };

  const cancelEdit = (): void => {
    setEditName(row.name);
    setIsEditing(false);
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Never let a rename keystroke reach the row's own Enter/Space-to-open handler.
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  return {
    isEditing,
    editName,
    inputRef,
    suppressClickRef,
    startEdit,
    handleInputChange: (e) => setEditName(e.target.value),
    handleInputKeyDown,
    handleInputBlur: saveEdit,
    handleRowMouseDown: () => {
      suppressClickRef.current = isEditing;
    },
  };
}

/**
 * The name slot shared by every row: a truncated name + hover pencil, or (while
 * editing) an inline input seeded with the current name. Callers put the row's
 * outer element in a `group` class so the pencil's `group-hover:opacity-100`
 * has something to key off of.
 */
function InlineNameEditor({ row, rename }: { row: QuickSessionRow; rename: ReturnType<typeof useInlineRename> }): React.JSX.Element {
  if (rename.isEditing) {
    return (
      <input
        ref={rename.inputRef}
        type="text"
        value={rename.editName}
        onChange={rename.handleInputChange}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={rename.handleInputKeyDown}
        onBlur={rename.handleInputBlur}
        className="min-w-0 flex-1 border border-border-emphasized bg-bg-primary px-1 font-bold text-text-primary outline-none"
        style={{ fontSize: '13px' }}
      />
    );
  }
  return (
    <>
      <span className="truncate font-bold text-text-primary" style={{ fontSize: '13px' }} title={row.name}>
        {row.name}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          rename.startEdit();
        }}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label="Rename session"
        title="Rename"
        className="shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100 hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </>
  );
}

/**
 * "Needs your input" — full-width card. Only the name row and the "Answer in
 * session →" button open the session; the details toggle stops propagation and
 * the summary/waiting-on content in between is not itself clickable.
 */
function NeedsInputCard({
  row,
  nowMs,
  expanded,
  payload,
  onToggleDetails,
}: {
  row: QuickSessionRow;
  nowMs: number;
  expanded: boolean;
  payload: SummaryCacheEntry | undefined;
  onToggleDetails: ToggleDetails;
}): React.JSX.Element {
  const isBlocked = row.state === 'blocked';
  const quiet = row.state === 'idle' ? formatElapsedMinutes(row.idleSince, nowMs) : null;
  const rename = useInlineRename(row);
  const open = () => openQuickSession(row);
  return (
    <div className="border border-status-error/40 bg-surface-primary p-3 transition-colors hover:border-status-error">
      <div
        role="button"
        tabIndex={0}
        onMouseDown={rename.handleRowMouseDown}
        onClick={() => {
          if (rename.suppressClickRef.current) {
            rename.suppressClickRef.current = false;
            return;
          }
          if (rename.isEditing) return;
          open();
        }}
        onKeyDown={(e) => {
          if (rename.isEditing) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        className="group flex w-full cursor-pointer items-center gap-2 text-left"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-error" />
        <InlineNameEditor row={row} rename={rename} />
        {!rename.isEditing && (
          <span
            className={`eyebrow ml-auto shrink-0 border px-1.5 py-0.5 ${
              isBlocked ? 'border-status-error text-status-error' : 'border-status-warning text-status-warning'
            }`}
          >
            {isBlocked ? 'question' : 'asked you'}
          </span>
        )}
      </div>
      <div className="mt-2">
        <SummaryLine row={row} />
      </div>
      {row.waitingOn !== null && (
        <div className="mt-2 bg-status-warning/10 p-2 text-status-warning" style={{ fontSize: '11.5px' }}>
          {row.waitingOn}
        </div>
      )}
      <div className="mt-2 flex items-center gap-3">
        {row.state === 'idle' && <span className="text-[11px] text-text-muted">quiet {quiet}</span>}
        <DetailsToggle expanded={expanded} onClick={(e) => onToggleDetails(row.sessionId, e)} />
        <button
          type="button"
          onClick={() => openQuickSession(row)}
          className="eyebrow ml-auto text-text-tertiary hover:text-interactive"
        >
          Answer in session →
        </button>
      </div>
      {expanded && (
        <div className="mt-2">
          <DetailsPanel row={row} payload={payload} nowMs={nowMs} />
        </div>
      )}
    </div>
  );
}

/**
 * "Ready for review" — compact row. The row is clickable everywhere except the
 * details toggle (rendered as a `<div role="button">` so the nested toggle
 * `<button>` stays valid HTML, unlike nesting a button inside a button).
 */
function ReadyRow({
  row,
  nowMs,
  expanded,
  payload,
  onToggleDetails,
}: {
  row: QuickSessionRow;
  nowMs: number;
  expanded: boolean;
  payload: SummaryCacheEntry | undefined;
  onToggleDetails: ToggleDetails;
}): React.JSX.Element {
  const quiet = row.state === 'idle' ? formatElapsedMinutes(row.idleSince, nowMs) : null;
  const readyState = describeReadyState(row);
  const toneClass =
    readyState.tone === 'error'
      ? 'text-status-error'
      : readyState.tone === 'success'
        ? 'text-status-success'
        : 'text-text-muted';
  const rename = useInlineRename(row);
  const open = () => openQuickSession(row);
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onMouseDown={rename.handleRowMouseDown}
        onClick={() => {
          if (rename.suppressClickRef.current) {
            rename.suppressClickRef.current = false;
            return;
          }
          if (rename.isEditing) return;
          open();
        }}
        onKeyDown={(e) => {
          if (rename.isEditing) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        className="group flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-surface-hover"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${row.unviewed ? 'bg-interactive' : 'bg-border-emphasized'}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <InlineNameEditor row={row} rename={rename} />
            {!rename.isEditing && readyState.label !== '' && (
              <span className={`ml-auto shrink-0 text-[11px] ${toneClass}`}>{readyState.label}</span>
            )}
          </span>
          <SummaryLine row={row} />
        </span>
        <span className="shrink-0 text-[11px] text-text-muted">quiet {quiet}</span>
        <DetailsToggle expanded={expanded} onClick={(e) => onToggleDetails(row.sessionId, e)} />
      </div>
      {expanded && (
        <div className="px-4 pb-2">
          <DetailsPanel row={row} payload={payload} nowMs={nowMs} />
        </div>
      )}
    </div>
  );
}

/**
 * "Working" — compact row, whole-row click target (no details toggle — nothing
 * needed from you). A `div[role=button]` rather than a `<button>` so the inline
 * rename input can nest inside it (an input inside a button is invalid HTML).
 */
function WorkingRow({ row }: { row: QuickSessionRow }): React.JSX.Element {
  const rename = useInlineRename(row);
  const open = () => openQuickSession(row);
  return (
    <div
      role="button"
      tabIndex={0}
      onMouseDown={rename.handleRowMouseDown}
      onClick={() => {
        if (rename.suppressClickRef.current) {
          rename.suppressClickRef.current = false;
          return;
        }
        if (rename.isEditing) return;
        open();
      }}
      onKeyDown={(e) => {
        if (rename.isEditing) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className="group flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-surface-hover"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-success" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <InlineNameEditor row={row} rename={rename} />
          {!rename.isEditing && (
            <span className="eyebrow ml-auto shrink-0 border border-border-emphasized px-1.5 py-0.5 text-status-success">
              running
            </span>
          )}
        </span>
        <SummaryLine row={row} />
      </span>
    </div>
  );
}

/**
 * The triage board. Renders nothing when there are no quick sessions (so the
 * review home doesn't show an empty box). Self-subscribes to the polling feed.
 */
export function SessionTriageGroups(): React.JSX.Element | null {
  const rows = useQuickSessionRows();
  const activeDynamicWorkflows = useActiveDynamicWorkflows();

  // Join the polling feed while mounted (ref-counted in the store).
  React.useEffect(() => useQuickSessionsStore.getState().init(), []);

  // One shared clock for every row's elapsed label — see QuickSessionsTable's
  // original doc comment for the visibility-pause rationale (mirrored here).
  const [nowMs, setNowMs] = React.useState<number>(() => Date.now());
  React.useEffect(() => {
    const tick = () => setNowMs(Date.now());
    let id: number | null = null;
    const start = () => {
      if (id !== null) return;
      tick();
      id = window.setInterval(tick, ELAPSED_TICK_MS);
    };
    const stop = () => {
      if (id === null) return;
      window.clearInterval(id);
      id = null;
    };
    const handleVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };
    if (document.hidden) tick();
    else start();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      stop();
    };
  }, []);

  // NOTE: the git-cache warm is server-side now — sessions:list-quick itself
  // throttle-warms the resting rows' git status (at most once a minute while a
  // board is polling), so this component only ever renders the cache snapshot.

  const activeWorkflowSessionIds = React.useMemo(
    () => new Set(activeDynamicWorkflows.map((w) => w.sessionId)),
    [activeDynamicWorkflows],
  );
  const triage = React.useMemo(
    () => deriveQuickSessionTriage(rows, activeWorkflowSessionIds, nowMs),
    [rows, activeWorkflowSessionIds, nowMs],
  );

  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set());
  const [summaryCache, setSummaryCache] = React.useState<Record<string, SummaryCacheEntry>>({});

  const toggleDetails: ToggleDetails = (sessionId, e) => {
    e.stopPropagation();
    const isExpanding = !expanded.has(sessionId);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
    if (isExpanding && !(sessionId in summaryCache)) {
      setSummaryCache((cache) => ({ ...cache, [sessionId]: 'loading' }));
      void API.sessions
        .getSummary(sessionId, { catchUp: false })
        .then((res) => {
          setSummaryCache((cache) => ({
            ...cache,
            [sessionId]:
              res.success && res.data !== undefined
                ? res.data
                : { enabled: false, summary: null, updatedAt: null, entries: [] },
          }));
        })
        .catch(() => {
          setSummaryCache((cache) => {
            const next = { ...cache };
            delete next[sessionId];
            return next;
          });
        });
    }
  };

  if (rows.length === 0) return null;

  return (
    <>
      {triage.needsInput.length > 0 && (
        <section data-testid="queue-group-session-needs-input">
          <GroupHeader
            swatchClass="bg-status-error"
            name="Needs your input"
            count={triage.needsInput.length}
            descriptor="Sessions waiting on your answer"
          />
          {triage.needsInput.map((row) => (
            <NeedsInputCard
              key={row.sessionId}
              row={row}
              nowMs={nowMs}
              expanded={expanded.has(row.sessionId)}
              payload={summaryCache[row.sessionId]}
              onToggleDetails={toggleDetails}
            />
          ))}
        </section>
      )}

      {triage.readyForReview.length > 0 && (
        <section data-testid="queue-group-session-ready">
          <GroupHeader
            swatchClass="bg-status-success"
            name="Ready for review"
            count={triage.readyForReview.length}
            descriptor="Finished — review, merge, or wrap up"
          />
          {triage.readyForReview.map((row) => (
            <ReadyRow
              key={row.sessionId}
              row={row}
              nowMs={nowMs}
              expanded={expanded.has(row.sessionId)}
              payload={summaryCache[row.sessionId]}
              onToggleDetails={toggleDetails}
            />
          ))}
        </section>
      )}

      {triage.working.length > 0 && (
        <section data-testid="queue-group-session-working">
          <GroupHeader
            swatchClass="bg-interactive"
            name="Working"
            count={triage.working.length}
            descriptor="Running — nothing needed from you"
          />
          {triage.working.map((row) => (
            <WorkingRow key={row.sessionId} row={row} />
          ))}
        </section>
      )}
    </>
  );
}
