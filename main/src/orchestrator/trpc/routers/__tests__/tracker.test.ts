/**
 * Unit tests for the tRPC tracker sub-router
 * (main/src/orchestrator/trpc/routers/tracker.ts).
 *
 * The router is a thin wrapper over the injected TrackerSyncFacade, so what is
 * worth testing here is exactly the part that is NOT in the service: input
 * validation, and the mapping of the engine's typed failures onto TRPCError
 * codes the renderer branches on. That mapping is by ERROR NAME rather than by
 * `instanceof`, because router files may not import main/src/services/* — which
 * is precisely the kind of coupling a test should pin down.
 *
 * Wiring mirrors health.test.ts: `vi.resetModules()` + dynamic import per case,
 * so the bridge's module-level facade singleton cannot leak between tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TRPCError } from '@trpc/server';
import type {
  TrackerConflictChoice,
  TrackerConflictSummary,
  TrackerConnectPayload,
  TrackerConnectionSummary,
  TrackerCredentialsInput,
  TrackerEntityLinkRef,
  TrackerEntityType,
  TrackerIssue,
  TrackerReconcileItem,
  TrackerSettingsPatch,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerSyncPassSummary,
  TrackerWorkspaceIdentity,
} from '../../../../../../shared/types/trackerSync';
import type { TrackerSyncFacade } from '../../../trackerSyncBridge';

beforeEach(() => {
  vi.resetModules();
});

const IDENTITY: TrackerWorkspaceIdentity = {
  workspaceId: 'ws-1',
  workspaceName: 'Acme',
  actorLabel: 'K. Esteva',
};

/**
 * A facade whose every method fails loudly, so a test that provokes an
 * unintended call sees it. Cases override only what they exercise.
 */
class UnusedFacade implements TrackerSyncFacade {
  wizardValidate(_c: TrackerCredentialsInput): Promise<TrackerWorkspaceIdentity> {
    throw new Error('not used');
  }
  wizardContainers(_c: TrackerCredentialsInput): Promise<TrackerSourceTree> {
    throw new Error('not used');
  }
  wizardNarrows(_c: TrackerCredentialsInput, _id: string): Promise<TrackerSourceNarrow[]> {
    throw new Error('not used');
  }
  wizardStates(
    _c: TrackerCredentialsInput,
    _s: TrackerSourceSelection,
  ): Promise<TrackerState[]> {
    throw new Error('not used');
  }
  wizardIssues(
    _c: TrackerCredentialsInput,
    _s: TrackerSourceSelection,
  ): Promise<TrackerIssue[]> {
    throw new Error('not used');
  }
  reconcilePreview(_p: number, _i: TrackerIssue[]): Promise<TrackerReconcileItem[]> {
    throw new Error('not used');
  }
  connect(_p: TrackerConnectPayload): Promise<{ connectionId: string }> {
    throw new Error('not used');
  }
  updateCredentials(_id: string, _key: string): Promise<TrackerWorkspaceIdentity> {
    throw new Error('not used');
  }
  connections(_p: number): Promise<TrackerConnectionSummary[]> {
    throw new Error('not used');
  }
  updateSettings(_id: string, _patch: TrackerSettingsPatch): Promise<void> {
    throw new Error('not used');
  }
  disconnect(_id: string): Promise<void> {
    throw new Error('not used');
  }
  syncNow(_id: string): Promise<TrackerSyncPassSummary> {
    throw new Error('not used');
  }
  conflicts(_id: string): Promise<TrackerConflictSummary[]> {
    throw new Error('not used');
  }
  resolveConflictChoice(_id: number, _c: TrackerConflictChoice): Promise<void> {
    throw new Error('not used');
  }
  linkForEntity(_t: TrackerEntityType, _id: string): Promise<TrackerEntityLinkRef | null> {
    throw new Error('not used');
  }
  hasLinkedDescendants(_t: TrackerEntityType, _id: string): Promise<boolean> {
    throw new Error('not used');
  }
  stageUnlinkRuling(
    _t: TrackerEntityType,
    _id: string,
    _o: { cancelRemote: boolean },
  ): Promise<void> {
    throw new Error('not used');
  }
  clearUnlinkRuling(_t: TrackerEntityType, _id: string): Promise<void> {
    throw new Error('not used');
  }
  unlinkEntity(
    _t: TrackerEntityType,
    _id: string,
    _o: { cancelRemote: boolean },
  ): Promise<{ unlinked: boolean }> {
    throw new Error('not used');
  }
}

