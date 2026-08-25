/**
 * parseDbTimestamp — the UTC normalization every raw SQLite timestamp needs.
 *
 * SQLite's CURRENT_TIMESTAMP / datetime('now') write space-separated UTC with
 * no zone marker ("2026-08-24 19:12:52"); JS parses that shape as LOCAL time.
 * The failure mode is not a visibly wrong number: shifted into the future, a
 * "time ago" formatter sees a negative interval and drops every recent row into
 * its zero-bucket, so a broken clock renders as a plausible "just now".
 *
 * These tests are timezone-independent — they compare against an explicit UTC
 * instant rather than asserting a formatted local string.
 */
import { describe, it, expect } from 'vitest';
import { parseDbTimestamp, parseTimestamp } from '../timestampUtils';

const UTC_INSTANT = Date.UTC(2026, 7, 24, 19, 12, 52); // 2026-08-24T19:12:52Z

describe('parseDbTimestamp', () => {
  it('reads a space-separated SQLite timestamp as UTC', () => {
    expect(parseDbTimestamp('2026-08-24 19:12:52').getTime()).toBe(UTC_INSTANT);
  });

  it('passes an ISO string with Z through unchanged', () => {
    // What strftime('%Y-%m-%dT%H:%M:%SZ', …) and Date.toISOString() emit.
    expect(parseDbTimestamp('2026-08-24T19:12:52Z').getTime()).toBe(UTC_INSTANT);
  });

  it('passes an ISO string with milliseconds through unchanged', () => {
    expect(parseDbTimestamp('2026-08-24T19:12:52.000Z').getTime()).toBe(UTC_INSTANT);
  });

  it('agrees with the naive parse only when the value already carries a zone', () => {
    // The regression guard: on any host that is not UTC these two must DIFFER
    // for the space-separated form, which is precisely why the helper exists.
    const zoned = '2026-08-24T19:12:52Z';
    expect(parseDbTimestamp(zoned).getTime()).toBe(parseTimestamp(zoned).getTime());

    const unzoned = '2026-08-24 19:12:52';
    const offsetMinutes = new Date(UTC_INSTANT).getTimezoneOffset();
    if (offsetMinutes !== 0) {
      expect(parseDbTimestamp(unzoned).getTime()).not.toBe(parseTimestamp(unzoned).getTime());
    }
    // And regardless of host zone, the helper lands on the true instant.
    expect(parseDbTimestamp(unzoned).getTime()).toBe(UTC_INSTANT);
  });

  it('the naive parse is off by exactly the host UTC offset (documents the bug)', () => {
    const naive = parseTimestamp('2026-08-24 19:12:52').getTime();
    const offsetMs = new Date(UTC_INSTANT).getTimezoneOffset() * 60_000;
    expect(naive - UTC_INSTANT).toBe(offsetMs);
  });
});
