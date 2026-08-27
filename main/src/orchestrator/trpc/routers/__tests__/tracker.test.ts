/**
 * Unit tests for the tRPC tracker sub-router
 * (main/src/orchestrator/trpc/routers/tracker.ts).
 *
 * The router is a thin wrapper over the injected TrackerSyncFacade, so what is
 * worth testing here is exactly the part that is NOT in the service: input
 * validation, and the mapping of the engine's typed failures onto TRPCError
 * codes the renderer branches on. That mapping is by ERROR NAME rather than by
 * `instanceof`, because router files may not import main/src/services/* — which
 * is precisely the kind of coupling a test should pin down. The keyless
 * workspace-recovery trio (probeRecovery / remapRenamedPrefix /
 * adoptNewWorkspace) adds two more of those names — the keyed-provider refusal
 * and the stale-classification refusal — and both are load-bearing for what the
 * banner does next.
 *
 * Wiring mirrors health.test.ts: `vi.resetModules()` + dynamic import per case,
 * so the bridge's module-level facade singleton cannot leak between tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TRPCError } from '@trpc/server';
import type {
  TrackerAdoptionResult,
  TrackerConflictChoice,
  TrackerConflictSummary,
  TrackerConnectPayload,
  TrackerConnectionSummary,
  TrackerCredentialsInput,
  TrackerEntityLinkRef,
  TrackerEntityType,
  TrackerFieldOptions,
  TrackerIssue,
  TrackerReconcileItem,
  TrackerRecoveryProbe,
  TrackerRemapResult,
  TrackerSettingsPatch,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerState,
  TrackerSyncPassSummary,
  TrackerWizardSourceInput,
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
  wizardGroups(_s: TrackerWizardSourceInput): Promise<TrackerGroupTree> {
    throw new Error('not used');
  }
  wizardContainers(_c: TrackerCredentialsInput): Promise<TrackerSourceTree> {
    throw new Error('not used');
  }
  wizardNarrows(_c: TrackerCredentialsInput, _id: string): Promise<TrackerSourceNarrow[]> {
    throw new Error('not used');
  }
  wizardStates(
    _src: TrackerWizardSourceInput,
    _s: TrackerSourceSelection,
  ): Promise<TrackerState[]> {
    throw new Error('not used');
  }
  wizardFieldOptions(_src: TrackerWizardSourceInput): Promise<TrackerFieldOptions> {
    throw new Error('not used');
  }
  wizardIssues(
    _src: TrackerWizardSourceInput,
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
  probeRecovery(_id: string): Promise<TrackerRecoveryProbe> {
    throw new Error('not used');
  }
  remapRenamedPrefix(_id: string): Promise<TrackerRemapResult> {
    throw new Error('not used');
  }
  adoptNewWorkspace(_id: string): Promise<TrackerAdoptionResult> {
    throw new Error('not used');
  }
  connections(_p: number): Promise<TrackerConnectionSummary[]> {
    throw new Error('not used');
  }
  mappings(_id: string): Promise<TrackerConnectionSummary[]> {
    throw new Error('not used');
  }
  setPushTarget(_id: string): Promise<void> {
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
  linksForEntity(_t: TrackerEntityType, _id: string): Promise<TrackerEntityLinkRef[]> {
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

describe('cyboflow.tracker.wizardFieldOptions', () => {
  const OPTIONS: TrackerFieldOptions = {
    priorities: ['critical', 'high'],
    categories: ['Bug'],
    defaultPriorityMapping: {
      toProvider: { P0: 'critical', P1: 'high', P2: null, P3: null, P4: null, P5: null, P6: null },
      toLocal: { critical: 'P0', high: 'P1' },
    },
    defaultCategoryMapping: {
      toProvider: { feature: null, bug: 'Bug', chore: null },
      toLocal: { bug: 'bug' },
    },
  };

  it('passes a pasted-key probe through and returns the provider vocabularies', async () => {
    const seen: TrackerWizardSourceInput[] = [];
    const facade = new UnusedFacade();
    facade.wizardFieldOptions = async (source) => {
      seen.push(source);
      return OPTIONS;
    };
    const caller = await callerWith(facade);

    const result = await caller.wizardFieldOptions({
      credentials: { provider: 'dart', apiKey: 'dsa_1' },
    });

    expect(result).toEqual(OPTIONS);
    expect(seen).toEqual([{ credentials: { provider: 'dart', apiKey: 'dsa_1' }, connectionId: undefined }]);
  });

  it('accepts the mapping-management path, where the key stays main-side', async () => {
    const seen: TrackerWizardSourceInput[] = [];
    const facade = new UnusedFacade();
    facade.wizardFieldOptions = async (source) => {
      seen.push(source);
      return OPTIONS;
    };
    const caller = await callerWith(facade);

    await caller.wizardFieldOptions({ connectionId: 'trk_1' });

    expect(seen).toEqual([{ credentials: undefined, connectionId: 'trk_1' }]);
  });

  it('refuses both credential sources at once, and neither, before the facade', async () => {
    // The two keys answer the same question, so a payload carrying both is a
    // caller bug and one carrying neither can probe nothing.
    const facade = new UnusedFacade();
    const caller = await callerWith(facade);

    await expect(
      caller.wizardFieldOptions({
        credentials: { provider: 'dart', apiKey: 'dsa_1' },
        connectionId: 'trk_1',
      }),
    ).rejects.toThrow();
    await expect(caller.wizardFieldOptions({})).rejects.toThrow();
  });

  it('maps a rejected key to UNAUTHORIZED, like every other tracker probe', async () => {
    const authError = new Error('invalid api key');
    authError.name = 'TrackerAuthError';
    const facade = new UnusedFacade();
    facade.wizardFieldOptions = async () => {
      throw authError;
    };
    const caller = await callerWith(facade);

    expect(
      await codeOf(caller.wizardFieldOptions({ credentials: { provider: 'dart', apiKey: 'x' } })),
    ).toBe('UNAUTHORIZED');
  });
});

/** A minimal `connect` input the router's zod schema accepts as-is. */
const BASE_CONNECT_INPUT = {
  projectId: 1,
  credentials: { provider: 'dart' as const, apiKey: 'dsa_1' },
  source: { containerId: 'space-1', narrowId: 'all', narrowKind: 'all' as const },
  sourceLabel: 'Personal',
  selectionMode: 'all' as const,
  selectionJson: null,
  stateMapping: {},
  statusSyncMode: 'auto' as const,
  pullMode: 'auto' as const,
  pushMode: 'auto' as const,
  mirrorSubissues: true,
  conflictMode: 'auto' as const,
  reconcile: [],
};

