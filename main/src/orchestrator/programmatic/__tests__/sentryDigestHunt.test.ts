/**
 * Drift guard for scripts/sentry-digest-hunt.mjs.
 *
 * That script recovers the plaintext behind an `errorDigest` Sentry tag by
 * brute force, which only works if its digest implementation is byte-identical
 * in behaviour to the one that PRODUCED the tags. It cannot import the real
 * one — systemicError.ts is TypeScript and the script runs under bare `node`
 * against an unbuilt tree — so it carries a copy.
 *
 * A silent divergence would be the worst possible failure: the script would
 * still run, still print confident output, and simply never match anything,
 * while the reader concluded "not a bare literal" about a string that is right
 * there in the corpus. So pin the copy here instead.
 */
import { describe, it, expect } from 'vitest';
import { digestErrorSkeleton, describeErrorShape } from '../systemicError';
// @ts-expect-error — untyped .mjs script, imported for behavioural comparison only.
import { digestErrorSkeleton as scriptDigest, skeletonize as scriptSkeletonize } from '../../../../../scripts/sentry-digest-hunt.mjs';

/**
 * Inputs chosen to exercise every branch of skeletonize (url, email, hex, path,
 * quoted string, digits, whitespace collapse, the 400-char cap) plus the error
 * shapes the digest is actually attached to.
 */
const SAMPLES: string[] = [
  '',
  'Failed to authenticate: OAuth session expired and could not be refreshed',
  'Claude AI usage limit reached|1751234567',
  'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
  'fetch failed at https://api.anthropic.com/v1/messages?beta=true',
  'contact someone@example.com about request 9f3a2b1c8e7d6f5a',
  'ENOENT: no such file or directory, open /Users/alice/repo/src/App.tsx',
  "Command failed: eslint 'src/**/*.ts' --max-warnings 0",
  'multi\nline\n    at Object.<anonymous> (/tmp/x.js:1:1)',
  '   collapse   these    spaces   ',
  'x'.repeat(500),
  'MCP session expired (server no longer recognizes session ID), triggering reconnection',
];

describe('scripts/sentry-digest-hunt.mjs stays in sync with systemicError.ts', () => {
  it.each(SAMPLES)('produces the same digest for %j', (sample) => {
    expect(scriptDigest(sample)).toBe(digestErrorSkeleton(sample));
  });

  it('handles undefined the same way (both treat it as the empty string)', () => {
    expect(scriptDigest(undefined)).toBe(digestErrorSkeleton(undefined));
  });

  // The script's self-test pins this pair; it is the digest that identified the
  // 2026-08-27 auth cascade, and the reason the technique is trusted at all.
  it('still reproduces the known-good d1a52bbe pair', () => {
    const known = 'Failed to authenticate: OAuth session expired and could not be refreshed';
    expect(digestErrorSkeleton(known)).toBe('d1a52bbe');
    expect(scriptDigest(known)).toBe('d1a52bbe');
  });

  // skeletonize is exported from the script but private to the module; compare
  // it indirectly via a shape whose digest depends on the full transform.
  it('skeletonizes to a lowercase, collapsed, bounded string', () => {
    const out = scriptSkeletonize('  HTTPS://x.io/a/b  AND   1234  ');
    expect(out).toBe(out.toLowerCase());
    expect(out).not.toMatch(/\s{2,}/);
    expect(out.length).toBeLessThanOrEqual(400);
  });

  // Guards the assumption the digest rests on: it is only ever ATTACHED to the
  // unclassified buckets, so the shapes it must round-trip are these.
  it('covers the error shapes the digest is attached to', () => {
    expect(describeErrorShape(SAMPLES[1])).toBe('one-line-short');
    expect(describeErrorShape(SAMPLES[10])).toBe('one-line-long');
    expect(describeErrorShape(SAMPLES[8])).toBe('stack-trace');
    expect(describeErrorShape('{"type":"error"}')).toBe('json-envelope');
    expect(describeErrorShape(SAMPLES[0])).toBe('empty');
  });
});
