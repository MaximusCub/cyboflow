/**
 * segmentIntoSittings — pure timestamp-gap segmentation for the idle-gated
 * session-summary feature (plan §2.4, `docs/proposals/session-summary-plan.md`).
 *
 * A "sitting" is a maximal run of conversation activity with no internal gap
 * longer than the idle threshold. Segmenting by gap (rather than persisting
 * per-sitting boundary rows) means a missed idle-timer fire (app quit,
 * feature disabled, a bug) is transparently re-derived from
 * `conversation_messages` timestamps on the next catch-up call — no extra
 * persistence, restart-safe by construction.
 *
 * Standalone-typecheck note: no imports at all — this module is pure data
 * shaping, satisfying the orchestrator layering rule trivially (no
 * `services/*`, no db, no SDK).
 */

/** One row of `conversation_messages` as read for the summarizer's delta window. */
export interface SummaryInputMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/** Idle threshold: the gap that ends one sitting and starts the next. */
export const SESSION_SUMMARY_IDLE_MS = 5 * 60_000;

/**
 * Parse a message timestamp defensively. SQLite's `CURRENT_TIMESTAMP` writes
 * `'YYYY-MM-DD HH:MM:SS'` with no timezone indicator (implicitly UTC); a real
 * ISO string already carries a `'T'`/`'Z'`/an offset. Mirrors the existing
 * `SessionManager.getPanelOutputs` convention rather than inventing a new one.
 * Returns null (not NaN) for anything that still fails to parse, so a caller
 * can treat it as "unknown gap" instead of silently producing `NaN` compares.
 */
function parseTimestampMs(timestamp: string): number | null {
  const looksIsoAlready = timestamp.includes('T') || timestamp.includes('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp);
  const normalized = looksIsoAlready ? timestamp : `${timestamp}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Segment `messages` (assumed already ordered by non-decreasing `id` — the
 * `conversation_messages` AUTOINCREMENT contract) into sittings: a new segment
 * starts wherever two consecutive messages are separated by more than `gapMs`.
 *
 * A message whose timestamp fails to parse (or whose neighbor's does) cannot
 * have its gap measured — it is defensively kept in the CURRENT segment (never
 * split) rather than guessed at, since a bogus split would fragment a single
 * sitting into spurious history sentences.
 */
export function segmentIntoSittings(
  messages: readonly SummaryInputMessage[],
  gapMs: number,
): SummaryInputMessage[][] {
  if (messages.length === 0) return [];

  const segments: SummaryInputMessage[][] = [[messages[0]]];
  let lastKnownMs = parseTimestampMs(messages[0].timestamp);

  for (let i = 1; i < messages.length; i++) {
    const message = messages[i];
    const currentMs = parseTimestampMs(message.timestamp);
    const gap = lastKnownMs !== null && currentMs !== null ? currentMs - lastKnownMs : 0;

    if (gap > gapMs) {
      segments.push([message]);
    } else {
      segments[segments.length - 1].push(message);
    }

    if (currentMs !== null) lastKnownMs = currentMs;
  }

  return segments;
}

/** The result of locating the watermark-eligible tail of a segmented delta. */
export interface WatermarkStopResult {
  /** Highest `conversation_messages.id` safe to advance the watermark to. */
  newWatermark: number;
  /**
   * Segments (in order) that should be billed a history sentence: every
   * segment up to and including the last assistant-bearing one, filtered down
   * to only those that themselves contain >= 1 assistant message.
   */
  billableSegments: SummaryInputMessage[][];
}

/** Sentinel returned when no segment contains an assistant message (no-op for callers). */
const NO_OP_RESULT: WatermarkStopResult = { newWatermark: 0, billableSegments: [] };

/**
 * Compute where the content watermark may safely advance to, and which
 * segments are billable (worth a history sentence).
 *
 * The watermark stops at the end of the LAST segment containing an assistant
 * message — a trailing user-only segment (an abandoned or not-yet-answered
 * prompt) stays above the watermark and is re-summarized in the next delta
 * together with its eventual response, rather than being dropped or
 * misreported as completed work (plan §2.4 / Codex finding #3).
 *
 * If no segment contains an assistant message at all, this is a pure no-op:
 * the watermark is unchanged and there is nothing to bill.
 */
export function computeWatermarkStop(segments: readonly SummaryInputMessage[][]): WatermarkStopResult {
  let lastAssistantSegmentIndex = -1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].some((message) => message.role === 'assistant')) {
      lastAssistantSegmentIndex = i;
    }
  }

  if (lastAssistantSegmentIndex === -1) {
    return NO_OP_RESULT;
  }

  const billableSegments = segments
    .slice(0, lastAssistantSegmentIndex + 1)
    .filter((segment) => segment.some((message) => message.role === 'assistant'))
    .map((segment) => [...segment]);

  const lastSegment = segments[lastAssistantSegmentIndex];
  const newWatermark = lastSegment.reduce((max, message) => Math.max(max, message.id), 0);

  return { newWatermark, billableSegments };
}
