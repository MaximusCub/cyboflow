/**
 * providerUsage — the shape of a provider's SUBSCRIPTION quota, as reported by
 * the provider itself, for the usage meters at the top of the Human review queue.
 *
 * ## This is observed, never computed
 *
 * Every field here is copied from a reading the vendor pushed at us. Nothing is
 * accumulated locally and nothing is inferred from token counts — tokens are not
 * quota, and a synthetic percentage would be a confident lie. A provider that has
 * not spoken recently is reported as stale, not as zero.
 *
 * ## The two providers do NOT report symmetrically
 *
 * - Codex (`account/rateLimits/updated`) always carries a real `usedPercent`.
 * - Claude (`rate_limit_event`) carries `utilization` only sometimes — across
 *   1362 production rows, every reading that had one was already at
 *   `allowed_warning` (`surpassedThreshold: 0.75`). The schema
 *   (shared/types/claudeStream.ts) makes it optional independently of `status`,
 *   so we accept a number under any status, but we must render correctly when
 *   there is none.
 *
 * Hence `usedPercent: number | null`. A null percent means "the provider did not
 * say" — it must never render as 0%.
 */

/** Providers with a subscription quota worth metering. OMP is out of scope. */
export type UsageProvider = 'claude' | 'codex';

/**
 * A single quota window. Claude's kinds mirror the SDK's `rateLimitType`; Codex
 * reports two unnamed slots, so they are keyed by slot.
 */
export type UsageWindowKind =
  | 'claude_five_hour'
  | 'claude_seven_day'
  | 'claude_seven_day_opus'
  | 'claude_seven_day_sonnet'
  | 'claude_seven_day_oauth_apps'
  | 'claude_seven_day_overage_included'
  | 'claude_model_scoped'
  | 'claude_overage'
  | 'codex_primary'
  | 'codex_secondary';

/**
 * Severity tiers. `exhausted` is terminal for the window — lanes on that provider
 * will park until it resets.
 */
export type UsageStatus = 'ok' | 'warning' | 'critical' | 'exhausted';

/**
 * Where a reading came from.
 *
 * - `poll`  — we ASKED, just now. Codex `account/rateLimits/read`, or Claude's
 *   `/usage` control request. Authoritative and current.
 * - `stream` — it fell out of a turn that happened to be running. Correct WHEN
 *   OBSERVED, but it only refreshes when a turn runs, so it can silently
 *   describe a world that has moved on. The UI says so.
 */
export type UsageSource = 'poll' | 'stream';

export interface ProviderUsageWindow {
  kind: UsageWindowKind;
  /**
   * The server-supplied model bucket this window is scoped to ("Fable"), or
   * null for a window that covers the whole account.
   *
   * `claude_model_scoped` rows are DYNAMIC — the poll's `model_scoped[]` array
   * is server-driven and names buckets no enum here could enumerate ahead of
   * time — so the kind alone does not identify one. Use {@link usageWindowKey}
   * wherever a window needs a stable identity (map keys, React keys).
   */
  scopeLabel: string | null;
  /** Display label ("5-hour session", "Weekly", "Weekly (Fable)"). */
  label: string;
  status: UsageStatus;
  /** 0-100, or null when the provider reported no number. NEVER coerce to 0. */
  usedPercent: number | null;
  /**
   * Provenance of `usedPercent` specifically — null when there is no percentage.
   *
   * Tracked separately from the window record because the two can diverge: a
   * stream reading that carries no `utilization` RETAINS the percentage from an
   * earlier reading, so the record is fresh while the number it shows is not.
   */
  percentSource: UsageSource | null;
  /**
   * When `usedPercent` was measured. May PREDATE `observedAtMs` for the retained
   * case above — that gap is exactly what the staleness warning is about.
   */
  percentObservedAtMs: number | null;
  /** Unix MILLISECONDS. Both providers report seconds on the wire; converted at ingest. */
  resetsAtMs: number | null;
  /** Window length in minutes. Codex reports it; Claude does not. */
  windowMinutes: number | null;
  /** Unix ms at which this window record was last updated by any reading. */
  observedAtMs: number;
}

/**
 * True when the displayed percentage came from a turn's event stream rather than
 * a direct poll, and so may describe a world that has moved on. A window with no
 * percentage is NOT "stale" — it is unknown, which the UI states differently.
 */
export function isPercentPossiblyStale(window: ProviderUsageWindow): boolean {
  return window.usedPercent !== null && window.percentSource === 'stream';
}

/**
 * The stable identity of a window: its kind, plus the model bucket for the
 * dynamic `claude_model_scoped` rows. Two model-scoped windows share a kind and
 * would otherwise collide in a map (and share a React key).
 */
export function usageWindowKey(window: Pick<ProviderUsageWindow, 'kind' | 'scopeLabel'>): string {
  return window.scopeLabel === null ? window.kind : `${window.kind}:${window.scopeLabel}`;
}

