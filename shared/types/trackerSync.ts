/**
 * trackerSync — wire shapes for the external issue-tracker sync feature
 * (Settings → Integrations: Linear + Plane). Design: docs/proposals/
 * tracker-sync-integration.md.
 *
 * These types cross the IPC boundary (wizard/connected-view tRPC surface), so
 * they live here per the IPC type-parity rules. The main-only adapter contract
 * (main/src/services/trackerSync/adapterTypes.ts) builds on these.
 *
 * SECRETS NEVER CROSS OUTBOUND: `TrackerCredentialsInput` flows renderer→main
 * exactly once at connect time; no shape in this file ever carries the stored
 * key back to the renderer.
 */

export type TrackerProvider = 'linear' | 'plane';

/** Renderer→main, connect-time only. */
export interface TrackerCredentialsInput {
  provider: TrackerProvider;
  apiKey: string;
  /** Plane self-hosted instance origin; omitted = the provider's cloud default. */
  baseUrl?: string;
  /** Plane only: the workspace slug all API paths are scoped under. */
  workspaceSlug?: string;
}

/** Result of a successful credential validation ("Authorized as …" card). */
export interface TrackerWorkspaceIdentity {
  workspaceId: string;
  workspaceName: string;
  /** Display attribution for the authorizing user, e.g. "J. Kesteva". */
  actorLabel: string;
}

/**
 * Wizard Step 1 hierarchy. The top level is provider-defined (Linear team,
 * Plane project); the second level narrows it (Linear project/view/cycle,
 * Plane cycle/module). `'all'` is the whole-container narrow.
 */
export interface TrackerSourceContainer {
  id: string;
  name: string;
  /** Short key chip (Linear team key "COR"; Plane project identifier). */
  key: string | null;
  openIssueCount: number | null;
}

export type TrackerNarrowKind = 'all' | 'project' | 'view' | 'cycle' | 'module';

export interface TrackerSourceNarrow {
  id: string;
  kind: TrackerNarrowKind;
  name: string;
  issueCount: number | null;
}

export interface TrackerSourceTree {
  /** UI label for the container level: "Team" (Linear) / "Project" (Plane). */
  containerLabel: string;
  containers: TrackerSourceContainer[];
}

/** The persisted source choice on a connection. */
export interface TrackerSourceSelection {
  containerId: string;
  narrowId: string;
  narrowKind: TrackerNarrowKind;
}

/**
 * Canonical state grouping used to seed mapping defaults. Plane states carry
 * these natively; Linear workflow-state types map onto them (triage → triage,
 * backlog → backlog, unstarted → unstarted, started → started,
 * completed → completed, canceled → cancelled).
 */
export type TrackerStateGroup =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'cancelled';

export interface TrackerState {
  id: string;
  name: string;
  /** Hex color for the state dot; null when the provider has none. */
  color: string | null;
  group: TrackerStateGroup;
}

/** Mapping target: cyboflow's four writable stages, or don't-import. */
export type TrackerMappingTarget = 'dont' | 'idea' | 'ready' | 'done' | 'wontdo';

/** Per-connection state mapping, keyed by tracker state id. */
export type TrackerStateMapping = Record<string, TrackerMappingTarget>;

export interface TrackerUserRef {
  id: string;
  name: string;
  /** Two-letter avatar initials, derived when the provider has none. */
  initials: string;
}

export interface TrackerIssue {
  /**
   * The stable sync key. ADAPTER-OPAQUE: each adapter owns its format and the
   * core never parses it. Linear uses the bare issue UUID; Plane composites
   * the project scope in ("<projectId>/<issueId>") because its REST paths are
   * project-scoped.
   */
  externalId: string;
  /** Human ref shown in lowercase mono, e.g. "CORE-142" / "WEB-12". */
  identifier: string;
  title: string;
  /** Provider-native rich description, normalized to markdown; null if empty. */
  description: string | null;
  url: string;
  stateId: string;
  assignee: TrackerUserRef | null;
  estimate: number | null;
  parentExternalId: string | null;
  /** ISO-8601; drives the incremental cursor. */
  updatedAt: string;
  /** Remote archive marker (Linear archivedAt); null = live. */
  archivedAt: string | null;
}

export type TrackerSelectionMode = 'all' | 'assignee' | 'manual';
export type TrackerConflictMode = 'auto' | 'manual';
export type TrackerConnectionStatus = 'active' | 'paused' | 'disconnected';

/** The three entity tables a tracker link can point at (mirrors EntityExternalLinkRow). */
export type TrackerEntityType = 'idea' | 'epic' | 'task';

// ---------------------------------------------------------------------------
// Read models — the connected view + wizard tRPC surface
//
// EVERY shape below is renderer-visible. None of them carries key material, and
// none ever will: the API key flows renderer->main once inside
// TrackerCredentialsInput and is encrypted before it reaches sqlite.
// ---------------------------------------------------------------------------

/**
 * One line of a connection's sync log, persisted as a JSON array in
 * `tracker_connections.last_sync_log_json`. `marker` is the leading glyph the
 * connected view's log column renders in its own color; `line` is the text.
 */
export interface TrackerSyncLogEntry {
  marker: string;
  line: string;
}

