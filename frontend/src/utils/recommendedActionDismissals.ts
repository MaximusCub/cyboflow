/**
 * recommendedActionDismissals — localStorage-backed persistence for the
 * "Recommended actions" cards a user has dismissed.
 *
 * Keyed by card id -> the trigger `signature` at the moment of dismissal (see
 * recommendedActions.ts). A card resurfaces once its CURRENT signature no
 * longer matches the stored one — new evidence invalidates a stale dismissal.
 *
 * Mirrors the defensive try/catch idiom of migrateLocalStorageKey.ts: any
 * localStorage access (unavailable, private-mode, corrupt JSON) degrades to a
 * safe empty-map default rather than throwing.
 */

const STORAGE_KEY = 'cyboflow.reviewQueue.dismissedActions.v1';

/** card id -> the signature it was dismissed with. */
export type DismissalMap = Record<string, string>;

/** True when `v` is a plain string-to-string record (defensive shape check on parsed JSON). */
function isDismissalMap(v: unknown): v is DismissalMap {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((value) => typeof value === 'string');
}

/**
 * Read the persisted dismissal map. Returns `{}` on any failure — missing key,
 * inaccessible storage, or corrupt JSON — never throws.
 */
export function readDismissals(): DismissalMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return isDismissalMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Record a dismissal for `id` at `signature`, merging into the existing map.
 * Best-effort — a write failure (e.g. storage quota, private mode) is
 * swallowed rather than thrown.
 */
export function recordDismissal(id: string, signature: string): void {
  try {
    const current = readDismissals();
    const next: DismissalMap = { ...current, [id]: signature };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Best-effort persistence — a dismissal that fails to save just resurfaces
    // the card next render, which is a safe fallback (not silent data loss).
  }
}
