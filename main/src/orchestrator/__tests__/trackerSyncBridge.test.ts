/**
 * Unit tests for main/src/orchestrator/trackerSyncBridge.ts — the injection
 * seam the cyboflow.tracker tRPC router reaches the sync service through.
 *
 * Nothing here touches sqlite or the network: the bridge is a module-level
 * singleton plus an EventEmitter, and these are exactly the two behaviours the
 * router depends on (a typed not-initialized failure, and a project-scoped
 * channel both sides derive identically).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getTrackerSyncFacade,
  setTrackerSyncFacade,
  trackerProjectChannel,
  trackerSyncEvents,
  TrackerSyncNotInitializedError,
  _resetTrackerSyncFacadeForTesting,
  type TrackerChangedEvent,
  type TrackerSyncFacade,
} from '../trackerSyncBridge';

/**
 * Minimal stand-in. Only the two methods the assertions call are real; the rest
 * are never invoked, so the cast keeps the fixture to the surface under test
 * instead of restating all fourteen facade methods.
 */
function fakeFacade(tag: string): TrackerSyncFacade {
  return {
    connections: async () => [],
    disconnect: async () => {
      throw new Error(tag);
    },
  } as unknown as TrackerSyncFacade;
}

beforeEach(() => {
  _resetTrackerSyncFacadeForTesting();
});

afterEach(() => {
  _resetTrackerSyncFacadeForTesting();
});

describe('trackerSyncBridge facade injection', () => {
  it('throws a typed error until boot injects a facade', () => {
    expect(() => getTrackerSyncFacade()).toThrow(TrackerSyncNotInitializedError);
    expect(() => getTrackerSyncFacade()).toThrow(/setTrackerSyncFacade/);
  });

  it('returns the injected facade, and a later injection replaces it', async () => {
    const first = fakeFacade('first');
    setTrackerSyncFacade(first);
    expect(getTrackerSyncFacade()).toBe(first);

    const second = fakeFacade('second');
    setTrackerSyncFacade(second);
    expect(getTrackerSyncFacade()).toBe(second);
    await expect(getTrackerSyncFacade().disconnect('c-1')).rejects.toThrow('second');
  });
});

describe('trackerSyncBridge change broadcast', () => {
  it('derives a per-project channel and delivers only that project events', () => {
    expect(trackerProjectChannel(7)).toBe('tracker-project-7');
    expect(trackerProjectChannel(7)).not.toBe(trackerProjectChannel(8));

    const seen: TrackerChangedEvent[] = [];
    const listener = (event: TrackerChangedEvent): void => {
      seen.push(event);
    };
    trackerSyncEvents.on(trackerProjectChannel(7), listener);
    try {
      const mine: TrackerChangedEvent = { projectId: 7, connectionId: 'c-1', kind: 'sync' };
      trackerSyncEvents.emit(trackerProjectChannel(7), mine);
      trackerSyncEvents.emit(trackerProjectChannel(8), {
        projectId: 8,
        connectionId: 'c-2',
        kind: 'conflicts',
      });
      expect(seen).toEqual([mine]);
    } finally {
      trackerSyncEvents.off(trackerProjectChannel(7), listener);
    }
  });
});
