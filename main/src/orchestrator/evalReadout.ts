/**
 * evalReadout — the code-review eval's verdict, shaped for an AGENT to act on.
 *
 * WHY A SEPARATE READ. `getRunEval` (insightsQueries) serves the summary panel:
 * it polls every ten seconds and therefore deliberately does NOT select
 * `diff_text` or `per_sample_json`, which are the multi-MB columns. But
 * `per_sample_json` is where the jury's actual reasoning lives — every finding
 * it raised and every sub-check it failed, with evidence — and that is precisely
 * what an agent asked to "fix what the eval flagged" needs.
 *
 * WHAT REACHED AGENTS BEFORE THIS. Only a filtered slice, via `review_items`:
 * EvalWorker.writeFindings keeps a candidate only if it is net-new OR
 * majority-confirmed catastrophic, drops anything that dedups against an
 * existing item, and caps the advisory remainder at MAX_FINDINGS_PER_EVAL (10).
 * The score, band, CI and per-dimension breakdown reached them not at all: the
 * one review item carrying that rollup is written by `maybeWriteAdHocSummary`,
 * which returns early unless `origin = 'adhoc'` — so an automatic or
 * A/B-tagged eval, the kind a flow run actually gets, posts no summary at all.
 * An agent could therefore see at most ten of the jury's findings and never its
 * verdict, which is how "I don't have a tool that reads that jury's content"
 * became a true statement about a database row that was right there.
 *
 * CROSS-LINKING. Each merged finding carries `reviewItemId` when a matching
 * `review_items` row exists for the same run, so the agent can fix and then
 * `cyboflow_resolve_finding` in one pass — and, just as usefully, `null` marks a
 * finding the queue never got, which is the one an agent would otherwise never
 * learn about.
 *
 * Standalone-typecheck invariant: no electron, no better-sqlite3, no
 * main/src/services — just the narrow DatabaseLike.
 */
import type { DatabaseLike } from './types';

/**
 * Cap on merged findings and failed sub-checks returned per eval. Generous
 * relative to MAX_FINDINGS_PER_EVAL (10) because this read exists to surface
 * what that cap dropped; bounded anyway so one pathological jury run cannot
 * blow an agent's context. Truncation is REPORTED (`findingsTruncated`), never
 * silent — a quietly shortened list reads as a complete one.
 */
export const MAX_READOUT_ROWS = 60;

/** One sub-check the jury failed, merged across samples. */
export interface EvalSubCheckFailure {
  /** Rubric sub-check id, e.g. 'COR-2'. */
  id: string;
  /** How many samples returned FAIL for it. */
  failVotes: number;
  /** How many samples returned a verdict for it at all. */
  votes: number;
  /** The judge's justification, from the first FAIL sample that supplied one. */
  evidence: string | null;
}

/** One jury finding, merged across samples and linked to its review item. */
export interface EvalFindingReadout {
  /** The sub-check it hangs off (e.g. 'SEC-2'); null when general. */
  subCheckId: string | null;
  dimension: string | null;
  severity: string | null;
  title: string;
  body: string | null;
  file: string | null;
  line: number | null;
  /** How many samples raised this same finding. */
  votes: number;
  /** How many of those flagged it catastrophic (a majority is what blocks). */
  catastrophicVotes: number;
  /**
   * The `review_items.id` this finding was filed as, or null when it never
   * reached the queue — deduped against an existing item, or dropped by the
   * advisory cap. A null is the interesting case: nothing else surfaces it.
   */
  reviewItemId: string | null;
  /** That row's status ('pending' / 'resolved' / 'dismissed'), when linked. */
  reviewItemStatus: string | null;
}

/** The verdict rollup plus the jury's reasoning, for one run. */
export interface EvalReadout {
  runId: string;
  rubricVersion: string;
  evalStatus: string;
  /** 'adhoc' for a tool-triggered grade; null for the automatic/A-B one. */
  origin: string | null;
  snapshotAt: string | null;
  humanInfluenced: boolean;
  overallScore: number | null;
  band: string | null;
  ciLow: number | null;
  ciHigh: number | null;
  sampleCount: number | null;
  judgeModel: string | null;
  gated: boolean;
  securityFlag: boolean;
  requirementsUnmet: boolean;
  /** Catastrophic-cap trigger tokens; empty when the cap did not fire. */
  capTriggers: string[];
  /** Per-dimension scores as the worker stored them. */
  dimensions: unknown[] | null;
  failedSubChecks: EvalSubCheckFailure[];
  findings: EvalFindingReadout[];
  /** True when either list hit {@link MAX_READOUT_ROWS}. */
  truncated: boolean;
  /** Populated only when evalStatus is 'failed'. */
  error: string | null;
}

