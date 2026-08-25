/**
 * Utility functions for consistent timestamp handling throughout the application
 */

/**
 * Formats a date for database storage
 * @param date - The date to format (defaults to current date)
 * @returns ISO 8601 formatted string
 */
export function formatForDatabase(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Formats a timestamp for display to users
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized time string
 */
export function formatForDisplay(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toLocaleTimeString();
}

/**
 * Formats a timestamp with full date and time for display
 * @param timestamp - The timestamp string from database or Date object
 * @returns Localized date and time string
 */
export function formatFullDateTime(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toLocaleString();
}

/**
 * Parses a timestamp string to a Date object with NO normalization.
 *
 * ⚠️ Do NOT use this on a raw SQLite column. SQLite writes CURRENT_TIMESTAMP /
 * datetime('now') as space-separated UTC with no zone marker
 * ("2026-08-24 19:12:52"), and JS parses that shape as LOCAL time — silently
 * shifting it by the host's UTC offset. Use {@link parseDbTimestamp} for
 * anything read out of the database.
 *
 * @param timestamp - An already-zoned timestamp string (ISO 8601 with Z/offset)
 * @returns Date object
 */
export function parseTimestamp(timestamp: string): Date {
  return new Date(timestamp);
}

/**
 * Parses a SQLite timestamp column to a Date, treating an unzoned value as UTC.
 *
 * SQLite's CURRENT_TIMESTAMP and datetime('now') produce
 * "YYYY-MM-DD HH:MM:SS" — UTC, but with no zone marker. `new Date()` reads that
 * shape as LOCAL time, so on a UTC-7 host every such timestamp lands 7 hours in
 * the future. Downstream that is worse than a wrong number: a "time ago"
 * formatter sees a negative interval and collapses every recent row to its
 * zero-bucket ("just now"), which looks like a working feature rather than a
 * broken one.
 *
 * Values that already carry a zone (an ISO string with 'T' — what
 * `strftime('%Y-%m-%dT%H:%M:%SZ', …)` and `Date.toISOString()` emit) pass
 * through untouched, so this is safe on the repo's mixed-format columns. This
 * mirrors the frontend's `parseTimestamp` in
 * frontend/src/utils/timestampUtils.ts and the `.includes('T') ? … : replace+Z`
 * idiom used in outboxWorker/insightsQueries/questionRouter.
 *
 * @param timestamp - The raw string from a SQLite column
 * @returns Date object in the correct instant
 */
export function parseDbTimestamp(timestamp: string): Date {
  return new Date(timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
}

/**
 * Gets the current timestamp in ISO format for database storage
 * @returns ISO 8601 formatted string
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Checks if a timestamp is valid
 * @param timestamp - The timestamp to validate
 * @returns boolean indicating if the timestamp is valid
 */
export function isValidTimestamp(timestamp: string | Date | null | undefined): boolean {
  if (!timestamp) return false;
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return !isNaN(date.getTime());
}

/**
 * Converts a timestamp to UTC
 * @param timestamp - The timestamp to convert
 * @returns UTC ISO string
 */
export function toUTC(timestamp: string | Date): string {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  return date.toISOString();
}

/**
 * Gets the time difference between two timestamps
 * @param start - Start timestamp
 * @param end - End timestamp (defaults to current time)
 * @returns Duration in milliseconds
 */
export function getTimeDifference(start: string | Date, end: string | Date = new Date()): number {
  const startDate = typeof start === 'string' ? new Date(start) : start;
  const endDate = typeof end === 'string' ? new Date(end) : end;
  return endDate.getTime() - startDate.getTime();
}

/**
 * Formats a duration in milliseconds to a human-readable string
 * @param ms - Duration in milliseconds
 * @returns Human-readable duration string
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}