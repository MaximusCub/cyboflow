/**
 * foldPluginEntries — one gallery card per plugin id.
 *
 * Guards the real-world shape that motivated the fold: a single plugin id with
 * 31 install records (one per cyboflow worktree at local scope, plus a
 * project-scope record on another repo) rendered 31 identical cards.
 */
import { describe, it, expect } from 'vitest';
import type { PluginEntry } from '../../../../../shared/types/integrations';
import { foldPluginEntries } from '../pluginGallery';

function entry(over: Partial<PluginEntry> = {}): PluginEntry {
  return {
    id: 'soloflow-dev@soloflow',
    name: 'soloflow-dev',
    marketplace: 'soloflow',
    scope: 'local',
    version: '0.11.0',
    enabled: false,
    lastUpdated: '2026-08-01T00:00:00.000Z',
    projectPath: '/repo/worktrees/a',
    ...over,
  };
}

describe('foldPluginEntries', () => {
  it('returns one entry per id and counts the install records', () => {
    const folded = foldPluginEntries([
      entry({ projectPath: '/repo/worktrees/a' }),
      entry({ projectPath: '/repo/worktrees/b' }),
      entry({ projectPath: '/repo/worktrees/c' }),
      entry({ id: 'codex@openai-codex', name: 'codex', marketplace: 'openai-codex', scope: 'user', projectPath: null }),
    ]);
    expect(folded).toHaveLength(2);
    expect(folded[0].installCount).toBe(3);
    expect(folded[0].projectInstallCount).toBe(3);
    expect(folded[1].installCount).toBe(1);
    expect(folded[1].projectInstallCount).toBe(0);
  });

  it('preserves first-seen id order', () => {
    const folded = foldPluginEntries([
      entry({ id: 'b@m', name: 'b' }),
      entry({ id: 'a@m', name: 'a' }),
      entry({ id: 'b@m', name: 'b', projectPath: '/other' }),
    ]);
    expect(folded.map((f) => f.id)).toEqual(['b@m', 'a@m']);
  });

  it('collects distinct scopes, highest-precedence first', () => {
    const folded = foldPluginEntries([
      entry({ scope: 'local' }),
      entry({ scope: 'project', projectPath: '/other' }),
      entry({ scope: 'local', projectPath: '/another' }),
    ]);
    expect(folded[0].scopes).toEqual(['project', 'local']);
  });

  it('takes the version of the most-recently-updated record', () => {
    const folded = foldPluginEntries([
      entry({ version: '0.9.12', lastUpdated: '2026-05-01T00:00:00.000Z' }),
      entry({ version: '0.11.0', lastUpdated: '2026-08-07T00:00:00.000Z', projectPath: '/b' }),
      entry({ version: '0.10.0', lastUpdated: '2026-06-01T00:00:00.000Z', projectPath: '/c' }),
    ]);
    expect(folded[0].version).toBe('0.11.0');
    expect(folded[0].versionCount).toBe(3);
    expect(folded[0].lastUpdated).toBe('2026-08-07T00:00:00.000Z');
  });

  it('never lets a timestamp-less record displace a timestamped one', () => {
    const folded = foldPluginEntries([
      entry({ version: '0.11.0', lastUpdated: '2026-08-07T00:00:00.000Z' }),
      entry({ version: 'unknown', lastUpdated: null, projectPath: '/b' }),
    ]);
    expect(folded[0].version).toBe('0.11.0');
    expect(folded[0].lastUpdated).toBe('2026-08-07T00:00:00.000Z');
  });

  it('falls back to the first record when no record carries a timestamp', () => {
    const folded = foldPluginEntries([
      entry({ version: 'unknown', lastUpdated: null }),
      entry({ version: 'also-unknown', lastUpdated: null, projectPath: '/b' }),
    ]);
    expect(folded[0].version).toBe('unknown');
    expect(folded[0].lastUpdated).toBeNull();
  });

  it('reads enabled when ANY record is enabled at the user tier', () => {
    const folded = foldPluginEntries([
      entry({ enabled: false }),
      entry({ enabled: true, projectPath: '/b' }),
    ]);
    expect(folded[0].enabled).toBe(true);
  });

  it('returns [] for an empty catalogue', () => {
    expect(foldPluginEntries([])).toEqual([]);
  });
});
