/**
 * Unit tests for useDesignComments (design-mode.md "Comment mode").
 *
 * useFeedback is mocked (its own behavior is covered by useFeedback.test.ts) —
 * this file exercises useDesignComments' OWN logic: the enter (capture →
 * sanitize → host) flow and its fail-soft error paths, inspector message
 * validation, the composer's breadcrumb/anchor construction, drafts derived
 * from the mocked comments list, and the send (sendDesignBatch) path. The
 * design-prototype `feedback.sendDesignBatch` tRPC call is mocked directly
 * (useDesignComments calls it itself, not through useFeedback — the design
 * outbox is never routed through useFeedback's own `sendBatch`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { RefObject } from 'react';
import type { FeedbackBatch, FeedbackComment } from '../../../../shared/types/feedback';
import type { InteractivePrototypeCaptureHandle } from '../../components/cyboflow/design/InteractivePrototypeEmbed';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateComment = vi.fn();
const mockUpdateComment = vi.fn();
const mockDeleteComment = vi.fn();
let mockComments: FeedbackComment[] = [];
let mockBatches: FeedbackBatch[] = [];

vi.mock('../useFeedback', () => ({
  useFeedback: () => ({
    comments: mockComments,
    batches: mockBatches,
    loading: false,
    createComment: mockCreateComment,
    updateComment: mockUpdateComment,
    deleteComment: mockDeleteComment,
    sendBatch: vi.fn(),
  }),
}));

const sendDesignBatchSpy = vi.fn();
vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      feedback: {
        sendDesignBatch: { mutate: (...args: unknown[]) => sendDesignBatchSpy(...args) },
      },
    },
  },
}));

const {
  useDesignComments,
  parseDesignInspectMessage,
  computeComposerDisabledReason,
  computeDesignSendDisabledReason,
} = await import('../useDesignComments');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUN = 'run-interactive-1';
const SESSION = 'sess-1';
const SOURCE_REF = 'IDEA-1';

function makeCaptureRef(
  overrides: Partial<InteractivePrototypeCaptureHandle> = {},
): RefObject<InteractivePrototypeCaptureHandle | null> {
  return {
    current: {
      requestCapture: vi.fn().mockResolvedValue('<!doctype html><html><body>hi</body></html>'),
      ...overrides,
    },
  };
}

function makeDraftComment(overrides: Partial<FeedbackComment> = {}): FeedbackComment {
  return {
    id: 'cmt-1',
    projectId: 1,
    runId: RUN,
    atype: 'interactive-prototype',
    sourceRef: SOURCE_REF,
    batchId: null,
    anchor: {
      kind: 'element',
      designId: 'btn-1',
      ancestorStack: [
        { tag: 'button', designId: 'btn-1', label: 'Save' },
        { tag: 'div', designId: null, label: null },
        { tag: 'body', designId: null, label: null },
      ],
      pickedIndex: 0,
    },
    body: 'Make this bigger',
    status: 'draft',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    sentAt: null,
    addressedAt: null,
    ...overrides,
  };
}

function installBridge(overrides?: {
  hostComment?: (req: { runId: string; sanitizedHtml: string }) => Promise<unknown>;
}) {
  const hostComment = vi.fn(
    overrides?.hostComment ??
      ((): Promise<unknown> => Promise.resolve({ success: true, data: { url: 'http://127.0.0.1:9/tok/comment/1.html' } })),
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    designPrototypeServer: { hostComment },
  };
  return { hostComment };
}

beforeEach(() => {
  mockComments = [];
  mockBatches = [];
  mockCreateComment.mockReset().mockResolvedValue(undefined);
  mockUpdateComment.mockReset().mockResolvedValue(undefined);
  mockDeleteComment.mockReset().mockResolvedValue(undefined);
  sendDesignBatchSpy.mockReset().mockResolvedValue({ batchId: 'batch-1', round: 1, commentIds: [] });
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

function renderDesignComments(overrides?: {
  captureRef?: RefObject<InteractivePrototypeCaptureHandle | null>;
  sourceRef?: string | null;
  runId?: string | null;
  sessionId?: string | null;
}) {
  const captureRef = overrides?.captureRef ?? makeCaptureRef();
  return renderHook(() =>
    useDesignComments({
      projectId: 1,
      runId: overrides?.runId === undefined ? RUN : overrides.runId,
      sessionId: overrides?.sessionId === undefined ? SESSION : overrides.sessionId,
      sourceRef: overrides?.sourceRef === undefined ? SOURCE_REF : overrides.sourceRef,
      atype: 'interactive-prototype',
      captureRef,
    }),
  );
}

// ---------------------------------------------------------------------------
// parseDesignInspectMessage
// ---------------------------------------------------------------------------

describe('parseDesignInspectMessage', () => {
  it('accepts a valid hover message', () => {
    const msg = parseDesignInspectMessage({
      type: 'cyboflow-design-inspect',
      kind: 'hover',
      stack: [{ tag: 'button', designId: 'b1', label: 'Save' }],
    });
    expect(msg).toEqual({ kind: 'hover', stack: [{ tag: 'button', designId: 'b1', label: 'Save' }] });
  });

  it('accepts a valid pick message with null designId/label', () => {
    const msg = parseDesignInspectMessage({
      type: 'cyboflow-design-inspect',
      kind: 'pick',
      stack: [{ tag: 'div', designId: null, label: null }],
    });
    expect(msg?.kind).toBe('pick');
  });

  it('rejects a non-object payload', () => {
    expect(parseDesignInspectMessage('not an object')).toBeNull();
    expect(parseDesignInspectMessage(null)).toBeNull();
    expect(parseDesignInspectMessage(undefined)).toBeNull();
  });

  it('rejects the wrong message type', () => {
    expect(
      parseDesignInspectMessage({ type: 'cyboflow-design-capture-result', kind: 'hover', stack: [] }),
    ).toBeNull();
  });

  it('rejects an unknown kind', () => {
    expect(
      parseDesignInspectMessage({ type: 'cyboflow-design-inspect', kind: 'drag', stack: [{ tag: 'a', designId: null, label: null }] }),
    ).toBeNull();
  });

  it('rejects an empty stack', () => {
    expect(parseDesignInspectMessage({ type: 'cyboflow-design-inspect', kind: 'hover', stack: [] })).toBeNull();
  });

  it('rejects a non-array stack', () => {
    expect(
      parseDesignInspectMessage({ type: 'cyboflow-design-inspect', kind: 'hover', stack: 'nope' }),
    ).toBeNull();
  });

  it('rejects a malformed stack entry (missing tag)', () => {
    expect(
      parseDesignInspectMessage({
        type: 'cyboflow-design-inspect',
        kind: 'hover',
        stack: [{ designId: null, label: null }],
      }),
    ).toBeNull();
  });

  it('rejects a malformed stack entry (non-string designId)', () => {
    expect(
      parseDesignInspectMessage({
        type: 'cyboflow-design-inspect',
        kind: 'hover',
        stack: [{ tag: 'div', designId: 42, label: null }],
      }),
    ).toBeNull();
  });

  it('rejects an oversized stack (> 64 entries)', () => {
    const stack = Array.from({ length: 65 }, () => ({ tag: 'div', designId: null, label: null }));
    expect(parseDesignInspectMessage({ type: 'cyboflow-design-inspect', kind: 'hover', stack })).toBeNull();
  });

  it('accepts exactly 64 entries', () => {
    const stack = Array.from({ length: 64 }, () => ({ tag: 'div', designId: null, label: null }));
    expect(parseDesignInspectMessage({ type: 'cyboflow-design-inspect', kind: 'hover', stack })).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeComposerDisabledReason / computeDesignSendDisabledReason
// ---------------------------------------------------------------------------

describe('computeComposerDisabledReason', () => {
  it('is null (enabled) when everything is satisfied', () => {
    expect(computeComposerDisabledReason({ sourceRefMissing: false, textEmpty: false, saving: false })).toBeNull();
  });
  it('flags a missing sourceRef first', () => {
    expect(computeComposerDisabledReason({ sourceRefMissing: true, textEmpty: true, saving: true })).toMatch(/linked idea/);
  });
  it('flags empty text', () => {
    expect(computeComposerDisabledReason({ sourceRefMissing: false, textEmpty: true, saving: false })).toMatch(/comment/i);
  });
});

describe('computeDesignSendDisabledReason', () => {
  it('is null (enabled) when everything is satisfied', () => {
    expect(computeDesignSendDisabledReason({ sourceRefMissing: false, draftCount: 1, sending: false })).toBeNull();
  });
  it('flags zero drafts', () => {
    expect(computeDesignSendDisabledReason({ sourceRefMissing: false, draftCount: 0, sending: false })).toMatch(/No draft/);
  });
});

// ---------------------------------------------------------------------------
// enter() — capture → sanitize → host
// ---------------------------------------------------------------------------

describe('useDesignComments — enter()', () => {
  it('happy path: sanitizes the captured html before hosting, then goes active with the returned url', async () => {
    const captureRef = makeCaptureRef({
      requestCapture: vi.fn().mockResolvedValue('<!doctype html><html><body><script>evil()</script>hi</body></html>'),
    });
    const bridge = installBridge();
    const { result } = renderDesignComments({ captureRef });

    expect(result.current.status).toBe('live');
    await act(async () => {
      await result.current.enter();
    });

    expect(bridge.hostComment).toHaveBeenCalledTimes(1);
    const sentHtml = bridge.hostComment.mock.calls[0][0].sanitizedHtml as string;
    // sanitizeFrozenDom strips <script> — proves the real sanitizer ran, not
    // the raw captured bytes.
    expect(sentHtml).not.toContain('<script>');
    expect(bridge.hostComment.mock.calls[0][0].runId).toBe(RUN);

    expect(result.current.status).toBe('active');
    expect(result.current.commentUrl).toBe('http://127.0.0.1:9/tok/comment/1.html');
    expect(result.current.errorMessage).toBeNull();
  });

  it('fails soft (stays live) when the capture handle is not ready', async () => {
    const captureRef: RefObject<InteractivePrototypeCaptureHandle | null> = { current: null };
    const { result } = renderDesignComments({ captureRef });

    await act(async () => {
      await result.current.enter();
    });

    expect(result.current.status).toBe('live');
    expect(result.current.commentUrl).toBeNull();
    expect(result.current.errorMessage).not.toBeNull();
  });

  it('fails soft when requestCapture rejects', async () => {
    const captureRef = makeCaptureRef({ requestCapture: vi.fn().mockRejectedValue(new Error('timed out')) });
    installBridge();
    const { result } = renderDesignComments({ captureRef });

    await act(async () => {
      await result.current.enter();
    });

    expect(result.current.status).toBe('live');
    expect(result.current.errorMessage).toBe('timed out');
  });

  it('fails soft when hostComment returns success: false', async () => {
    const captureRef = makeCaptureRef();
    installBridge({ hostComment: () => Promise.resolve({ success: false, error: 'no server' }) });
    const { result } = renderDesignComments({ captureRef });

    await act(async () => {
      await result.current.enter();
    });

    expect(result.current.status).toBe('live');
    expect(result.current.errorMessage).toBe('no server');
  });

  it('fails soft when the electronAPI bridge is absent', async () => {
    const captureRef = makeCaptureRef();
    // No installBridge() call — window.electronAPI stays undefined.
    const { result } = renderDesignComments({ captureRef });

    await act(async () => {
      await result.current.enter();
    });

    expect(result.current.status).toBe('live');
    expect(result.current.errorMessage).not.toBeNull();
  });

  it('is a no-op when runId is null', async () => {
    const captureRef = makeCaptureRef();
    installBridge();
    const { result } = renderDesignComments({ runId: null, captureRef });

    await act(async () => {
      await result.current.enter();
    });

    expect(result.current.status).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// exit()
// ---------------------------------------------------------------------------

describe('useDesignComments — exit()', () => {
  it('resets status/commentUrl/hover/composer/sendError back to live', async () => {
    installBridge();
    const { result } = renderDesignComments();
    await act(async () => {
      await result.current.enter();
    });
    expect(result.current.status).toBe('active');

    act(() => {
      result.current.handleInspectorMessage({
        type: 'cyboflow-design-inspect',
        kind: 'pick',
        stack: [{ tag: 'button', designId: 'b1', label: null }],
      });
    });
    expect(result.current.composer).not.toBeNull();

    act(() => {
      result.current.exit();
    });

    expect(result.current.status).toBe('live');
    expect(result.current.commentUrl).toBeNull();
    expect(result.current.hoverBreadcrumb).toBeNull();
    expect(result.current.composer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inspector message handling
// ---------------------------------------------------------------------------

describe('useDesignComments — handleInspectorMessage', () => {
  it('a hover message sets the breadcrumb', () => {
    const { result } = renderDesignComments();
    act(() => {
      result.current.handleInspectorMessage({
        type: 'cyboflow-design-inspect',
        kind: 'hover',
        stack: [{ tag: 'button', designId: 'b1', label: 'Save' }],
      });
    });
    expect(result.current.hoverBreadcrumb).toEqual([{ tag: 'button', designId: 'b1', label: 'Save' }]);
  });

  it('a pick message opens the composer at pickedIndex 0 and clears the hover breadcrumb', () => {
    const { result } = renderDesignComments();
    act(() => {
      result.current.handleInspectorMessage({
        type: 'cyboflow-design-inspect',
        kind: 'hover',
        stack: [{ tag: 'a', designId: null, label: null }],
      });
    });
    expect(result.current.hoverBreadcrumb).not.toBeNull();

    const stack = [
      { tag: 'button', designId: 'b1', label: 'Save' },
      { tag: 'div', designId: null, label: null },
    ];
    act(() => {
      result.current.handleInspectorMessage({ type: 'cyboflow-design-inspect', kind: 'pick', stack });
    });
    expect(result.current.composer).toEqual({ stack, pickedIndex: 0 });
    expect(result.current.hoverBreadcrumb).toBeNull();
  });

  it('ignores a malformed message silently (no state change)', () => {
    const { result } = renderDesignComments();
    act(() => {
      result.current.handleInspectorMessage({ type: 'not-inspect', kind: 'hover', stack: [] });
    });
    expect(result.current.hoverBreadcrumb).toBeNull();
    expect(result.current.composer).toBeNull();
  });

  it('walking setComposerPickedIndex clamps to the stack bounds', () => {
    const { result } = renderDesignComments();
    const stack = [
      { tag: 'button', designId: 'b1', label: null },
      { tag: 'div', designId: 'd1', label: null },
      { tag: 'body', designId: null, label: null },
    ];
    act(() => {
      result.current.handleInspectorMessage({ type: 'cyboflow-design-inspect', kind: 'pick', stack });
    });

    act(() => {
      result.current.setComposerPickedIndex(2);
    });
    expect(result.current.composer?.pickedIndex).toBe(2);

    act(() => {
      result.current.setComposerPickedIndex(99);
    });
    expect(result.current.composer?.pickedIndex).toBe(2); // clamped to stack.length - 1

    act(() => {
      result.current.setComposerPickedIndex(-5);
    });
    expect(result.current.composer?.pickedIndex).toBe(0); // clamped to 0
  });
});

// ---------------------------------------------------------------------------
// saveComposer — anchor construction
// ---------------------------------------------------------------------------

describe('useDesignComments — saveComposer', () => {
  const stack = [
    { tag: 'button', designId: 'b1', label: 'Save' },
    { tag: 'div', designId: 'd1', label: null },
    { tag: 'body', designId: null, label: null },
  ];

  it('creates a comment with the FULL ancestor stack and the picked designId, then closes the composer', async () => {
    const { result } = renderDesignComments();
    act(() => {
      result.current.handleInspectorMessage({ type: 'cyboflow-design-inspect', kind: 'pick', stack });
    });
    act(() => {
      result.current.setComposerPickedIndex(1);
    });
    act(() => {
      result.current.setComposerText('Make this bigger');
    });

    await act(async () => {
      await result.current.saveComposer();
    });

    expect(mockCreateComment).toHaveBeenCalledWith(
      { kind: 'element', designId: 'd1', ancestorStack: stack, pickedIndex: 1 },
      'Make this bigger',
    );
    expect(result.current.composer).toBeNull();
    expect(result.current.composerText).toBe('');
  });

  it('is a no-op when the composer text is empty', async () => {
    const { result } = renderDesignComments();
    act(() => {
      result.current.handleInspectorMessage({ type: 'cyboflow-design-inspect', kind: 'pick', stack });
    });
    await act(async () => {
      await result.current.saveComposer();
    });
    expect(mockCreateComment).not.toHaveBeenCalled();
  });

  it('is a no-op when sourceRef is null', async () => {
    const { result } = renderDesignComments({ sourceRef: null });
    act(() => {
      result.current.handleInspectorMessage({ type: 'cyboflow-design-inspect', kind: 'pick', stack });
    });
    act(() => {
      result.current.setComposerText('x');
    });
    await act(async () => {
      await result.current.saveComposer();
    });
    expect(mockCreateComment).not.toHaveBeenCalled();
    expect(result.current.composerDisabledReason).toMatch(/linked idea/);
  });
});

// ---------------------------------------------------------------------------
// drafts / rail CRUD
// ---------------------------------------------------------------------------

describe('useDesignComments — drafts + rail CRUD', () => {
  it('exposes only draft, element-anchored comments', () => {
    mockComments = [
      makeDraftComment({ id: 'd1' }),
      makeDraftComment({ id: 'sent-1', status: 'sent' }),
      // A quote-anchored comment should never appear for a design surface,
      // but the filter must not crash if one somehow does.
      makeDraftComment({ id: 'quote-1', anchor: { quote: 'x', occurrence: 0, bodyHash: 'h' } as never }),
    ];
    const { result } = renderDesignComments();
    expect(result.current.drafts.map((d) => d.id)).toEqual(['d1']);
  });

  it('edit: startEdit seeds editText, saveEdit calls updateComment and clears editing state', async () => {
    mockComments = [makeDraftComment({ id: 'd1', body: 'old text' })];
    const { result } = renderDesignComments();

    act(() => {
      result.current.startEdit(result.current.drafts[0]);
    });
    expect(result.current.editingId).toBe('d1');
    expect(result.current.editText).toBe('old text');

    act(() => {
      result.current.setEditText('new text');
    });
    await act(async () => {
      await result.current.saveEdit('d1');
    });

    expect(mockUpdateComment).toHaveBeenCalledWith('d1', 'new text');
    expect(result.current.editingId).toBeNull();
  });

  it('delete: deleteDraft forwards to deleteComment', async () => {
    mockComments = [makeDraftComment({ id: 'd1' })];
    const { result } = renderDesignComments();
    await act(async () => {
      await result.current.deleteDraft('d1');
    });
    expect(mockDeleteComment).toHaveBeenCalledWith('d1');
  });

  it('chipStatus derives from batches for the matching sourceRef', () => {
    mockBatches = [
      {
        id: 'b1',
        projectId: 1,
        runId: RUN,
        atype: 'interactive-prototype',
        sourceRef: SOURCE_REF,
        round: 1,
        status: 'queued',
        error: null,
        createdAt: '2026-07-27T00:00:00.000Z',
        appliedAt: null,
        sessionId: SESSION,
        currentAttemptId: null,
        attemptCount: 0,
        blockedReason: null,
        dispatchedAt: null,
        appliedPrototypeRevision: null,
      },
    ];
    const { result } = renderDesignComments();
    expect(result.current.chipStatus).toEqual({ kind: 'pending', round: 1 });
  });
});

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe('useDesignComments — send()', () => {
  it('sends exactly the draft ids + sessionId, then exits comment mode on success', async () => {
    mockComments = [makeDraftComment({ id: 'd1' }), makeDraftComment({ id: 'd2' })];
    installBridge();
    const { result } = renderDesignComments();

    // Enter comment mode first so we can assert it exits.
    await act(async () => {
      await result.current.enter();
    });
    expect(result.current.status).toBe('active');

    await act(async () => {
      await result.current.send();
    });

    expect(sendDesignBatchSpy).toHaveBeenCalledWith({
      runId: RUN,
      sessionId: SESSION,
      atype: 'interactive-prototype',
      sourceRef: SOURCE_REF,
      commentIds: ['d1', 'd2'],
    });
    expect(result.current.status).toBe('live');
    expect(result.current.commentUrl).toBeNull();
  });

  it('on error, surfaces sendError and stays in comment mode', async () => {
    mockComments = [makeDraftComment({ id: 'd1' })];
    sendDesignBatchSpy.mockRejectedValueOnce(new Error('busy'));
    installBridge();
    const { result } = renderDesignComments();

    await act(async () => {
      await result.current.enter();
    });

    await act(async () => {
      await result.current.send();
    });

    expect(result.current.sendError).toBe('busy');
    expect(result.current.status).toBe('active');
  });

  it('is a no-op with no drafts', async () => {
    mockComments = [];
    const { result } = renderDesignComments();
    await act(async () => {
      await result.current.send();
    });
    expect(sendDesignBatchSpy).not.toHaveBeenCalled();
  });

  it('sendDisabledReason reflects draft count / sourceRef / sending', async () => {
    mockComments = [];
    const { result } = renderDesignComments({ sourceRef: null });
    await waitFor(() => expect(result.current.sendDisabledReason).toMatch(/linked idea/));
  });
});
