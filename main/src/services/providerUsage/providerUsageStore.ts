/**
 * ProviderUsageStore — the process-wide, last-known subscription quota for each
 * agent provider, feeding the usage meters at the top of the Human review queue.
 *
 * ## Observed, not accumulated
 *
 * Readings arrive opportunistically: Claude's `rate_limit_event` and Codex's
 * `account/rateLimits/updated` are both pushed by the vendor while a turn runs.
 * Each one states the CURRENT truth for its window, so a missed reading costs
 * freshness, never correctness — which is why nothing here counts tokens or
 * spends quota to measure quota.
 *
 * ## Never throw at the caller
 *
 * Both ingest seams sit on hot vendor paths where an exception is destructive —
 * a throw out of the Codex `onNotification` handler reaches
 * `CodexAppServerClient.fail()`, which SIGTERMs the app-server's whole process
 * group mid-turn. The record methods therefore swallow and log their own
 * failures, and the callers wrap them again. Telemetry must never break a turn.
 *
 * ## Persistence
 *
 * A versioned blob in `user_preferences` (no migration needed). `setUserPreference`
 * is a SYNCHRONOUS main-thread write and a busy sprint emits a reading per turn
 * per lane, so writes are debounced; `flush()` exists for quit-time draining.
 */
import { EventEmitter } from 'events';
import type { RateLimitEvent } from '../../../../shared/types/claudeStream';
import type {
  ProviderSpendSummary,
  ProviderUsageSnapshot,
  ProviderUsageState,
  ProviderUsageWindow,
  UsageProvider,
  UsageSource,
  UsageStatus,
  UsageWindowKind,
} from '../../../../shared/types/providerUsage';
import {
  USAGE_WINDOW_LABELS,
  compareWindowsByPressure,
  usageTier,
  usageWindowKey,
} from '../../../../shared/types/providerUsage';
import type { CodexRateLimits } from '../panels/codex/appServer/rateLimits';

/** The `user_preferences` key holding the persisted blob. */
export const PROVIDER_USAGE_PREFERENCE_KEY = 'providerUsage.snapshotV1';

/** Bumped when the persisted shape changes; an older/newer blob is discarded. */
const PERSISTED_VERSION = 1;

/** Debounce for the synchronous preference write. */
const PERSIST_DEBOUNCE_MS = 2_000;

/**
 * A window that reports no reset time can never expire by clock, so it expires
 * by age instead. Without this, the 4 production rows carrying neither
 * `resetsAt` nor `rateLimitType` would be immortal.
 */
const NO_RESET_MAX_AGE_MS = 12 * 60 * 60 * 1_000;

/**
 * How far apart two reset timestamps may be and still name the SAME window.
 *
 * The two Claude sources report the same reset at different precision: the
 * `/usage` poll returns ISO 8601 with sub-second digits
 * (`…T19:09:59.822085+00:00`), while `rate_limit_event` reports whole epoch
 * SECONDS (`1787685000`) — 178 ms apart for one observed five-hour window.
 * Compared exactly, the stream reading looked like a different window, so the
 * polled percentage was not retained and the meter blanked seconds after every
 * poll. Consecutive real windows are five hours or seven days apart, so a
 * minute of slack cannot merge two of them.
 */
const RESET_MATCH_TOLERANCE_MS = 60_000;

/**
 * Whether an incoming reading describes the window a stored record already
 * holds. Two unknown resets match (neither reading names a boundary); a known
 * reset never matches an unknown one.
 */
function isSameResetWindow(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= RESET_MATCH_TOLERANCE_MS;
}

/** The narrow log surface this store needs — `console` satisfies it. */
export interface ProviderUsageLogger {
  warn(message: string): void;
}

/** The narrow DB surface this store needs — nothing else from Database. */
export interface ProviderUsagePreferences {
  getUserPreference(key: string): string | null;
  setUserPreference(key: string, value: string): void;
}

