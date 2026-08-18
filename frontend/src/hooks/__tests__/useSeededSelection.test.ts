/**
 * Unit tests for useSeededSelection — generic per-key seed/touched selection.
 *
 * Focus:
 *   1. Seeds on mount (value === seed when untouched); falls back when
 *      seed is undefined.
 *   2. Re-seeds on seed change while untouched.
 *   3. setByUser marks touched and blocks further re-seeding.
 *   4. reseed does NOT mark touched — a later seed change still applies.
 *   5. The seed effect's [key, seed]-only dep contract: a same-key reseed()
 *      cannot re-trigger it (guarded via a render-count assertion).
 *   6. Per-key isolation: touching key 'a' does not bleed onto key 'b', and
 *      switching back to 'a' restores its value/touched latch.
 *   7. The hook stays seed-source-agnostic (no configStore / run-type-default
 *      imports), enforced via a static source-text check.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useSeededSelection } from '../useSeededSelection';

describe('useSeededSelection', () => {
  it('seeds on mount', () => {
    const { result } = renderHook(() => useSeededSelection({ key: 'a', seed: 'seed-val', fallback: 'fallback-val' }));
    expect(result.current.value).toBe('seed-val');
    expect(result.current.isTouched).toBe(false);
  });

  it('falls back when seed is undefined', () => {
    const { result } = renderHook(() =>
      useSeededSelection({ key: 'a', seed: undefined, fallback: 'fallback-val' }),
    );
    expect(result.current.value).toBe('fallback-val');
    expect(result.current.isTouched).toBe(false);
  });

  it('re-seeds on seed change while untouched', () => {
    const { result, rerender } = renderHook(
      ({ seed }: { seed: string }) => useSeededSelection({ key: 'a', seed, fallback: 'fallback-val' }),
      { initialProps: { seed: 'seed-1' } },
    );
    expect(result.current.value).toBe('seed-1');

    rerender({ seed: 'seed-2' });
    expect(result.current.value).toBe('seed-2');
    expect(result.current.isTouched).toBe(false);
  });

  it('setByUser marks touched and blocks further re-seeding', () => {
    const { result, rerender } = renderHook(
      ({ seed }: { seed: string }) => useSeededSelection({ key: 'a', seed, fallback: 'fallback-val' }),
      { initialProps: { seed: 'seed-1' } },
    );

    act(() => result.current.setByUser('user-val'));
    expect(result.current.value).toBe('user-val');
    expect(result.current.isTouched).toBe(true);

    // A subsequent seed change must NOT clobber the user's choice.
    rerender({ seed: 'seed-2' });
    expect(result.current.value).toBe('user-val');
    expect(result.current.isTouched).toBe(true);
  });

  it('reseed does NOT mark touched — a later seed change still applies', () => {
    const { result, rerender } = renderHook(
      ({ seed }: { seed: string }) => useSeededSelection({ key: 'a', seed, fallback: 'fallback-val' }),
      { initialProps: { seed: 'seed-1' } },
    );

    act(() => result.current.reseed('coerced-val'));
    expect(result.current.value).toBe('coerced-val');
    expect(result.current.isTouched).toBe(false);

    // Because reseed did not mark touched, a subsequent seed prop change
    // still re-seeds the value (unlike setByUser above).
    rerender({ seed: 'seed-2' });
    expect(result.current.value).toBe('seed-2');
    expect(result.current.isTouched).toBe(false);
  });

  it('reseed on the same key does not loop (dep array is [key, seed], never value)', () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useSeededSelection({ key: 'a', seed: 'seed-1', fallback: 'fallback-val' });
    });
    const rendersAfterMount = renderCount;

    act(() => result.current.reseed('coerced-val'));

    // If the seed effect depended on `value`, this reseed call (which changes
    // `value` but not `key`/`seed`) would re-fire the effect, snapping the
    // value straight back to the unchanged seed and causing further renders
    // (a loop, in the worst case). It must not: exactly one render for the
    // `setValue` state update, and the coerced value must stick.
    expect(result.current.value).toBe('coerced-val');
    expect(renderCount).toBe(rendersAfterMount + 1);
  });

  it('per-key isolation: touching key a does not bleed onto key b', () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useSeededSelection({ key, seed: 'seed-val', fallback: 'fallback-val' }),
      { initialProps: { key: 'a' } },
    );

    act(() => result.current.setByUser('a-user-val'));
    expect(result.current.isTouched).toBe(true);

    rerender({ key: 'b' });
    expect(result.current.isTouched).toBe(false);
    expect(result.current.value).toBe('seed-val');

    // Switching back to 'a' restores its last user-chosen value and touched state.
    rerender({ key: 'a' });
    expect(result.current.isTouched).toBe(true);
    expect(result.current.value).toBe('a-user-val');
  });

  it('stays seed-source-agnostic: source imports nothing from configStore or run-type-default types', () => {
    const hookPath = resolve(dirname(fileURLToPath(import.meta.url)), '../useSeededSelection.ts');
    const source = readFileSync(hookPath, 'utf-8');

    expect(source).not.toMatch(/configStore/);
    expect(source).not.toMatch(/RunTypeDefaults/);
  });
});
