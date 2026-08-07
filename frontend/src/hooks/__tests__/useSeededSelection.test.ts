/**
 * Unit tests for useSeededSelection — generic per-key seed/touched selection.
 *
 * Focus:
 *   1. Seeds on mount (value === seed when untouched).
 *   2. Re-seeds on seed change while untouched.
 *   3. setByUser marks touched and blocks further re-seeding.
 *   4. reseed does NOT mark touched — a later seed change still applies.
 *   5. Per-key isolation: touching key 'a' does not bleed onto key 'b'.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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
    const { result } = renderHook(() => useSeededSelection({ key: 'a', seed: 'seed-1', fallback: 'fallback-val' }));

    act(() => result.current.reseed('coerced-val'));
    // If the seed effect depended on `value`, this reseed call (which changes
    // `value` but not `key`/`seed`) would re-fire the effect and snap the
    // value straight back to the unchanged seed. It must not.
    expect(result.current.value).toBe('coerced-val');
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
});
