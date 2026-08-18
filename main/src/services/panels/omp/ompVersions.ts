/**
 * Version discipline for the OMP CLI (oh-my-pi, omp.sh).
 *
 * OMP releases near-daily — 683 changelog entries in ~9 months per the
 * proposal's fact §2.8 — with majors incrementing weekly and breaking changes
 * flagged in the changelog. A hard equality pin, the shape Codex uses
 * (`CODEX_EXECUTABLE_VERSION`), would break this integration constantly: we
 * spawn the USER's binary, not a bundled one, so an equality pin would refuse
 * every install within days of release.
 *
 * Instead OMP carries two numbers (proposal §3.4):
 *   - {@link OMP_MIN_SUPPORTED_VERSION} — a hard floor. A binary below this is
 *     refused (probes report 'unavailable') because it may predate behavior
 *     this integration depends on (the `--no-extensions`/`--no-skills`
 *     discovery-lockdown flags, the RPC `ready`-frame shape).
 *   - {@link OMP_TESTED_VERSION} — the newest version this integration has
 *     actually been verified against. A binary newer than this is still
 *     ACCEPTED (refusing it would put cyboflow permanently behind OMP's
 *     release cadence); callers log a one-time warning so the gap stays
 *     visible instead of silently drifting.
 *
 * docs/proposals/omp-provider-integration.md §3.4.
 */

/** Hard floor: a probed OMP binary below this version is refused. */
export const OMP_MIN_SUPPORTED_VERSION = '17.3.0';

/**
 * Newest version this integration has been verified against (the real
 * `~/.local/bin/omp` probe in scratchpad/omp-probe/PROBE-FINDINGS.md). Soft
 * ceiling only — never refuses, only warns.
 */
export const OMP_TESTED_VERSION = '17.3.2';

export interface OmpParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse an OMP version string defensively. Accepts a bare `MAJOR.MINOR.PATCH`
 * or the `omp/MAJOR.MINOR.PATCH` form the real binary's `--version` output
 * uses (verified: v17.3.2 reports `omp/17.3.2`) — the regex only looks for the
 * first `\d+.\d+.\d+` run, so either form (and any surrounding prefix/suffix
 * text a future release adds) parses the same way. Returns null rather than
 * throwing on anything unrecognized: OMP's release cadence makes an
 * unparseable future format an expected event, not a bug, and callers must
 * degrade to "unavailable" rather than crash the probe.
 */
export function parseOmpVersion(raw: string): OmpParsedVersion | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Ascending comparator over parsed versions: negative/zero/positive like `Array.prototype.sort`. */
export function compareOmpVersions(a: OmpParsedVersion, b: OmpParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export type OmpVersionPolicyVerdict =
  | { ok: true; aboveTested: boolean }
  | { ok: false; reason: 'unparseable' | 'below-floor' };

/**
 * Apply the floor+tested policy (see module doc) to a raw `--version` string.
 *  - Unparseable output → refuse, `reason: 'unparseable'`.
 *  - Below {@link OMP_MIN_SUPPORTED_VERSION} → refuse, `reason: 'below-floor'`.
 *  - At/above the floor → accept; `aboveTested: true` when the binary is newer
 *    than {@link OMP_TESTED_VERSION}, so the caller can log a one-time warning.
 */
export function evaluateOmpVersionPolicy(raw: string): OmpVersionPolicyVerdict {
  const parsed = parseOmpVersion(raw);
  if (!parsed) return { ok: false, reason: 'unparseable' };
  // Both constants are hardcoded valid `MAJOR.MINOR.PATCH` strings — non-null
  // by construction — but guard rather than assert past a compiler check.
  const floor = parseOmpVersion(OMP_MIN_SUPPORTED_VERSION);
  const tested = parseOmpVersion(OMP_TESTED_VERSION);
  if (!floor || !tested) return { ok: false, reason: 'unparseable' };
  if (compareOmpVersions(parsed, floor) < 0) return { ok: false, reason: 'below-floor' };
  return { ok: true, aboveTested: compareOmpVersions(parsed, tested) > 0 };
}