describe('cyboflow.tracker.connect — priority/category mapping overlay', () => {
  it('accepts a priorityMapping/categoryMapping overlay and passes it through verbatim', async () => {
    const seen: TrackerConnectPayload[] = [];
    const facade = new UnusedFacade();
    facade.connect = async (payload) => {
      seen.push(payload);
      return { connectionId: 'trk_1' };
    };
    const caller = await callerWith(facade);

    await caller.connect({
      ...BASE_CONNECT_INPUT,
      priorityMapping: { toProvider: { P0: 'critical', P6: null } },
      categoryMapping: { toProvider: { bug: 'Bug' } },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].priorityMapping).toEqual({ toProvider: { P0: 'critical', P6: null } });
    expect(seen[0].categoryMapping).toEqual({ toProvider: { bug: 'Bug' } });
  });

  it('connects fine with neither overlay — every pre-Phase-6 caller', async () => {
    const seen: TrackerConnectPayload[] = [];
    const facade = new UnusedFacade();
    facade.connect = async (payload) => {
      seen.push(payload);
      return { connectionId: 'trk_1' };
    };
    const caller = await callerWith(facade);

    await caller.connect(BASE_CONNECT_INPUT);

    expect(seen[0].priorityMapping).toBeUndefined();
    expect(seen[0].categoryMapping).toBeUndefined();
  });

  it('rejects an unknown priority level or category key in the overlay', async () => {
    const facade = new UnusedFacade();
    const caller = await callerWith(facade);

    await expect(
      caller.connect({
        ...BASE_CONNECT_INPUT,
        priorityMapping: { toProvider: { P9: 'critical' } },
      } as never),
    ).rejects.toThrow();

    await expect(
      caller.connect({
        ...BASE_CONNECT_INPUT,
        categoryMapping: { toProvider: { epic: 'Epic' } },
      } as never),
    ).rejects.toThrow();
  });
});

