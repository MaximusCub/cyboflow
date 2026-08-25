/**
 * timestampUtils.parseTimestamp — the UTC normalization every raw SQLite
 * timestamp needs, and the boundary of what it does NOT cover.
 *
 * SQLite's CURRENT_TIMESTAMP / datetime('now') write space-separated UTC with
 * no zone marker ("2026-08-24 19:12:52"); JS parses that shape as LOCAL time.
 * The failure mode is not a visibly wrong number: shifted into the future, a
 * "time ago" formatter sees a negative interval and drops every recent row into
 * its zero bucket, so a broken clock renders as a plausible "just now". That is
 * how the sidebar stayed wrong for every session touched in the last 7 hours.
 *
 * These tests are timezone-independent — they compare against an explicit UTC
 * instant rather than asserting a formatted local string, so they hold on a UTC
 * CI host as well as on a developer's machine.
 */
import { describe, it, expect } from 'vitest';
import { parseTimestamp, getTimeDifference } from '../timestampUtils';

const UTC_INSTANT = Date.UTC(2026, 7, 24, 19, 12, 52); // 2026-08-24T19:12:52Z

describe('parseTimestamp', () => {
  it('reads a space-separated SQLite timestamp as UTC', () => {
    expect(parseTimestamp('2026-08-24 19:12:52').getTime()).toBe(UTC_INSTANT);
  });

  it('passes an ISO string with Z through unchanged', () => {
    // What strftime('%Y-%m-%dT%H:%M:%SZ', …) and Date.toISOString() emit —
    // including anything serialized across the IPC boundary.
    expect(parseTimestamp('2026-08-24T19:12:52Z').getTime()).toBe(UTC_INSTANT);
  });

  it('passes an ISO string with milliseconds through unchanged', () => {
    expect(parseTimestamp('2026-08-24T19:12:52.000Z').getTime()).toBe(UTC_INSTANT);
  });

  it('differs from a bare new Date() on the unzoned form by exactly the host offset', () => {
    // The regression guard. On a UTC host the offset is 0 and the two agree,
    // which is why the assertion is expressed against the offset rather than
    // asserting they always differ.
    const unzoned = '2026-08-24 19:12:52';
    const offsetMs = new Date(UTC_INSTANT).getTimezoneOffset() * 60_000;
    expect(new Date(unzoned).getTime() - parseTimestamp(unzoned).getTime()).toBe(offsetMs);
    // Whatever the host zone, the helper lands on the true instant.
    expect(parseTimestamp(unzoned).getTime()).toBe(UTC_INSTANT);
  });

  it('matches the frontend copy of parseTimestamp, which has always normalized', () => {
    // The two timestampUtils files previously disagreed under the same name —
    // the trap that made this easy to reintroduce on the main side.
    const sqliteShape = '2026-08-24 19:12:52';
    const frontendEquivalent = new Date(sqliteShape.replace(' ', 'T') + 'Z');
    expect(parseTimestamp(sqliteShape).getTime()).toBe(frontendEquivalent.getTime());
  });
});

describe('getTimeDifference is unaffected when BOTH sides share a format', () => {
  it('two unzoned SQLite values yield the correct interval even unnormalized', () => {
    // Why contextCompactor's getTimeDifference(prompt.timestamp,
    // prompt.completion_timestamp) was never broken: prompt_markers writes both
    // columns through datetime(), so both misparse by the SAME offset and it
    // cancels in the subtraction. Only a MIXED pair — one raw column against a
    // `new Date()` — goes wrong.
    const start = '2026-08-24 19:00:00';
    const end = '2026-08-24 19:12:52';
    expect(getTimeDifference(start, end)).toBe(12 * 60_000 + 52_000);
  });

  it('a mixed pair is what goes wrong (documents the real hazard)', () => {
    // A raw column compared against an already-zoned value skews by the offset.
    const offsetMs = new Date(UTC_INSTANT).getTimezoneOffset() * 60_000;
    const skew = getTimeDifference('2026-08-24 19:12:52', new Date(UTC_INSTANT));
    expect(skew).toBe(-offsetMs);
  });
});
