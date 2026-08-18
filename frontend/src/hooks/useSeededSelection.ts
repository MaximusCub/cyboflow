/**
 * useSeededSelection — generic per-key seed/touched selection state.
 *
 * Generalizes the seed/touched pattern the permission picker used to carry in a
 * hook of its own — since retired, this IS that hook now — (a value seeds
 * reactively from an external default until the user explicitly picks one) to
 * (a) any value type and (b) a KEYED selection, so switching key
 * (e.g. wizard card kind, or selected workflow) does not bleed one key's
 * touched flag onto another — each key tracks its own touched state and its
 * own last user-chosen value.
 *
 * Two setters, on purpose:
 *   - `setByUser` marks the current key touched (stops re-seeding for it).
 *   - `reseed` does NOT mark touched — it exists for programmatic/coercion
 *     callers (e.g. a runtime-family switch recomputing a compatible model)
 *     that must be able to update the value without permanently freezing
 *     future reactive re-seeds for a control the user never actually touched.
 *
 * The seed effect's dep array is `[key, seed]` ONLY — never `value` — so a
 * `reseed` call on the same key (which changes `value` but not `key`/`seed`)
 * can never re-trigger this effect and loop.
 */
import { useState, useEffect, useRef, useCallback } from 'react';

export interface UseSeededSelectionOptions<T> {
  /** Identifies the current selection scope (e.g. card kind, workflow id). */
  key: string;
  /** The externally-supplied seed for the current key (may be undefined). */
  seed: T | undefined;
  /** Fallback used when neither a touched value nor a seed is available. */
  fallback: T;
}

export interface UseSeededSelectionReturn<T> {
  /** The currently-selected value for the current key. */
  value: T;
  /** Set the value and mark the current key as user-touched (stops re-seeding it). */
  setByUser: (v: T) => void;
  /** Set the value WITHOUT marking the current key as touched (for programmatic coercion). */
  reseed: (v: T) => void;
  /** Whether the current key has been explicitly touched by the user. */
  isTouched: boolean;
}

export function useSeededSelection<T>({
  key,
  seed,
  fallback,
}: UseSeededSelectionOptions<T>): UseSeededSelectionReturn<T> {
  // Per-key: last user-chosen value (only set by setByUser). A ref (not
  // state) so writes don't trigger a re-render on their own — the visible
  // `value`/`isTouched` state below is what drives rendering.
  const touchedByKey = useRef(new Map<string, T>());

  const [value, setValue] = useState<T>(() => touchedByKey.current.get(key) ?? seed ?? fallback);
  const [isTouched, setIsTouched] = useState(() => touchedByKey.current.has(key));

  // Fires on key change (resolve the new key's touched value, else the seed,
  // else fallback) AND on seed change while the current key stays untouched
  // (re-apply the new seed). `fallback` is intentionally excluded from the
  // dep array — it's expected to be referentially stable-ish and re-seeding
  // off of it would defeat the touched latch for no benefit; `value` is
  // NEVER a dependency here, so a same-key `reseed()` cannot loop this effect.
  useEffect(() => {
    setValue(touchedByKey.current.get(key) ?? seed ?? fallback);
    setIsTouched(touchedByKey.current.has(key));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately [key, seed] only, see comment above
  }, [key, seed]);

  const setByUser = useCallback(
    (next: T) => {
      touchedByKey.current.set(key, next);
      setIsTouched(true);
      setValue(next);
    },
    [key],
  );

  const reseed = useCallback((next: T) => {
    // Deliberately does NOT touch `touchedByKey` or `isTouched` — programmatic
    // coercion must not freeze future reactive re-seeding for this key.
    setValue(next);
  }, []);

  return { value, setByUser, reseed, isTouched };
}