interface RawEvalRow {
  run_id?: unknown;
  rubric_version?: unknown;
  eval_status?: unknown;
  origin?: unknown;
  snapshot_at?: unknown;
  human_influenced?: unknown;
  overall_score?: unknown;
  band?: unknown;
  ci_low?: unknown;
  ci_high?: unknown;
  sample_count?: unknown;
  judge_model?: unknown;
  gated?: unknown;
  security_flag?: unknown;
  requirements_unmet?: unknown;
  cap_triggers_json?: unknown;
  dimensions_json?: unknown;
  per_sample_json?: unknown;
  error?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean {
  return value === 1 || value === true;
}

function parseArray(text: unknown): unknown[] | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge the K jury samples into one findings list and one failed-sub-check list.
 *
 * The dedup key mirrors EvalWorker.findingKey closely enough to group the same
 * issue across samples: sub-check id + file when the finding carries one, else
 * the lowercased title + file. It does NOT need to match the worker's key
 * exactly — this is a presentation merge, and a split that the worker would have
 * joined costs a duplicate row, not a wrong verdict.
 */
function mergeSamples(samples: unknown[]): {
  findings: EvalFindingReadout[];
  failedSubChecks: EvalSubCheckFailure[];
} {
  const findings = new Map<string, EvalFindingReadout>();
  const subChecks = new Map<string, EvalSubCheckFailure>();

  for (const sample of samples) {
    if (!isRecord(sample)) continue;

    for (const raw of Array.isArray(sample.verdicts) ? sample.verdicts : []) {
      if (!isRecord(raw)) continue;
      const id = asString(raw.id);
      if (id === null) continue;
      const verdict = asString(raw.verdict);
      const prev = subChecks.get(id) ?? { id, failVotes: 0, votes: 0, evidence: null };
      prev.votes += 1;
      if (verdict === 'FAIL') {
        prev.failVotes += 1;
        // First FAIL sample that cites anything wins — later ones paraphrase it.
        if (prev.evidence === null) prev.evidence = asString(raw.evidence);
      }
      subChecks.set(id, prev);
    }

    for (const raw of Array.isArray(sample.findings) ? sample.findings : []) {
      if (!isRecord(raw)) continue;
      const title = asString(raw.title);
      if (title === null) continue;
      const subCheckId = asString(raw.subCheckId);
      const file = asString(raw.file);
      const key = `${subCheckId ?? title.toLowerCase()}::${file ?? ''}`;
      const prev = findings.get(key);
      if (prev) {
        prev.votes += 1;
        if (asBool(raw.catastrophic)) prev.catastrophicVotes += 1;
        continue;
      }
      findings.set(key, {
        subCheckId,
        dimension: asString(raw.dimension),
        severity: asString(raw.severity),
        title,
        body: asString(raw.body),
        file,
        line: asNumber(raw.line),
        votes: 1,
        catastrophicVotes: asBool(raw.catastrophic) ? 1 : 0,
        reviewItemId: null,
        reviewItemStatus: null,
      });
    }
  }

  return {
    // Loudest first: a finding a majority of the jury raised outranks a lone
    // sample's, and catastrophic outranks everything — so a cap that trims the
    // tail trims the least important rows.
    findings: [...findings.values()].sort(
      (a, b) => b.catastrophicVotes - a.catastrophicVotes || b.votes - a.votes,
    ),
    failedSubChecks: [...subChecks.values()]
      .filter((c) => c.failVotes > 0)
      .sort((a, b) => b.failVotes - a.failVotes || a.id.localeCompare(b.id)),
  };
}

/**
 * Attach the `review_items.id` each merged finding was filed as, matching on
 * title (EvalWorker writes `title: f.title` verbatim).
 *
 * Matching across ALL of the run's findings, not just `source = 'agent:eval'`,
 * is deliberate: the worker dedups a jury finding against an in-flow reviewer's
 * item and then does NOT write its own row, so the review item that represents
 * that issue can legitimately carry `agent:code-review` as its source.
 */
function linkReviewItems(
  db: DatabaseLike,
  runId: string,
  findings: EvalFindingReadout[],
): void {
  if (findings.length === 0) return;
  let rows: Array<{ id?: unknown; title?: unknown; status?: unknown }> = [];
  try {
    rows = db
      .prepare(`SELECT id, title, status FROM review_items WHERE run_id = ? AND kind = 'finding'`)
      .all(runId) as Array<{ id?: unknown; title?: unknown; status?: unknown }>;
  } catch {
    // No review_items table (a pre-016 DB) — every link stays null, which is
    // the honest answer rather than a failure.
    return;
  }

  const byTitle = new Map<string, { id: string; status: string | null }>();
  for (const row of rows) {
    const id = asString(row.id);
    const title = asString(row.title);
    if (id === null || title === null) continue;
    // First writer wins: a re-fired eval can mint a second row for one issue,
    // and the earlier id is the one the queue has been showing.
    if (!byTitle.has(title.toLowerCase())) {
      byTitle.set(title.toLowerCase(), { id, status: asString(row.status) });
    }
  }

  for (const finding of findings) {
    const hit = byTitle.get(finding.title.toLowerCase());
    if (hit) {
      finding.reviewItemId = hit.id;
      finding.reviewItemStatus = hit.status;
    }
  }
}

/**
 * The agent-facing eval readout for one run, or null when that run has no
 * `run_evals` row (never graded, or a DB predating migration 043).
 *
 * Row selection matches `getRunEval`'s canonical rule so this and the summary
 * panel never disagree about which grade is "the" grade: prefer a
 * non-human-influenced snapshot (the pristine, pre-human evaluation), earliest
 * first, falling back to an influenced row only when every row is influenced.
 */
export function selectEvalReadout(db: DatabaseLike, runId: string): EvalReadout | null {
  let row: RawEvalRow | undefined;
  try {
    row = db
      .prepare(
        `SELECT run_id, rubric_version, eval_status, origin, snapshot_at, human_influenced,
                overall_score, band, ci_low, ci_high, sample_count, judge_model, gated,
                security_flag, requirements_unmet, cap_triggers_json, dimensions_json,
                per_sample_json, error
           FROM run_evals
          WHERE run_id = ?
          ORDER BY human_influenced ASC, snapshot_at ASC
          LIMIT 1`,
      )
      .get(runId) as RawEvalRow | undefined;
  } catch {
    // No run_evals table at all (pre-043) — indistinguishable, for the caller,
    // from a run that was never graded.
    return null;
  }
  if (row === undefined) return null;

  const merged = mergeSamples(parseArray(row.per_sample_json) ?? []);
  const truncated =
    merged.findings.length > MAX_READOUT_ROWS ||
    merged.failedSubChecks.length > MAX_READOUT_ROWS;
  const findings = merged.findings.slice(0, MAX_READOUT_ROWS);
  linkReviewItems(db, runId, findings);

  return {
    runId: asString(row.run_id) ?? runId,
    rubricVersion: asString(row.rubric_version) ?? '',
    evalStatus: asString(row.eval_status) ?? 'pending',
    origin: asString(row.origin),
    snapshotAt: asString(row.snapshot_at),
    humanInfluenced: asBool(row.human_influenced),
    overallScore: asNumber(row.overall_score),
    band: asString(row.band),
    ciLow: asNumber(row.ci_low),
    ciHigh: asNumber(row.ci_high),
    sampleCount: asNumber(row.sample_count),
    judgeModel: asString(row.judge_model),
    gated: asBool(row.gated),
    securityFlag: asBool(row.security_flag),
    requirementsUnmet: asBool(row.requirements_unmet),
    capTriggers: (parseArray(row.cap_triggers_json) ?? []).filter(
      (t): t is string => typeof t === 'string',
    ),
    dimensions: parseArray(row.dimensions_json),
    failedSubChecks: merged.failedSubChecks.slice(0, MAX_READOUT_ROWS),
    findings,
    truncated,
    error: asString(row.error),
  };
}
