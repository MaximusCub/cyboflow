/**
 * useDesignComments — comment-mode state machine for the v1 interactive
 * design canvas (design-mode.md "Comment mode — live-DOM freeze + sanitizer +
 * nonce-CSP").
 *
 * Owns:
 *   - Enter: capture the live prototype DOM (via the InteractivePrototypeEmbed
 *     imperative handle's `requestCapture`) → sanitize parent-side
 *     (`sanitizeFrozenDom`) → host it (`designPrototypeServer.hostComment`) →
 *     swap in the comment frame URL. Any failure at any step is fail-soft:
 *     surfaces `errorMessage` and stays in `'live'` mode — comment mode never
 *     wedges the surface.
 *   - Inspector message validation: schema-checked (never trusted as a
 *     security decision — the CSP + navigation guard are the enforcement,
 *     this is UI input) and capped, so a malformed or oversized payload is
 *     silently ignored rather than crashing the rail.
 *   - Drafts CRUD, delegated to `useFeedback` (the same doc-scoped hook the
 *     document feedback surface uses — draft creation/edit/delete are
 *     identical operations for the element-anchor variant).
 *   - Send: the DESIGN outbox path (`feedback.sendDesignBatch`), never
 *     `useFeedback`'s `sendBatch` (that throws for a design-prototype atype —
 *     see its doc comment).
 *
 * DOM concerns (the `message` listener's source-identity check, the iframe
 * ref) live in the consuming component (`DesignCommentMode`), not here — this
 * hook only validates message SHAPE once handed a raw payload.
 */
import { useCallback, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { trpc } from '../trpc/client';
import { useFeedback } from './useFeedback';
import { sanitizeFrozenDom } from '../utils/sanitizeFrozenDom';
import { latestBatchStatus, type ChipStatus } from '../components/cyboflow/feedback/feedbackLogic';
import { isElementAnchor } from '../../../shared/types/feedback';
import type {
  DesignFeedbackAtype,
  ElementAncestor,
  ElementCommentAnchor,
  FeedbackComment,
} from '../../../shared/types/feedback';
import type { InteractivePrototypeCaptureHandle } from '../components/cyboflow/design/InteractivePrototypeEmbed';

export type CommentModeStatus = 'live' | 'entering' | 'active';

export type DraftDesignComment = FeedbackComment & { anchor: ElementCommentAnchor };

export interface DesignInspectMessage {
  kind: 'hover' | 'pick';
  stack: ElementAncestor[];
}

/** Ceiling on an inspector stack — see designInspectorScript.ts's own walk; matched here defensively. */
const MAX_INSPECTOR_STACK = 64;

/** The inspector's message `type` (main/src/services/designInspectorScript.ts `DESIGN_INSPECT_MESSAGE_TYPE`) — duplicated as a literal, see InteractivePrototypeEmbed.tsx's note on why frontend/ doesn't import main/src. */
const DESIGN_INSPECT_MESSAGE_TYPE = 'cyboflow-design-inspect';

function isValidAncestor(value: unknown): value is ElementAncestor {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.tag !== 'string' || v.tag.length === 0) return false;
  if (v.designId !== null && typeof v.designId !== 'string') return false;
  if (v.label !== null && typeof v.label !== 'string') return false;
  return true;
}

/**
 * Validate + narrow a raw inspector postMessage payload. Returns null for
 * anything malformed or oversized — callers must ignore silently, never
 * throw (inspector output is UI input, never a security decision).
 */
export function parseDesignInspectMessage(data: unknown): DesignInspectMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== DESIGN_INSPECT_MESSAGE_TYPE) return null;
  if (d.kind !== 'hover' && d.kind !== 'pick') return null;
  if (!Array.isArray(d.stack) || d.stack.length === 0 || d.stack.length > MAX_INSPECTOR_STACK) return null;
  if (!d.stack.every(isValidAncestor)) return null;
  return { kind: d.kind, stack: d.stack };
}

