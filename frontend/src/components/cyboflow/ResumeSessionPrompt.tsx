/**
 * ResumeSessionPrompt — open-time recovery prompt for a lost interactive (PTY)
 * quick session.
 *
 * When the app is closed/restarted the persistent `claude` REPL backing an
 * interactive quick session is gone, but the conversation's context survives on
 * disk (claude's transcript) and as `sessions.claude_session_id`. On reopening
 * such a session, ClaudePanel shows this prompt INSTEAD of silently letting the
 * next message start a brand-new conversation:
 *
 *   - primary "Resume previous session" → onResume: arms the deferred resume
 *     (sessions:resume-interactive). The next composer message continues the
 *     prior conversation with full context (`claude --resume <uuid>
 *     --fork-session`).
 *   - ghost   "Start fresh"             → onStartFresh: dismiss; the next message
 *     starts a new conversation (unchanged behavior).
 *
 * CLAUDE SWITCHED OFF (Settings → Integrations): resuming SPAWNS a claude REPL,
 * so the provider guard refuses it. That refusal used to be invisible — the
 * handler's spawn is fire-and-forget, so the prompt closed onto a blank terminal
 * with no explanation. The prompt now says so up front and still offers to go
 * ahead, because declining is not symmetric with the SDK case: a lost REPL's
 * conversation is recoverable ONLY by respawning it with `--resume`, and "start
 * fresh" destroys that history for good, where a refused SDK turn costs nothing
 * but a retry. Resuming anyway reopens the conversation read-only — the composer
 * is still guarded, so the copy promises exactly that and no more.
 *
 * Thin PRESENTATIONAL wrapper over `ui/Modal` (mirrors InteractiveWarnDialog) —
 * the scrim/card dismissal contract is delegated to Modal; actions are plain
 * callbacks. No tRPC, no wire types.
 */
import { type ReactElement } from 'react';
import { History, AlertTriangle, Settings2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

export interface ResumeSessionPromptProps {
  isOpen: boolean;
  /** Modal dismissal via Escape — the caller treats this as declining (start fresh). */
  onClose: () => void;
  /** Primary action: resume the prior conversation on the next message. */
  onResume: () => void;
  /** Ghost action: start a fresh conversation (dismiss). */
  onStartFresh: () => void;
  /**
   * Claude is switched off, so resuming needs an explicit override. Shows the
   * warning + Settings shortcut and relabels the primary action.
   */
  claudeDisabled?: boolean;
  /** Open Settings → Integrations. Required in practice whenever claudeDisabled. */
  onOpenSettings?: () => void;
}

export function ResumeSessionPrompt({
  isOpen,
  onClose,
  onResume,
  onStartFresh,
  claudeDisabled = false,
  onOpenSettings,
}: ResumeSessionPromptProps): ReactElement {
  // Actions do NOT call onClose themselves — the parent owns isOpen (it closes the
  // prompt by flipping its armed/dismissed state). This keeps Resume from being
  // immediately undone by an onClose that the parent maps to "decline".
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      closeOnOverlayClick={false}
      showCloseButton={false}
    >
      {/* Accent eyebrow stripe in the interactive (PTY) color. */}
      <div className="h-1.5 bg-interactive" aria-hidden="true" />

      <div className="px-6 py-5">
        <div className="mb-3 flex items-center gap-1.5 text-interactive">
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          <span
            className="font-semibold uppercase"
            style={{ fontSize: '10px', letterSpacing: '0.18em' }}
          >
            Previous session found
          </span>
        </div>

        <h2
          className="font-bold text-text-primary"
          style={{ fontSize: '13.5px', lineHeight: 1.35 }}
        >
          Resume your previous terminal session?
        </h2>

        <p
          className="mt-2 text-text-secondary"
          style={{ fontSize: '11.5px', lineHeight: 1.5 }}
        >
          This session's interactive terminal was closed when the app last shut
          down. You can resume the previous conversation — your next message will
          continue it with the full prior context — or start fresh with a new
          conversation in the same worktree.
        </p>

        {claudeDisabled && (
          <div
            className="mt-3 flex items-start gap-2 rounded border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-text-secondary"
            style={{ fontSize: '11.5px', lineHeight: 1.5 }}
            data-testid="resume-prompt-claude-disabled"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning" aria-hidden="true" />
            <span>
              <span className="font-semibold text-text-primary">Claude is turned off</span> in Settings
              → Integrations. You can still reopen this conversation to recover its history, but you
              won't be able to send a new message until Claude is switched back on.
            </span>
          </div>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onStartFresh}>
            Start fresh
          </Button>
          {claudeDisabled && onOpenSettings && (
            <Button variant="secondary" size="sm" onClick={onOpenSettings}>
              <Settings2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Open Settings
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={onResume}>
            {claudeDisabled ? 'Resume anyway' : 'Resume previous session'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default ResumeSessionPrompt;
