/**
 * layoutStore tests — the two rail-collapse flags and their localStorage
 * round-trip.
 *
 * The seeding path (module init reads localStorage) is exercised by re-importing
 * the module with `vi.resetModules()` after seeding storage, since the initial
 * value is captured once when `create()` runs.
 *
 * Environment: jsdom (localStorage).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  LEFT_RAIL_COLLAPSED_KEY,
  RIGHT_RAIL_COLLAPSED_KEY,
  useLayoutStore,
} from '../layoutStore';

/** Re-import layoutStore so its module-init seeding re-reads localStorage. */
async function freshStore(): Promise<typeof useLayoutStore> {
  vi.resetModules();
  const mod = await import('../layoutStore');
  return mod.useLayoutStore;
}

beforeEach(() => {
  localStorage.clear();
  useLayoutStore.setState({ leftRailCollapsed: false, rightRailCollapsed: false });
});

describe('layoutStore — keys', () => {
  it('reuses the pre-existing right-rail key so installs keep their state', () => {
    // Load-bearing: CyboflowRoot wrote this exact key before the state was
    // lifted. Changing it would silently reset every user's right rail.
    expect(RIGHT_RAIL_COLLAPSED_KEY).toBe('cyboflow.runRightRail.collapsed');
  });

  it('uses a brand-new key for the left rail (no migration needed)', () => {
    expect(LEFT_RAIL_COLLAPSED_KEY).toBe('cyboflow-sidebar-collapsed');
  });
});

describe('layoutStore — toggles persist', () => {
  it('toggleLeftRail flips the flag and writes "true"/"false"', () => {
    useLayoutStore.getState().toggleLeftRail();
    expect(useLayoutStore.getState().leftRailCollapsed).toBe(true);
    expect(localStorage.getItem(LEFT_RAIL_COLLAPSED_KEY)).toBe('true');

    useLayoutStore.getState().toggleLeftRail();
    expect(useLayoutStore.getState().leftRailCollapsed).toBe(false);
    expect(localStorage.getItem(LEFT_RAIL_COLLAPSED_KEY)).toBe('false');
  });

  it('toggleRightRail flips the flag and writes "true"/"false"', () => {
    useLayoutStore.getState().toggleRightRail();
    expect(useLayoutStore.getState().rightRailCollapsed).toBe(true);
    expect(localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY)).toBe('true');

    useLayoutStore.getState().toggleRightRail();
    expect(useLayoutStore.getState().rightRailCollapsed).toBe(false);
    expect(localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY)).toBe('false');
  });

  it('the two rails are independent', () => {
    useLayoutStore.getState().toggleLeftRail();
    expect(useLayoutStore.getState().rightRailCollapsed).toBe(false);
    expect(localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY)).toBeNull();
  });

  it('setters persist the explicit value', () => {
    useLayoutStore.getState().setRightRailCollapsed(true);
    expect(useLayoutStore.getState().rightRailCollapsed).toBe(true);
    expect(localStorage.getItem(RIGHT_RAIL_COLLAPSED_KEY)).toBe('true');

    useLayoutStore.getState().setLeftRailCollapsed(true);
    expect(localStorage.getItem(LEFT_RAIL_COLLAPSED_KEY)).toBe('true');
  });
});

describe('layoutStore — seeding from localStorage', () => {
  it('defaults both rails expanded when nothing is stored', async () => {
    const store = await freshStore();
    expect(store.getState().leftRailCollapsed).toBe(false);
    expect(store.getState().rightRailCollapsed).toBe(false);
  });

  it('seeds collapsed from a stored "true"', async () => {
    localStorage.setItem(LEFT_RAIL_COLLAPSED_KEY, 'true');
    localStorage.setItem(RIGHT_RAIL_COLLAPSED_KEY, 'true');
    const store = await freshStore();
    expect(store.getState().leftRailCollapsed).toBe(true);
    expect(store.getState().rightRailCollapsed).toBe(true);
  });

  it('treats any non-"true" stored value as expanded', async () => {
    localStorage.setItem(LEFT_RAIL_COLLAPSED_KEY, 'yes');
    localStorage.setItem(RIGHT_RAIL_COLLAPSED_KEY, '1');
    const store = await freshStore();
    expect(store.getState().leftRailCollapsed).toBe(false);
    expect(store.getState().rightRailCollapsed).toBe(false);
  });

  it('round-trips: a toggle survives a module reload', async () => {
    useLayoutStore.getState().toggleRightRail();
    const store = await freshStore();
    expect(store.getState().rightRailCollapsed).toBe(true);
  });
});
