/**
 * Token-count estimates per tuning level (docs/plans/workflow-tuning-levels.md D8).
 *
 * Pure fallback chain over the per-(workflow × level) `run_usage.total_tokens`
 * samples `insightsQueries.selectTuningLevelUsage` collects:
 *   1. that workflow's own median for the level, once it has >= MIN_SAMPLES
 *      completed, attributed (tuning_level NOT NULL), non-variant runs;
 *   2. else the workflow's OVERALL median (every level's samples pooled)
 *      scaled by the level's static multiplier;
 *   3. else a static per-flow default (fresh install, zero runs yet), scaled
 *      the same way.
 * CUSTOM never takes step 2 — a multiplier calibrated on the BUILT-IN preset
 * transforms says nothing about an arbitrary custom graph — so it falls
 * straight from step 1 to step 3 (the STANDARD static default; there is no
 * "custom" static default to fall back to, since a custom graph is by
 * definition not one of the calibrated shapes).
 *
 * Numbers here are EXECUTION tokens only: `run_usage` rolls up the run's own
 * `raw_events`; eval-jury judge calls run through separate queries with no
 * persisted usage (plan D8's "Scope caveat"). This module deliberately does
 * NOT bake an "excl. eval" qualifier into `label` — every caller must render
 * that once per surface (a shared caption near the selector), not once per
 * segment.
 *
 * Free of Node built-ins and any main/ import (mirrors workflowTuning.ts) —
 * both main (the tRPC read) and, if ever needed, the renderer can import it.
 */
import { TUNING_LEVELS, type TuningLevel } from './workflowTuning';
import { isCyboflowWorkflowName, type CyboflowWorkflowName } from '../types/workflows';

/** A workflow's completed-run token samples, one array per tuning level. */
export type TuningLevelUsageSamples = Record<TuningLevel, readonly number[]>;

export type TuningEstimateSource = 'measured' | 'derived' | 'static';

export interface TuningLevelEstimate {
  /** Always `~<count>` (e.g. "~284k") — an estimate, never claimed exact. */
  label: string;
  source: TuningEstimateSource;
  /**
   * Sample count backing `label`: the level's own runs (measured), the whole
   * workflow's pooled runs across every level (derived), or 0 (static — no
   * runs at all yet).
   */
  samples: number;
}

/**
 * A workflow × level needs at least this many of its OWN completed runs
 * before that level's median is trusted over the derived/static fallback.
 */
const MIN_SAMPLES = 3;

/**
 * Static multiplier applied to the OVERALL workflow median (fallback step 2).
 * `standard` is 1.0 by construction — it IS the baseline the other levels are
 * calibrated relative to. Custom never reads this table (step 2 is skipped
 * for it — see the module doc comment).
 */
const LEVEL_MULTIPLIER: Readonly<Record<Exclude<TuningLevel, 'custom'>, number>> = {
  efficient: 0.5,
  standard: 1.0,
  thorough: 2.6,
};

/**
 * Fresh-install static defaults (fallback step 3) — one execution-token
 * figure per built-in flow AT STANDARD; `LEVEL_MULTIPLIER` scales it for
 * efficient/thorough. Sprint and planner are calibrated against observed
 * runs; the rest are UNCALIBRATED placeholders (no per-flow measurement
 * exists yet) picked to be in the right order of magnitude for what each
 * flow actually does — they self-correct once real runs accumulate (step 1/2
 * take over).
 */
const STATIC_STANDARD_DEFAULT: Readonly<Record<CyboflowWorkflowName, number>> = {
  sprint: 300_000,
  planner: 150_000,
  // Uncalibrated — compound mines an already-merged diff, a lighter read/summarize pass.
  compound: 80_000,
  // Uncalibrated — ship runs a sprint-shaped lane chain over a smaller, already-scoped change.
  ship: 220_000,
  // Uncalibrated — verify-setup is a bounded survey-and-draft task, no fan-out.
  'verify-setup': 40_000,
  // Uncalibrated — launch runs a multi-round interview plus a full idea decomposition.
  launch: 200_000,
};

/**
 * Fallback used when `flow` is not a recognized built-in. Should not occur in
 * practice — the tuning selector is hidden for non-built-in ("save as new")
 * flows — but keeps this function total over any string.
 */
const UNKNOWN_FLOW_STANDARD_DEFAULT = 150_000;

/**
 * Median of a numeric list (mean of the middle pair when even); null for an
 * empty list. Mirrors the `median` precedent in
 * `main/src/orchestrator/trpc/routers/verificationRequests.ts` — SQLite has
 * no native median, so every median here is computed in JS.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Format a token count as "~936" / "~12.4k" / "~1.2M" (trailing .0 trimmed).
 * Mirrors `frontend/src/hooks/useSessionMetrics.ts`'s `formatTokenCount`,
 * duplicated (not imported) so this shared module stays free of a
 * frontend-only dependency — it is consumed from main as well.
 */
function formatEstimateLabel(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  if (rounded < 1000) return `~${rounded}`;
  if (rounded < 1_000_000) return `~${(rounded / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `~${(rounded / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function standardDefaultFor(flow: string): number {
  return isCyboflowWorkflowName(flow) ? STATIC_STANDARD_DEFAULT[flow] : UNKNOWN_FLOW_STANDARD_DEFAULT;
}

/**
 * The fallback-chain estimate for every level of one workflow. Pure — no I/O;
 * `samples` is exactly what `selectTuningLevelUsage` returns (or an
 * equivalent fixture in tests).
 */
export function estimateTuningLevelTokens(
  flow: string,
  samples: TuningLevelUsageSamples,
): Record<TuningLevel, TuningLevelEstimate> {
  const pooled = TUNING_LEVELS.flatMap((level) => samples[level]);
  const overallMedian = median(pooled);
  const staticDefault = standardDefaultFor(flow);

  const result = {} as Record<TuningLevel, TuningLevelEstimate>;
  for (const level of TUNING_LEVELS) {
    const own = samples[level];
    if (own.length >= MIN_SAMPLES) {
      // own.length >= MIN_SAMPLES > 0 guarantees a non-null median.
      const measured = median(own) as number;
      result[level] = { label: formatEstimateLabel(measured), source: 'measured', samples: own.length };
      continue;
    }
    if (level === 'custom') {
      // Custom skips step 2 entirely (module doc) — straight to the standard
      // static default, unscaled (the standard multiplier is 1.0).
      result[level] = { label: formatEstimateLabel(staticDefault), source: 'static', samples: 0 };
      continue;
    }
    const multiplier = LEVEL_MULTIPLIER[level];
    if (overallMedian !== null) {
      result[level] = {
        label: formatEstimateLabel(overallMedian * multiplier),
        source: 'derived',
        samples: pooled.length,
      };
    } else {
      result[level] = { label: formatEstimateLabel(staticDefault * multiplier), source: 'static', samples: 0 };
    }
  }
  return result;
}
