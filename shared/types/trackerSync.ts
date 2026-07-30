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
  /** Provider UUID — the stable sync key. */
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
