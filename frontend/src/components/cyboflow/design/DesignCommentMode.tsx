/**
 * DesignCommentMode — the v1 comment-mode UI (design-mode.md "Comment mode —
 * live-DOM freeze + sanitizer + nonce-CSP").
 *
 * Renders the hosted comment frame (a nonce-CSP sandboxed iframe whose only
 * possible writer is the app-owned inspector script — see
 * main/src/services/designInspectorScript.ts) beside a rail of draft
 * comments. All async/business logic (capture→sanitize→host, message
 * validation, drafts CRUD, send) lives in `useDesignComments`; this component
 * owns exactly the DOM concerns that logic can't: the iframe ref and the
 * `window.message` listener's SOURCE-IDENTITY check (never `event.origin` —
 * the sandboxed frame has no `allow-same-origin`, so its origin is the opaque
 * string `'null'`).
 *
 * Rendered by DesignModeSurface as a sibling of (never a replacement for) the
 * live DesignStage — the live embed stays mounted underneath so the
 * prototype's JS state survives a comment-mode round trip.
 */
import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { FeedbackChip } from '../feedback/FeedbackChip';
import type { ChipStatus } from '../feedback/feedbackLogic';
import type { ElementAncestor, FeedbackComment } from '../../../../../shared/types/feedback';
import type { DraftDesignComment } from '../../../hooks/useDesignComments';

interface DesignCommentModeProps {
  commentUrl: string;
  hoverBreadcrumb: ElementAncestor[] | null;
  onInspectorMessage: (raw: unknown) => void;

  composer: { stack: ElementAncestor[]; pickedIndex: number } | null;
  onComposerPickedIndex: (index: number) => void;
  onComposerClose: () => void;
  composerText: string;
  onComposerTextChange: (text: string) => void;
  onComposerSave: () => void;
  savingComposer: boolean;
  composerDisabledReason: string | null;

  drafts: DraftDesignComment[];
  editingId: string | null;
  onStartEdit: (comment: FeedbackComment) => void;
  editText: string;
  onEditTextChange: (text: string) => void;
  onSaveEdit: (commentId: string) => void;
  onCancelEdit: () => void;
  onDeleteDraft: (commentId: string) => void;

  chipStatus: ChipStatus | null;

  onSend: () => void;
  sending: boolean;
  sendError: string | null;
  sendDisabledReason: string | null;
}

function breadcrumbLabel(entry: ElementAncestor): string {
  return entry.label ? `${entry.tag} "${entry.label}"` : entry.tag;
}

function summarizeAnchor(comment: DraftDesignComment): string {
  const picked = comment.anchor.ancestorStack[comment.anchor.pickedIndex];
  return picked ? breadcrumbLabel(picked) : 'element';
}

