/**
 * composerFocusStore tests — the one-slot focus mailbox plus its two consumer
 * hooks (the composer that takes focus, and the dock tab host that reveals it).
 *
 * Environment: jsdom (document.activeElement / element.focus()).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import {
  COMPOSER_FOCUS_ATTR,
  isComposerFocused,
  useChatTabFocusRequest,
  useComposerFocusRequest,
  useComposerFocusStore,
} from '../composerFocusStore';

/** A textarea attached to the document, so focus() actually takes. */
function mountTextarea(): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  document.body.appendChild(el);
  return el;
}

let created: HTMLTextAreaElement[] = [];

beforeEach(() => {
  useComposerFocusStore.setState({ request: null });
  created = [];
});

afterEach(() => {
  for (const el of created) el.remove();
});

function textarea(): HTMLTextAreaElement {
  const el = mountTextarea();
  created.push(el);
  return el;
}

describe('composerFocusStore — request/consume', () => {
  it('requestFocus stores the key with a nonce', () => {
    useComposerFocusStore.getState().requestFocus('run-1');
    const req = useComposerFocusStore.getState().request;
    expect(req?.key).toBe('run-1');
    expect(typeof req?.nonce).toBe('number');
  });

  it('a repeat request for the same key is a DISTINCT event (new nonce)', () => {
    useComposerFocusStore.getState().requestFocus('run-1');
    const first = useComposerFocusStore.getState().request?.nonce;
    useComposerFocusStore.getState().requestFocus('run-1');
    const second = useComposerFocusStore.getState().request?.nonce;
    expect(second).not.toBe(first);
  });

  it('consumeFocusRequest clears a matching request', () => {
    useComposerFocusStore.getState().requestFocus('run-1');
    useComposerFocusStore.getState().consumeFocusRequest('run-1');
    expect(useComposerFocusStore.getState().request).toBeNull();
  });

  it('consumeFocusRequest leaves a request for ANOTHER key alone', () => {
    useComposerFocusStore.getState().requestFocus('run-1');
    useComposerFocusStore.getState().consumeFocusRequest('session-9');
    expect(useComposerFocusStore.getState().request?.key).toBe('run-1');
  });
});

describe('isComposerFocused', () => {
  it('is false when nothing registered is focused', () => {
    expect(isComposerFocused('run-1')).toBe(false);
  });

  it('is true only for the focused, registered composer', () => {
    const el = textarea();
    const ref = { current: el };
    renderHook(() => useComposerFocusRequest('run-1', ref));
    el.focus();
    expect(isComposerFocused('run-1')).toBe(true);
    expect(isComposerFocused('run-2')).toBe(false);
  });

  it('is false once the composer blurs', () => {
    const el = textarea();
    const ref = { current: el };
    renderHook(() => useComposerFocusRequest('run-1', ref));
    el.focus();
    el.blur();
    expect(isComposerFocused('run-1')).toBe(false);
  });
});

