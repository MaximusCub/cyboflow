/**
 * Cross-adapter capability exhaustiveness (docs/proposals/tracker-field-writeback.md
 * Phase 4, invariant 8: "Exhaustiveness over grep").
 *
 * `TrackerAdapterCapabilities` is the seam Phase 5 gates every content/archive
 * write on, so a provider whose `contentWrite`/`archive` values silently drift
 * from what its adapter actually implements would fail SILENTLY — not as a
 * compile error, since every adapter constructs its own object literal
 * independently. This file is the one place that puts all three side by side
 * against a `Record<TrackerProvider, ...>`, so TypeScript itself refuses to
 * compile if a provider is ever added here without a capabilities row (or
 * dropped from `TrackerProvider` without one being removed), and the
 * assertions below pin each provider's values against what its adapter's own
 * write methods actually do.
 */
import { describe, it, expect } from 'vitest';
import type { TrackerProvider } from '../../../../../shared/types/trackerSync';
import type { TrackerAdapter } from '../adapterTypes';
import { BeadsAdapter } from '../beadsAdapter';
import { DartAdapter } from '../dartAdapter';
import { LinearAdapter } from '../linearAdapter';
import { PlaneAdapter } from '../planeAdapter';

const noopFetch = (async () => {
  throw new Error('adapterCapabilities.test.ts never makes a network call');
}) as unknown as typeof fetch;

const noopExec = async () => {
  throw new Error('adapterCapabilities.test.ts never spawns a process');
};

/**
 * One instance per provider, keyed by `TrackerProvider` — the `Record` type
 * itself is the exhaustiveness guard: a provider added to the union without a
 * row here is a COMPILE ERROR, not a silently-passing test.
 */
const ADAPTERS: Record<TrackerProvider, TrackerAdapter> = {
  dart: new DartAdapter({ apiKey: 'k', fetchImpl: noopFetch }),
  linear: new LinearAdapter({ apiKey: 'k', fetchImpl: noopFetch }),
  plane: new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl: noopFetch }),
  beads: new BeadsAdapter({ workspacePath: '/tmp/proj', execImpl: noopExec }),
};

describe('TrackerAdapterCapabilities — per-provider exhaustiveness', () => {
  it('every provider declares a contentWrite/archive shape', () => {
    for (const provider of Object.keys(ADAPTERS) as TrackerProvider[]) {
      const { capabilities } = ADAPTERS[provider];
      expect(capabilities.contentWrite).toEqual(
        expect.objectContaining({
          title: expect.any(Boolean),
          description: expect.any(Boolean),
          priority: expect.any(Boolean),
          category: expect.any(Boolean),
        }),
      );
      expect(['trash', 'archive', 'none']).toContain(capabilities.archive);
    }
  });

  it('Dart: everything is writable, and archive is a trash (not a hard delete)', () => {
    expect(ADAPTERS.dart.capabilities.contentWrite).toEqual({
      title: true,
      description: true,
      priority: true,
      category: true,
    });
    expect(ADAPTERS.dart.capabilities.archive).toBe('trash');
  });

  it('Linear: no category (no type field), archive is a trash', () => {
    expect(ADAPTERS.linear.capabilities.contentWrite).toEqual({
      title: true,
      description: true,
      priority: true,
      category: false,
    });
    expect(ADAPTERS.linear.capabilities.archive).toBe('trash');
  });

  it('Plane: no category (no type field), archive is unsupported (\'none\') pending a proven endpoint', () => {
    expect(ADAPTERS.plane.capabilities.contentWrite).toEqual({
      title: true,
      description: true,
      priority: true,
      category: false,
    });
    expect(ADAPTERS.plane.capabilities.archive).toBe('none');
  });

  it('beads: everything content-writable, no archive endpoint, id reconciliation + guarded updates required', () => {
    expect(ADAPTERS.beads.capabilities.contentWrite).toEqual({
      title: true,
      description: true,
      priority: true,
      category: true,
    });
    expect(ADAPTERS.beads.capabilities.archive).toBe('none');
    expect(ADAPTERS.beads.capabilities.requiresIdReconciliation).toBe(true);
    expect(ADAPTERS.beads.capabilities.guardedUpdates).toBe(true);
  });

  it('only beads requires id reconciliation or guarded updates', () => {
    for (const provider of Object.keys(ADAPTERS) as TrackerProvider[]) {
      const expected = provider === 'beads';
      expect(ADAPTERS[provider].capabilities.requiresIdReconciliation).toBe(expected);
      expect(ADAPTERS[provider].capabilities.guardedUpdates).toBe(expected);
    }
  });

  it('never declares "delete" — the locked scope decision has no hard-delete archive mode', () => {
    for (const provider of Object.keys(ADAPTERS) as TrackerProvider[]) {
      expect(ADAPTERS[provider].capabilities.archive).not.toBe('delete');
    }
  });

  it("Plane's archive is unreachable, matching archiveIssue's own throw", async () => {
    await expect(ADAPTERS.plane.archiveIssue('proj1/iss1')).rejects.toThrow(/unsupported/i);
  });

  it("beads' archive is also unreachable ('none' — `bd delete` is a hard delete)", async () => {
    expect(ADAPTERS.beads.capabilities.archive).toBe('none');
    await expect(ADAPTERS.beads.archiveIssue('bd-1')).rejects.toThrow(/unsupported/i);
  });
});
