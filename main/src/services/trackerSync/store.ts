/**
 * trackerSync/store — the typed data-access layer over migration 093's four
 * tables (tracker_connections, entity_external_links, tracker_outbox,
 * tracker_conflicts). Design: docs/proposals/tracker-sync-integration.md
 * ("Data model" + "Durability & failure semantics").
 *
 * Every function takes a real better-sqlite3 `Database.Database` as its
 * first argument (no class, mirroring main/src/orchestrator/taskListing.ts /
 * main/src/services/cyboflow/transitions.ts) so it can be unit-tested against
 * a temp-file DB with zero mocking. Everything else in the sync engine (the
 * outbox worker, the poller, the conflict machinery, the wizard's tRPC
 * handlers) builds on this module — it owns 100% of the SQL for these four
 * tables so no other file should reach for `db.prepare` against them
 * directly.
 *
 * Timestamps are always `datetime('now')` (UTC 'YYYY-MM-DD HH:MM:SS'), same
 * as the migration's column defaults, so string comparisons (claimNextPending's
 * `next_attempt_at <= now`) stay consistent whether a row's timestamp came
 * from the schema default or a store write.
 *
 * Grouped into four sections mirroring the four tables:
 *   - Connections: insertConnection / getConnection / listConnections /
 *     updateConnectionSettings / findDisconnectedConnection /
 *     reactivateConnection / advanceCursor / storeSecret / readSecret /
 *     clearSecret.
 *   - Links: upsertLink / getLinkByEntity / getLinkById / getLinkByExternal /
 *     listLinks / updateBaseline / markOrphaned / listLinksByParentExternal /
 *     listActiveLinksWithoutEntity / hasActiveLinkedDescendant.
 *   - Outbox: enqueueOutbox / claimNextPending / resolveOutbox /
 *     listUnresolvedOutbox / findOutboxByClientKey / requeueInFlightAsAmbiguous.
 *   - Conflicts: insertConflict / getConflict / listOpenConflicts /
 *     resolveConflict / hasOpenConflictForLink.
 */
import type Database from 'better-sqlite3';
import type {
  TrackerConnectionRow,
  EntityExternalLinkRow,
  TrackerOutboxRow,
  TrackerConflictRow,
} from '../../database/models';

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/**
 * insertConnection's input: every `tracker_connections` column except the two
 * timestamps (both default to `datetime('now')` at the schema level). `id` is
 * caller-supplied (no server-side id generation here — the wizard's connect
 * step mints it). `secret_ciphertext` is part of the row shape but callers
 * normally pass `null` here and set it via {@link storeSecret} once the key is
 * encrypted, keeping the plaintext-never-touches-sqlite invariant local to one
 * call site.
 */
export type NewConnectionRow = Omit<TrackerConnectionRow, 'created_at' | 'updated_at'>;

/** Insert a new tracker connection row and return it as persisted. */
export function insertConnection(db: Database.Database, row: NewConnectionRow): TrackerConnectionRow {
  return db
    .prepare(
      `INSERT INTO tracker_connections (
         id, project_id, provider, status, workspace_id, workspace_name, actor_label,
         base_url, secret_ciphertext, source_json, selection_mode, selection_json,
         state_mapping_json, two_way, mirror_subissues, conflict_mode,
         cursor_updated_at, cursor_external_id, last_sync_at, last_sync_log_json
       ) VALUES (
         @id, @project_id, @provider, @status, @workspace_id, @workspace_name, @actor_label,
         @base_url, @secret_ciphertext, @source_json, @selection_mode, @selection_json,
         @state_mapping_json, @two_way, @mirror_subissues, @conflict_mode,
         @cursor_updated_at, @cursor_external_id, @last_sync_at, @last_sync_log_json
       )
       RETURNING *`,
    )
    .get(row) as TrackerConnectionRow;
}

/** Fetch one connection by id, or null when it does not exist. */
export function getConnection(db: Database.Database, id: string): TrackerConnectionRow | null {
  const row = db.prepare('SELECT * FROM tracker_connections WHERE id = ?').get(id) as
    | TrackerConnectionRow
    | undefined;
  return row ?? null;
}