/** Why the composer's Save is disabled, or null when it's enabled. Exported for testing. */
export function computeComposerDisabledReason(input: {
  sourceRefMissing: boolean;
  textEmpty: boolean;
  saving: boolean;
}): string | null {
  if (input.sourceRefMissing) return "This session's prototype has no linked idea yet";
  if (input.saving) return 'Saving…';
  if (input.textEmpty) return 'Write a comment first';
  return null;
}

/** Why "Send feedback" is disabled, or null when it's enabled. Exported for testing. */
export function computeDesignSendDisabledReason(input: {
  sourceRefMissing: boolean;
  draftCount: number;
  sending: boolean;
}): string | null {
  if (input.sourceRefMissing) return "This session's prototype has no linked idea yet";
  if (input.sending) return 'Sending…';
  if (input.draftCount === 0) return 'No draft comments to send';
  return null;
}

export interface UseDesignCommentsOptions {
  projectId: number | null;
  /** The interactive-prototype run's id — comment mode's own runId, distinct
   *  from any other run the session may have. Null before it resolves. */
  runId: string | null;
  sessionId: string | null;
  /** The prototype artifact's `sourceRef` (the owning idea id), or null when
   *  the artifact hasn't been stamped with one yet. */
  sourceRef: string | null;
  atype: DesignFeedbackAtype;
  captureRef: RefObject<InteractivePrototypeCaptureHandle | null>;
}

export interface UseDesignCommentsResult {
  status: CommentModeStatus;
  errorMessage: string | null;
  commentUrl: string | null;
  enter: () => Promise<void>;
  exit: () => void;

  hoverBreadcrumb: ElementAncestor[] | null;
  handleInspectorMessage: (raw: unknown) => void;

  composer: { stack: ElementAncestor[]; pickedIndex: number } | null;
  setComposerPickedIndex: (index: number) => void;
  closeComposer: () => void;
  composerText: string;
  setComposerText: (text: string) => void;
  saveComposer: () => Promise<void>;
  savingComposer: boolean;
  composerDisabledReason: string | null;

  drafts: DraftDesignComment[];
  editingId: string | null;
  startEdit: (comment: FeedbackComment) => void;
  editText: string;
  setEditText: (text: string) => void;
  saveEdit: (commentId: string) => Promise<void>;
  cancelEdit: () => void;
  deleteDraft: (commentId: string) => Promise<void>;

  chipStatus: ChipStatus | null;

  send: () => Promise<void>;
  sending: boolean;
  sendError: string | null;
  sendDisabledReason: string | null;
}