const CLAUDE_KIND_BY_RATE_LIMIT_TYPE: Record<string, UsageWindowKind> = {
  five_hour: 'claude_five_hour',
  seven_day: 'claude_seven_day',
  seven_day_opus: 'claude_seven_day_opus',
  seven_day_sonnet: 'claude_seven_day_sonnet',
  seven_day_overage_included: 'claude_seven_day_overage_included',
  overage: 'claude_overage',
};

const STATUS_SEVERITY: Record<UsageStatus, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
  exhausted: 3,
};

function mostSevere(a: UsageStatus, b: UsageStatus): UsageStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}

/**
 * The Claude `/usage` control-request payload, narrowed to what we consume.
 * Declared here rather than imported: the SDK's own type is behind an
 * explicitly-experimental method name and must not become a compile dependency.
 */
/** The poll slots that map 1:1 onto a whole-account window. */
export type ClaudeUsagePollSlot =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'seven_day_oauth_apps';

export interface ClaudeUsagePoll {
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  rateLimits: (Partial<Record<
    ClaudeUsagePollSlot,
    { utilization: number | null; resets_at: string | null } | null
  >> & {
    /**
     * Per-model weekly windows, server-driven and ADDITIVE — the bucket names
     * ("Fable") are supplied by the server, so they cannot be enumerated here.
     */
    model_scoped?: unknown;
    /** Money view of extra-usage credits (minor units + currency). */
    spend?: unknown;
    /** The older credits view of the same thing; used only when `spend` is absent. */
    extra_usage?: unknown;
  }) | null;
}

/** Poll slot → the window kind it populates. */
const CLAUDE_POLL_WINDOWS: ReadonlyArray<readonly [UsageWindowKind, ClaudeUsagePollSlot]> = [
  ['claude_five_hour', 'five_hour'],
  ['claude_seven_day', 'seven_day'],
  ['claude_seven_day_opus', 'seven_day_opus'],
  ['claude_seven_day_sonnet', 'seven_day_sonnet'],
  ['claude_seven_day_oauth_apps', 'seven_day_oauth_apps'],
];

/** The Claude poll reports ISO 8601; the stream reports epoch seconds. */
function isoToMs(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Wire timestamps are epoch SECONDS from both providers; the model is ms. */
function secondsToMs(seconds: number | undefined | null): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1_000);
}

function clampPercent(value: number | undefined | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The poll's `model_scoped[]` — per-model weekly windows the server adds on its
 * own schedule ("Fable"). Narrowed entry by entry rather than cast: the array is
 * explicitly additive, so an entry in a shape we do not recognise must be
 * dropped, never turned into a window with a missing name or an invented number.
 */
function parseModelScopedWindows(value: unknown, nowMs: number): ProviderUsageWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: ProviderUsageWindow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const displayName = typeof entry.display_name === 'string' ? entry.display_name.trim() : '';
    if (displayName === '') continue;
    const usedPercent = clampPercent(asFiniteNumber(entry.utilization));
    // Same rule as every other polled window: no number, no row.
    if (usedPercent === null) continue;
    windows.push({
      kind: 'claude_model_scoped',
      scopeLabel: displayName,
      label: `Weekly (${displayName})`,
      status: usageTier(usedPercent).status,
      usedPercent,
      percentSource: 'poll',
      percentObservedAtMs: nowMs,
      resetsAtMs: isoToMs(typeof entry.resets_at === 'string' ? entry.resets_at : null),
      windowMinutes: null,
      observedAtMs: nowMs,
    });
  }
  return windows;
}

/**
 * Extra-usage credits, from whichever of the two shapes the account reports.
 *
 * `spend` is preferred: it states the currency and the minor-unit exponent
 * explicitly. `extra_usage` is the older credits view of the same balance and
 * is read only as a fallback — assuming USD there, because that view names no
 * currency at all and every observed account reports one alongside it.
 *
 * `percent` is taken from the provider VERBATIM. It reads 100 while 1393 minor
 * units stand against a 1000 cap; recomputing it to 139 would be this module
 * inventing a number the vendor did not report.
 */
