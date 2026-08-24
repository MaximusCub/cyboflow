/**
 * pluginGallery — folds the RAW installed-plugin records into ONE gallery card
 * per plugin id.
 *
 * `cyboflow.plugins.list` returns the catalogue verbatim: one `PluginEntry` per
 * install RECORD, and Claude Code writes a separate record per project path for
 * `project`/`local` scope. A git worktree is a distinct path, so a plugin the
 * user enables across cyboflow sessions accumulates one record per worktree —
 * observed in the wild at 31 records for a single id, rendered as 31 visually
 * identical cards (the card never showed `projectPath`). Claude Code never GCs
 * records whose project path is gone, so the raw list only ever grows.
 *
 * This is DISPLAY-ONLY aggregation. Deliberately NOT done in
 * `readInstalledPluginIds` (main): that feeds the spawn-time EXCLUSIVE
 * `enabledPlugins` map, whose correctness depends on seeing the FULL installed
 * universe — dropping records there would stop cyboflow emitting `{id:false}`
 * for a plugin and let an inherited-enabled plugin leak into a session.
 */
import type { PluginEntry } from '../../../../shared/types/integrations';

/** Scope precedence for the badge when a plugin is installed at several scopes. */
const SCOPE_RANK: Record<string, number> = { user: 0, project: 1, local: 2 };

function scopeRank(scope: string): number {
  return SCOPE_RANK[scope] ?? 3;
}

/** One plugin id, folded across its install records. */
export interface PluginGalleryEntry {
  /** Full id "<name>@<marketplace>" — the fold key. */
  id: string;
  name: string;
  marketplace: string;
  /** Distinct scopes across the records, highest-precedence first. */
  scopes: string[];
  /** Version of the most-recently-updated record (the one that "wins" on disk). */
  version: string;
  /** Distinct versions across the records. */
  versionCount: number;
  /** Total install records for this id. */
  installCount: number;
  /**
   * Records carrying a `projectPath` (i.e. `project`/`local` scope). >1 means the
   * per-directory fan-out is under way and a user-scope install would collapse it.
   */
  projectInstallCount: number;
  /** True when ANY record reads enabled at the user tier. */
  enabled: boolean;
  /** Newest `lastUpdated` across the records, or null when none carry one. */
  lastUpdated: string | null;
}

/**
 * Fold `entries` to one card per id, preserving first-seen id order so the
 * gallery stays stable across polls.
 */
export function foldPluginEntries(entries: readonly PluginEntry[]): PluginGalleryEntry[] {
  const byId = new Map<string, PluginGalleryEntry>();
  // Track the winning record's timestamp per id so `version` follows the newest
  // record rather than whichever the catalogue happened to list first.
  const versionsById = new Map<string, Set<string>>();
  const versionStampById = new Map<string, string | null>();

  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, {
        id: entry.id,
        name: entry.name,
        marketplace: entry.marketplace,
        scopes: [entry.scope],
        version: entry.version,
        versionCount: 1,
        installCount: 1,
        projectInstallCount: entry.projectPath ? 1 : 0,
        enabled: entry.enabled,
        lastUpdated: entry.lastUpdated,
      });
      versionsById.set(entry.id, new Set([entry.version]));
      versionStampById.set(entry.id, entry.lastUpdated);
      continue;
    }

    existing.installCount += 1;
    if (entry.projectPath) existing.projectInstallCount += 1;
    if (entry.enabled) existing.enabled = true;
    if (!existing.scopes.includes(entry.scope)) existing.scopes.push(entry.scope);
    if (entry.lastUpdated && (!existing.lastUpdated || entry.lastUpdated > existing.lastUpdated)) {
      existing.lastUpdated = entry.lastUpdated;
    }

    const versions = versionsById.get(entry.id);
    versions?.add(entry.version);
    existing.versionCount = versions?.size ?? existing.versionCount;

    // A record with no timestamp never displaces one that has a timestamp.
    const stamp = versionStampById.get(entry.id) ?? null;
    if (entry.lastUpdated && (!stamp || entry.lastUpdated > stamp)) {
      existing.version = entry.version;
      versionStampById.set(entry.id, entry.lastUpdated);
    }
  }

  for (const folded of byId.values()) {
    folded.scopes.sort((a, b) => scopeRank(a) - scopeRank(b) || a.localeCompare(b));
  }
  return Array.from(byId.values());
}
