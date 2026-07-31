/**
 * TrackerIntegrationSection — the issue-tracker catalog inside
 * Settings → Integrations, rendered below the Claude/Codex provider rows.
 *
 * Exactly two rows (Linear, Plane): a row is either "Not connected" with a
 * Connect button that opens the wizard, or "Connected" with a Manage button
 * that opens the connected view. Both sub-surfaces are `size="full"` Modals
 * rendered as CHILDREN of this section (and therefore of the Settings modal) —
 * the nested-modal pattern Modal.tsx documents.
 *
 * Connections are read for the ACTIVE project (a tracker connection is
 * project-scoped) and re-read on every `onTrackerChanged` notification: the
 * event is a signal, not a patch, so the handler always re-queries rather than
 * mutating a card from the payload.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { trpc } from '../../../trpc/client';
import { Button } from '../../ui/Button';
import { SettingsSection } from '../../ui/SettingsSection';
import { useNavigationStore } from '../../../stores/navigationStore';
import type {
  TrackerConnectionSummary,
  TrackerProvider,
} from '../../../../../shared/types/trackerSync';
import { ProviderTile } from './trackerShared';
import { TRACKER_PROVIDERS } from './trackerVocabulary';
import { TrackerWizardModal } from './TrackerWizardModal';
import { TrackerConnectedView } from './TrackerConnectedView';

export function TrackerIntegrationSection(): React.JSX.Element {
  const activeProjectId = useNavigationStore((s) => s.activeProjectId);

  const [connections, setConnections] = useState<TrackerConnectionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** Which sub-modal is open: the wizard for a provider, or one connection's manage view. */
  const [wizardProvider, setWizardProvider] = useState<TrackerProvider | null>(null);
  const [manageConnectionId, setManageConnectionId] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    if (activeProjectId === null) {
      setConnections([]);
      return;
    }
    void trpc.cyboflow.tracker.connections
      .query({ projectId: activeProjectId })
      .then((rows) => {
        setConnections(rows);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [activeProjectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live refresh. The onData payload type is AppRouter-inferred — do not annotate it.
  useEffect(() => {
    if (activeProjectId === null) return;
    const sub = trpc.cyboflow.tracker.onTrackerChanged.subscribe(
      { projectId: activeProjectId },
      { onData: () => refresh() },
    );
    return () => sub.unsubscribe();
  }, [activeProjectId, refresh]);

  const managed = connections.find((c) => c.id === manageConnectionId) ?? null;

  return (
    <SettingsSection
      title="Issue trackers"
      description="Two-way sync between this project's backlog and an external tracker."
      icon={<Link2 className="h-4 w-4" />}
      className="ml-0"
    >
      {error !== null && (
        <p role="alert" className="text-xs text-status-error">
          {error}
        </p>
      )}

      {activeProjectId === null && (
        <p className="text-xs text-text-tertiary">
          Select a project to connect an issue tracker.
        </p>
      )}

      <div className="divide-y divide-border-primary overflow-hidden rounded-none border border-border-primary bg-surface-primary">
        {TRACKER_PROVIDERS.map((meta) => {
          const connection = connections.find((c) => c.provider === meta.provider) ?? null;
          return (
            <div key={meta.provider} className="flex items-center gap-3 px-4 py-4">
              <ProviderTile mark={meta.mark} />
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-semibold text-text-primary">{meta.name}</h4>
                <p className="mt-1 text-xs leading-relaxed text-text-tertiary">
                  {meta.description}
                </p>
              </div>

              <div className="flex flex-shrink-0 items-center gap-3">
                {connection === null ? (
                  <span className="text-xs text-text-tertiary">Not connected</span>
                ) : (
                  <span className="flex items-center gap-2 text-xs font-semibold text-status-success">
                    <span className="h-2 w-2 flex-shrink-0 rounded-full bg-status-success" />
                    Connected
                  </span>
                )}
                {connection === null ? (
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="rounded-none"
                    disabled={activeProjectId === null}
                    onClick={() => setWizardProvider(meta.provider)}
                  >
                    Connect
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="rounded-none"
                    onClick={() => setManageConnectionId(connection.id)}
                  >
                    Manage
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Nested sub-modals — mounted only while open, so each opens with fresh state. */}
      {wizardProvider !== null && activeProjectId !== null && (
        <TrackerWizardModal
          isOpen
          provider={wizardProvider}
          projectId={activeProjectId}
          onClose={() => setWizardProvider(null)}
          onConnected={refresh}
        />
      )}

      {managed !== null && (
        <TrackerConnectedView
          isOpen
          connection={managed}
          onClose={() => setManageConnectionId(null)}
          onChanged={refresh}
        />
      )}
    </SettingsSection>
  );
}