describe('cyboflow.tracker.updateSettings — priority/category mapping overlay', () => {
  it('patches the overlay through to the facade, JSON shape untouched', async () => {
    const seen: Array<{ connectionId: string; patch: TrackerSettingsPatch }> = [];
    const facade = new UnusedFacade();
    facade.updateSettings = async (connectionId, patch) => {
      seen.push({ connectionId, patch });
    };
    const caller = await callerWith(facade);

    await caller.updateSettings({
      connectionId: 'trk_1',
      priorityMapping: { toProvider: { P0: 'critical' } },
      categoryMapping: { toProvider: { bug: 'Bug' } },
    });

    expect(seen).toEqual([
      {
        connectionId: 'trk_1',
        patch: {
          priorityMapping: { toProvider: { P0: 'critical' } },
          categoryMapping: { toProvider: { bug: 'Bug' } },
        },
      },
    ]);
  });

  it('rejects a malformed overlay before reaching the facade', async () => {
    const facade = new UnusedFacade();
    const caller = await callerWith(facade);

    await expect(
      caller.updateSettings({
        connectionId: 'trk_1',
        priorityMapping: { toProvider: 'not-an-object' },
      } as never),
    ).rejects.toThrow();
  });
});

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

// ---------------------------------------------------------------------------
// Keyless workspace recovery
// ---------------------------------------------------------------------------