function parseSpend(rateLimits: Record<string, unknown>): ProviderSpendSummary | null {
  const spend = rateLimits.spend;
  if (isRecord(spend) && isRecord(spend.used)) {
    const used = spend.used;
    const usedMinor = asFiniteNumber(used.amount_minor);
    if (usedMinor !== null) {
      const limit = isRecord(spend.limit) ? spend.limit : null;
      return {
        usedMinor,
        limitMinor: limit === null ? null : asFiniteNumber(limit.amount_minor),
        currency: typeof used.currency === 'string' ? used.currency : 'USD',
        exponent: asFiniteNumber(used.exponent) ?? 2,
        percent: clampPercent(asFiniteNumber(spend.percent)),
        enabled: spend.enabled === true,
        disabledReason: typeof spend.disabled_reason === 'string' ? spend.disabled_reason : null,
      };
    }
  }

  const extra = rateLimits.extra_usage;
  if (isRecord(extra)) {
    const usedMinor = asFiniteNumber(extra.used_credits);
    if (usedMinor !== null) {
      return {
        usedMinor,
        limitMinor: asFiniteNumber(extra.monthly_limit),
        currency: typeof extra.currency === 'string' ? extra.currency : 'USD',
        exponent: asFiniteNumber(extra.decimal_places) ?? 2,
        percent: clampPercent(asFiniteNumber(extra.utilization)),
        enabled: extra.is_enabled === true,
        disabledReason: typeof extra.disabled_reason === 'string' ? extra.disabled_reason : null,
      };
    }
  }

  return null;
}

/**
 * A window is live when its reset is still in the future. A window with no reset
 * falls back to an age cap. Expiry is evaluated on READ (see `getState`) — a
 * reset that has passed no longer describes current usage.
 */
function isLive(window: ProviderUsageWindow, nowMs: number): boolean {
  if (window.resetsAtMs !== null) return window.resetsAtMs > nowMs;
  return nowMs - window.observedAtMs < NO_RESET_MAX_AGE_MS;
}

interface PersistedBlob {
  version: number;
  providers: ProviderUsageState;
}

export class ProviderUsageStore {
  /** Per-provider windows keyed by {@link usageWindowKey} — Claude reports its
   *  windows in SEPARATE events, so replacing a whole snapshot per event would
   *  make them flap. Keyed by KEY rather than kind because the poll's
   *  `model_scoped[]` rows all share one kind and must not collide. */
  private readonly windows = new Map<UsageProvider, Map<string, ProviderUsageWindow>>();
  private readonly planTypes = new Map<UsageProvider, string | null>();
  /** Extra-usage credits per provider. Only Claude reports any today. */
  private readonly spends = new Map<UsageProvider, ProviderSpendSummary | null>();

  private persistTimer: NodeJS.Timeout | null = null;
  private persistPending = false;

  readonly events = new EventEmitter();

  constructor(
    private readonly preferences?: ProviderUsagePreferences,
    private readonly logger?: ProviderUsageLogger,
  ) {}

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  /**
   * The live state, with expired windows pruned. A provider whose every window
   * has expired drops out entirely, so its card falls back to the no-data state
   * rather than showing a window that has already reset.
   */
  getState(nowMs: number = Date.now()): ProviderUsageState {
    const state: ProviderUsageState = {};
    for (const [provider, byKey] of this.windows) {
      const live = [...byKey.values()].filter((w) => isLive(w, nowMs));
      if (live.length === 0) continue;
      live.sort(compareWindowsByPressure);
      state[provider] = {
        provider,
        windows: live,
        planType: this.planTypes.get(provider) ?? null,
        spend: this.spends.get(provider) ?? null,
        observedAtMs: live.reduce((max, w) => Math.max(max, w.observedAtMs), 0),
      };
    }
    return state;
  }

  // -------------------------------------------------------------------------
  // Ingest
  // -------------------------------------------------------------------------

