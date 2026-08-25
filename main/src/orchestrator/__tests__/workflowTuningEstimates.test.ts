/**
 * Unit tests for workflowTuningEstimates (shared/tuning/workflowTuningEstimates.ts,
 * plan D8): the median helper and the per-level fallback chain (measured ->
 * derived -> static).
 *
 * Colocated in main because main's vitest config only collects `main/src/**`
 * (see the sibling `workflowTuning.test.ts` doc comment for the same rationale).
 */
import { describe, it, expect } from 'vitest';
import {
  median,
  estimateTuningLevelTokens,
  type TuningLevelUsageSamples,
} from '../../../../shared/tuning/workflowTuningEstimates';

const EMPTY_SAMPLES: TuningLevelUsageSamples = {
  efficient: [],
  standard: [],
  thorough: [],
  custom: [],
};

describe('median', () => {
  it('returns null for an empty list', () => {
    expect(median([])).toBeNull();
  });

  it('returns the middle value for an odd-length list, regardless of input order', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('returns the mean of the middle pair for an even-length list', () => {
    expect(median([10, 20, 30, 40])).toBe(25);
    // A fractional mean rounds to the nearest integer (token counts are whole).
    expect(median([1, 2])).toBe(2); // (1 + 2) / 2 = 1.5 -> rounds to 2
  });

  it('does not mutate the input array', () => {
    const values = [5, 1, 3];
    median(values);
    expect(values).toEqual([5, 1, 3]);
  });
});

describe('estimateTuningLevelTokens', () => {
  it("measured: uses the level's own median once it has >= 3 samples, ignoring the pooled overall", () => {
    const samples: TuningLevelUsageSamples = {
      ...EMPTY_SAMPLES,
      efficient: [100_000, 120_000, 140_000],
    };
    const result = estimateTuningLevelTokens('sprint', samples);
    expect(result.efficient).toEqual({ label: '~120k', source: 'measured', samples: 3 });
  });

  it('derived: <3 own samples but the workflow has other-level data falls back to the pooled median x the level multiplier', () => {
    const samples: TuningLevelUsageSamples = {
      ...EMPTY_SAMPLES,
      // Only 2 efficient samples (below MIN_SAMPLES) — but standard has data,
      // so the pooled overall median feeds the derived estimate.
      efficient: [50_000, 60_000],
      standard: [200_000, 200_000, 200_000],
    };
    const result = estimateTuningLevelTokens('sprint', samples);
    expect(result.efficient.source).toBe('derived');
    // pooled = [50000, 60000, 200000, 200000, 200000] -> median 200000 * 0.5
    expect(result.efficient.label).toBe('~100k');
    expect(result.efficient.samples).toBe(5);
  });

  it('static: a fresh workflow with zero runs anywhere falls back to the static per-flow default x the level multiplier', () => {
    const result = estimateTuningLevelTokens('sprint', EMPTY_SAMPLES);
    expect(result.standard).toEqual({ label: '~300k', source: 'static', samples: 0 });
    expect(result.efficient).toEqual({ label: '~150k', source: 'static', samples: 0 });
    expect(result.thorough).toEqual({ label: '~780k', source: 'static', samples: 0 });
  });

  it('static per-flow defaults differ by flow (planner vs sprint) and fall back for an unknown flow', () => {
    expect(estimateTuningLevelTokens('planner', EMPTY_SAMPLES).standard.label).toBe('~150k');
    expect(estimateTuningLevelTokens('sprint', EMPTY_SAMPLES).standard.label).toBe('~300k');
    // A non-built-in flow name is not expected in practice (the selector is
    // hidden for those), but the function stays total over any string.
    expect(estimateTuningLevelTokens('my-custom-flow', EMPTY_SAMPLES).standard.source).toBe('static');
  });

  it('custom NEVER uses the multiplier fallback: <3 own samples with rich workflow data still goes straight to the static default', () => {
    const samples: TuningLevelUsageSamples = {
      ...EMPTY_SAMPLES,
      custom: [10_000],
      // Plenty of pooled data elsewhere that WOULD feed a derived estimate for
      // any other level — custom must ignore it.
      standard: [500_000, 500_000, 500_000, 500_000],
    };
    const result = estimateTuningLevelTokens('sprint', samples);
    expect(result.custom).toEqual({ label: '~300k', source: 'static', samples: 0 });
  });

  it('custom uses its own median once it has >= 3 samples', () => {
    const samples: TuningLevelUsageSamples = {
      ...EMPTY_SAMPLES,
      custom: [10_000, 20_000, 30_000],
    };
    const result = estimateTuningLevelTokens('sprint', samples);
    expect(result.custom).toEqual({ label: '~20k', source: 'measured', samples: 3 });
  });

  it('every level always carries a `~`-prefixed label', () => {
    const result = estimateTuningLevelTokens('sprint', EMPTY_SAMPLES);
    for (const level of ['efficient', 'standard', 'thorough', 'custom'] as const) {
      expect(result[level].label.startsWith('~')).toBe(true);
    }
  });
});