/**
 * List connections, optionally scoped to a project. Disconnected connections
 * (`status = 'disconnected'`) are excluded by default — they are kept for
 * history/audit but should not show up in normal "your connections" listings
 * — pass `includeDisconnected: true` to see them too.
 */
export function listConnections(
  db: Database.Database,
  projectId?: number,
  opts?: { includeDisconnected?: boolean },
): TrackerConnectionRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (projectId !== undefined) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  if (opts?.includeDisconnected !== true) {
    clauses.push("status != 'disconnected'");
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM tracker_connections ${where} ORDER BY created_at ASC, id ASC`)
    .all(...params) as TrackerConnectionRow[];
}

/**
 * The mutable, wizard/connected-view-editable subset of a connection's
 * columns. Every field is optional — only the keys present in `patch` are
 * written, so a caller can flip a single flag (e.g. `conflict_mode`) without
 * re-supplying the rest of the row.
 */
export interface ConnectionSettingsPatch {
  status?: TrackerConnectionRow['status'];
  selection_mode?: TrackerConnectionRow['selection_mode'];
  selection_json?: string | null;
  state_mapping_json?: string;
  two_way?: number;
  mirror_subissues?: number;
  conflict_mode?: TrackerConnectionRow['conflict_mode'];
  source_json?: string | null;
  last_sync_at?: string | null;
  last_sync_log_json?: string | null;
  workspace_id?: string | null;
  workspace_name?: string | null;
  actor_label?: string | null;
}

/** The column order ConnectionSettingsPatch's keys are allowed to touch. */
const CONNECTION_SETTINGS_COLUMNS = [
  'status',
  'selection_mode',
  'selection_json',
  'state_mapping_json',
  'two_way',
  'mirror_subissues',
  'conflict_mode',
  'source_json',
  'last_sync_at',
  'last_sync_log_json',
  'workspace_id',
  'workspace_name',
  'actor_label',
] as const satisfies readonly (keyof ConnectionSettingsPatch)[];

/**
 * Patch a connection's settings columns in place. Only keys present on
 * `patch` are written (an omitted key leaves the stored value untouched; an
 * explicit `null` clears a nullable column). A no-op patch (`{}`) touches
 * nothing, not even `updated_at`.
 */
export function updateConnectionSettings(
  db: Database.Database,
  id: string,
  patch: ConnectionSettingsPatch,
): void {
  const setClauses: string[] = [];
  const params: unknown[] = [];
  for (const column of CONNECTION_SETTINGS_COLUMNS) {
    if (column in patch) {
      setClauses.push(`${column} = ?`);
      params.push(patch[column] ?? null);
    }
  }
  if (setClauses.length === 0) return;
  setClauses.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE tracker_connections SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * The DISCONNECTED connection a re-connect should REVIVE, or null.
 *
 * IDENTITY IS `(project_id, provider, workspace_id)` — "the same workspace, on
 * the same tracker, in the same project". `workspace_id` is the honest key
 * because it is what the connect flow persists from the LIVE
 * `validateCredentials()` probe (Linear's organization id, Plane's workspace
 * slug), NOT anything the user typed: it survives exactly the event that makes
 * this lookup necessary, a credential rotation. The API key changes, the
 * workspace does not.
 *
 * Only `disconnected` rows are candidates. An active or paused connection is
 * still the project's live connection for that workspace, and silently
 * repointing it from a wizard run would move someone else's links. A stored
 * NULL `workspace_id` never matches either (SQL's NULL comparison), which is
 * deliberate rather than incidental: a row whose identity we never learned
 * cannot be claimed BY identity.
 *
 * Most recently updated first, so a workspace connected and retired more than
 * once revives the life whose links are freshest.
 */
export function findDisconnectedConnection(
  db: Database.Database,
  projectId: number,
  provider: TrackerConnectionRow['provider'],
  workspaceId: string,
): TrackerConnectionRow | null {
  const row = db
    .prepare(
      `SELECT * FROM tracker_connections
        WHERE project_id = ? AND provider = ? AND workspace_id = ? AND status = 'disconnected'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1`,
    )
    .get(projectId, provider, workspaceId) as TrackerConnectionRow | undefined;
  return row ?? null;
}

/**
 * Re-arm a retired connection IN PLACE from a fresh wizard payload: every
 * column {@link insertConnection} would have written is written here instead,
 * onto the row `id` already names.
 *
 * REUSING THE ID IS THE WHOLE POINT. `disconnect` deliberately keeps the links,
 * and a link is scoped to its `connection_id` — so a re-connect that minted a
 * new id would leave every one of them attached to a dead connection, and the
 * first pass would re-import the entire synced backlog as new ideas.
 *
 * `row` is exactly the value insertConnection takes (minus the id), so the two
 * paths cannot drift: the caller composes the row once and picks a verb. An
 * `id` key present on `row` is ignored — the `id` ARGUMENT is the row being
 * rewritten. The caller is expected to pass a NULL cursor in it: re-fetching
 * from the beginning is what lets each retained link re-bind, merging its issue
 * against its own baseline instead of importing it again.
 */
export function reactivateConnection(
  db: Database.Database,
  id: string,
  row: Omit<NewConnectionRow, 'id'>,
): TrackerConnectionRow {
  return db
    .prepare(
      `UPDATE tracker_connections SET
         project_id = @project_id, provider = @provider, status = @status,
         workspace_id = @workspace_id, workspace_name = @workspace_name,
         actor_label = @actor_label, base_url = @base_url,
         secret_ciphertext = @secret_ciphertext, source_json = @source_json,
         selection_mode = @selection_mode, selection_json = @selection_json,
         state_mapping_json = @state_mapping_json, two_way = @two_way,
         mirror_subissues = @mirror_subissues, conflict_mode = @conflict_mode,
         cursor_updated_at = @cursor_updated_at, cursor_external_id = @cursor_external_id,
         last_sync_at = @last_sync_at, last_sync_log_json = @last_sync_log_json,
         updated_at = datetime('now')
       WHERE id = @id
       RETURNING *`,
    )
    .get({ ...row, id }) as TrackerConnectionRow;
}

/**
 * Advance the crash-safe compound cursor (`(cursor_updated_at,
 * cursor_external_id)` — see "Durability & failure semantics" #2 in the
 * design doc). Callers apply a fetched page and this cursor update inside the
 * SAME sqlite transaction so a crash mid-page always rewinds to the last
 * durable cursor.
 */
export function advanceCursor(
  db: Database.Database,
  id: string,
  cursorUpdatedAt: string,
  cursorExternalId: string,
): void {
  db.prepare(
    `UPDATE tracker_connections
        SET cursor_updated_at = ?, cursor_external_id = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(cursorUpdatedAt, cursorExternalId, id);
}

