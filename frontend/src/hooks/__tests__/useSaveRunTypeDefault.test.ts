/**
 * useSaveRunTypeDefault — the shared "Save as default" + Undo subsystem.
 *
 * The two defects this hook exists to prevent, pinned here:
 *
 *  1. A FAILED write must never look like a success. The old store contract
 *     returned `undefined` for "succeeded with no prior value", "the API said
 *     no", and "the call threw" alike; the surfaces showed a success toast for
 *     all three and recorded `previous ?? null` as the Undo payload. Clicking
 *     that Undo issued `{ kind: 'replace', value: null }` — DELETING a default
 *     the failed write never overwrote.
 *
 *  2. Overlapping saves must not corrupt the Undo ordering. The latch is a ref
 *     read synchronously in the handler, so a second click in the SAME tick is
 *     rejected outright — a `useState` flag (and any `disabled` derived from it)
 *     only takes effect on the next render, which is exactly how the shipped
 *     code raced.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useSaveRunTypeDefault,
  combineSaveCompanions,
  SAVE_DEFAULT_TOAST_MS,
} from '../useSaveRunTypeDefault';
import { useConfigStore } from '../../stores/configStore';
import type { ApplyRunTypeDefaultResult } from '../../stores/configStore';
import type {
  RunTypeDefaults,
  RunTypeDefaultsOp,
} from '../../../../shared/types/sessionDefaults';

const apply = vi.fn(
  async (_key: string, _op: RunTypeDefaultsOp): Promise<ApplyRunTypeDefaultResult> => ({
    ok: true,
    previous: null,
  }),
);

/** A promise whose resolution the test drives, so overlap is deterministic. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  apply.mockReset();
  apply.mockResolvedValue({ ok: true, previous: null });
  useConfigStore.setState({ applyRunTypeDefault: apply });
});

function renderSave(key: string | null = 'workflow:wf-1', label = 'Custom') {
  return renderHook(() => useSaveRunTypeDefault({ key, label }));
}

describe('useSaveRunTypeDefault — success path', () => {
  it('writes a merge op under the key and records an Undo only after the store confirms', async () => {
    const { result } = renderSave();

    await act(async () => {
      result.current.save({ model: 'opus' });
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('workflow:wf-1', {
      kind: 'merge',
      value: { model: 'opus' },
    });
    expect(result.current.toast).toEqual({
      message: 'Saved as default for Custom',
      tone: 'success',
    });
    expect(result.current.canUndo).toBe(true);
  });

  it('Undo DELETES the key when the confirmed write found no prior value', async () => {
    apply.mockResolvedValue({ ok: true, previous: null });
    const { result } = renderSave();

    await act(async () => {
      result.current.save({ model: 'opus' });
    });
    await act(async () => {
      result.current.undo();
    });

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith('workflow:wf-1', { kind: 'replace', value: null });
    // Explicitly NOT `value: undefined`, which would leave the write standing.
    expect(apply.mock.calls[1][1]).not.toEqual({ kind: 'replace', value: undefined });
    expect(result.current.toast).toBeNull();
    expect(result.current.canUndo).toBe(false);
  });

  it('Undo restores the exact prior entry when one existed', async () => {
    const previous: RunTypeDefaults = {
      model: 'sonnet',
      permissionMode: 'auto',
      substrate: 'interactive',
      agentRuntime: 'claude-interactive',
    };
    apply.mockResolvedValue({ ok: true, previous });
    const { result } = renderSave();

    await act(async () => {
      result.current.save({ model: 'opus' });
    });
    await act(async () => {
      result.current.undo();
    });

    expect(apply).toHaveBeenLastCalledWith('workflow:wf-1', { kind: 'replace', value: previous });
  });

  it('no-ops when there is no writable key yet', async () => {
    const { result } = renderSave(null);

    await act(async () => {
      result.current.save({ model: 'opus' });
    });

    expect(apply).not.toHaveBeenCalled();
    expect(result.current.toast).toBeNull();
    expect(result.current.canUndo).toBe(false);
  });
});

describe('useSaveRunTypeDefault — failure path (the data-loss fix)', () => {
  it('surfaces a failure toast and offers NO Undo when the store reports the write failed', async () => {
    apply.mockResolvedValue({ ok: false, error: 'nope' });
    const { result } = renderSave();

    await act(async () => {
      result.current.save({ model: 'opus' });
    });

    expect(result.current.toast).toEqual({
      message: "Couldn't save default for Custom",
      tone: 'error',
    });
    expect(result.current.canUndo).toBe(false);
  });

  it('a post-failure undo() call cannot issue a deleting replace', async () => {
    apply.mockResolvedValue({ ok: false, error: 'nope' });
    const { result } = renderSave();

    await act(async () => {
      result.current.save({ model: 'opus' });
    });
    await act(async () => {
      result.current.undo();
    });

    // Exactly the one failed merge — never a `{ kind: 'replace', value: null }`
    // that would delete a default the failed write never overwrote.
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toEqual({ kind: 'merge', value: { model: 'opus' } });
  });

  it('a failure after a prior SUCCESS clears the stale Undo record', async () => {
    const previous: RunTypeDefaults = { model: 'sonnet' };
    apply.mockResolvedValue({ ok: true, previous });
    const { result } = renderSave();

    await act(async () => {
      result.current.save({ model: 'opus' });
    });
    expect(result.current.canUndo).toBe(true);

    apply.mockResolvedValue({ ok: false, error: 'nope' });
    await act(async () => {
      result.current.save({ model: 'haiku' });
    });

    expect(result.current.canUndo).toBe(false);
    expect(result.current.toast?.tone).toBe('error');
  });
});

describe('useSaveRunTypeDefault — synchronous in-flight latch', () => {
  it('rejects a second save fired in the SAME tick and keeps the landed write as the Undo record', async () => {
    const first = deferred<ApplyRunTypeDefaultResult>();
    apply.mockReturnValueOnce(first.promise);
    const secondPrevious: RunTypeDefaults = { model: 'haiku' };
    apply.mockResolvedValue({ ok: true, previous: secondPrevious });
    const { result } = renderSave();

    // Both calls in ONE tick: the ref latch is the only thing standing between
    // them, since neither a state flag nor `disabled` has re-rendered yet.
    act(() => {
      result.current.save({ model: 'opus' });
      result.current.save({ model: 'sonnet' });
    });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toEqual({ kind: 'merge', value: { model: 'opus' } });

    const firstPrevious: RunTypeDefaults = { model: 'sonnet' };
    await act(async () => {
      first.resolve({ ok: true, previous: firstPrevious });
    });

    // The Undo record belongs to the write that ACTUALLY landed — the first —
    // not to a second write that was never issued.
    await act(async () => {
      result.current.undo();
    });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith('workflow:wf-1', {
      kind: 'replace',
      value: firstPrevious,
    });
  });

  it('exposes isSaving for the whole write and releases the latch afterwards', async () => {
    const pending = deferred<ApplyRunTypeDefaultResult>();
    apply.mockReturnValueOnce(pending.promise);
    const { result } = renderSave();

    act(() => {
      result.current.save({ model: 'opus' });
    });
    await waitFor(() => expect(result.current.isSaving).toBe(true));

    await act(async () => {
      pending.resolve({ ok: true, previous: null });
    });
    expect(result.current.isSaving).toBe(false);

    // Latch released — a later save goes through.
    apply.mockResolvedValue({ ok: true, previous: null });
    await act(async () => {
      result.current.save({ model: 'haiku' });
    });
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('rejects a save fired while an Undo is still in flight', async () => {
    apply.mockResolvedValue({ ok: true, previous: null });
    const { result } = renderSave();
    await act(async () => {
      result.current.save({ model: 'opus' });
    });

    const undoPending = deferred<ApplyRunTypeDefaultResult>();
    apply.mockReturnValueOnce(undoPending.promise);
    act(() => {
      result.current.undo();
      result.current.save({ model: 'haiku' });
    });

    // merge + the undo's replace — the interleaved save was rejected.
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][1]).toEqual({ kind: 'replace', value: null });

    await act(async () => {
      undoPending.resolve({ ok: true, previous: null });
    });
  });
});

describe('useSaveRunTypeDefault — toast lifecycle', () => {
  it('captures the label at save time so a later key/label change cannot relabel it', async () => {
    const { result, rerender } = renderHook(
      ({ key, label }: { key: string; label: string }) => useSaveRunTypeDefault({ key, label }),
      { initialProps: { key: 'workflow:wf-1', label: 'Custom' } },
    );

    const pending = deferred<ApplyRunTypeDefaultResult>();
    apply.mockReturnValueOnce(pending.promise);
    act(() => {
      result.current.save({ model: 'opus' });
    });
    rerender({ key: 'workflow:wf-2', label: 'Compound' });
    await act(async () => {
      pending.resolve({ ok: true, previous: null });
    });

    expect(result.current.toast?.message).toBe('Saved as default for Custom');
    // …and the Undo targets the key that was written, not the current one.
    await act(async () => {
      result.current.undo();
    });
    expect(apply).toHaveBeenLastCalledWith('workflow:wf-1', { kind: 'replace', value: null });
  });

  it('dismissToast hides the toast without touching config', async () => {
    const { result } = renderSave();
    await act(async () => {
      result.current.save({ model: 'opus' });
    });

    act(() => {
      result.current.dismissToast();
    });

    expect(result.current.toast).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('owns the 9s undo window in one place', () => {
    expect(SAVE_DEFAULT_TOAST_MS).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// combineSaveCompanions — the wizard saves TWO workflow-row stamps (tuning
// level + runtime mix) through the ONE companion slot `save` offers, so the
// fold has to preserve the slot's all-or-nothing contract by itself.
// ---------------------------------------------------------------------------
describe('combineSaveCompanions', () => {
  function companion(write: () => Promise<boolean>, undo: () => Promise<boolean>) {
    return { write: vi.fn(write), undo: vi.fn(undo) };
  }
  const ok = async (): Promise<boolean> => true;
  const fail = async (): Promise<boolean> => false;

  it('is undefined for nothing, and the companion ITSELF for exactly one', () => {
    const only = companion(ok, ok);
    expect(combineSaveCompanions([])).toBeUndefined();
    expect(combineSaveCompanions([undefined, undefined])).toBeUndefined();
    expect(combineSaveCompanions([undefined, only])).toBe(only);
  });

  it('writes every companion in order and reports success', async () => {
    const order: string[] = [];
    const first = companion(async () => (order.push('a'), true), ok);
    const second = companion(async () => (order.push('b'), true), ok);

    const combined = combineSaveCompanions([first, second]);
    await expect(combined?.write()).resolves.toBe(true);
    expect(order).toEqual(['a', 'b']);
  });

  it('rolls back the writes that already landed when a later one fails', async () => {
    // The defect this guards: a half-saved default — the level stamped, the mix
    // not, and no record that the pair ever diverged.
    const first = companion(ok, ok);
    const second = companion(fail, ok);

    const combined = combineSaveCompanions([first, second]);
    await expect(combined?.write()).resolves.toBe(false);
    expect(first.undo).toHaveBeenCalledTimes(1);
    // The FAILED write is never undone — it never landed.
    expect(second.undo).not.toHaveBeenCalled();
  });

  it('undo replays every companion and reports failure if any fails', async () => {
    const first = companion(ok, fail);
    const second = companion(ok, ok);

    const combined = combineSaveCompanions([first, second]);
    await expect(combined?.undo()).resolves.toBe(false);
    // A failing revert does not abort the rest — the other stamp still reverts.
    expect(second.undo).toHaveBeenCalledTimes(1);
  });
});