export function useDesignComments(opts: UseDesignCommentsOptions): UseDesignCommentsResult {
  const { projectId, runId, sessionId, sourceRef, atype, captureRef } = opts;

  const [status, setStatus] = useState<CommentModeStatus>('live');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [commentUrl, setCommentUrl] = useState<string | null>(null);

  const [hoverBreadcrumb, setHoverBreadcrumb] = useState<ElementAncestor[] | null>(null);
  const [composer, setComposer] = useState<{ stack: ElementAncestor[]; pickedIndex: number } | null>(null);
  const [composerText, setComposerText] = useState('');
  const [savingComposer, setSavingComposer] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const { comments, batches, createComment, updateComment, deleteComment } = useFeedback(
    projectId,
    runId,
    atype,
    sourceRef ?? undefined,
  );

  const drafts = useMemo(
    () =>
      comments.filter(
        (c): c is DraftDesignComment => c.status === 'draft' && isElementAnchor(c.anchor),
      ),
    [comments],
  );

  const chipStatus = useMemo(
    () => (sourceRef !== null ? latestBatchStatus(batches, sourceRef) : null),
    [batches, sourceRef],
  );

  const enter = useCallback(async (): Promise<void> => {
    if (status !== 'live' || runId === null) return;
    setStatus('entering');
    setErrorMessage(null);
    try {
      const handle = captureRef.current;
      if (!handle) throw new Error('Prototype frame is not ready');
      const rawHtml = await handle.requestCapture();
      const sanitized = sanitizeFrozenDom(rawHtml);
      const bridge = window.electronAPI?.designPrototypeServer;
      if (!bridge) throw new Error('Design bridge unavailable');
      const result = await bridge.hostComment({ runId, sanitizedHtml: sanitized });
      if (!result.success || !result.data) {
        throw new Error(result.error ?? 'Failed to host comment document');
      }
      setCommentUrl(result.data.url);
      setStatus('active');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to enter comment mode');
      setStatus('live');
      setCommentUrl(null);
    }
  }, [status, runId, captureRef]);

  const exit = useCallback((): void => {
    setStatus('live');
    setCommentUrl(null);
    setErrorMessage(null);
    setHoverBreadcrumb(null);
    setComposer(null);
    setComposerText('');
    setSendError(null);
  }, []);

  const handleInspectorMessage = useCallback((raw: unknown): void => {
    const message = parseDesignInspectMessage(raw);
    if (message === null) return;
    if (message.kind === 'hover') {
      setHoverBreadcrumb(message.stack);
      return;
    }
    setHoverBreadcrumb(null);
    setComposer({ stack: message.stack, pickedIndex: 0 });
    setComposerText('');
  }, []);

  const setComposerPickedIndex = useCallback((index: number): void => {
    setComposer((prev) => {
      if (prev === null) return prev;
      const clamped = Math.max(0, Math.min(index, prev.stack.length - 1));
      return { ...prev, pickedIndex: clamped };
    });
  }, []);

  const closeComposer = useCallback((): void => {
    setComposer(null);
    setComposerText('');
  }, []);

  const saveComposer = useCallback(async (): Promise<void> => {
    if (composer === null || sourceRef === null) return;
    const trimmed = composerText.trim();
    if (trimmed.length === 0 || savingComposer) return;
    setSavingComposer(true);
    try {
      const picked = composer.stack[composer.pickedIndex] ?? composer.stack[0];
      const anchor: ElementCommentAnchor = {
        kind: 'element',
        designId: picked?.designId ?? null,
        ancestorStack: composer.stack,
        pickedIndex: composer.pickedIndex,
      };
      await createComment(anchor, trimmed);
      setComposer(null);
      setComposerText('');
    } finally {
      setSavingComposer(false);
    }
  }, [composer, composerText, savingComposer, sourceRef, createComment]);

  const startEdit = useCallback((comment: FeedbackComment): void => {
    setEditingId(comment.id);
    setEditText(comment.body);
  }, []);

  const cancelEdit = useCallback((): void => {
    setEditingId(null);
    setEditText('');
  }, []);

  const saveEdit = useCallback(
    async (commentId: string): Promise<void> => {
      const trimmed = editText.trim();
      if (trimmed.length === 0) return;
      await updateComment(commentId, trimmed);
      setEditingId(null);
      setEditText('');
    },
    [editText, updateComment],
  );

  const deleteDraft = useCallback(
    async (commentId: string): Promise<void> => {
      await deleteComment(commentId);
    },
    [deleteComment],
  );

  const send = useCallback(async (): Promise<void> => {
    if (runId === null || sessionId === null || sourceRef === null || drafts.length === 0 || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await trpc.cyboflow.feedback.sendDesignBatch.mutate({
        runId,
        sessionId,
        atype,
        sourceRef,
        commentIds: drafts.map((d) => d.id),
      });
      exit();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Failed to send feedback');
    } finally {
      setSending(false);
    }
  }, [runId, sessionId, sourceRef, atype, drafts, sending, exit]);

  const composerDisabledReason = computeComposerDisabledReason({
    sourceRefMissing: sourceRef === null,
    textEmpty: composerText.trim().length === 0,
    saving: savingComposer,
  });

  const sendDisabledReason = computeDesignSendDisabledReason({
    sourceRefMissing: sourceRef === null,
    draftCount: drafts.length,
    sending,
  });

  return {
    status,
    errorMessage,
    commentUrl,
    enter,
    exit,
    hoverBreadcrumb,
    handleInspectorMessage,
    composer,
    setComposerPickedIndex,
    closeComposer,
    composerText,
    setComposerText,
    saveComposer,
    savingComposer,
    composerDisabledReason,
    drafts,
    editingId,
    startEdit,
    editText,
    setEditText,
    saveEdit,
    cancelEdit,
    deleteDraft,
    chipStatus,
    send,
    sending,
    sendError,
    sendDisabledReason,
  };
}