/** Install `facade` and hand back a caller for the tracker sub-router. */
async function callerWith(
  facade: TrackerSyncFacade,
): Promise<ReturnType<typeof buildCaller>> {
  const { setTrackerSyncFacade } = await import('../../../trackerSyncBridge');
  setTrackerSyncFacade(facade);
  return buildCaller();
}

async function buildCaller(): Promise<
  ReturnType<
    Awaited<typeof import('../../router')>['appRouter']['createCaller']
  >['cyboflow']['tracker']
> {
  const { appRouter } = await import('../../router');
  const { createContext } = await import('../../context');
  return appRouter.createCaller(createContext()).cyboflow.tracker;
}

/** The TRPCError code a rejected call carried. */
async function codeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (err) {
    return (err as TRPCError).code;
  }
  throw new Error('expected the call to reject');
}

describe('cyboflow.tracker.updateCredentials', () => {
  it('passes the rotation through and returns the validated identity', async () => {
    const seen: Array<{ connectionId: string; apiKey: string }> = [];
    const facade = new UnusedFacade();
    facade.updateCredentials = async (connectionId, apiKey) => {
      seen.push({ connectionId, apiKey });
      return IDENTITY;
    };
    const caller = await callerWith(facade);

    const result = await caller.updateCredentials({
      connectionId: 'trk_1',
      apiKey: 'lin_rotated',
    });

    expect(result).toEqual(IDENTITY);
    expect(seen).toEqual([{ connectionId: 'trk_1', apiKey: 'lin_rotated' }]);
  });

  it('rejects an empty connection id or key before reaching the facade', async () => {
    const facade = new UnusedFacade();
    const caller = await callerWith(facade);

    await expect(
      caller.updateCredentials({ connectionId: '', apiKey: 'k' }),
    ).rejects.toThrow();
    await expect(
      caller.updateCredentials({ connectionId: 'trk_1', apiKey: '' }),
    ).rejects.toThrow();
  });

  it('maps an unknown connection to NOT_FOUND and a wrong-workspace key to CONFLICT', async () => {
    // Both classes live under main/src/services/trackerSync/, which this router
    // may not import — hence the by-NAME recognition these two cases pin down.
    const notFound = new Error('tracker connection trk_x does not exist');
    notFound.name = 'TrackerConnectionNotFoundError';
    const mismatch = new Error('this API key authorizes a different workspace (ws-2)');
    mismatch.name = 'TrackerIdentityMismatchError';

    const facade = new UnusedFacade();
    let next: Error = notFound;
    facade.updateCredentials = async () => {
      throw next;
    };
    const caller = await callerWith(facade);

    expect(await codeOf(caller.updateCredentials({ connectionId: 'trk_x', apiKey: 'k' }))).toBe(
      'NOT_FOUND',
    );

    next = mismatch;
    const conflict = caller.updateCredentials({ connectionId: 'trk_1', apiKey: 'k' });
    expect(await codeOf(conflict)).toBe('CONFLICT');
    // Passed through verbatim, unlike the deliberately generic auth message:
    // naming the two workspaces IS the actionable content here.
    await expect(
      caller.updateCredentials({ connectionId: 'trk_1', apiKey: 'k' }),
    ).rejects.toThrow(/different workspace/);
  });

  it('maps a rejected key to UNAUTHORIZED, like every other tracker call', async () => {
    const authError = new Error('invalid api key');
    authError.name = 'TrackerAuthError';
    const facade = new UnusedFacade();
    facade.updateCredentials = async () => {
      throw authError;
    };
    const caller = await callerWith(facade);

    expect(await codeOf(caller.updateCredentials({ connectionId: 'trk_1', apiKey: 'k' }))).toBe(
      'UNAUTHORIZED',
    );
  });
});