/**
 * Store an already-encrypted secret (see secrets.ts — plaintext never
 * reaches this module). `cipher` is written verbatim into
 * `secret_ciphertext` (a BLOB column); better-sqlite3 binds a Node `Buffer`
 * directly.
 */
export function storeSecret(db: Database.Database, id: string, cipher: Buffer): void {
  db.prepare(
    `UPDATE tracker_connections SET secret_ciphertext = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(cipher, id);
}

/** Read back a connection's stored ciphertext (still encrypted), or null. */
export function readSecret(db: Database.Database, id: string): Buffer | null {
  const row = db.prepare('SELECT secret_ciphertext FROM tracker_connections WHERE id = ?').get(id) as
    | { secret_ciphertext: Buffer | null }
    | undefined;
  return row?.secret_ciphertext ?? null;
}

/**
 * Drop a connection's stored ciphertext (disconnect). The ROW survives — the
 * connection is kept as `status = 'disconnected'` for history, and its links
 * stay inspectable — but the key it was authorized with does not: a disconnected
 * connection must not be resumable without the user pasting a key again.
 */
export function clearSecret(db: Database.Database, id: string): void {
  db.prepare(
    `UPDATE tracker_connections SET secret_ciphertext = NULL, updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** upsertLink's input — the identity columns plus the mutable metadata. */
export interface UpsertLinkInput {
  connection_id: string;
  entity_type: EntityExternalLinkRow['entity_type'];
  entity_id: string;
  provider: EntityExternalLinkRow['provider'];
  external_id: string;
  external_identifier?: string | null;
  external_url?: string | null;
  external_parent_id?: string | null;
  baseline_json?: string | null;
}

/**
 * Create-or-refresh a link. The conflict target is `(entity_type, entity_id,
 * provider)` — migration 093's "one entity maps to at most one issue per
 * provider" invariant, and the natural identity of "this entity's link
 * record". A re-upsert for the same entity/provider refreshes every mutable
 * column (including clearing `orphaned_at` — seeing the same external issue
 * again means the link is live) and `updated_at`. The table's OTHER unique
 * constraint, `(connection_id, external_id)`, is intentionally left
 * unhandled by the ON CONFLICT clause: if a fresh entity's external_id
 * collides with a DIFFERENT entity's existing link under the same
 * connection, that is a genuine data conflict and the INSERT throws rather
 * than silently repointing someone else's link.
 */
export function upsertLink(db: Database.Database, input: UpsertLinkInput): EntityExternalLinkRow {
  return db
    .prepare(
      `INSERT INTO entity_external_links (
         connection_id, entity_type, entity_id, provider, external_id,
         external_identifier, external_url, external_parent_id, baseline_json
       ) VALUES (
         @connection_id, @entity_type, @entity_id, @provider, @external_id,
         @external_identifier, @external_url, @external_parent_id, @baseline_json
       )
       ON CONFLICT (entity_type, entity_id, provider) DO UPDATE SET
         connection_id = excluded.connection_id,
         external_id = excluded.external_id,
         external_identifier = excluded.external_identifier,
         external_url = excluded.external_url,
         external_parent_id = excluded.external_parent_id,
         baseline_json = excluded.baseline_json,
         orphaned_at = NULL,
         updated_at = datetime('now')
       RETURNING *`,
    )
    .get({
      connection_id: input.connection_id,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      provider: input.provider,
      external_id: input.external_id,
      external_identifier: input.external_identifier ?? null,
      external_url: input.external_url ?? null,
      external_parent_id: input.external_parent_id ?? null,
      baseline_json: input.baseline_json ?? null,
    }) as EntityExternalLinkRow;
}

/** Look up a link by its entity identity (an entity has at most one per provider). */
export function getLinkByEntity(
  db: Database.Database,
  entityType: EntityExternalLinkRow['entity_type'],
  entityId: string,
  provider: EntityExternalLinkRow['provider'],
): EntityExternalLinkRow | null {
  const row = db
    .prepare('SELECT * FROM entity_external_links WHERE entity_type = ? AND entity_id = ? AND provider = ?')
    .get(entityType, entityId, provider) as EntityExternalLinkRow | undefined;
  return row ?? null;
}

/** Look up a link by its own row id (the conflict rows' `link_id` FK). */
export function getLinkById(db: Database.Database, linkId: number): EntityExternalLinkRow | null {
  const row = db.prepare('SELECT * FROM entity_external_links WHERE id = ?').get(linkId) as
    | EntityExternalLinkRow
    | undefined;
  return row ?? null;
}

/** Look up a link by the external issue it points at (scoped to a connection). */
export function getLinkByExternal(
  db: Database.Database,
  connectionId: string,
  externalId: string,
): EntityExternalLinkRow | null {
  const row = db
    .prepare('SELECT * FROM entity_external_links WHERE connection_id = ? AND external_id = ?')
    .get(connectionId, externalId) as EntityExternalLinkRow | undefined;
  return row ?? null;
}

/**
 * List a connection's links. `activeOnly` filters out orphaned links
 * (`orphaned_at IS NOT NULL` — a remote deletion that has already been
 * archived locally, see {@link markOrphaned}).
 */
export function listLinks(
  db: Database.Database,
  connectionId: string,
  opts?: { activeOnly?: boolean },
): EntityExternalLinkRow[] {
  const where =
    opts?.activeOnly === true
      ? 'WHERE connection_id = ? AND orphaned_at IS NULL'
      : 'WHERE connection_id = ?';
  return db
    .prepare(`SELECT * FROM entity_external_links ${where} ORDER BY created_at ASC, id ASC`)
    .all(connectionId) as EntityExternalLinkRow[];
}

/** Refresh a link's three-way-merge baseline snapshot after a sync pass applies it. */
export function updateBaseline(db: Database.Database, linkId: number, baselineJson: string): void {
  db.prepare(
    `UPDATE entity_external_links SET baseline_json = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(baselineJson, linkId);
}

/** Mark a link orphaned (its remote issue was deleted/archived — see the deletion sweep). */
export function markOrphaned(db: Database.Database, linkId: number): void {
  db.prepare(
    `UPDATE entity_external_links SET orphaned_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
  ).run(linkId);
}

/**
 * List a mirrored parent's sub-issue links (children of `parentExternalId`
 * under one connection) — used by the "close parent when all mirrored
 * children are done" rollup.
 */
export function listLinksByParentExternal(
  db: Database.Database,
  connectionId: string,
  parentExternalId: string,
): EntityExternalLinkRow[] {
  return db
    .prepare(
      `SELECT * FROM entity_external_links
        WHERE connection_id = ? AND external_parent_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(connectionId, parentExternalId) as EntityExternalLinkRow[];
}

// ---------------------------------------------------------------------------
// Links x entities
//
// The only two queries here that reach past the four tracker tables into the
// native entity tables (ideas/epics/tasks). They live in this module anyway
// because they are still fundamentally LINK queries — "which links does this
// entity's removal affect?" — and splitting the JOIN's two halves across two
// files would hide the tracker side of it.
//
// `entity_external_links` deliberately has NO entity foreign key: the entity
// lives in one of three tables, so there is nothing single to point at. Sqlite
// therefore cannot cascade a deleted entity into its link, which is exactly the
// gap these two close.
// ---------------------------------------------------------------------------

/**
 * Active links whose ENTITY ROW NO LONGER EXISTS — the zombie links a hard
 * delete leaves behind (its cascade removes rows from ideas/epics/tasks and
 * nothing touches the link table). Left alone they are unreachable forever: the
 * inbound poller finds the link, finds no entity, and skips it every pass.
 *
 * Scoped to one project through the link's connection, oldest-first like every
 * other listing here.
 */
export function listActiveLinksWithoutEntity(
  db: Database.Database,
  projectId: number,
): EntityExternalLinkRow[] {
  return db
    .prepare(
      `SELECT l.* FROM entity_external_links l
         JOIN tracker_connections c ON c.id = l.connection_id
         LEFT JOIN ideas i ON l.entity_type = 'idea' AND i.id = l.entity_id
         LEFT JOIN epics e ON l.entity_type = 'epic' AND e.id = l.entity_id
         LEFT JOIN tasks t ON l.entity_type = 'task' AND t.id = l.entity_id
        WHERE c.project_id = ?
          AND l.orphaned_at IS NULL
          AND i.id IS NULL AND e.id IS NULL AND t.id IS NULL
        ORDER BY l.created_at ASC, l.id ASC`,
    )
    .all(projectId) as EntityExternalLinkRow[];
}

/**
 * True when hard-deleting `entityId` would ALSO remove at least one other
 * entity that is itself linked and live. Mirrors TaskChangeRouter's
 * `collectDeleteCascade` exactly — an idea claims its epics, its direct tasks
 * AND its epics' tasks; an epic claims its child tasks; a task claims nothing —
 * so the removal dialog can tell the user their ruling covers synced children
 * too before they commit to it.
 */
export function hasActiveLinkedDescendant(
  db: Database.Database,
  entityType: EntityExternalLinkRow['entity_type'],
  entityId: string,
): boolean {
  if (entityType === 'task') return false;

  if (entityType === 'epic') {
    const row = db
      .prepare(
        `SELECT 1 FROM entity_external_links l
           JOIN tasks t ON t.id = l.entity_id
          WHERE l.entity_type = 'task' AND l.orphaned_at IS NULL AND t.parent_epic_id = ?
          LIMIT 1`,
      )
      .get(entityId);
    return row !== undefined;
  }

  const row = db
    .prepare(
      `SELECT 1 FROM entity_external_links l
        WHERE l.orphaned_at IS NULL
          AND (
            (l.entity_type = 'epic'
              AND EXISTS (SELECT 1 FROM epics e
                           WHERE e.id = l.entity_id AND e.originating_idea_id = ?))
            OR (l.entity_type = 'task'
              AND EXISTS (SELECT 1 FROM tasks t
                           WHERE t.id = l.entity_id
                             AND (t.originating_idea_id = ?
                                  OR t.parent_epic_id IN
                                       (SELECT id FROM epics WHERE originating_idea_id = ?))))
          )
        LIMIT 1`,
    )
    .get(entityId, entityId, entityId);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

/** enqueueOutbox's input — the identity/payload columns; state/attempts/etc. default at the schema level. */
export interface EnqueueOutboxInput {
  connection_id: string;
  kind: TrackerOutboxRow['kind'];
  entity_type?: string | null;
  entity_id?: string | null;
  external_id?: string | null;
  client_key?: string | null;
  payload_json: string;
}

/**
 * Durably record a remote write BEFORE the API call is attempted (see
 * "Durability & failure semantics" #1 — this row is what makes a
 * half-created sub-issue impossible to double-create or re-import).
 */
export function enqueueOutbox(db: Database.Database, input: EnqueueOutboxInput): TrackerOutboxRow {
  return db
    .prepare(
      `INSERT INTO tracker_outbox (connection_id, kind, entity_type, entity_id, external_id, client_key, payload_json)
       VALUES (@connection_id, @kind, @entity_type, @entity_id, @external_id, @client_key, @payload_json)
       RETURNING *`,
    )
    .get({
      connection_id: input.connection_id,
      kind: input.kind,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      external_id: input.external_id ?? null,
      client_key: input.client_key ?? null,
      payload_json: input.payload_json,
    }) as TrackerOutboxRow;
}

/**
 * Atomically claim the oldest eligible pending row for a connection: the
 * oldest (by `created_at`, then `id` as a tiebreaker for same-second
 * inserts) `state = 'pending'` row whose `next_attempt_at` is NULL or
 * `<= nowIso`, flipping it to `state = 'in_flight'` and incrementing
 * `attempts`. Runs inside a `BEGIN IMMEDIATE` transaction (mirrors
 * transitions.ts's `tx.immediate(...)` pattern) so two concurrent callers
 * can never claim the same row. Returns null when nothing is eligible.
 */
export function claimNextPending(
  db: Database.Database,
  connectionId: string,
  nowIso: string,
): TrackerOutboxRow | null {
  const claim = db.transaction((connId: string, now: string): TrackerOutboxRow | null => {
    const candidate = db
      .prepare(
        `SELECT id FROM tracker_outbox
          WHERE connection_id = ? AND state = 'pending'
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY created_at ASC, id ASC
          LIMIT 1`,
      )
      .get(connId, now) as { id: number } | undefined;
    if (!candidate) return null;
    return db
      .prepare(
        `UPDATE tracker_outbox
            SET state = 'in_flight', attempts = attempts + 1, updated_at = datetime('now')
          WHERE id = ?
          RETURNING *`,
      )
      .get(candidate.id) as TrackerOutboxRow;
  });
  return claim.immediate(connectionId, nowIso);
}

/**
 * Resolve a claimed (`in_flight`) outbox row. `'done'` and `'ambiguous'` set
 * the state verbatim. `'failed'` WITHOUT `nextAttemptAtIso` is a terminal
 * failure (state stays `'failed'`). `'failed'` WITH `nextAttemptAtIso` is the
 * retry mechanism: the row goes back to `state = 'pending'` with
 * `next_attempt_at` set, so the next {@link claimNextPending} sweep picks it
 * up again once that time passes. `opts.lastError` is recorded on every call
 * (cleared to null when omitted); `next_attempt_at` is cleared for every
 * outcome except a requeued retry.
 */
export function resolveOutbox(
  db: Database.Database,
  id: number,
  outcome: 'done' | 'failed' | 'ambiguous',
  opts?: { lastError?: string | null; nextAttemptAtIso?: string | null },
): void {
  const isRetry = outcome === 'failed' && !!opts?.nextAttemptAtIso;
  const state: TrackerOutboxRow['state'] = isRetry ? 'pending' : outcome;
  const nextAttemptAt = isRetry ? (opts?.nextAttemptAtIso ?? null) : null;
  db.prepare(
    `UPDATE tracker_outbox
        SET state = ?, last_error = ?, next_attempt_at = ?, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(state, opts?.lastError ?? null, nextAttemptAt, id);
}

/** List a connection's not-yet-settled outbox rows (pending / in_flight / ambiguous). */
export function listUnresolvedOutbox(db: Database.Database, connectionId: string): TrackerOutboxRow[] {
  return db
    .prepare(
      `SELECT * FROM tracker_outbox
        WHERE connection_id = ? AND state IN ('pending', 'in_flight', 'ambiguous')
        ORDER BY created_at ASC, id ASC`,
    )
    .all(connectionId) as TrackerOutboxRow[];
}

/** Look up an outbox row by its client-generated idempotency key (outbox recovery). */
export function findOutboxByClientKey(
  db: Database.Database,
  connectionId: string,
  clientKey: string,
): TrackerOutboxRow | null {
  const row = db
    .prepare('SELECT * FROM tracker_outbox WHERE connection_id = ? AND client_key = ?')
    .get(connectionId, clientKey) as TrackerOutboxRow | undefined;
  return row ?? null;
}

/**
 * Boot-time crash recovery: every `in_flight` row for a connection (a write
 * that was mid-API-call when the app last exited — its outcome is genuinely
 * unknown, not just "not yet attempted") becomes `'ambiguous'` so the sync
 * engine reconciles it (Plane: list-and-match; Linear: point lookup by
 * client key) before any retry. Returns the number of rows requeued.
 */
export function requeueInFlightAsAmbiguous(db: Database.Database, connectionId: string): number {
  const result = db
    .prepare(
      `UPDATE tracker_outbox
          SET state = 'ambiguous', updated_at = datetime('now')
        WHERE connection_id = ? AND state = 'in_flight'`,
    )
    .run(connectionId);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

/** insertConflict's input — the identity/payload columns; state/resolution default at the schema level. */
export interface InsertConflictInput {
  connection_id: string;
  link_id?: number | null;
  kind: TrackerConflictRow['kind'];
  field?: string | null;
  local_value?: string | null;
  remote_value?: string | null;
  payload_json?: string | null;
}

/** Open a conflict row: Manual-mode field conflicts, or Auto/Manual remote-deletion records. */
export function insertConflict(db: Database.Database, input: InsertConflictInput): TrackerConflictRow {
  return db
    .prepare(
      `INSERT INTO tracker_conflicts (connection_id, link_id, kind, field, local_value, remote_value, payload_json)
       VALUES (@connection_id, @link_id, @kind, @field, @local_value, @remote_value, @payload_json)
       RETURNING *`,
    )
    .get({
      connection_id: input.connection_id,
      link_id: input.link_id ?? null,
      kind: input.kind,
      field: input.field ?? null,
      local_value: input.local_value ?? null,
      remote_value: input.remote_value ?? null,
      payload_json: input.payload_json ?? null,
    }) as TrackerConflictRow;
}

/** Fetch one conflict by id (open or resolved), or null when it does not exist. */
export function getConflict(db: Database.Database, id: number): TrackerConflictRow | null {
  const row = db.prepare('SELECT * FROM tracker_conflicts WHERE id = ?').get(id) as
    | TrackerConflictRow
    | undefined;
  return row ?? null;
}

/** List a connection's open (unresolved) conflicts. */
export function listOpenConflicts(db: Database.Database, connectionId: string): TrackerConflictRow[] {
  return db
    .prepare(
      `SELECT * FROM tracker_conflicts WHERE connection_id = ? AND state = 'open' ORDER BY created_at ASC, id ASC`,
    )
    .all(connectionId) as TrackerConflictRow[];
}

/** Resolve a conflict with the user's (or Auto mode's) decision, stamping `resolved_at`. */
export function resolveConflict(db: Database.Database, id: number, resolution: string): void {
  db.prepare(
    `UPDATE tracker_conflicts SET state = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?`,
  ).run(resolution, id);
}

/** True when `linkId` has at least one open conflict (used to gate per-item sync pausing in Manual mode). */
export function hasOpenConflictForLink(db: Database.Database, linkId: number): boolean {
  const row = db.prepare('SELECT 1 FROM tracker_conflicts WHERE link_id = ? AND state = ?').get(linkId, 'open');
  return row !== undefined;
}
