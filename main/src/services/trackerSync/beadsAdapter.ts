/**
 * BeadsAdapter — Phase 1 STUB for the beads (`bd`, github.com/gastownhall/beads)
 * `TrackerAdapter` implementation. Design: docs/proposals/
 * tracker-beads-provider.md, in full — the method-by-method mapping table,
 * "2. CLI transport" for the real `bd` invocation shapes, and "3. Concurrency
 * and the single-writer lock" for why every write here will eventually be
 * serialized per project.
 *
 * This file exists so `TrackerProvider`/`TrackerAdapter` widen to a fourth
 * member with something concrete implementing the contract (the
 * `Record<TrackerProvider, TrackerAdapter>` exhaustiveness fixture in
 * adapterCapabilities.test.ts needs an instance to key on) — every method
 * throws. The real CLI transport (`runToolCapture`-based `bd` spawns, the
 * `-C <project.path>` workspace pinning, the identity/HEAD sandwich checks,
 * the error-taxonomy classification) is Phase 2 work; nothing here makes a
 * process call.
 */

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerState,
  TrackerIssue,
} from '../../../../shared/types/trackerSync';
import type {
  TrackerAdapter,
  TrackerAdapterCapabilities,
  IssueDraft,
  IssueContentPatch,
  TrackerFieldOptionsRaw,
} from './adapterTypes';
import { TrackerApiError } from './errors';
import { PROVIDER_ARCHIVE_CAPABILITY } from './providerCapabilities';

const PROVIDER: TrackerProvider = 'beads';

/**
 * The `child_process.execFile`-shaped call this adapter spawns `bd` through,
 * injected at construction the same way every other adapter injects
 * `FetchLike` — so a test never actually forks a process. Phase 2 wires the
 * real implementation on `runToolCapture` (main/src/utils/runGit.ts); this
 * type is a placeholder for that seam's exact shape (argv-only, never a
 * shell, with an explicit timeout and raised `maxBuffer` — see the proposal's
 * "Bounded listings" and "Timeout" sections).
 */
export type ExecLike = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

const CAPABILITIES: TrackerAdapterCapabilities = {
  // beads has no native "auto-close parent when children complete" behavior
  // (parent-child is `--parent`/dotted hierarchical ids only) — same as Plane
  // and Dart, the shared close-parent write is the only path.
  nativeParentAutoClose: false,
  // beads has no HTTP origin to self-host; the transport is a local CLI spawn
  // against the project's own workspace.
  selfHostedBaseUrl: false,
  // `bd create` mints its own id; there is no client-supplied-id equivalent
  // to Linear's idempotent issueCreate. Recovery for a lost create's response
  // is the `--metadata-field cyboflow_client_key=<uuid>` list filter instead
  // (proposal "Capabilities row" — "Client key via metadata, not a
  // description marker").
  idempotentCreate: false,
  // `bd update` writes all four fields directly (title/description/priority
  // via its native type field), per the proposal's method-by-method mapping.
  contentWrite: { title: true, description: true, priority: true, category: true },
  // Read from the shared table so the outbound trigger — which gates on the
  // capability WITHOUT an adapter in hand — can never disagree with this
  // adapter. beads exposes no archive/trash endpoint (`bd delete` is a hard
  // delete), so this resolves to 'none'.
  archive: PROVIDER_ARCHIVE_CAPABILITY.beads,
  // A `bd dolt pull` preserves each issue's original `updated_at`, and
  // label/comment/dependency edits never bump it at all — the incremental
  // cursor alone can miss real changes permanently, so the deletion sweep
  // must reconcile by full id+revision listing instead of a bare id set. See
  // `listIssueRevisions` below and the proposal's "4. Pull reconciliation".
  requiresIdReconciliation: true,
  // beads' embedded single-writer database has no CAS/if-match primitive
  // (`--claim` is advisory and scoped to (assignee, status) only), so every
  // existing-issue mutation is guarded by a detect-after-write history diff
  // rather than a conditional write. See the proposal's "Dual writers on one
  // issue".
  guardedUpdates: true,
};

export interface BeadsAdapterOptions {
  /** The resolved `bd` workspace root (the project's checkout path). */
  workspacePath: string;
  /** Injected for tests; Phase 2 supplies the real `runToolCapture`-based spawn. */
  execImpl?: ExecLike;
}

/**
 * Every method below rejects with this — see the file header. A REJECTED
 * PROMISE, not a synchronous throw: every `TrackerAdapter` method returns
 * `Promise<T>`, and a plain (non-`async`) method that `throw`s directly
 * violates that contract — the call itself throws before a caller's
 * `await`/`.catch`/`expect(...).rejects` ever sees a promise to act on.
 */
function notImplemented<T>(method: string): Promise<T> {
  return Promise.reject(
    new TrackerApiError(PROVIDER, `BeadsAdapter.${method} is not implemented yet (Phase 2)`, null),
  );
}

export class BeadsAdapter implements TrackerAdapter {
  readonly provider: TrackerProvider = PROVIDER;
  readonly capabilities: TrackerAdapterCapabilities = CAPABILITIES;

  private readonly workspacePath: string;
  private readonly execImpl: ExecLike | undefined;

  constructor(options: BeadsAdapterOptions) {
    this.workspacePath = options.workspacePath;
    this.execImpl = options.execImpl;
  }

  validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    return notImplemented('validateCredentials');
  }

  listGroups(): Promise<TrackerGroupTree> {
    return notImplemented('listGroups');
  }

  listContainers(): Promise<TrackerSourceTree> {
    return notImplemented('listContainers');
  }

  listNarrows(_containerId: string): Promise<TrackerSourceNarrow[]> {
    return notImplemented('listNarrows');
  }

  listStates(_selection: TrackerSourceSelection): Promise<TrackerState[]> {
    return notImplemented('listStates');
  }

  listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    return notImplemented('listFieldOptions');
  }

  listIssues(_selection: TrackerSourceSelection, _sinceIso?: string): Promise<TrackerIssue[]> {
    return notImplemented('listIssues');
  }

  listIssueIds(_selection: TrackerSourceSelection): Promise<string[]> {
    return notImplemented('listIssueIds');
  }

  listIssueRevisions(
    _selection: TrackerSourceSelection,
  ): Promise<Array<{ id: string; revision: string }>> {
    return notImplemented('listIssueRevisions');
  }

  getIssue(_externalId: string): Promise<TrackerIssue | null> {
    return notImplemented('getIssue');
  }

  createSubIssue(
    _parentExternalId: string,
    _draft: IssueDraft,
    _clientKey: string,
  ): Promise<TrackerIssue> {
    return notImplemented('createSubIssue');
  }

  createIssue(
    _selection: TrackerSourceSelection,
    _draft: IssueDraft,
    _clientKey: string,
  ): Promise<TrackerIssue> {
    return notImplemented('createIssue');
  }

  updateIssueState(_externalId: string, _stateId: string, _expectedToken?: string): Promise<void> {
    return notImplemented('updateIssueState');
  }

  updateIssueContent(
    _externalId: string,
    _patch: IssueContentPatch,
    _expectedToken?: string,
  ): Promise<TrackerIssue | null> {
    return notImplemented('updateIssueContent');
  }

  archiveIssue(_externalId: string): Promise<void> {
    return notImplemented('archiveIssue');
  }
}
