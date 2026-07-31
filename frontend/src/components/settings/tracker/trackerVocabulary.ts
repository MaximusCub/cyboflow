/**
 * Non-visual vocabulary for the Settings → Integrations tracker surface: the
 * per-provider copy + credential shape, the mapping-target list with its
 * state-group-seeded defaults, the sync-log marker palette, and the two shared
 * form-control class strings.
 *
 * Split from trackerShared.tsx (which holds the components) so neither file
 * mixes component and non-component exports.
 *
 * Wire shapes come from shared/types/trackerSync.ts; nothing here re-declares a
 * type that crosses the IPC boundary.
 */
import type {
  TrackerMappingTarget,
  TrackerProvider,
  TrackerState,
  TrackerStateGroup,
  TrackerStateMapping,
} from '../../../../../shared/types/trackerSync';

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One catalog row's copy plus the credential fields its wizard Step 0 asks for. */
export interface TrackerProviderMeta {
  provider: TrackerProvider;
  name: string;
  description: string;
  /** Short text plate rendered in the row/header tile (no brand raster assets). */
  mark: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  /** Plane scopes every REST path under a workspace slug; Linear does not. */
  needsWorkspaceSlug: boolean;
  /** Plane can be self-hosted, so its origin is user-supplied (pre-filled with the cloud default). */
  defaultBaseUrl: string | null;
  /** Documentation card on Step 0 — what cyboflow reads and writes. */
  scopes: { label: string; granted: boolean }[];
  scopeFootnote: string;
}

export const TRACKER_PROVIDERS: readonly TrackerProviderMeta[] = [
  {
    provider: 'linear',
    name: 'Linear',
    description:
      'Import a Linear team, project, view or cycle as cyboflow ideas and write status back.',
    mark: 'LN',
    apiKeyLabel: 'Personal API key',
    apiKeyHint: 'Linear → Settings → Security & access → Personal API keys.',
    needsWorkspaceSlug: false,
    defaultBaseUrl: null,
    scopes: [
      { label: 'read:issues', granted: true },
      { label: 'write:issues', granted: true },
    ],
    scopeFootnote: 'No access to comments, attachments, or billing.',
  },
  {
    provider: 'plane',
    name: 'Plane',
    description:
      'Import a Plane project, cycle or module — cloud or self-hosted — with two-way status sync.',
    mark: 'PL',
    apiKeyLabel: 'Personal access token',
    apiKeyHint: 'Plane → Workspace settings → API tokens.',
    needsWorkspaceSlug: true,
    defaultBaseUrl: 'https://api.plane.so',
    scopes: [
      { label: 'read:issues', granted: true },
      { label: 'write:issues', granted: true },
    ],
    scopeFootnote: 'No access to comments, attachments, or billing.',
  },
];

export function providerMeta(provider: TrackerProvider): TrackerProviderMeta {
  const meta = TRACKER_PROVIDERS.find((p) => p.provider === provider);
  // The union has exactly two members and both are in the table above; the
  // fallback exists so the return type is not needlessly optional.
  return meta ?? TRACKER_PROVIDERS[0];
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

/** The mapping dropdown's options — cyboflow's four writable stages plus opt-out. */
export const MAPPING_TARGETS: readonly { value: TrackerMappingTarget; label: string }[] = [
  { value: 'dont', label: "— Don't import" },
  { value: 'idea', label: 'Idea' },
  { value: 'ready', label: 'Ready for development' },
  { value: 'done', label: 'Done' },
  { value: 'wontdo', label: "Won't do" },
];

export function mappingTargetLabel(target: TrackerMappingTarget): string {
  return MAPPING_TARGETS.find((t) => t.value === target)?.label ?? target;
}

/**
 * Seed defaults keyed by the adapter's canonical state group (both providers
 * normalize onto it, so the wizard never branches on provider here).
 */
export const DEFAULT_TARGET_BY_GROUP: Record<TrackerStateGroup, TrackerMappingTarget> = {
  triage: 'dont',
  backlog: 'idea',
  unstarted: 'ready',
  started: 'ready',
  completed: 'done',
  cancelled: 'wontdo',
};

/**
 * Build the mapping table's initial value. `previous` carries a user's overrides
 * across a re-fetch of the same source, so re-entering Step 3 never silently
 * resets a hand-picked row back to its group default.
 */
export function seedStateMapping(
  states: TrackerState[],
  previous?: TrackerStateMapping,
): TrackerStateMapping {
  const seeded: TrackerStateMapping = {};
  for (const state of states) {
    seeded[state.id] = previous?.[state.id] ?? DEFAULT_TARGET_BY_GROUP[state.group];
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// Sync-log markers
// ---------------------------------------------------------------------------

/**
 * Colour for a `TrackerSyncLogEntry.marker`. The engine owns the glyphs; this
 * only decides the column's tone, so an unknown marker degrades to muted rather
 * than dropping the line.
 */
export function logMarkerClass(marker: string): string {
  switch (marker) {
    case '▸':
    case '✓':
      return 'text-status-success';
    case '✎':
      return 'text-status-warning';
    case '●':
      return 'text-interactive';
    default:
      return 'text-text-tertiary';
  }
}

// ---------------------------------------------------------------------------
// Form-control chrome
// ---------------------------------------------------------------------------

/** Square text input carrying the surface/border tokens the cards use. */
export const trackerInputClass =
  'w-full rounded-none border border-border-primary bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none';

/** Square native `<select>` — deliberately native so the option list works everywhere. */
export const trackerSelectClass =
  'rounded-none border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary focus:border-border-focus focus:outline-none';
