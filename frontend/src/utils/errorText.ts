/**
 * errorText — normalize an unknown catch value into a displayable string.
 *
 * A rejected dispatch can carry an Error, a plain string, or an IPC-shaped
 * `{ error }` object depending on which layer rejected. Callers that surface the
 * reason to the user (e.g. the chat's failed pending-send row) need one string
 * without re-deriving the same three cases each time. Returns `undefined` when
 * nothing usable is present, so a caller can fall back to its generic copy
 * rather than printing "[object Object]".
 */
export function errorText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (value instanceof Error) return value.message.trim() || undefined;
  if (typeof value === 'object' && value !== null) {
    const candidate = (value as { error?: unknown }).error;
    if (typeof candidate === 'string') return candidate.trim() || undefined;
  }
  return undefined;
}