/**
 * Extra-usage credits — MONEY, not a quota window.
 *
 * Claude's poll describes the same thing twice: `spend` (minor units with an
 * explicit currency and exponent) and the older `extra_usage` (credits plus
 * `decimal_places`). Both are folded into this one shape at ingest, `spend`
 * winning when the account reports both.
 *
 * It is deliberately NOT a {@link ProviderUsageWindow}: it has no reset to count
 * down to, the spend can EXCEED its limit (13.93 used against a 10.00 cap), and
 * sorting it among the quota windows would let a maxed-but-DISABLED credit line
 * outrank the window that is actually about to stop your lanes.
 */
export interface ProviderSpendSummary {
  /** Spent so far, in minor units (1393 = $13.93 at exponent 2). */
  usedMinor: number;
  /** The cap, in minor units, or null when the account reports none. */
  limitMinor: number | null;
  /** ISO 4217 code ("USD"). */
  currency: string;
  /** Minor-unit exponent: 2 for cents. */
  exponent: number;
  /** The provider's OWN percentage — reported, never recomputed from the
   *  amounts above, which is why it can read 100% while used exceeds limit. */
  percent: number | null;
  /** Whether extra usage is actually switched on. A disabled line is
   *  informational: nothing will be charged, and no lane will be unblocked. */
  enabled: boolean;
  /** The provider's machine reason ("org_level_disabled_until"), or null. */
  disabledReason: string | null;
}

/** "$13.93" — minor units rendered with the provider's own currency + exponent. */
export function formatSpendAmount(minor: number, currency: string, exponent: number): string {
  const value = minor / 10 ** exponent;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value);
  } catch {
    // An unknown/malformed currency code must not throw inside a render.
    return `${value.toFixed(exponent)} ${currency}`;
  }
}

export interface ProviderUsageSnapshot {
  provider: UsageProvider;
  /** Most-constrained window first. */
  windows: ProviderUsageWindow[];
  /** Codex reports a plan ("prolite"); Claude does not. */
  planType: string | null;
  /** Extra-usage credits, when the provider reports them. Codex: always null. */
  spend: ProviderSpendSummary | null;
  /** max(window.observedAtMs) — drives the "as of Xm ago" footer. */
  observedAtMs: number;
}

/** Both providers. A provider absent from the map has never reported. */
export type ProviderUsageState = Partial<Record<UsageProvider, ProviderUsageSnapshot>>;

// ---------------------------------------------------------------------------
// Tiering
// ---------------------------------------------------------------------------

/**
 * Status AND fill colour from one function, so the two can never disagree.
 *
 * An earlier draft reused `contextMeterClass` for the fill while deriving status
 * from a separate threshold table; at 51-79% that painted an amber bar under an
 * "OK" label. The boundaries below are deliberately the SAME as
 * `frontend/src/components/cyboflow/unified/contextUsage.ts` (>50 amber, >80
 * terracotta) so the usage meters and the context meter read as one family —
 * this adds only the `exhausted` tier at 100, which a context meter has no
 * equivalent for.
 */
export interface UsageTier {
  status: UsageStatus;
  /** Tailwind background class for the meter fill. */
  fillClass: string;
}

export function usageTier(percent: number): UsageTier {
  if (percent >= 100) return { status: 'exhausted', fillClass: 'bg-status-error' };
  if (percent > 80) return { status: 'critical', fillClass: 'bg-interactive' };
  if (percent > 50) return { status: 'warning', fillClass: 'bg-status-warning' };
  return { status: 'ok', fillClass: 'bg-status-success' };
}

/** Fill class for a window, including the no-number case (no fill at all). */
export function usageWindowFillClass(window: ProviderUsageWindow): string | null {
  if (window.usedPercent === null) return null;
  return usageTier(window.usedPercent).fillClass;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const USAGE_WINDOW_LABELS: Record<UsageWindowKind, string> = {
  claude_five_hour: '5-hour session',
  claude_seven_day: 'Weekly',
  claude_seven_day_opus: 'Weekly (Opus)',
  claude_seven_day_sonnet: 'Weekly (Sonnet)',
  claude_seven_day_oauth_apps: 'Weekly (OAuth apps)',
  claude_seven_day_overage_included: 'Weekly (incl. overage)',
  claude_model_scoped: 'Weekly (model)',
  claude_overage: 'Overage',
  codex_primary: 'Primary',
  codex_secondary: 'Secondary',
};

export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * Sort key — most-constrained first. A window with no percent sorts after every
 * window that has one, since we cannot claim it is more or less constrained.
 */
export function compareWindowsByPressure(a: ProviderUsageWindow, b: ProviderUsageWindow): number {
  if (a.usedPercent === null && b.usedPercent === null) {
    return usageWindowKey(a).localeCompare(usageWindowKey(b));
  }
  if (a.usedPercent === null) return 1;
  if (b.usedPercent === null) return -1;
  if (b.usedPercent !== a.usedPercent) return b.usedPercent - a.usedPercent;
  // Equal pressure: order by identity so two model-scoped rows at the same
  // percentage do not swap places between renders.
  return usageWindowKey(a).localeCompare(usageWindowKey(b));
}