export function DesignCommentMode({
  commentUrl,
  hoverBreadcrumb,
  onInspectorMessage,
  composer,
  onComposerPickedIndex,
  onComposerClose,
  composerText,
  onComposerTextChange,
  onComposerSave,
  savingComposer,
  composerDisabledReason,
  drafts,
  editingId,
  onStartEdit,
  editText,
  onEditTextChange,
  onSaveEdit,
  onCancelEdit,
  onDeleteDraft,
  chipStatus,
  onSend,
  sending,
  sendError,
  sendDisabledReason,
}: DesignCommentModeProps): ReactElement {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const handler = (event: MessageEvent): void => {
      // Source identity, not origin — see the header comment.
      if (event.source !== iframeRef.current?.contentWindow) return;
      onInspectorMessage(event.data);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onInspectorMessage]);

  return (
    <div data-testid="design-comment-mode" className="h-full w-full flex min-h-0">
      <div className="relative flex-1 flex flex-col min-h-0">
        <iframe
          ref={iframeRef}
          data-testid="design-comment-frame"
          src={commentUrl}
          title="Design comments"
          // Same rationale as the live embed — allow-scripts ONLY, no
          // allow-same-origin. The inspector is the frame's sole writer under
          // its nonce-only CSP either way; the sandbox is defense in depth.
          sandbox="allow-scripts"
          className="flex-1 w-full border-0 bg-surface-primary min-h-0"
        />
        {hoverBreadcrumb && (
          <div
            data-testid="design-comment-hover-breadcrumb"
            className="absolute bottom-2 left-2 text-[10px] text-text-secondary border border-border-primary rounded px-2 py-1 pointer-events-none"
            style={{ backgroundColor: 'color-mix(in srgb, var(--color-bg-primary) 90%, transparent)' }}
          >
            {hoverBreadcrumb.map(breadcrumbLabel).join(' ‹ ')}
          </div>
        )}
        {composer && (
          <div
            data-testid="design-comment-composer"
            className="absolute inset-0 flex items-center justify-center p-4"
            style={{ backgroundColor: 'color-mix(in srgb, var(--color-bg-primary) 40%, transparent)' }}
          >
            <div className="w-72 bg-bg-primary border border-border-primary rounded-lg p-3 flex flex-col gap-2 shadow-lg">
              <div className="flex flex-wrap items-center gap-1 text-[10px]">
                {composer.stack.map((entry, index) => (
                  <button
                    key={index}
                    type="button"
                    data-testid={`design-comment-breadcrumb-${index}`}
                    onClick={() => onComposerPickedIndex(index)}
                    className={
                      index === composer.pickedIndex
                        ? 'font-bold text-text-primary underline'
                        : 'text-text-muted hover:text-text-primary'
                    }
                  >
                    {breadcrumbLabel(entry)}
                    {index < composer.stack.length - 1 ? ' ‹' : ''}
                  </button>
                ))}
              </div>
              <textarea
                data-testid="design-comment-composer-textarea"
                autoFocus
                value={composerText}
                onChange={(e) => onComposerTextChange(e.target.value)}
                placeholder="What should change here?"
                rows={3}
                className="text-xs p-2 border border-border-primary rounded bg-surface-primary text-text-primary resize-y"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="design-comment-composer-cancel"
                  onClick={onComposerClose}
                  className="text-[10px] font-semibold px-2 py-1 border border-border-primary rounded text-text-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="design-comment-composer-save"
                  title={composerDisabledReason ?? undefined}
                  disabled={composerDisabledReason !== null}
                  onClick={onComposerSave}
                  className="text-[10px] font-bold px-2 py-1 rounded bg-text-primary text-surface-primary disabled:opacity-50"
                >
                  {savingComposer ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div
        data-testid="design-comment-rail"
        className="w-72 shrink-0 border-l border-border-primary flex flex-col min-h-0 overflow-y-auto"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-primary">
          <span className="text-[10px] font-bold tracking-wide text-text-tertiary uppercase">Comments</span>
          <span className="flex-1" />
          <FeedbackChip status={chipStatus} />
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {drafts.length === 0 ? (
            <div data-testid="design-comment-rail-empty" className="text-[11px] text-text-tertiary italic">
              Click an element in the frame to leave a comment.
            </div>
          ) : (
            drafts.map((comment) => (
              <div
                key={comment.id}
                data-testid={`design-comment-draft-${comment.id}`}
                className="border-l-2 border-border-primary pl-2 mb-3"
              >
                <div className="text-[10px] italic text-text-tertiary">{summarizeAnchor(comment)}</div>
                {editingId === comment.id ? (
                  <div className="mt-1">
                    <textarea
                      data-testid={`design-comment-edit-textarea-${comment.id}`}
                      value={editText}
                      onChange={(e) => onEditTextChange(e.target.value)}
                      rows={2}
                      className="w-full text-[11px] p-1.5 border border-border-primary rounded bg-surface-primary text-text-primary"
                    />
                    <div className="flex gap-2 mt-1">
                      <button
                        type="button"
                        data-testid={`design-comment-edit-save-${comment.id}`}
                        onClick={() => onSaveEdit(comment.id)}
                        className="text-[10px] font-bold text-text-primary"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        data-testid={`design-comment-edit-cancel-${comment.id}`}
                        onClick={onCancelEdit}
                        className="text-[10px] font-semibold text-text-secondary"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="text-[11.5px] text-text-primary mt-0.5">{comment.body}</div>
                    <div className="flex gap-2 mt-1">
                      <button
                        type="button"
                        data-testid={`design-comment-draft-edit-${comment.id}`}
                        onClick={() => onStartEdit(comment)}
                        className="text-[10px] font-semibold text-text-secondary"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        data-testid={`design-comment-draft-delete-${comment.id}`}
                        onClick={() => onDeleteDraft(comment.id)}
                        className="text-[10px] font-semibold text-red-500"
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
          )}
        </div>

        <div className="border-t border-border-primary px-3 py-2 flex flex-col gap-1.5">
          {sendError && (
            <div data-testid="design-comment-send-error" className="text-[10px] text-red-500">
              {sendError}
            </div>
          )}
          <button
            type="button"
            data-testid="design-comment-send"
            title={sendDisabledReason ?? undefined}
            disabled={sendDisabledReason !== null}
            onClick={onSend}
            className="text-xs font-bold text-text-primary bg-bg-primary border border-border-primary rounded px-3 py-1.5 disabled:opacity-50"
          >
            {sending ? 'Sending…' : `Send feedback (${drafts.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