describe('useComposerFocusRequest', () => {
  it('stamps the identifying attribute on the textarea', () => {
    const el = textarea();
    renderHook(() => useComposerFocusRequest('run-1', { current: el }));
    expect(el.getAttribute(COMPOSER_FOCUS_ATTR)).toBe('run-1');
  });

  it('removes the attribute on unmount', () => {
    const el = textarea();
    const { unmount } = renderHook(() => useComposerFocusRequest('run-1', { current: el }));
    unmount();
    expect(el.getAttribute(COMPOSER_FOCUS_ATTR)).toBeNull();
  });

  it('focuses the textarea on a matching request and consumes it', () => {
    const el = textarea();
    renderHook(() => useComposerFocusRequest('run-1', { current: el }));
    act(() => {
      useComposerFocusStore.getState().requestFocus('run-1');
    });
    expect(document.activeElement).toBe(el);
    expect(useComposerFocusStore.getState().request).toBeNull();
  });

  it('ignores a request for a different key (and leaves it pending)', () => {
    const el = textarea();
    renderHook(() => useComposerFocusRequest('run-1', { current: el }));
    act(() => {
      useComposerFocusStore.getState().requestFocus('session-9');
    });
    expect(document.activeElement).not.toBe(el);
    expect(useComposerFocusStore.getState().request?.key).toBe('session-9');
  });

  it('leaves the request PENDING when there is no textarea yet, and a later mount honours it', () => {
    // The dock hosts unmount / display:none their chat surface, so a request
    // fired while the composer is absent has to survive until it mounts.
    renderHook(() => useComposerFocusRequest('run-1', { current: null }));
    act(() => {
      useComposerFocusStore.getState().requestFocus('run-1');
    });
    expect(useComposerFocusStore.getState().request?.key).toBe('run-1');

    const el = textarea();
    renderHook(() => useComposerFocusRequest('run-1', { current: el }));
    expect(document.activeElement).toBe(el);
    expect(useComposerFocusStore.getState().request).toBeNull();
  });

  it('stamps a textarea that appeared AFTER the mount effect ran', () => {
    // The stamping effect's deps are [key, textareaRef] and a ref object is
    // referentially STABLE, so a host that renders null on its first commit and
    // the textarea later re-runs no effect. Without the focus path re-stamping,
    // that element is never registered and isComposerFocused stays false for it
    // forever — which is exactly what the ⌘' collapse leg reads.
    const ref: { current: HTMLTextAreaElement | null } = { current: null };
    renderHook(() => useComposerFocusRequest('run-1', ref));
    expect(useComposerFocusStore.getState().request).toBeNull();

    // Late mount: same ref object, no dep change, no re-render of the host.
    ref.current = textarea();

    act(() => {
      useComposerFocusStore.getState().requestFocus('run-1');
    });

    expect(ref.current.getAttribute(COMPOSER_FOCUS_ATTR)).toBe('run-1');
    expect(document.activeElement).toBe(ref.current);
    expect(isComposerFocused('run-1')).toBe(true);
    expect(useComposerFocusStore.getState().request).toBeNull();
  });

  it('is inert for a null key', () => {
    const el = textarea();
    renderHook(() => useComposerFocusRequest(null, { current: el }));
    act(() => {
      useComposerFocusStore.getState().requestFocus('run-1');
    });
    expect(el.getAttribute(COMPOSER_FOCUS_ATTR)).toBeNull();
    expect(useComposerFocusStore.getState().request?.key).toBe('run-1');
  });
});

describe('useChatTabFocusRequest', () => {
  it('fires showChat on a matching request WITHOUT consuming it', () => {
    const showChat = vi.fn();
    renderHook(() => useChatTabFocusRequest('run-1', showChat));
    act(() => {
      useComposerFocusStore.getState().requestFocus('run-1');
    });
    expect(showChat).toHaveBeenCalledTimes(1);
    // The composer, not the tab host, owns consumption — the request must still
    // be pending when the freshly-revealed composer mounts.
    expect(useComposerFocusStore.getState().request?.key).toBe('run-1');
  });

  it('does not fire for another key or a null key', () => {
    const showChat = vi.fn();
    const nullKey = vi.fn();
    renderHook(() => useChatTabFocusRequest('run-1', showChat));
    renderHook(() => useChatTabFocusRequest(null, nullKey));
    act(() => {
      useComposerFocusStore.getState().requestFocus('session-9');
    });
    expect(showChat).not.toHaveBeenCalled();
    expect(nullKey).not.toHaveBeenCalled();
  });

  it('fires again for a repeat request on the same key (nonce-keyed)', () => {
    const showChat = vi.fn();
    renderHook(() => useChatTabFocusRequest('run-1', showChat));
    act(() => {
      useComposerFocusStore.getState().requestFocus('run-1');
    });
    act(() => {
      useComposerFocusStore.getState().requestFocus('run-1');
    });
    expect(showChat).toHaveBeenCalledTimes(2);
  });
});