/**
 * What one sync pass did — the "Sync now" mutation's result. The main-side
 * `TrackerSyncPassResult` (trackerSyncService.ts) is an alias of this type, so
 * the wire shape and the engine's own result cannot drift apart.
 */
export interface TrackerSyncPassSummary {
  connectionId: string;
  /** False when the connection id is unknown (nothing ran, nothing persisted). */
  ran: boolean;
  /** The deletion sweep ran this pass. */
  swept: boolean;
  /** The connection was left `paused` (bad/absent credentials). */
  paused: boolean;
  /** The composed log, exactly as persisted. */
  entries: TrackerSyncLogEntry[];
  /** Non-null when the pass failed; the message is also in `entries`. */
  error: string | null;
}

/**
 * One connected-view card. `workspaceName` / `actorLabel` are nullable columns
 * normalized to '' here — the card always renders a string, and "unknown
 * workspace" is not a state worth branching on in the renderer.
 */
export interface TrackerConnectionSummary {
  id: string;
  projectId: number;
  provider: TrackerProvider;
  status: TrackerConnectionStatus;
  workspaceName: string;
  actorLabel: string;
  /** Plane self-hosted origin; null on cloud/Linear connections. */
  baseUrl: string | null;
  /** Human label for the wizard's Step-1 choice, e.g. "Core · Cycle 12". */
  sourceLabel: string;
  selectionMode: TrackerSelectionMode;
  twoWay: boolean;
  mirrorSubissues: boolean;
  conflictMode: TrackerConflictMode;
  stateMapping: TrackerStateMapping;
  lastSyncAt: string | null;
  lastSyncLog: TrackerSyncLogEntry[];
  /** Active (non-orphaned) entity links on this connection. */
  linkedCount: number;
  openConflictCount: number;
}

/** `tracker_conflicts.kind` (mirrors TrackerConflictRow). */
export type TrackerConflictKind = 'field_conflict' | 'remote_deleted';

/** The user's per-conflict decision in the connected view's conflict list. */
export type TrackerConflictChoice = 'local' | 'remote';

/**
 * One row of the Manual-mode conflict list. `entityRef` / `entityTitle` come
 * from the linked entity and are null when the conflict has no link (or the
 * entity is gone) — a `remote_deleted` conflict on a hard-deleted entity, say.
 */
export interface TrackerConflictSummary {
  id: number;
  connectionId: string;
  kind: TrackerConflictKind;
  /** 'title' | 'description' | 'stage' on a field conflict; null on remote_deleted. */
  field: string | null;
  localValue: string | null;
  remoteValue: string | null;
  entityRef: string | null;
  entityTitle: string | null;
  createdAt: string;
}

/** One row of the wizard's Reconcile step (a pre-existing backlog item). */
export interface TrackerReconcileItem {
  entityType: 'idea' | 'task';
  entityId: string;
  ref: string;
  title: string;
  /** Best title match among the fetched issues, or null when nothing matched. */
  suggestedExternalId: string | null;
}

/** The user's Keep / Link / Discard ruling for one Reconcile row. */
export interface TrackerReconcileDecision {
  entityType: 'idea' | 'task';
  entityId: string;
  action: 'keep' | 'link' | 'discard';
  /** The issue to link to — required for action 'link', ignored otherwise. */
  linkExternalId?: string;
  /**
   * The linked issue's display ref ("CORE-142") and web URL, carried alongside
   * the id so the link row lands with its ref chip populated — the wizard
   * already holds the issue list, and nothing else back-fills these later.
   */
  linkIdentifier?: string;
  linkUrl?: string;
}

/**
 * `tracker_connections.selection_json` — the wizard's Step-2 choice. Mirrors
 * the main-side `TrackerSelectionPayload` (inboundSync.ts), which reads the
 * same blob back for inbound filtering.
 */
export interface TrackerSelectionJson {
  /** selection_mode 'assignee': only issues assigned to one of these import. */
  assigneeIds?: string[];
  /** selection_mode 'manual': only these external ids import. */
  issueIds?: string[];
}

/** Everything the wizard's final Review step hands to `connect`. */
export interface TrackerConnectPayload {
  projectId: number;
  credentials: TrackerCredentialsInput;
  source: TrackerSourceSelection;
  sourceLabel: string;
  selectionMode: TrackerSelectionMode;
  selectionJson: TrackerSelectionJson | null;
  stateMapping: TrackerStateMapping;
  twoWay: boolean;
  mirrorSubissues: boolean;
  conflictMode: TrackerConflictMode;
  reconcile: TrackerReconcileDecision[];
}

/**
 * The connected view's editable settings. Every field optional — an omitted key
 * leaves the stored value untouched (mirrors the store's ConnectionSettingsPatch).
 */
export interface TrackerSettingsPatch {
  twoWay?: boolean;
  mirrorSubissues?: boolean;
  conflictMode?: TrackerConflictMode;
  stateMapping?: TrackerStateMapping;
  selectionMode?: TrackerSelectionMode;
  /** null clears the stored selection (back to "everything in the source"). */
  selectionJson?: TrackerSelectionJson | null;
}

/** An entity's live tracker link — the "open in Linear/Plane" affordance's data. */
export interface TrackerEntityLinkRef {
  provider: TrackerProvider;
  externalUrl: string | null;
  externalIdentifier: string | null;
}
