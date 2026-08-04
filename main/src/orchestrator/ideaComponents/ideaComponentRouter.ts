/**
 * IdeaComponentRouter — the SINGLE write chokepoint for the `idea_components`
 * table (migration 098, `shared/types/ideaComponents.ts`,
 * `./resolveIdeaComponents.ts`). Mirrors `reviewItemRouter.ts`'s per-project
 * PQueue + emit-after-commit architecture in miniature, scaled to a table
 * with no `entity_events` audit trail of its own (nothing in this feature's
 * design asks for one — see the header there for the fuller pattern this one
 * borrows from).
 *
 * INVARIANT: every `idea_components` write goes through `applyChange`. The
 * merged hybrid read model (`resolveIdeaComponents`) is recomputed AFTER each
 * commit and broadcast via `ideaComponentChangeEvents`, so a subscriber always
 * receives the same shape `cyboflow.ideaComponents.get` would return — never
 * a raw row, never a partial component list.
 *
 * THE HYBRID MODEL (see `shared/types/ideaComponents.ts` for the full
 * rationale) constrains every op here:
 *   - A ledger row, once written, is authoritative over derivation. This
 *     router only ever writes rows explicitly — it never needs to "delete
 *     down to derivation" as a normal op (that's what `deleteForIdea` is
 *     for, and it's cascade-only).
 *   - `state='skipped'` is NEVER derived and only ever set explicitly via
 *     `setComponentState` — this router does not special-case it beyond
 *     that; the derivation module is what enforces "never derive skipped".
 *   - Staleness (`stale_at`/`stale_reason`) is a column, not a state. See
 *     `markStale`/`clearStale` below for exactly what each touches.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*. The DB is
 * injected as the narrow DatabaseLike interface.
 */
import { EventEmitter } from 'node:events';
import PQueue from 'p-queue';
import type { DatabaseLike } from '../types';
import type { IdeaComponentKey, IdeaComponentChangedEvent, IdeaComponentState } from '../../../../shared/types/ideaComponents';
import { resolveIdeaComponents } from './resolveIdeaComponents';

// ---------------------------------------------------------------------------
// Public event emitter — hosted HERE (not trpc/routers/events.ts), mirroring
// reviewItemChangeEvents/taskChangeEvents, to avoid file contention with the
// events router. The tRPC subscription bridges this emitter via
// eventToAsyncIterable.
//
// Emit key format: 'idea-components-project-' + projectId (mirrors
// taskProjectChannel's 'task-project-' / reviewItemProjectChannel's
// 'review-project-' naming convention).
// ---------------------------------------------------------------------------

export const ideaComponentChangeEvents = new EventEmitter();