  /**
   * Record a Claude `rate_limit_event`.
   *
   * A reading with no `rateLimitType` is REFUSED: it names no window, so there is
   * nothing it could correctly update.
   *
   * `utilization` is absent from most readings. When it is, and the same window
   * (same kind AND the same reset, within {@link RESET_MATCH_TOLERANCE_MS})
   * already has a known percentage, that percentage is
   * RETAINED — otherwise a plain `allowed` event arriving after a 95% warning
   * would blank the meter and read as a recovery that never happened.
   */
  recordClaudeRateLimit(
    info: RateLimitEvent['rate_limit_info'],
    nowMs: number = Date.now(),
  ): void {
    try {
      const kind = info.rateLimitType === undefined
        ? undefined
        : CLAUDE_KIND_BY_RATE_LIMIT_TYPE[info.rateLimitType];
      if (kind === undefined) return;

      const resetsAtMs = secondsToMs(info.resetsAt);
      // `utilization` is a 0-1 fraction on the wire.
      const reported = clampPercent(
        typeof info.utilization === 'number' ? info.utilization * 100 : null,
      );

      // A streamed reading is never model-scoped, so its key is its kind.
      const previous = this.windows.get('claude')?.get(usageWindowKey({ kind, scopeLabel: null }));
      const sameWindow = previous !== undefined && isSameResetWindow(previous.resetsAtMs, resetsAtMs);
      const retained = sameWindow ? previous : undefined;
      const usedPercent = reported ?? retained?.usedPercent ?? null;
      // A RETAINED percentage keeps its original provenance and measurement time
      // — the record is fresh, the number in it is not, and conflating the two
      // is what the staleness warning exists to prevent.
      const percentSource: UsageSource | null = reported !== null
        ? 'stream'
        : usedPercent === null ? null : retained?.percentSource ?? 'stream';
      const percentObservedAtMs = reported !== null
        ? nowMs
        : usedPercent === null ? null : retained?.percentObservedAtMs ?? null;

      const fromStatus: UsageStatus = info.status === 'rejected'
        ? 'exhausted'
        : info.status === 'allowed_warning' ? 'warning' : 'ok';
      const status = info.status === 'rejected'
        ? 'exhausted'
        : usedPercent === null
          ? fromStatus
          : mostSevere(fromStatus, usageTier(usedPercent).status);

      this.putWindow('claude', {
        kind,
        scopeLabel: null,
        label: USAGE_WINDOW_LABELS[kind],
        status,
        usedPercent,
        percentSource,
        percentObservedAtMs,
        resetsAtMs,
        windowMinutes: null,
        observedAtMs: nowMs,
      });
      this.onChanged();
    } catch (error) {
      this.warn('recordClaudeRateLimit', error);
    }
  }

