/**
 * PendingSendRow — the pinned optimistic-echo strip rendered between the chat
 * transcript and the composer (see UnifiedChatView). Each entry is a message the
 * user just sent that has not yet surfaced as a real transcript row:
 *
 *   - 'sending' — dispatched, awaiting its transcript echo. Subtle spinner; not
 *                 clickable (it will reconcile itself momentarily).
 *   - 'queued'  — buffered server-side, will be delivered at the next turn
 *                 boundary. Distinct "queued" treatment; click to reopen (pulls
 *                 the text back into the composer and dequeues it).
 *   - 'failed'  — the dispatch rejected. Error treatment; click to reopen (pulls
 *                 the text back into the composer to retry). The REASON is shown
 *                 beneath the label whenever the dispatch supplied one — a bare
 *                 "Failed · click to retry" leaves the user re-sending into the
 *                 same wall with no idea what to change.
 *
 * A provider-disabled failure (the user switched Claude/Codex off in Settings →
 * Integrations, so the call-level guard refused) additionally renders a direct
 * "Open Settings → Integrations" action, since retrying is futile until the
 * toggle flips back. It is recognized structurally, via the wire code the guard
 * embeds (shared/types/agentRuntime), never by matching prose.
 *
 * Presentational apart from that one navigation action: it reads the entries +
 * a reopen callback from the host and owns no state.
 */
import { Loader2, Clock, AlertTriangle, Settings2 } from 'lucide-react';
import { cn } from '../../../utils/cn';
import { parseAgentProviderDisabled } from '../../../../../shared/types/agentRuntime';
import { useNavigationStore } from '../../../stores/navigationStore';
import type { PendingSend } from '../../../stores/pendingSendStore';

export interface PendingSendRowProps {
  entries: PendingSend[];
  /** Reopen a 'queued'/'failed' entry — repopulate the composer + remove it. */
  onReopen: (entry: PendingSend) => void;
}

function statusLabel(status: PendingSend['status']): string {
  if (status === 'sending') return 'Sending';
  if (status === 'queued') return 'Queued · click to edit';
  return 'Failed · click to retry';
}

function statusTitle(status: PendingSend['status']): string {
  if (status === 'sending') return 'Sending…';
  if (status === 'queued') return 'Queued — will send at the next pause. Click to edit.';
  return 'Send failed. Click to edit and retry.';
}

export function PendingSendRow({ entries, onReopen }: PendingSendRowProps): React.ReactElement | null {
  const openSettings = useNavigationStore((s) => s.openSettings);

  if (entries.length === 0) return null;

  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-t border-border-primary bg-bg-primary px-4 pt-2"
      data-testid="pending-send-row"
    >
      {entries.map((entry) => {
        const reopenable = entry.status === 'queued' || entry.status === 'failed';
        // Only a 'failed' entry carries a reason; a provider-disabled one also
        // earns the Settings shortcut (retrying cannot help until it is on).
        const disabled = entry.status === 'failed' ? parseAgentProviderDisabled(entry.error) : null;
        const reason = disabled?.message ?? (entry.status === 'failed' ? entry.error : undefined);

        return (
          <div
            key={entry.id}
            data-testid="pending-send-entry"
            className={cn(
              'border text-xs',
              entry.status === 'failed'
                ? 'border-status-error/40 bg-status-error/5 text-status-error'
                : entry.status === 'queued'
                  ? 'border-dashed border-border-hover bg-surface-secondary text-text-secondary'
                  : 'border-border-primary bg-surface-secondary text-text-tertiary',
            )}
          >
            {/* The reopen affordance stays a button covering the label + text;
                the Settings action below is a SIBLING, never nested inside it
                (nested interactive elements are invalid and untargetable). */}
            <button
              type="button"
              disabled={!reopenable}
              onClick={reopenable ? () => onReopen(entry) : undefined}
              title={statusTitle(entry.status)}
              data-testid={`pending-send-${entry.status}`}
              className={cn(
                'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
                reopenable ? 'cursor-pointer hover:text-text-primary' : 'cursor-default',
              )}
            >
              <span className="mt-0.5 shrink-0">
                {entry.status === 'sending' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : entry.status === 'queued' ? (
                  <Clock className="h-3.5 w-3.5" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-[0.1em] opacity-70">
                  {statusLabel(entry.status)}
                </span>
                {reason && (
                  <span
                    className="mb-1 block whitespace-pre-wrap break-words opacity-90"
                    data-testid="pending-send-reason"
                  >
                    {reason}
                  </span>
                )}
                <span className="block whitespace-pre-wrap break-words font-mono">{entry.text}</span>
              </span>
            </button>

            {disabled && (
              <div className="border-t border-status-error/25 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => openSettings('integrations')}
                  data-testid="pending-send-open-integrations"
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold underline underline-offset-2 transition-opacity hover:opacity-80"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  Open Settings → Integrations
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
