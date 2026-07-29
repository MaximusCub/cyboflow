/**
 * DesignCommentMode — the comment-mode frame + rail. All async/business logic
 * lives in useDesignComments (tested separately); this file covers the DOM
 * concerns this component itself owns: the `window.message` listener's
 * SOURCE-IDENTITY check on the comment frame (never trusted by schema alone —
 * see the component's header comment), and the prop-driven rail/composer
 * wiring (breadcrumb walking, edit/delete, send gating).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { DraftDesignComment } from '../../../../hooks/useDesignComments';
import { DesignCommentMode } from '../DesignCommentMode';

function makeDraft(overrides: Partial<DraftDesignComment> = {}): DraftDesignComment {
  return {
    id: 'd1',
    projectId: 1,
    runId: 'run-1',
    atype: 'interactive-prototype',
    sourceRef: 'IDEA-1',
    batchId: null,
    anchor: {
      kind: 'element',
      designId: 'btn-1',
      ancestorStack: [{ tag: 'button', designId: 'btn-1', label: 'Save' }],
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

function baseProps() {
  return {
    commentUrl: 'http://127.0.0.1:9/tok/comment/1.html',
    hoverBreadcrumb: null,
    onInspectorMessage: vi.fn(),
    composer: null,
    onComposerPickedIndex: vi.fn(),
    onComposerClose: vi.fn(),
    composerText: '',
    onComposerTextChange: vi.fn(),
    onComposerSave: vi.fn(),
    savingComposer: false,
    composerDisabledReason: null,
    drafts: [] as DraftDesignComment[],
    editingId: null,
    onStartEdit: vi.fn(),
    editText: '',
    onEditTextChange: vi.fn(),
    onSaveEdit: vi.fn(),
    onCancelEdit: vi.fn(),
    onDeleteDraft: vi.fn(),
    chipStatus: null,
    onSend: vi.fn(),
    sending: false,
    sendError: null,
    sendDisabledReason: null,
  };
}

describe('DesignCommentMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the comment frame with the given url and allow-scripts sandbox', () => {
    render(<DesignCommentMode {...baseProps()} />);
    const frame = screen.getByTestId('design-comment-frame');
    expect(frame).toHaveAttribute('src', baseProps().commentUrl);
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('forwards a message from the frame contentWindow to onInspectorMessage', () => {
    const props = baseProps();
    render(<DesignCommentMode {...props} />);
    const frame = screen.getByTestId('design-comment-frame') as HTMLIFrameElement;
    const frameWindow = frame.contentWindow;
    expect(frameWindow).not.toBeNull();

    const payload = { type: 'cyboflow-design-inspect', kind: 'hover', stack: [{ tag: 'a', designId: null, label: null }] };
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: payload, source: frameWindow }));
    });

    expect(props.onInspectorMessage).toHaveBeenCalledWith(payload);
  });

  it('ignores a message from a different source', () => {
    const props = baseProps();
    render(<DesignCommentMode {...props} />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'cyboflow-design-inspect', kind: 'hover', stack: [] },
          source: window, // top window, not the comment frame
        }),
      );
    });
    expect(props.onInspectorMessage).not.toHaveBeenCalled();
  });

  it('unsubscribes the message listener on unmount', () => {
    const props = baseProps();
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<DesignCommentMode {...props} />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('message', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('renders the hover breadcrumb when present', () => {
    render(<DesignCommentMode {...baseProps()} hoverBreadcrumb={[{ tag: 'button', designId: null, label: 'Save' }]} />);
    expect(screen.getByTestId('design-comment-hover-breadcrumb')).toHaveTextContent('button "Save"');
  });

  it('does not render the hover breadcrumb when null', () => {
    render(<DesignCommentMode {...baseProps()} />);
    expect(screen.queryByTestId('design-comment-hover-breadcrumb')).not.toBeInTheDocument();
  });

  describe('composer', () => {
    const stack = [
      { tag: 'button', designId: 'b1', label: 'Save' },
      { tag: 'div', designId: 'd1', label: null },
      { tag: 'body', designId: null, label: null },
    ];

    it('renders the breadcrumb walk and the textarea', () => {
      render(<DesignCommentMode {...baseProps()} composer={{ stack, pickedIndex: 0 }} />);
      expect(screen.getByTestId('design-comment-breadcrumb-0')).toHaveTextContent('button "Save"');
      expect(screen.getByTestId('design-comment-breadcrumb-2')).toHaveTextContent('body');
      expect(screen.getByTestId('design-comment-composer-textarea')).toBeInTheDocument();
    });

    it('clicking an ancestor breadcrumb walks the pickedIndex up', () => {
      const props = baseProps();
      render(<DesignCommentMode {...props} composer={{ stack, pickedIndex: 0 }} />);
      fireEvent.click(screen.getByTestId('design-comment-breadcrumb-1'));
      expect(props.onComposerPickedIndex).toHaveBeenCalledWith(1);
    });

    it('typing calls onComposerTextChange', () => {
      const props = baseProps();
      render(<DesignCommentMode {...props} composer={{ stack, pickedIndex: 0 }} />);
      fireEvent.change(screen.getByTestId('design-comment-composer-textarea'), { target: { value: 'hello' } });
      expect(props.onComposerTextChange).toHaveBeenCalledWith('hello');
    });

    it('cancel calls onComposerClose', () => {
      const props = baseProps();
      render(<DesignCommentMode {...props} composer={{ stack, pickedIndex: 0 }} />);
      fireEvent.click(screen.getByTestId('design-comment-composer-cancel'));
      expect(props.onComposerClose).toHaveBeenCalledTimes(1);
    });

    it('save is disabled with a tooltip when composerDisabledReason is set', () => {
      render(
        <DesignCommentMode
          {...baseProps()}
          composer={{ stack, pickedIndex: 0 }}
          composerDisabledReason="This session's prototype has no linked idea yet"
        />,
      );
      const save = screen.getByTestId('design-comment-composer-save');
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute('title', "This session's prototype has no linked idea yet");
    });

    it('save calls onComposerSave when enabled', () => {
      const props = baseProps();
      render(<DesignCommentMode {...props} composer={{ stack, pickedIndex: 0 }} composerText="hi" />);
      fireEvent.click(screen.getByTestId('design-comment-composer-save'));
      expect(props.onComposerSave).toHaveBeenCalledTimes(1);
    });

    it('does not render when composer is null', () => {
      render(<DesignCommentMode {...baseProps()} composer={null} />);
      expect(screen.queryByTestId('design-comment-composer')).not.toBeInTheDocument();
    });
  });

  describe('rail', () => {
    it('shows the empty state with no drafts', () => {
      render(<DesignCommentMode {...baseProps()} />);
      expect(screen.getByTestId('design-comment-rail-empty')).toBeInTheDocument();
    });

    it('renders draft rows with a breadcrumb summary + body', () => {
      render(<DesignCommentMode {...baseProps()} drafts={[makeDraft()]} />);
      const row = screen.getByTestId('design-comment-draft-d1');
      expect(row).toHaveTextContent('button "Save"');
      expect(row).toHaveTextContent('Make this bigger');
    });

    it('Edit calls onStartEdit with the comment', () => {
      const props = baseProps();
      const draft = makeDraft();
      render(<DesignCommentMode {...props} drafts={[draft]} />);
      fireEvent.click(screen.getByTestId('design-comment-draft-edit-d1'));
      expect(props.onStartEdit).toHaveBeenCalledWith(draft);
    });

    it('Delete calls onDeleteDraft with the id', () => {
      const props = baseProps();
      render(<DesignCommentMode {...props} drafts={[makeDraft()]} />);
      fireEvent.click(screen.getByTestId('design-comment-draft-delete-d1'));
      expect(props.onDeleteDraft).toHaveBeenCalledWith('d1');
    });

    it('editing state shows a textarea + Save/Cancel wired to onSaveEdit/onCancelEdit', () => {
      const props = baseProps();
      render(<DesignCommentMode {...props} drafts={[makeDraft()]} editingId="d1" editText="edited text" />);
      const textarea = screen.getByTestId('design-comment-edit-textarea-d1');
      expect(textarea).toHaveValue('edited text');

      fireEvent.change(textarea, { target: { value: 'more edits' } });
      expect(props.onEditTextChange).toHaveBeenCalledWith('more edits');

      fireEvent.click(screen.getByTestId('design-comment-edit-save-d1'));
      expect(props.onSaveEdit).toHaveBeenCalledWith('d1');

      fireEvent.click(screen.getByTestId('design-comment-edit-cancel-d1'));
      expect(props.onCancelEdit).toHaveBeenCalledTimes(1);
    });
  });

  describe('send', () => {
    it('shows the draft count and calls onSend when enabled', () => {
      const props = baseProps();
      render(<DesignCommentMode {...props} drafts={[makeDraft(), makeDraft({ id: 'd2' })]} />);
      const send = screen.getByTestId('design-comment-send');
      expect(send).toHaveTextContent('Send feedback (2)');
      expect(send).not.toBeDisabled();
      fireEvent.click(send);
      expect(props.onSend).toHaveBeenCalledTimes(1);
    });

    it('is disabled with a tooltip when sendDisabledReason is set', () => {
      render(<DesignCommentMode {...baseProps()} sendDisabledReason="No draft comments to send" />);
      const send = screen.getByTestId('design-comment-send');
      expect(send).toBeDisabled();
      expect(send).toHaveAttribute('title', 'No draft comments to send');
    });

    it('shows "Sending…" while sending', () => {
      render(<DesignCommentMode {...baseProps()} sending drafts={[makeDraft()]} sendDisabledReason={null} />);
      expect(screen.getByTestId('design-comment-send')).toHaveTextContent('Sending…');
    });

    it('renders a send error inline', () => {
      render(<DesignCommentMode {...baseProps()} sendError="A revision is already in progress" />);
      expect(screen.getByTestId('design-comment-send-error')).toHaveTextContent('A revision is already in progress');
    });
  });
});