  /**
   * Record a Claude `/usage` poll — the SDK's usage control request.
   *
   * AUTHORITATIVE: the response enumerates every window, so a window it omits is
   * one the account does not have, and is deleted rather than left behind. This
   * is the difference that matters versus the event stream, which reports one
   * window at a time and withholds `utilization` below the warning threshold.
   *
   * `rateLimitsAvailable === false` (API key, Bedrock, Vertex, or a missing
   * profile scope) means plan limits do not apply at all — the provider drops
   * out entirely rather than showing an empty meter.
   */
  recordClaudeUsagePoll(usage: ClaudeUsagePoll, nowMs: number = Date.now()): void {
    try {
      if (!usage.rateLimitsAvailable || usage.rateLimits === null) {
        this.windows.delete('claude');
        this.spends.delete('claude');
        this.planTypes.set('claude', usage.subscriptionType ?? null);
        this.onChanged();
        return;
      }

      const next = new Map<string, ProviderUsageWindow>();
      for (const [kind, slot] of CLAUDE_POLL_WINDOWS) {
        const reading = usage.rateLimits[slot];
        if (reading === undefined || reading === null) continue;
        const usedPercent = clampPercent(reading.utilization);
        if (usedPercent === null) continue;
        next.set(usageWindowKey({ kind, scopeLabel: null }), {
          kind,
          scopeLabel: null,
          label: USAGE_WINDOW_LABELS[kind],
          status: usageTier(usedPercent).status,
          usedPercent,
          percentSource: 'poll',
          percentObservedAtMs: nowMs,
          resetsAtMs: isoToMs(reading.resets_at),
          windowMinutes: null,
          observedAtMs: nowMs,
        });
      }
      // Per-model weekly buckets ride the same authoritative replacement: one
      // the server stops reporting is a bucket the account no longer has.
      for (const window of parseModelScopedWindows(usage.rateLimits.model_scoped, nowMs)) {
        next.set(usageWindowKey(window), window);
      }

      if (next.size === 0) {
        this.windows.delete('claude');
      } else {
        this.windows.set('claude', next);
      }
      // Credits are AUTHORITATIVE per poll too — an account that stops reporting
      // them has none, and a retained balance would be a number nobody stands behind.
      this.spends.set('claude', parseSpend(usage.rateLimits));
      this.planTypes.set('claude', usage.subscriptionType ?? null);
      this.onChanged();
    } catch (error) {
      this.warn('recordClaudeUsagePoll', error);
    }
  }

