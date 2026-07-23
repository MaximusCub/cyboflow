import { describe, it, expect } from 'vitest';
import {
  segmentIntoSittings,
  computeWatermarkStop,
  SESSION_SUMMARY_IDLE_MS,
  type SummaryInputMessage,
} from '../segmentIntoSittings';

const BASE = Date.parse('2026-01-01T00:00:00.000Z');

function msg(id: number, role: 'user' | 'assistant', offsetMs: number): SummaryInputMessage {
  return { id, role, content: `msg ${id}`, timestamp: new Date(BASE + offsetMs).toISOString() };
}

describe('segmentIntoSittings', () => {
  it('returns an empty array for empty input', () => {
    expect(segmentIntoSittings([], SESSION_SUMMARY_IDLE_MS)).toEqual([]);
  });

  it('keeps a single message in its own single segment', () => {
    const segments = segmentIntoSittings([msg(1, 'user', 0)], SESSION_SUMMARY_IDLE_MS);
    expect(segments).toEqual([[msg(1, 'user', 0)]]);
  });

  it('keeps consecutive messages within the gap in one segment', () => {
    const messages = [msg(1, 'user', 0), msg(2, 'assistant', 1_000), msg(3, 'user', 2_000)];
    const segments = segmentIntoSittings(messages, SESSION_SUMMARY_IDLE_MS);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(3);
  });

  it('splits into a new segment wherever the gap STRICTLY exceeds gapMs', () => {
    const gapMs = SESSION_SUMMARY_IDLE_MS;
    const messages = [
      msg(1, 'user', 0),
      msg(2, 'assistant', 1_000),
      msg(3, 'user', 1_000 + gapMs + 1), // gap > threshold -> new sitting
      msg(4, 'assistant', 1_000 + gapMs + 2_000),
    ];
    const segments = segmentIntoSittings(messages, gapMs);
    expect(segments).toHaveLength(2);
    expect(segments[0].map((m) => m.id)).toEqual([1, 2]);
    expect(segments[1].map((m) => m.id)).toEqual([3, 4]);
  });

  it('does not split on an exact-boundary gap (only strictly-greater-than splits)', () => {
    const gapMs = 1_000;
    const messages = [msg(1, 'user', 0), msg(2, 'assistant', 1_000)];
    expect(segmentIntoSittings(messages, gapMs)).toHaveLength(1);
  });

  it('splits on more than two gaps into more than two segments', () => {
    const gapMs = 1_000;
    const messages = [
      msg(1, 'user', 0),
      msg(2, 'user', gapMs + 1),
      msg(3, 'user', 2 * (gapMs + 1)),
    ];
    const segments = segmentIntoSittings(messages, gapMs);
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.map((m) => m.id))).toEqual([[1], [2], [3]]);
  });

  it('treats an unparseable timestamp defensively — never splits on an unmeasurable gap', () => {
    const messages: SummaryInputMessage[] = [
      { id: 1, role: 'user', content: 'a', timestamp: 'not-a-date' },
      { id: 2, role: 'assistant', content: 'b', timestamp: 'also-not-a-date' },
    ];
    expect(segmentIntoSittings(messages, SESSION_SUMMARY_IDLE_MS)).toHaveLength(1);
  });

  it('parses SQLite-style timestamps with no timezone indicator as UTC', () => {
    // 'YYYY-MM-DD HH:MM:SS' (no 'T'/'Z') is the CURRENT_TIMESTAMP shape; a gap
    // computed against it must still split when the SQLite-shaped pair itself
    // straddles the threshold.
    const messages: SummaryInputMessage[] = [
      { id: 1, role: 'user', content: 'a', timestamp: '2026-01-01 00:00:00' },
      { id: 2, role: 'assistant', content: 'b', timestamp: '2026-01-01 00:06:00' }, // +6 min > 5 min idle
    ];
    expect(segmentIntoSittings(messages, SESSION_SUMMARY_IDLE_MS)).toHaveLength(2);
  });
});

describe('computeWatermarkStop', () => {
  it('returns the no-op sentinel when no segment has an assistant message', () => {
    const segments = [[msg(1, 'user', 0)], [msg(2, 'user', 1_000_000)]];
    expect(computeWatermarkStop(segments)).toEqual({ newWatermark: 0, billableSegments: [] });
  });

  it('returns the no-op sentinel for no segments at all', () => {
    expect(computeWatermarkStop([])).toEqual({ newWatermark: 0, billableSegments: [] });
  });

  it('stops the watermark at the end of the last assistant-bearing segment, excluding a trailing user-only segment', () => {
    const segments = [
      [msg(1, 'user', 0), msg(2, 'assistant', 1_000)],
      [msg(3, 'user', 1_000_000)], // trailing, unanswered — must NOT be billed or watermarked
    ];
    const result = computeWatermarkStop(segments);
    expect(result.newWatermark).toBe(2);
    expect(result.billableSegments).toEqual([[segments[0][0], segments[0][1]]]);
  });

  it('bills only assistant-bearing segments up to and including the last one, skipping a user-only middle segment', () => {
    const segments = [
      [msg(1, 'user', 0), msg(2, 'assistant', 1_000)],
      [msg(3, 'user', 2_000_000)], // user-only middle segment — not billed
      [msg(4, 'user', 3_000_000), msg(5, 'assistant', 3_001_000)],
    ];
    const result = computeWatermarkStop(segments);
    expect(result.newWatermark).toBe(5);
    expect(result.billableSegments).toEqual([segments[0], segments[2]]);
  });

  it('takes the MAX id within the last assistant-bearing segment (assistant need not be the last message in it)', () => {
    const segments = [[msg(1, 'user', 0), msg(2, 'assistant', 1_000), msg(3, 'user', 2_000)]];
    expect(computeWatermarkStop(segments).newWatermark).toBe(3);
  });
});
