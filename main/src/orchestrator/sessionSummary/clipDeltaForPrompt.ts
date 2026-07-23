/**
 * clipDeltaForPrompt — pure, deterministic clipping of a session-summary delta
 * transcript down to a bounded prompt budget (plan §3,
 * `docs/proposals/session-summary-plan.md`). Runs BEFORE the transcript is
 * formatted into `USER:`/`ASSISTANT:` blocks with sitting markers
 * (`sessionSummaryQuery.ts`), so this module knows nothing about sittings —
 * it operates on a flat, order-preserving message list.
 *
 * Two passes:
 *   1. Per-message cap — every `user` body is capped at
 *      {@link CLIP_USER_MESSAGE_CAP} chars; every `assistant` body longer than
 *      its head+tail budget is spliced down to a head + tail (the middle,
 *      usually tool-call narration, is the least useful part for a summary).
 *   2. Global budget — if the capped transcript is still over
 *      {@link CLIP_TOTAL_CHAR_BUDGET}, the OLDEST assistant bodies are elided
 *      first (replaced with a short marker), oldest to newest, until the
 *      transcript fits. The single LAST assistant message in the whole delta
 *      is never elided — it is the freshest signal of where the session left
 *      off and the model needs it to write an accurate rolling summary.
 *
 * Deterministic: no randomness, no clock reads, no I/O — same input always
 * produces the same output.
 */
import type { SummaryInputMessage } from './segmentIntoSittings';

/** Total transcript char budget handed to the model. */
export const CLIP_TOTAL_CHAR_BUDGET = 48_000;

/** Per-message cap for a `user` turn's content. */
export const CLIP_USER_MESSAGE_CAP = 2_000;

/** Head/tail split for an `assistant` turn's content once it exceeds the combined budget. */
export const CLIP_ASSISTANT_HEAD_CHARS = 1_500;
export const CLIP_ASSISTANT_TAIL_CHARS = 500;

/** Marker substituted for an assistant body dropped for budget (pass 2). */
export const ELISION_MARKER = '[earlier assistant response omitted for length]';

function capUserContent(content: string): string {
  if (content.length <= CLIP_USER_MESSAGE_CAP) return content;
  return `${content.slice(0, CLIP_USER_MESSAGE_CAP)}…`;
}

function capAssistantContent(content: string): string {
  const combinedBudget = CLIP_ASSISTANT_HEAD_CHARS + CLIP_ASSISTANT_TAIL_CHARS;
  if (content.length <= combinedBudget) return content;
  const head = content.slice(0, CLIP_ASSISTANT_HEAD_CHARS);
  const tail = content.slice(content.length - CLIP_ASSISTANT_TAIL_CHARS);
  return `${head}\n…[truncated]…\n${tail}`;
}

function totalContentLength(messages: readonly SummaryInputMessage[]): number {
  return messages.reduce((sum, message) => sum + message.content.length, 0);
}

/**
 * Clip `messages` (order preserved) down to {@link CLIP_TOTAL_CHAR_BUDGET}.
 * Returns a new array — the input is never mutated.
 */
export function clipDeltaForPrompt(messages: readonly SummaryInputMessage[]): SummaryInputMessage[] {
  const capped: SummaryInputMessage[] = messages.map((message) => ({
    ...message,
    content: message.role === 'user' ? capUserContent(message.content) : capAssistantContent(message.content),
  }));

  if (totalContentLength(capped) <= CLIP_TOTAL_CHAR_BUDGET) return capped;

  // Locate the single LAST assistant message in the whole delta — protected
  // from elision regardless of how far over budget the transcript still is.
  let lastAssistantIndex = -1;
  for (let i = 0; i < capped.length; i++) {
    if (capped[i].role === 'assistant') lastAssistantIndex = i;
  }

  for (let i = 0; i < capped.length; i++) {
    if (totalContentLength(capped) <= CLIP_TOTAL_CHAR_BUDGET) break;
    const message = capped[i];
    if (message.role !== 'assistant') continue;
    if (i === lastAssistantIndex) continue;
    if (message.content === ELISION_MARKER) continue; // already elided
    capped[i] = { ...message, content: ELISION_MARKER };
  }

  return capped;
}
