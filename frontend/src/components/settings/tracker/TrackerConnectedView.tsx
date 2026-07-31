/**
 * TrackerConnectedView — the manage surface for one live tracker connection,
 * rendered as a `size="full"` Modal nested inside the Settings modal (the same
 * nesting the wizard uses).
 *
 * Reads everything but the conflict list off the `TrackerConnectionSummary` the
 * catalog already fetched; conflicts are their own query because they are per
 * connection and only shown when there is something to decide.
 *
 * Writes:
 *   settings toggles -> cyboflow.tracker.updateSettings (one PARTIAL per row)
 *   Sync now         -> cyboflow.tracker.syncNow  (its returned log replaces the card's)
 *   conflict rulings -> cyboflow.tracker.resolveConflict
 *   Disconnect       -> cyboflow.tracker.disconnect (inline confirm first)
 *
 * Toggle state is mirrored locally so a row flips immediately and the summary
 * re-read (driven by the parent's onTrackerChanged subscription) reconciles it.
 * v1 has NO edit deep-links back into the wizard: `updateSettings` covers the
 * direction/mirroring/conflict rows, and changing the source, selection or state
 * mapping means re-running the wizard.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { inferRouterInputs } from '@trpc/server';
import { RefreshCw } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { Modal } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { cn } from '../../../utils/cn';
import type { AppRouter } from '../../../../../shared/types/trpc';
import type {
  TrackerConflictMode,
  TrackerConflictSummary,
  TrackerConnectionSummary,
  TrackerMappingTarget,
  TrackerSyncLogEntry,
} from '../../../../../shared/types/trackerSync';
import { Eyebrow, PillToggle, ProviderTile, Segmented } from './trackerShared';
import { logMarkerClass, mappingTargetLabel, providerMeta } from './trackerVocabulary';

const CARD = 'rounded-none border border-border-primary bg-surface-primary';

/** The settings patch shape, inferred from the router — never a local mirror. */
type UpdateSettingsInput = inferRouterInputs<AppRouter>['cyboflow']['tracker']['updateSettings'];

const CONFLICT_OPTIONS: readonly { value: TrackerConflictMode; label: string }[] = [
  { value: 'auto', label: 'Auto-resolve' },
  { value: 'manual', label: 'Manual review' },
];

