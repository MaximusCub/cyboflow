import { describe, expect, it } from 'vitest';
import {
  compareOmpVersions,
  evaluateOmpVersionPolicy,
  OMP_MIN_SUPPORTED_VERSION,
  OMP_TESTED_VERSION,
  parseOmpVersion,
} from '../ompVersions';

describe('parseOmpVersion', () => {
  it('parses the bare MAJOR.MINOR.PATCH form', () => {
    expect(parseOmpVersion('17.3.2')).toEqual({ major: 17, minor: 3, patch: 2 });
  });

  it('parses the real binary\'s "omp/MAJOR.MINOR.PATCH" form', () => {
    expect(parseOmpVersion('omp/17.3.2')).toEqual({ major: 17, minor: 3, patch: 2 });
  });

  it('tolerates surrounding whitespace and trailing build text', () => {
    expect(parseOmpVersion('  omp/17.3.2 (build abc)\n')).toEqual({ major: 17, minor: 3, patch: 2 });
  });

  it('returns null for unparseable output', () => {
    expect(parseOmpVersion('not a version')).toBeNull();
    expect(parseOmpVersion('')).toBeNull();
  });
});

describe('compareOmpVersions', () => {
  const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });

  it('is 0 for equal versions', () => {
    expect(compareOmpVersions(v(17, 3, 2), v(17, 3, 2))).toBe(0);
  });

  it('orders by patch when major/minor match', () => {
    expect(compareOmpVersions(v(17, 3, 1), v(17, 3, 2))).toBeLessThan(0);
  });

  it('orders by minor over a higher patch', () => {
    expect(compareOmpVersions(v(17, 4, 0), v(17, 3, 99))).toBeGreaterThan(0);
  });

  it('orders by major over higher minor/patch', () => {
    expect(compareOmpVersions(v(18, 0, 0), v(17, 99, 99))).toBeGreaterThan(0);
  });
});

describe('evaluateOmpVersionPolicy', () => {
  it('refuses an unparseable version', () => {
    expect(evaluateOmpVersionPolicy('garbage')).toEqual({ ok: false, reason: 'unparseable' });
  });

  it('refuses a version below the floor', () => {
    expect(evaluateOmpVersionPolicy('omp/17.2.9')).toEqual({ ok: false, reason: 'below-floor' });
  });

  it('accepts exactly the floor version, not flagged as above-tested', () => {
    expect(evaluateOmpVersionPolicy(`omp/${OMP_MIN_SUPPORTED_VERSION}`)).toEqual({
      ok: true,
      aboveTested: false,
    });
  });

  it('accepts exactly the tested version, not flagged as above-tested', () => {
    expect(evaluateOmpVersionPolicy(`omp/${OMP_TESTED_VERSION}`)).toEqual({
      ok: true,
      aboveTested: false,
    });
  });

  it('accepts AND flags a version newer than tested — never refuses it', () => {
    expect(evaluateOmpVersionPolicy('omp/99.0.0')).toEqual({ ok: true, aboveTested: true });
  });
});