describe('cyboflow.tracker — keyless recovery', () => {
  const PROBE: TrackerRecoveryProbe = {
    connectionId: 'trk_1',
    recovery: 'renamed',
    boundWorkspaceId: 'inst-1',
    boundWorkspaceName: 'cf',
    currentWorkspaceId: 'inst-1',
    currentWorkspaceName: 'newpfx',
    probeError: null,
  };

  it('passes the classification through verbatim', async () => {
    const facade = new UnusedFacade();
    const seen: string[] = [];
    facade.probeRecovery = async (id) => {
      seen.push(id);
      return PROBE;
    };
    const caller = await callerWith(facade);

    await expect(caller.probeRecovery({ connectionId: 'trk_1' })).resolves.toEqual(PROBE);
    expect(seen).toEqual(['trk_1']);
  });

  it('maps a keyed-provider refusal to PRECONDITION_FAILED, message intact', async () => {
    // Another by-NAME mapping the router cannot express with `instanceof`.
    const unavailable = new Error(
      'linear connections have no workspace-recovery classification — reconnect them by pasting a fresh API key instead.',
    );
    unavailable.name = 'TrackerRecoveryUnavailableError';
    const facade = new UnusedFacade();
    facade.probeRecovery = async () => {
      throw unavailable;
    };
    const caller = await callerWith(facade);

    expect(await codeOf(caller.probeRecovery({ connectionId: 'trk_1' }))).toBe(
      'PRECONDITION_FAILED',
    );
    // The message names the reconnect that DOES apply, which is the whole
    // actionable content — so it is passed through rather than genericized.
    await expect(caller.probeRecovery({ connectionId: 'trk_1' })).rejects.toThrow(
      /pasting a fresh API key/,
    );
  });

  it('maps a stale-state refusal on either recovery action to CONFLICT', async () => {
    const stale = new Error(
      'this recovery applies to a renamed workspace, and re-probing now reports replaced: …',
    );
    stale.name = 'TrackerRecoveryStateError';
    const facade = new UnusedFacade();
    facade.remapRenamedPrefix = async () => {
      throw stale;
    };
    facade.adoptNewWorkspace = async () => {
      throw stale;
    };
    const caller = await callerWith(facade);

    expect(await codeOf(caller.remapRenamedPrefix({ connectionId: 'trk_1' }))).toBe('CONFLICT');
    expect(await codeOf(caller.adoptNewWorkspace({ connectionId: 'trk_1' }))).toBe('CONFLICT');
  });

  it('returns each action result unchanged', async () => {
    const remap: TrackerRemapResult = {
      remappedLinks: 2,
      remappedOutboxRows: 1,
      workspaceName: 'newpfx',
      unmatchedExternalIds: [],
    };
    const adoption: TrackerAdoptionResult = {
      newConnectionId: 'trk_2',
      orphanedLinks: 3,
      cancelledWrites: 1,
      relinked: 2,
      ambiguous: 1,
    };
    const facade = new UnusedFacade();
    facade.remapRenamedPrefix = async () => remap;
    facade.adoptNewWorkspace = async () => adoption;
    const caller = await callerWith(facade);

    await expect(caller.remapRenamedPrefix({ connectionId: 'trk_1' })).resolves.toEqual(remap);
    await expect(caller.adoptNewWorkspace({ connectionId: 'trk_1' })).resolves.toEqual(adoption);
  });

  it('rejects an empty connection id on all three, before the facade is reached', async () => {
    const caller = await callerWith(new UnusedFacade());

    expect(await codeOf(caller.probeRecovery({ connectionId: '' }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller.remapRenamedPrefix({ connectionId: '' }))).toBe('BAD_REQUEST');
    expect(await codeOf(caller.adoptNewWorkspace({ connectionId: '' }))).toBe('BAD_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// Keyless credentials (beads)
// ---------------------------------------------------------------------------

describe('cyboflow.tracker — the keyless credential shape', () => {
  it('accepts a keyless provider with a project id and no key at all', async () => {
    const seen: TrackerCredentialsInput[] = [];
    const facade = new UnusedFacade();
    facade.wizardValidate = async (credentials) => {
      seen.push(credentials);
      return IDENTITY;
    };
    const caller = await callerWith(facade);

    await caller.wizardValidate({ credentials: { provider: 'beads', projectId: 7 } });

    expect(seen).toEqual([{ provider: 'beads', projectId: 7 }]);
  });

  it('refuses a keyless provider that names no project — nothing anchors the probe', async () => {
    // The project id is beads' whole credential: without it main has no repo
    // path to spawn `bd` in, and a renderer may not supply one directly.
    const facade = new UnusedFacade();
    const caller = await callerWith(facade);

    await expect(caller.wizardValidate({ credentials: { provider: 'beads' } })).rejects.toThrow();
  });

  it('still refuses a KEYED provider with no key, which the optional field now makes expressible', async () => {
    const facade = new UnusedFacade();
    const caller = await callerWith(facade);

    await expect(caller.wizardValidate({ credentials: { provider: 'linear' } })).rejects.toThrow();
    await expect(
      caller.wizardValidate({ credentials: { provider: 'linear', apiKey: '' } }),
    ).rejects.toThrow();
    // …including on the connect path, whose schema shares the same object.
    await expect(
      caller.connect({ ...BASE_CONNECT_INPUT, credentials: { provider: 'dart' } }),
    ).rejects.toThrow();
  });

  it('re-detects a keyless connection through updateCredentials with no key', async () => {
    const seen: Array<{ connectionId: string; apiKey: string | undefined }> = [];
    const facade = new UnusedFacade();
    facade.updateCredentials = async (connectionId, apiKey) => {
      seen.push({ connectionId, apiKey });
      return IDENTITY;
    };
    const caller = await callerWith(facade);

    await caller.updateCredentials({ connectionId: 'trk_beads' });

    expect(seen).toEqual([{ connectionId: 'trk_beads', apiKey: undefined }]);
  });

  it('passes a KEYLESS auth failure through verbatim and keeps the keyed one generic', async () => {
    // Both failures are the same class. For a keyed provider "check the API
    // key" is always the fix; for a keyless one there is no key, and the two
    // real causes (no `bd` binary / no workspace in this repo) have different
    // fixes that the generic line would erase.
    const beadsFailure = Object.assign(
      new Error('[beads] `bd` was not found on PATH — install beads and re-detect this connection.'),
      { name: 'TrackerAuthError', provider: 'beads' },
    );
    const linearFailure = Object.assign(new Error('[linear] 401 unauthorized'), {
      name: 'TrackerAuthError',
      provider: 'linear',
    });

    const facade = new UnusedFacade();
    let next: Error = beadsFailure;
    facade.wizardValidate = async () => {
      throw next;
    };
    const caller = await callerWith(facade);

    await expect(
      caller.wizardValidate({ credentials: { provider: 'beads', projectId: 7 } }),
    ).rejects.toThrow(/not found on PATH/);
    expect(
      await codeOf(caller.wizardValidate({ credentials: { provider: 'beads', projectId: 7 } })),
    ).toBe('UNAUTHORIZED');

    next = linearFailure;
    await expect(
      caller.wizardValidate({ credentials: { provider: 'linear', apiKey: 'k' } }),
    ).rejects.toThrow(/Check the API key/);
  });

  it('maps a credential-wiring failure to PRECONDITION_FAILED, message intact', async () => {
    // TrackerCredentialsError is not a provider rejection: the connection is
    // not bound to a workspace it can reach, and the message names which of
    // the three ways that happened.
    const err = Object.assign(
      new Error('project 7 has no repo path on disk, so there is no beads workspace to detect'),
      { name: 'TrackerCredentialsError' },
    );
    const facade = new UnusedFacade();
    facade.wizardValidate = async () => {
      throw err;
    };
    const caller = await callerWith(facade);

    const call = caller.wizardValidate({ credentials: { provider: 'beads', projectId: 7 } });
    expect(await codeOf(call)).toBe('PRECONDITION_FAILED');
    await expect(
      caller.wizardValidate({ credentials: { provider: 'beads', projectId: 7 } }),
    ).rejects.toThrow(/no repo path on disk/);
  });
});