const SELECTION_LABEL: Record<TrackerConnectionSummary['selectionMode'], string> = {
  all: 'All issues',
  assignee: 'By assignee',
  manual: 'Hand-picked',
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `lastSyncAt` is an ISO stamp from the store; an unparseable one renders raw. */
function formatSyncedAt(iso: string | null): string {
  if (iso === null) return 'never';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export interface TrackerConnectedViewProps {
  isOpen: boolean;
  connection: TrackerConnectionSummary;
  onClose: () => void;
  /** Fired after any write so the catalog re-reads its connection rows. */
  onChanged: () => void;
}

export function TrackerConnectedView({
  isOpen,
  connection,
  onClose,
  onChanged,
}: TrackerConnectedViewProps): React.JSX.Element {
  const meta = providerMeta(connection.provider);

  // Optimistic mirror of the three editable settings rows.
  const [twoWay, setTwoWay] = useState(connection.twoWay);
  const [mirrorSubissues, setMirrorSubissues] = useState(connection.mirrorSubissues);
  const [conflictMode, setConflictMode] = useState<TrackerConflictMode>(connection.conflictMode);

  const [log, setLog] = useState<TrackerSyncLogEntry[]>(connection.lastSyncLog);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const [conflicts, setConflicts] = useState<TrackerConflictSummary[]>([]);

  // Re-seed from a fresh summary (the parent re-reads on every tracker event).
  useEffect(() => {
    setTwoWay(connection.twoWay);
    setMirrorSubissues(connection.mirrorSubissues);
    setConflictMode(connection.conflictMode);
    setLog(connection.lastSyncLog);
  }, [
    connection.twoWay,
    connection.mirrorSubissues,
    connection.conflictMode,
    connection.lastSyncLog,
  ]);

  /**
   * The conflict list is only meaningful in Manual mode or while auto-resolution
   * has left something open, so it is fetched under exactly that condition.
   */
  const showConflicts = conflictMode === 'manual' || connection.openConflictCount > 0;

  const loadConflicts = useCallback((): void => {
    if (!showConflicts) {
      setConflicts([]);
      return;
    }
    void trpc.cyboflow.tracker.conflicts
      .query({ connectionId: connection.id })
      .then(setConflicts)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [showConflicts, connection.id]);

  useEffect(() => {
    loadConflicts();
  }, [loadConflicts, connection.openConflictCount]);

  const patchSettings = (patch: UpdateSettingsInput): void => {
    setError(null);
    void trpc.cyboflow.tracker.updateSettings
      .mutate(patch)
      .then(() => onChanged())
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const handleTwoWay = (next: boolean): void => {
    setTwoWay(next);
    patchSettings({ connectionId: connection.id, twoWay: next });
  };

  const handleMirror = (next: boolean): void => {
    setMirrorSubissues(next);
    patchSettings({ connectionId: connection.id, mirrorSubissues: next });
  };

  const handleConflictMode = (next: TrackerConflictMode): void => {
    setConflictMode(next);
    patchSettings({ connectionId: connection.id, conflictMode: next });
  };

  const handleSyncNow = async (): Promise<void> => {
    setSyncing(true);
    setError(null);
    try {
      const result = await trpc.cyboflow.tracker.syncNow.mutate({ connectionId: connection.id });
      setLog(result.entries);
      if (result.error !== null) setError(result.error);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  const handleResolve = (conflictId: number, choice: 'local' | 'remote'): void => {
    setError(null);
    void trpc.cyboflow.tracker.resolveConflict
      .mutate({ conflictId, choice })
      .then(() => {
        setConflicts((prev) => prev.filter((c) => c.id !== conflictId));
        onChanged();
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const handleDisconnect = (): void => {
    setError(null);
    void trpc.cyboflow.tracker.disconnect
      .mutate({ connectionId: connection.id })
      .then(() => {
        onChanged();
        onClose();
      })
      .catch((err: unknown) => setError(errorMessage(err)));
  };

  const mappedCount = Object.values(connection.stateMapping).filter((t) => t !== 'dont').length;
  const totalStates = Object.keys(connection.stateMapping).length;

  /** The distinct cyboflow stages this connection imports into. */
  const mappedTargets = useMemo(() => {
    const seen = new Set<TrackerMappingTarget>();
    for (const target of Object.values(connection.stateMapping)) {
      if (target !== 'dont') seen.add(target);
    }
    return [...seen].map(mappingTargetLabel).join(' · ');
  }, [connection.stateMapping]);

  const stats: { label: string; value: string; tone?: string }[] = [
    { label: 'Items linked', value: String(connection.linkedCount) },
    { label: 'Selection', value: SELECTION_LABEL[connection.selectionMode] },
    { label: 'Source', value: connection.sourceLabel },
    {
      label: 'Direction',
      value: twoWay ? 'Two-way' : 'Read only',
      tone: twoWay ? 'text-status-success' : undefined,
    },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="full"
      showCloseButton={false}
      closeOnOverlayClick={false}
      className="rounded-none"
    >
      <div
        className="flex flex-col"
        style={{ height: '90vh', maxHeight: '90vh' }}
        data-testid="tracker-connected-view"
      >
        {/* ── Head ────────────────────────────────────────────────────────── */}
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2.5">
          <Eyebrow className="text-text-primary">Integrations</Eyebrow>
          <span className="text-[10px] uppercase tracking-[0.18em] text-text-tertiary">
            / {meta.name}
          </span>
          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-status-success">
            <span className="h-1.5 w-1.5 rounded-full bg-status-success" />
            Connected
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-none border border-border-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary hover:text-text-primary"
          >
            All integrations
          </button>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────── */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg-primary px-6 py-5">
          <div className="mx-auto w-full max-w-[840px] space-y-4">
            {error !== null && (
              <p
                role="alert"
                className="rounded-none border border-status-error px-3 py-2 text-xs text-status-error"
              >
                {error}
              </p>
            )}

            {/* Identity + disconnect */}
            <div className="flex items-center gap-3">
              <ProviderTile mark={meta.mark} />
              <div className="min-w-0">
                <h3 className="text-base font-bold text-text-primary">{meta.name}</h3>
                <p className="text-[11px] text-text-tertiary">
                  workspace {connection.workspaceName || 'unknown'} · authorized as{' '}
                  {connection.actorLabel || 'unknown'}
                  {connection.baseUrl !== null && ` · ${connection.baseUrl}`}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {confirmingDisconnect ? (
                  <>
                    <span className="text-[11px] text-text-secondary">
                      Disconnect? Existing links stay.
                    </span>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      className="rounded-none"
                      onClick={handleDisconnect}
                    >
                      Confirm
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="rounded-none"
                      onClick={() => setConfirmingDisconnect(false)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="rounded-none"
                    onClick={() => setConfirmingDisconnect(true)}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
            </div>

            {/* Stat grid */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className={cn(CARD, 'p-3')}>
                  <Eyebrow>{stat.label}</Eyebrow>
                  <p className={cn('mt-1.5 truncate text-sm font-bold', stat.tone ?? 'text-text-primary')}>
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {/* Sync settings */}
              <div className={CARD}>
                <div className="border-b border-border-primary bg-surface-secondary px-3 py-2">
                  <Eyebrow>Sync settings</Eyebrow>
                </div>
                <div className="divide-y divide-border-primary">
                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">Auto-sync</p>
                      <p className="text-[11px] text-text-tertiary">every 5 minutes</p>
                    </div>
                    <span className="flex-shrink-0 rounded-none border border-status-success px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-status-success">
                      On
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">Write status back</p>
                      <p className="text-[11px] text-text-tertiary">
                        Cyboflow stage changes update the {meta.name} issue.
                      </p>
                    </div>
                    <PillToggle
                      checked={twoWay}
                      onChange={handleTwoWay}
                      label="Write status back"
                    />
                  </div>

                  {twoWay && (
                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-text-primary">
                          Mirror task breakdowns
                        </p>
                        <p className="text-[11px] text-text-tertiary">
                          Planner tasks become sub-issues of the origin issue.
                        </p>
                      </div>
                      <PillToggle
                        checked={mirrorSubissues}
                        onChange={handleMirror}
                        label="Mirror task breakdowns"
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">Conflicts</p>
                      <p className="text-[11px] text-text-tertiary">
                        {connection.openConflictCount} open
                      </p>
                    </div>
                    <Segmented
                      options={CONFLICT_OPTIONS}
                      value={conflictMode}
                      onChange={handleConflictMode}
                      ariaLabel="Conflict mode"
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-text-primary">State mapping</p>
                      <p className="text-[11px] text-text-tertiary">
                        {mappedCount} of {totalStates} states mapped
                      </p>
                    </div>
                    <span className="flex-shrink-0 text-[10px] uppercase tracking-[0.12em] text-text-tertiary">
                      {mappedTargets || 'nothing imported'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Last sync */}
              <div className={CARD}>
                <div className="flex items-center justify-between gap-3 border-b border-border-primary bg-surface-secondary px-3 py-2">
                  <Eyebrow>Last sync · {formatSyncedAt(connection.lastSyncAt)}</Eyebrow>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="rounded-none"
                    icon={<RefreshCw className={cn('h-3 w-3', syncing && 'animate-spin')} />}
                    disabled={syncing}
                    onClick={() => void handleSyncNow()}
                  >
                    Sync now
                  </Button>
                </div>
                <div className="space-y-0.5 px-3 py-2.5 font-mono text-[11px]">
                  {log.map((entry, index) => (
                    <p key={`${index}-${entry.line}`} className="flex gap-2">
                      <span className={cn('flex-shrink-0', logMarkerClass(entry.marker))}>
                        {entry.marker}
                      </span>
                      <span className="min-w-0 break-words text-text-secondary">{entry.line}</span>
                    </p>
                  ))}
                  {log.length === 0 && (
                    <p className="text-text-tertiary">No sync has run on this connection yet.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Open conflicts */}
            {showConflicts && (
              <div className={CARD} data-testid="tracker-conflicts-card">
                <div className="border-b border-border-primary bg-surface-secondary px-3 py-2">
                  <Eyebrow>Open conflicts</Eyebrow>
                </div>
                <div className="divide-y divide-border-primary">
                  {conflicts.map((conflict) => (
                    <div key={conflict.id} className="px-3 py-2.5">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[10px] lowercase text-text-tertiary">
                          {conflict.entityRef ?? 'unlinked'}
                        </span>
                        <span className="truncate text-xs font-semibold text-text-primary">
                          {conflict.entityTitle ?? 'Removed in the tracker'}
                        </span>
                        <span className="ml-auto flex-shrink-0 text-[10px] uppercase tracking-[0.12em] text-status-warning">
                          {conflict.field ?? conflict.kind}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div className="border border-border-primary p-2">
                          <Eyebrow>Cyboflow</Eyebrow>
                          <p className="mt-1 break-words text-[11px] text-text-secondary">
                            {conflict.localValue ?? '—'}
                          </p>
                        </div>
                        <div className="border border-border-primary p-2">
                          <Eyebrow>{meta.name}</Eyebrow>
                          <p className="mt-1 break-words text-[11px] text-text-secondary">
                            {conflict.remoteValue ?? '—'}
                          </p>
                        </div>
                      </div>
                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="rounded-none"
                          onClick={() => handleResolve(conflict.id, 'local')}
                        >
                          Accept ours
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className="rounded-none"
                          onClick={() => handleResolve(conflict.id, 'remote')}
                        >
                          Accept theirs
                        </Button>
                      </div>
                    </div>
                  ))}
                  {conflicts.length === 0 && (
                    <p className="px-3 py-4 text-xs text-text-tertiary">
                      Nothing is waiting on a decision.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
