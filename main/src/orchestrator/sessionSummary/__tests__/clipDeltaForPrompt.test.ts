import { describe, it, expect } from 'vitest';
import {
  clipDeltaForPrompt,
  CLIP_TOTAL_CHAR_BUDGET,
  CLIP_USER_MESSAGE_CAP,
  CLIP_ASSISTANT_HEAD_CHARS,
  CLIP_ASSISTANT_TAIL_CHARS,
  ELISION_MARKER,
} from '../clipDeltaForPrompt';
import type { SummaryInputMessage } from '../segmentIntoSittings';

function msg(id: number, role: 'user' | 'assistant', content: string): SummaryInputMessage {
  return { id, role, content, timestamp: '2026-01-01T00:00:00.000Z' };
}

describe('clipDeltaForPrompt', () => {
  it('leaves a short user message untouched', () => {
    const [clipped] = clipDeltaForPrompt([msg(1, 'user', 'hi')]);
    expect(clipped.content).toBe('hi');
  });

  it('caps a long user message body at CLIP_USER_MESSAGE_CAP chars (plus the ellipsis)', () => {
    const long = 'x'.repeat(CLIP_USER_MESSAGE_CAP + 500);
    const [clipped] = clipDeltaForPrompt([msg(1, 'user', long)]);
    expect(clipped.content.length).toBe(CLIP_USER_MESSAGE_CAP + 1); // + trailing ellipsis char
    expect(clipped.content.startsWith('x'.repeat(CLIP_USER_MESSAGE_CAP))).toBe(true);
  });

  it('leaves a short assistant message untouched', () => {
    const [clipped] = clipDeltaForPrompt([msg(1, 'assistant', 'short reply')]);
    expect(clipped.content).toBe('short reply');
  });

  it('leaves an assistant message exactly at the head+tail budget untouched', () => {
    const exact = 'A'.repeat(CLIP_ASSISTANT_HEAD_CHARS + CLIP_ASSISTANT_TAIL_CHARS);
    const [clipped] = clipDeltaForPrompt([msg(1, 'assistant', exact)]);
    expect(clipped.content).toBe(exact);
  });

  it('splices a long assistant message to head + tail, dropping the middle', () => {
    const head = 'H'.repeat(CLIP_ASSISTANT_HEAD_CHARS);
    const tail = 'T'.repeat(CLIP_ASSISTANT_TAIL_CHARS);
    const middle = 'M'.repeat(5_000);
    const [clipped] = clipDeltaForPrompt([msg(1, 'assistant', head + middle + tail)]);
    expect(clipped.content.startsWith(head)).toBe(true);
    expect(clipped.content.endsWith(tail)).toBe(true);
    expect(clipped.content).not.toContain(middle);
  });

  it('elides the OLDEST assistant bodies first when the global budget is still exceeded, always keeping the final assistant message', () => {
    // Each body sits exactly at the per-message head+tail budget (pass 1 leaves
    // it untouched), but 30 of them together blow the 48,000-char global cap.
    const bigAssistant = 'A'.repeat(CLIP_ASSISTANT_HEAD_CHARS + CLIP_ASSISTANT_TAIL_CHARS);
    const messages: SummaryInputMessage[] = [];
    for (let i = 0; i < 30; i++) messages.push(msg(i, 'assistant', bigAssistant));

    const clipped = clipDeltaForPrompt(messages);
    const totalLength = clipped.reduce((sum, m) => sum + m.content.length, 0);

    expect(totalLength).toBeLessThanOrEqual(CLIP_TOTAL_CHAR_BUDGET);
    expect(clipped[clipped.length - 1].content).toBe(bigAssistant); // final message never elided
    expect(clipped[0].content).toBe(ELISION_MARKER); // oldest elided first
  });

  it('never elides a user message even under global budget pressure', () => {
    const bigAssistant = 'A'.repeat(CLIP_ASSISTANT_HEAD_CHARS + CLIP_ASSISTANT_TAIL_CHARS);
    const messages: SummaryInputMessage[] = [msg(0, 'user', 'the original ask')];
    for (let i = 1; i <= 30; i++) messages.push(msg(i, 'assistant', bigAssistant));

    const clipped = clipDeltaForPrompt(messages);
    expect(clipped[0].role).toBe('user');
    expect(clipped[0].content).toBe('the original ask');
  });

  it('is deterministic — identical input always produces identical output', () => {
    const messages: SummaryInputMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(msg(i, i % 2 === 0 ? 'user' : 'assistant', `content ${i} `.repeat(50)));
    }
    expect(clipDeltaForPrompt(messages)).toEqual(clipDeltaForPrompt(messages));
  });

  it('does not mutate the input messages', () => {
    const original = msg(1, 'user', 'x'.repeat(CLIP_USER_MESSAGE_CAP + 10));
    const messages = [original];
    clipDeltaForPrompt(messages);
    expect(messages[0]).toBe(original);
    expect(original.content.length).toBe(CLIP_USER_MESSAGE_CAP + 10);
  });

  it('preserves message order and ids', () => {
    const messages = [msg(1, 'user', 'a'), msg(2, 'assistant', 'b'), msg(3, 'user', 'c')];
    const clipped = clipDeltaForPrompt(messages);
    expect(clipped.map((m) => m.id)).toEqual([1, 2, 3]);
  });
});