  /**
   * Record a Codex `account/rateLimits/updated` payload.
   *
   * Each notification is AUTHORITATIVE for the whole Codex snapshot: a slot the
   * provider reports as null is a window it no longer has, so it is deleted
   * rather than left behind stale. Only the `codex` limit is metered — a
   * `premium`/credits frame describes a different limit and must not clobber it.
   */
  recordCodexRateLimits(
    rateLimits: CodexRateLimits,
    nowMs: number = Date.now(),
    source: UsageSource = 'stream',
  ): void {
    try {
      if (rateLimits.limitId !== 'codex') return;

      const next = new Map<string, ProviderUsageWindow>();
      for (const [kind, slot] of [
        ['codex_primary', rateLimits.primary],
        ['codex_secondary', rateLimits.secondary],
      ] as const) {
        if (slot === null) continue;
        const usedPercent = clampPercent(slot.usedPercent);
        if (usedPercent === null) continue;
        next.set(usageWindowKey({ kind, scopeLabel: null }), {
          kind,
          scopeLabel: null,
          label: codexWindowLabel(kind, slot.windowDurationMins),
          status: usageTier(usedPercent).status,
          usedPercent,
          percentSource: source,
          percentObservedAtMs: nowMs,
          resetsAtMs: secondsToMs(slot.resetsAt),
          windowMinutes: slot.windowDurationMins ?? null,
          observedAtMs: nowMs,
        });
      }

      if (next.size === 0) {
        this.windows.delete('codex');
      } else {
        this.windows.set('codex', next);
      }
      this.planTypes.set('codex', rateLimits.planType ?? null);
      this.onChanged();
    } catch (error) {
      this.warn('recordCodexRateLimits', error);
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Load the persisted blob. A missing, malformed, or wrong-version value is an
   *  empty state — never a boot failure. Expired windows are pruned on the way in. */
  hydrate(nowMs: number = Date.now()): void {
    try {
      const raw = this.preferences?.getUserPreference(PROVIDER_USAGE_PREFERENCE_KEY);
      if (raw === null || raw === undefined) return;
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedBlob(parsed) || parsed.version !== PERSISTED_VERSION) return;

      for (const snapshot of Object.values(parsed.providers)) {
        if (snapshot === undefined) continue;
        const live = snapshot.windows.filter((w) => isLive(w, nowMs));
        if (live.length === 0) continue;
        // Re-key on the way in: a blob written before model-scoped windows
        // existed carries no `scopeLabel`, which reads as null and keys by kind
        // exactly as it did then.
        this.windows.set(
          snapshot.provider,
          new Map(live.map((w) => [usageWindowKey({ kind: w.kind, scopeLabel: w.scopeLabel ?? null }), { ...w, scopeLabel: w.scopeLabel ?? null }])),
        );
        this.planTypes.set(snapshot.provider, snapshot.planType);
        this.spends.set(snapshot.provider, snapshot.spend ?? null);
      }
    } catch (error) {
      this.warn('hydrate', error);
    }
  }

  /**
   * Write immediately, cancelling any pending debounce. Call at quit.
   *
   * `nowMs` is threaded through because the persisted blob is `getState()`'s
   * pruned output — writing it against a different clock than the caller reasons
   * with would silently persist an empty state.
   */
  flush(nowMs: number = Date.now()): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistPending) return;
    this.persistPending = false;
    try {
      const blob: PersistedBlob = {
        version: PERSISTED_VERSION,
        providers: this.getState(nowMs),
      };
      this.preferences?.setUserPreference(PROVIDER_USAGE_PREFERENCE_KEY, JSON.stringify(blob));
    } catch (error) {
      this.warn('flush', error);
    }
  }

  dispose(): void {
    this.flush();
    this.events.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private putWindow(provider: UsageProvider, window: ProviderUsageWindow): void {
    let byKey = this.windows.get(provider);
    if (byKey === undefined) {
      byKey = new Map();
      this.windows.set(provider, byKey);
    }
    byKey.set(usageWindowKey(window), window);
  }

  private onChanged(): void {
    this.persistPending = true;
    if (this.persistTimer === null) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.flush();
      }, PERSIST_DEBOUNCE_MS);
      // Never hold the process open for a telemetry write.
      this.persistTimer.unref?.();
    }
    // A listener that throws must not take out the vendor call that got us here.
    try {
      this.events.emit('changed', this.getState());
    } catch (error) {
      this.warn('emit', error);
    }
  }

  private warn(where: string, error: unknown): void {
    this.logger?.warn(
      `[ProviderUsageStore] ${where} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function codexWindowLabel(kind: UsageWindowKind, windowMinutes: number | null): string {
  if (windowMinutes === 10_080) return 'Weekly';
  if (windowMinutes === 300) return '5-hour session';
  if (windowMinutes !== null && windowMinutes % 60 === 0) return `${windowMinutes / 60}-hour window`;
  return USAGE_WINDOW_LABELS[kind];
}

function isPersistedBlob(value: unknown): value is PersistedBlob {
  if (typeof value !== 'object' || value === null) return false;
  const blob = value as Record<string, unknown>;
  if (typeof blob.version !== 'number') return false;
  const providers = blob.providers;
  if (typeof providers !== 'object' || providers === null) return false;
  return Object.values(providers as Record<string, unknown>).every(isSnapshot);
}

function isSnapshot(value: unknown): value is ProviderUsageSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snap = value as Record<string, unknown>;
  if (snap.provider !== 'claude' && snap.provider !== 'codex') return false;
  if (!Array.isArray(snap.windows)) return false;
  return snap.windows.every((w: unknown) => {
    if (typeof w !== 'object' || w === null) return false;
    const win = w as Record<string, unknown>;
    return typeof win.kind === 'string'
      && typeof win.observedAtMs === 'number'
      && (win.usedPercent === null || typeof win.usedPercent === 'number')
      && (win.resetsAtMs === null || typeof win.resetsAtMs === 'number');
  });
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let singleton: ProviderUsageStore | null = null;

export function initProviderUsageStore(
  preferences: ProviderUsagePreferences,
  logger?: ProviderUsageLogger,
): ProviderUsageStore {
  singleton = new ProviderUsageStore(preferences, logger);
  singleton.hydrate();
  return singleton;
}

/**
 * The store, or null before boot wiring. Ingest seams call this on hot vendor
 * paths and must tolerate null (unit tests, headless runs) without branching
 * into an error.
 */
export function tryGetProviderUsageStore(): ProviderUsageStore | null {
  return singleton;
}

export function _resetProviderUsageStoreForTesting(): void {
  singleton?.dispose();
  singleton = null;
}