/** Build the emit channel name for a project. Exported so the tRPC subscription stays in sync. */
export function ideaComponentProjectChannel(projectId: number): string {
  return `idea-components-project-${projectId}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type IdeaComponentErrorCode = 'not_found' | 'invalid_payload';

/** Discriminated error for all chokepoint rejections. */
export class IdeaComponentError extends Error {
  constructor(
    public readonly code: IdeaComponentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IdeaComponentError';
  }
}

// ---------------------------------------------------------------------------
// Change request shapes
// ---------------------------------------------------------------------------

/**
 * Set one (idea, component) pair's state — UPSERTs the ledger row. This is
 * BOTH the flow-driven write path (a planner/sprint/design step stamping its
 * own progress, `source: 'flow'`) and the manual-override path from the card
 * (`source: 'manual'`, forced by the tRPC layer — see `trpc/routers/ideaComponents.ts`).
 *
 * Setting a state EXPLICITLY always clears `stale_at`/`stale_reason`,
 * regardless of which state is being set: an explicit write is, by
 * definition, a re-affirmation of the component's current status (even
 * "actually this is still incomplete" is a reviewed judgment, not a stale
 * carry-over) — see the file-level staleness note and the shared type header.
 */
export interface IdeaComponentSetState {
  op: 'set-component-state';
  ideaId: string;
  component: IdeaComponentKey;
  state: 'complete' | 'incomplete' | 'skipped';
  /** 'flow' | 'manual' only — 'derived' never persists (see module header). */
  source: 'flow' | 'manual';
  sourceRunId?: string | null;
  sourceSessionId?: string | null;
  /** The idea.version this component was built against, for staleness diffing. */
  builtAgainstVersion?: number | null;
}

/**
 * Mark the idea's currently-'complete' ledger rows stale — called when the
 * idea's body materially changes, so dependent prior work is flagged for
 * re-verification WITHOUT being discarded.
 *
 * Only rows with `state='complete'` are touched: each is set to
 * `state='incomplete'` with `stale_at`/`stale_reason` set, so the UI reads it
 * as "needs review" rather than "not started" (see the shared type header's
 * `state='incomplete' AND staleAt !== null` case). A row already
 * `state='incomplete'` is left completely untouched (even if it already
 * carries an older stale flag from a previous edit — re-staling it would
 * overwrite a reason a human may already be mid-review against). A
 * `state='skipped'` row is NEVER touched: the user or flow declared that
 * component not-applicable, and a body edit does not un-skip it.
 *
 * Deliberately scoped to EXISTING ledger rows only — a component with no row
 * at all has no frozen state to go stale in the first place: its next
 * `resolveIdeaComponents` read re-derives straight from the (now-changed)
 * body/children, which is already correct with no explicit flag needed. See
 * this router's class-level JSDoc on `runMarkStale` for the fuller rationale
 * and the flagged design choice this implies.
 *
 * `components`, when given, restricts which components are candidates (still
 * subject to the same 'complete'-rows-only rule above) — e.g. the
 * taskChangeRouter.ts idea-body-change hook passes
 * `IDEA_COMPONENTS_STALE_ON_BODY_CHANGE` (the four downstream components,
 * never 'idea-spec') rather than every component. Omitted (the default)
 * preserves the original behavior of considering every component.
 */
export interface IdeaComponentMarkStale {
  op: 'mark-stale';
  ideaId: string;
  staleReason: string;
  /** Optional component filter; default (omitted) = all five components. */
  components?: IdeaComponentKey[];
}

/**
 * Clear the stale flag on one (idea, component) ledger row and RESTORE it to
 * `complete` — the "a step re-entered holding the prior work plus the diff,
 * and found no adjustment needed" path.
 *
 * Restoring the state is load-bearing, not incidental. `markStale` only ever
 * flips rows that were `complete`, so a non-NULL `stale_at` unambiguously
 * encodes "this WAS complete". Clearing the flag alone would leave a bare
 * `incomplete` — indistinguishable from "never started", collapsing exactly
 * the distinction `stale_at` exists to carry.
 *
 * It is the inverse of `markStale`, and it is the CHEAP path: it needs no
 * provenance because none changed. Use `setComponentState` instead whenever the
 * step actually produced new work (it records a fresh run/session and a new
 * `built_against_version`, and clears staleness as a side effect).
 *
 * Requires an existing row — rejected `not_found` when absent. Idempotent when
 * the row exists but is already non-stale.
 */
export interface IdeaComponentClearStale {
  op: 'clear-stale';
  ideaId: string;
  component: IdeaComponentKey;
}

/** Remove every ledger row for an idea (the idea-delete cascade). */
export interface IdeaComponentDeleteForIdea {
  op: 'delete-for-idea';
  ideaId: string;
}

export type IdeaComponentChange =
  | IdeaComponentSetState
  | IdeaComponentMarkStale
  | IdeaComponentClearStale
  | IdeaComponentDeleteForIdea;

/** The result of every op: the affected idea + its post-write merged hybrid snapshot. */
export interface IdeaComponentChangeResult {
  ideaId: string;
  states: IdeaComponentState[];
}

// ---------------------------------------------------------------------------
// Internal row shape (subset actually read by this router's op handlers)
// ---------------------------------------------------------------------------

interface StaleColumnsRow {
  stale_at: string | null;
}

interface CompleteComponentRow {
  component: IdeaComponentKey;
}

// ---------------------------------------------------------------------------
// Exhaustiveness guard for the IdeaComponentChange dispatch switch. A new op
// added to the union without a switch case is a compile error here, never a
// silent fall-through.
// ---------------------------------------------------------------------------

function assertNeverChange(change: never): never {
  throw new IdeaComponentError(
    'invalid_payload',
    `unhandled idea-component change op: ${JSON.stringify(change)}`,
  );
}

// ---------------------------------------------------------------------------
// IdeaComponentRouter
// ---------------------------------------------------------------------------

export class IdeaComponentRouter {
  private static instance: IdeaComponentRouter | null = null;

  /** Per-project serialization queues (idea components are project-scoped). */
  private projectQueues = new Map<number, PQueue>();

  constructor(private readonly db: DatabaseLike) {}

  // --------------------------------------------------------------------------
  // Lifecycle (singleton, mirroring ReviewItemRouter/TaskChangeRouter)
  // --------------------------------------------------------------------------

  static initialize(db: DatabaseLike): IdeaComponentRouter {
    IdeaComponentRouter.instance = new IdeaComponentRouter(db);
    return IdeaComponentRouter.instance;
  }

  static getInstance(): IdeaComponentRouter {
    if (!IdeaComponentRouter.instance) {
      throw new Error(
        'IdeaComponentRouter has not been initialized. Call IdeaComponentRouter.initialize() from main/src/index.ts.',
      );
    }
    return IdeaComponentRouter.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    IdeaComponentRouter.instance = null;
  }

  private getProjectQueue(projectId: number): PQueue {
    let q = this.projectQueues.get(projectId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.projectQueues.set(projectId, q);
    }
    return q;
  }

  /** Test/seam helper — exposes the per-project queue for `.onIdle()` waits. */
  _queueForProject(projectId: number): PQueue {
    return this.getProjectQueue(projectId);
  }

  // --------------------------------------------------------------------------
  // Core API
  // --------------------------------------------------------------------------

  /**
   * Apply a single idea-component change atomically and emit the resulting
   * event. `projectId` is trusted from the caller (exactly like
   * `ReviewItemRouter.applyReviewItem`) — the tRPC layer is responsible for
   * resolving it from a trusted source (the idea's own `project_id`) rather
   * than accepting one from the client; see `trpc/routers/ideaComponents.ts`.
   *
   * @returns the affected idea id + its post-write merged hybrid snapshot
   *   (all five components, built via `resolveIdeaComponents`).
   */
  async applyChange(
    projectId: number,
    change: IdeaComponentChange,
  ): Promise<IdeaComponentChangeResult> {
    return this.getProjectQueue(projectId).add(() => {
      // Exhaustive dispatch — see reviewItemRouter.ts's identical rationale:
      // a widened union without a switch case here is a compile error, not a
      // silent mis-route.
      switch (change.op) {
        case 'set-component-state':
          return this.runSetComponentState(projectId, change);
        case 'mark-stale':
          return this.runMarkStale(projectId, change);
        case 'clear-stale':
          return this.runClearStale(projectId, change);
        case 'delete-for-idea':
          return this.runDeleteForIdea(projectId, change);
        default:
          return assertNeverChange(change);
      }
    }) as Promise<IdeaComponentChangeResult>;
  }

  // --------------------------------------------------------------------------
  // setComponentState — UPSERT, always clears staleness
  // --------------------------------------------------------------------------

  private runSetComponentState(
    projectId: number,
    change: IdeaComponentSetState,
  ): IdeaComponentChangeResult {
    const now = new Date().toISOString();

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO idea_components
             (idea_id, project_id, component, state, source, source_run_id, source_session_id,
              built_against_version, stale_at, stale_reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
           ON CONFLICT(idea_id, component) DO UPDATE SET
             state = excluded.state,
             source = excluded.source,
             source_run_id = excluded.source_run_id,
             source_session_id = excluded.source_session_id,
             built_against_version = excluded.built_against_version,
             stale_at = NULL,
             stale_reason = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(
          change.ideaId,
          projectId,
          change.component,
          change.state,
          change.source,
          change.sourceRunId ?? null,
          change.sourceSessionId ?? null,
          change.builtAgainstVersion ?? null,
          now,
          now,
        );
    });
    (txn as () => void)();

    return { ideaId: change.ideaId, states: this.emitAndBuild(projectId, change.ideaId) };
  }

  // --------------------------------------------------------------------------
  // markStale — flip currently-'complete' rows to 'incomplete' + stale_at set
  // --------------------------------------------------------------------------

  private runMarkStale(
    projectId: number,
    change: IdeaComponentMarkStale,
  ): IdeaComponentChangeResult {
    const now = new Date().toISOString();

    const txn = this.db.transaction(() => {
      // Only 'complete' rows are candidates — 'skipped' stays skipped,
      // 'incomplete' is left untouched (see the type's JSDoc for the full
      // rationale on both exclusions). An optional `components` filter
      // narrows the candidate set further (e.g. the four downstream
      // components on an idea-body change) — omitted, every component is a
      // candidate, preserving the original unfiltered behavior.
      const completeRows = (
        change.components && change.components.length > 0
          ? (this.db
              .prepare(
                `SELECT component FROM idea_components
                  WHERE idea_id = ? AND state = 'complete'
                    AND component IN (${change.components.map(() => '?').join(', ')})`,
              )
              .all(change.ideaId, ...change.components))
          : this.db
              .prepare(`SELECT component FROM idea_components WHERE idea_id = ? AND state = 'complete'`)
              .all(change.ideaId)
      ) as CompleteComponentRow[];

      for (const row of completeRows) {
        this.db
          .prepare(
            `UPDATE idea_components
                SET state = 'incomplete', stale_at = ?, stale_reason = ?, updated_at = ?
              WHERE idea_id = ? AND component = ?`,
          )
          .run(now, change.staleReason, now, change.ideaId, row.component);
      }
    });
    (txn as () => void)();

    return { ideaId: change.ideaId, states: this.emitAndBuild(projectId, change.ideaId) };
  }

  // --------------------------------------------------------------------------
  // clearStale — drop stale_at/stale_reason on one row, state untouched
  // --------------------------------------------------------------------------

  private runClearStale(
    projectId: number,
    change: IdeaComponentClearStale,
  ): IdeaComponentChangeResult {
    const now = new Date().toISOString();

    const txn = this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT stale_at FROM idea_components WHERE idea_id = ? AND component = ?`)
        .get(change.ideaId, change.component) as StaleColumnsRow | undefined;
      if (!row) {
        throw new IdeaComponentError(
          'not_found',
          `no ledger row for idea ${change.ideaId} component ${change.component}`,
        );
      }
      if (row.stale_at === null) return; // idempotent no-op: nothing to clear

      // Restore `complete` alongside clearing the flag. `mark-stale` only ever
      // flips rows that were `complete`, so a non-NULL `stale_at` unambiguously
      // means "this WAS complete, then the idea body moved under it". Clearing
      // the flag without restoring the state would collapse "re-verified, still
      // valid" into a bare `incomplete` — indistinguishable from "never started",
      // which is exactly the loss `stale_at` exists to prevent.
      this.db
        .prepare(
          `UPDATE idea_components
              SET state = 'complete', stale_at = NULL, stale_reason = NULL, updated_at = ?
            WHERE idea_id = ? AND component = ?`,
        )
        .run(now, change.ideaId, change.component);
    });
    (txn as () => void)();

    return { ideaId: change.ideaId, states: this.emitAndBuild(projectId, change.ideaId) };
  }

  // --------------------------------------------------------------------------
  // deleteForIdea — cascade
  // --------------------------------------------------------------------------

  private runDeleteForIdea(
    projectId: number,
    change: IdeaComponentDeleteForIdea,
  ): IdeaComponentChangeResult {
    const txn = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM idea_components WHERE idea_id = ?`).run(change.ideaId);
    });
    (txn as () => void)();

    return { ideaId: change.ideaId, states: this.emitAndBuild(projectId, change.ideaId) };
  }

  // --------------------------------------------------------------------------
  // Emit
  // --------------------------------------------------------------------------

  /**
   * Recompute the merged hybrid snapshot for `ideaId` AFTER commit and
   * broadcast it on the project channel. Called by every op handler above —
   * single spot both to build and to emit so the two can never drift.
   */
  private emitAndBuild(projectId: number, ideaId: string): IdeaComponentState[] {
    const states = resolveIdeaComponents(this.db, ideaId);
    const event: IdeaComponentChangedEvent = { projectId, ideaId, states };
    ideaComponentChangeEvents.emit(ideaComponentProjectChannel(projectId), event);
    return states;
  }
}
