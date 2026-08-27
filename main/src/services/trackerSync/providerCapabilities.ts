/**
 * trackerSync/providerCapabilities — the per-provider facts the OUTBOUND
 * TRIGGERS need before any adapter exists.
 *
 * writeBack.ts runs inline on the entity-change broadcast and holds no adapter:
 * building one decrypts a stored key and it makes zero network calls by design
 * (see that module's header). But two of its decisions are capability
 * decisions, and getting them wrong is not a cosmetic problem:
 *
 *   - ARCHIVE. Enqueuing an `archive_issue` for a provider whose adapter would
 *     throw leaves an outbox row that can never settle, and
 *     `collectOutboxBlockers` is KIND-AGNOSTIC — an unresolved row for an
 *     issue halts the inbound batch at that issue on every pass, forever. The
 *     capability gate is what keeps that row from being written at all
 *     (docs/proposals/tracker-field-writeback.md invariant 5's reasoning,
 *     applied to a capability rather than a mode).
 *   - CATEGORY. Already answered by `categoryMapping.providerSupportsCategorySync`,
 *     which the trigger reuses rather than duplicating here.
 *
 * SINGLE DEFINITION, not a mirror: each adapter's own `CAPABILITIES.archive`
 * READS this table, so the trigger and the adapter can never disagree about a
 * provider, and a fourth provider fails to compile here (invariant 8) instead
 * of silently defaulting to "archivable".
 *
 * Only the archive half lives here. The `contentWrite` flags are per-FIELD and
 * consulted at drain time, where the adapter is in hand and the real
 * `capabilities` object is authoritative.
 */
import type { TrackerProvider } from '../../../../shared/types/trackerSync';
import type { TrackerAdapterCapabilities } from './adapterTypes';

/**
 * What each provider's `archiveIssue` actually does remotely. See
 * {@link TrackerAdapterCapabilities.archive} for what the three values mean and
 * each adapter's `CAPABILITIES` for the per-provider evidence (Linear's probe
 * L1, Dart's D5, and Plane's unprobed P1 that pins it to `'none'`).
 */
export const PROVIDER_ARCHIVE_CAPABILITY: Record<
  TrackerProvider,
  TrackerAdapterCapabilities['archive']
> = {
  linear: 'trash',
  plane: 'none',
  dart: 'trash',
  // beads exposes no archive/trash endpoint at all (`bd delete` is a HARD
  // delete, per docs/proposals/tracker-beads-provider.md's method-by-method
  // mapping) — same 'none' shape as Plane: the engine falls back to the
  // cancelled-state write, and the removal dialog's disclosure already
  // handles the copy.
  beads: 'none',
};

/**
 * Can a local archive/delete reach this provider as a remote trash/archive at
 * all? False (Plane today) means the archive trigger must enqueue NOTHING —
 * the ruling path falls back to the cancelled-state write instead, which is a
 * write its adapter genuinely supports.
 */
export function providerSupportsRemoteArchive(provider: TrackerProvider): boolean {
  return PROVIDER_ARCHIVE_CAPABILITY[provider] !== 'none';
}

/**
 * What a removal ruling's "cancel it in the tracker" ACTUALLY does for one
 * link: the provider's trash/archive, or the cancelled-state fallback. The
 * single decision both {@link import('./trackerSyncService').TrackerSyncService}'s
 * enqueue and the removal dialog's disclosure consult — the dialog promising
 * one action while the enqueue performs the other was adversarial round 3's
 * finding 2. `'off'` forces the fallback because an `archive_issue` row is
 * undrainable while the archive direction is off (the claim filter excludes
 * its kind), and invariant 5 says "Sync now" must never drain a direction the
 * user declined.
 */
export function removalWriteBackAction(
  provider: TrackerProvider,
  archiveSyncMode: 'auto' | 'manual' | 'off',
): 'archive' | 'cancel' {
  return archiveSyncMode !== 'off' && providerSupportsRemoteArchive(provider)
    ? 'archive'
    : 'cancel';
}

/**
 * Does this provider's adapter guard an existing-issue write with a
 * detect-after-write concurrency check (migration 123's `guardedUpdates`
 * capability on {@link TrackerAdapterCapabilities})? True only for beads: its
 * embedded single-writer database has no CAS/if-match primitive, so every
 * outbound state/content mutation of an EXISTING issue must be sandwiched
 * with a pre-send token capture and a post-write history diff (see
 * `TrackerRevisionMismatchError` in errors.ts). The three HTTP providers
 * write unguarded, as before.
 *
 * A SEPARATE table from `PROVIDER_ARCHIVE_CAPABILITY` rather than folded into
 * the adapter's own capabilities object: this is consulted at the ENQUEUE
 * chokepoint (docs/proposals/tracker-beads-provider.md, "The disable must be
 * expressible" — the gate-at-enqueue pattern the `'off'` content/archive
 * modes already use), where no adapter is in hand, exactly like
 * `PROVIDER_ARCHIVE_CAPABILITY` above.
 */
export const PROVIDER_REQUIRES_GUARDED_UPDATES: Record<TrackerProvider, boolean> = {
  linear: false,
  plane: false,
  dart: false,
  beads: true,
};

/**
 * "Does this provider need a stored credential at all?" — the NULL-secret
 * predicate every guard consults (`connect`, `buildAdapter`,
 * `credentialsForConnection`, reconnect). Re-exported rather than declared
 * here: the tRPC router enforces the same rule on the wire and may not import
 * main/src/services/*, so the one definition lives in shared/ (see its own
 * comment for why a second copy would be a correctness bug rather than a
 * duplicate fact).
 */
export {
  PROVIDER_NEEDS_SECRET,
  providerNeedsSecret,
} from '../../../../shared/types/trackerSync';
