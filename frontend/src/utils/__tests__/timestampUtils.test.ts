/**
 * formatDistanceToNow / parseTimestamp — the SQLite UTC normalization.
 *
 * SQLite writes "YYYY-MM-DD HH:MM:SS" — UTC with no zone marker — and JS reads
 * that shape as LOCAL. formatDistanceToNow used a bare `new Date()`, so such
 * values landed the host's UTC offset in the FUTURE; its buckets floor a
 * negative interval into the `else` arm, so the result rendered as a confident
 * "just now". WorkflowCard passes exactly such a value (lastUsedAt, folded from
 * workflow_runs.created_at), so every card read "used just now" for any run in
 * the preceding offset-many hours.
 *
 * Timezone-independent: assertions are expressed against an explicit UTC
 * instant or against getTimezoneOffset(), so they hold on a UTC CI host too.
 */
import { describe, it, expect } from 'vitest';
import { formatDistanceToNow, parseTimestamp } from '../timestampUtils';

const UTC_INSTANT = Date.UTC(2026, 7, 24, 19, 12, 52); // 2026-08-24T19:12:52Z

/** A SQLite-shaped ("YYYY-MM-DD HH:MM:SS", UTC, unzoned) stamp N ms in the past. */
function sqliteStampAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

describe('parseTimestamp', () => {
  it('reads a space-separated SQLite timestamp as UTC', () => {
    expect(parseTimestamp('2026-08-24 19:12:52').getTime()).toBe(UTC_INSTANT);
  });

  it('passes an already-zoned ISO string through unchanged', () => {
    expect(parseTimestamp('2026-08-24T19:12:52Z').getTime()).toBe(UTC_INSTANT);
  });
});

describe('formatDistanceToNow normalizes a raw SQLite string', () => {
  it('reports real elapsed time, not "just now"', () => {
    // The exact WorkflowCard case: three hours ago, stored SQLite-shaped.
    expect(formatDistanceToNow(sqliteStampAgo(3 * 60 * 60_000))).toBe('3 hours ago');
  });

  it('does not collapse a recent-but-not-instant value', () => {
    expect(formatDistanceToNow(sqliteStampAgo(42 * 60_000))).toBe('42 minutes ago');
  });

  it('regression guard: the bare parse would have said "just now" instead', () => {
    // Only meaningful on a host behind UTC, which is where the bug bites; on a
    // UTC host the two agree and there is nothing to guard.
    const raw = sqliteStampAgo(3 * 60 * 60_000);
    if (new Date(UTC_INSTANT).getTimezoneOffset() > 0) {
      const naiveElapsedMs = Date.now() - new Date(raw).getTime();
      expect(naiveElapsedMs).toBeLessThan(0); // parsed into the future
      expect(formatDistanceToNow(raw)).not.toBe('just now');
    }
  });
});

describe('formatDistanceToNow leaves correct callers alone', () => {
  it('accepts a Date unchanged (the sidebar / ProjectDashboard case)', () => {
    expect(formatDistanceToNow(new Date(Date.now() - 2 * 60 * 60_000))).toBe('2 hours ago');
  });

  it('accepts an ISO-with-Z string (an IPC-serialized Date)', () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatDistanceToNow(iso)).toBe('5 minutes ago');
  });

  it('is idempotent when a caller already wrapped in parseTimestamp', () => {
    // ChatTranscript does formatDistanceToNow(parseTimestamp(x)) — a Date goes
    // down the untouched branch, so the explicit wrap stays harmless.
    const raw = sqliteStampAgo(90 * 60_000);
    expect(formatDistanceToNow(parseTimestamp(raw))).toBe(formatDistanceToNow(raw));
  });

  it('still reports "just now" for something that genuinely just happened', () => {
    expect(formatDistanceToNow(sqliteStampAgo(2_000))).toBe('just now');
  });
});
