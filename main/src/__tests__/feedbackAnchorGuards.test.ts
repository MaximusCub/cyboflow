/**
 * Guards for the FeedbackAnchor union (shared/types/feedback.ts).
 *
 * The two feedback surfaces store their anchors in ONE column (`anchor_json`),
 * discriminated by the PRESENCE of `kind === 'element'`. Quote anchors predate
 * the union (migration 077) and their rows on disk carry NO `kind` field at all,
 * so "no kind" must read as the quote variant — a guard that required a
 * `kind: 'quote'` literal would silently orphan every existing comment. Pin that.
 *
 * Covered:
 *   1. isElementAnchor / isQuoteAnchor on both variants, including LEGACY quote
 *      JSON round-tripped through JSON.parse with no `kind` key.
 *   2. The two guards are exact complements (never both true, never both false).
 *   3. The atype guards: doc vs design partition, and isFeedbackAtype as the union.
 */
import { describe, it, expect } from 'vitest';
import {
  DESIGN_FEEDBACK_ATYPES,
  DOC_FEEDBACK_ATYPES,
  FEEDBACK_ATYPES,
  isDesignFeedbackAtype,
  isDocFeedbackAtype,
  isElementAnchor,
  isFeedbackAtype,
  isQuoteAnchor,
} from '../../../shared/types/feedback';
import type { CommentAnchor, ElementCommentAnchor, FeedbackAnchor } from '../../../shared/types/feedback';

const QUOTE: CommentAnchor = { quote: 'the quoted text', occurrence: 1, bodyHash: 'aabbccdd' };

const ELEMENT: ElementCommentAnchor = {
  kind: 'element',
  designId: 'hero-cta',
  ancestorStack: [
    { tag: 'button', designId: 'hero-cta', label: 'Get started' },
    { tag: 'div', designId: 'hero', label: null },
    { tag: 'body', designId: null, label: null },
  ],
  pickedIndex: 0,
};

/** A row exactly as migration 077 wrote it: no `kind` key anywhere. */
function legacyStoredQuoteAnchor(): FeedbackAnchor {
  const stored = JSON.stringify(QUOTE);
  expect(stored).not.toContain('kind');
  return JSON.parse(stored) as FeedbackAnchor;
}

describe('FeedbackAnchor guards', () => {
  it('isElementAnchor is true only for the element variant', () => {
    expect(isElementAnchor(ELEMENT)).toBe(true);
    expect(isElementAnchor(QUOTE)).toBe(false);
  });

  it('isQuoteAnchor accepts a LEGACY stored anchor that has no `kind` field', () => {
    const legacy = legacyStoredQuoteAnchor();
    expect(isQuoteAnchor(legacy)).toBe(true);
    expect(isElementAnchor(legacy)).toBe(false);
  });

  it('narrows so the variant-only fields are reachable', () => {
    const anchors: FeedbackAnchor[] = [legacyStoredQuoteAnchor(), ELEMENT];
    const quotes: string[] = [];
    const designIds: (string | null)[] = [];
    for (const a of anchors) {
      if (isElementAnchor(a)) designIds.push(a.designId);
      else quotes.push(a.quote);
    }
    expect(quotes).toEqual(['the quoted text']);
    expect(designIds).toEqual(['hero-cta']);
  });

  it('the two guards are exact complements', () => {
    for (const anchor of [QUOTE, ELEMENT, legacyStoredQuoteAnchor()]) {
      expect(isElementAnchor(anchor)).toBe(!isQuoteAnchor(anchor));
    }
  });

  it('an element anchor deserialized from storage still reads as element', () => {
    const round = JSON.parse(JSON.stringify(ELEMENT)) as FeedbackAnchor;
    expect(isElementAnchor(round)).toBe(true);
    expect(isQuoteAnchor(round)).toBe(false);
  });
});

describe('Feedback atype guards', () => {
  it.each([
    ['idea-spec', true, false],
    ['arch-design', true, false],
    ['ui-prototype', false, true],
    ['interactive-prototype', false, true],
    ['screenshots', false, false],
    ['generic', false, false],
    ['', false, false],
    [null, false, false],
    [undefined, false, false],
    [{ atype: 'idea-spec' }, false, false],
  ])('%o -> doc=%s design=%s', (value, isDoc, isDesign) => {
    expect(isDocFeedbackAtype(value)).toBe(isDoc);
    expect(isDesignFeedbackAtype(value)).toBe(isDesign);
    expect(isFeedbackAtype(value)).toBe(isDoc || isDesign);
  });

  it('FEEDBACK_ATYPES is exactly the doc set followed by the design set', () => {
    expect(FEEDBACK_ATYPES).toEqual([...DOC_FEEDBACK_ATYPES, ...DESIGN_FEEDBACK_ATYPES]);
    expect(FEEDBACK_ATYPES.every((a) => isFeedbackAtype(a))).toBe(true);
  });
});
