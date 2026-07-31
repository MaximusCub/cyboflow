/**
 * PlaneAdapter — tracker-sync provider adapter for plane.so (cloud + self-
 * hosted). Design: docs/proposals/tracker-sync-integration.md ("Provider
 * adapter seam").
 *
 * Pure REST client: constructor-injected `FetchLike`, no sqlite, no retry
 * loops, no timers — durability (outbox, cursor, sweep) lives in the sync
 * core, not here. Every method that crosses the network throws only
 * `TrackerApiError`/`TrackerAuthError` (see errors.ts).
 *
 * externalId is COMPOSITE: `"<projectId>/<issueId>"`. Plane's REST paths are
 * project-scoped (`/projects/{id}/issues/{id}/`), so the adapter encodes the
 * project into the opaque id it hands the sync core and parses it back out
 * on every call that takes one. `parentExternalId` on a returned `TrackerIssue`
 * always composites against the SAME project — Plane sub-issues cannot cross
 * projects.
 *
 * Verified against https://developers.plane.so (2026-07-30). A few response
 * shapes are under-documented there; see the "documented choice" comments
 * below for what this adapter assumes and why.
 */

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerSourceTree,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerState,
  TrackerStateGroup,
  TrackerIssue,
  TrackerUserRef,
} from '../../../../shared/types/trackerSync';
import type {
  TrackerAdapter,
  TrackerAdapterCapabilities,
  FetchLike,
  SubIssueDraft,
} from './adapterTypes';
import { TrackerApiError, TrackerAuthError } from './errors';

const PROVIDER: TrackerProvider = 'plane';
const DEFAULT_BASE_URL = 'https://api.plane.so';
/** Cloud API and cloud app UI live on separate hosts; self-hosted shares one. */
const CLOUD_APP_ORIGIN = 'https://app.plane.so';

const CAPABILITIES: TrackerAdapterCapabilities = {
  nativeParentAutoClose: false,
  selfHostedBaseUrl: true,
  // Plane has no client-supplied issue id on create — outbox recovery for an
  // ambiguous create is reconcile-by-listing-sub-issues, not a lookup here.
  idempotentCreate: false,
};

const KNOWN_STATE_GROUPS: ReadonlySet<string> = new Set([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
]);

export interface PlaneAdapterOptions {
  apiKey: string;
  workspaceSlug: string;
  /** Self-hosted instance origin; omitted = Plane cloud. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

// ---------------------------------------------------------------------------
// Wire shapes (only the fields this adapter reads/writes; Plane's objects
// carry more).
// ---------------------------------------------------------------------------

interface PlanePage<T> {
  results: T[];
  next_cursor: string | null;
  next_page_results: boolean;
}

interface PlaneUserWire {
  id: string;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

interface PlaneProjectWire {
  id: string;
  name: string;
  identifier: string;
}

interface PlaneCycleWire {
  id: string;
  name: string;
}

interface PlaneModuleWire {
  id: string;
  name: string;
}

interface PlaneStateWire {
  id: string;
  name: string;
  color: string | null;
  group: string;
}

interface PlaneIssueWire {
  id: string;
  name: string;
  sequence_id: number;
  description_html?: string | null;
  /** Not documented on every endpoint; used when present, see mapDescription. */
  description_stripped?: string | null;
  description?: string | null;
  state: string;
  assignees?: Array<string | PlaneUserWire>;
  estimate_point?: number | null;
  parent?: string | null;
  updated_at: string;
  archived_at?: string | null;
}

/** Link record returned by the cycle-issues / module-issues endpoints. */
interface PlaneMembershipLinkWire {
  issue: string;
}

// ---------------------------------------------------------------------------

export class PlaneAdapter implements TrackerAdapter {
  readonly provider: TrackerProvider = PROVIDER;
  readonly capabilities: TrackerAdapterCapabilities = CAPABILITIES;

  private readonly apiKey: string;
  private readonly workspaceSlug: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  /** projectId → project.identifier ("COR"), fetched once and reused. */
  private readonly projectIdentifierCache = new Map<string, string>();

  constructor(options: PlaneAdapterOptions) {
    this.apiKey = options.apiKey;
    this.workspaceSlug = options.workspaceSlug;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    const me = await this.request<PlaneUserWire>('GET', '/users/me/');
    // Authorization probe for the configured slug specifically — /users/me/
    // only proves the key is live, not that it can see this workspace.
    await this.request('GET', `/workspaces/${this.workspaceSlug}/projects/`);
    return {
      // Plane's REST API exposes no prettier workspace display name on
      // /users/me/ or /workspaces/{slug}/projects/ — the slug is all we have
      // at this seam. (Documented choice — see task notes.)
      workspaceId: this.workspaceSlug,
      workspaceName: this.workspaceSlug,
      actorLabel: deriveActorLabel(me),
    };
  }

  async listContainers(): Promise<TrackerSourceTree> {
    const projects = await this.paginateAll<PlaneProjectWire>(
      `/workspaces/${this.workspaceSlug}/projects/`
    );
    return {
      containerLabel: 'Project',
      containers: projects.map((project) => ({
        id: project.id,
        name: project.name,
        key: project.identifier ?? null,
        openIssueCount: null,
      })),
    };
  }

  async listNarrows(containerId: string): Promise<TrackerSourceNarrow[]> {
    const [cycles, modules] = await Promise.all([
      this.paginateAll<PlaneCycleWire>(
        `/workspaces/${this.workspaceSlug}/projects/${containerId}/cycles/`
      ),
      this.paginateAll<PlaneModuleWire>(
        `/workspaces/${this.workspaceSlug}/projects/${containerId}/modules/`
      ),
    ]);
    return [
      { id: 'all', kind: 'all', name: 'Whole project · all work items', issueCount: null },
      ...cycles.map((cycle) => ({
        id: cycle.id,
        kind: 'cycle' as const,
        name: cycle.name,
        issueCount: null,
      })),
      ...modules.map((mod) => ({
        id: mod.id,
        kind: 'module' as const,
        name: mod.name,
        issueCount: null,
      })),
    ];
  }

  async listStates(selection: TrackerSourceSelection): Promise<TrackerState[]> {
    const states = await this.paginateAll<PlaneStateWire>(
      `/workspaces/${this.workspaceSlug}/projects/${selection.containerId}/states/`
    );
    return states.map((state) => ({
      id: state.id,
      name: state.name,
      color: state.color ?? null,
      group: normalizeStateGroup(state.group),
    }));
  }

  async listIssues(
    selection: TrackerSourceSelection,
    sinceIso?: string
  ): Promise<TrackerIssue[]> {
    const projectId = selection.containerId;
    const raw = await this.paginateAll<PlaneIssueWire>(
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/`,
      // Documented choice: Plane's issue list returns bare assignee UUIDs by
      // default; `expand=assignees` (per the API's documented `expand` query
      // param) returns full user objects so assignee.name/initials can be
      // derived without an N+1 user lookup per issue.
      { expand: 'assignees' }
    );
    const scoped = await this.filterByNarrow(projectId, selection, raw);
    const identifier = await this.getProjectIdentifier(projectId);
    const mapped = scoped.map((issue) => this.mapIssue(projectId, identifier, issue));
    if (sinceIso === undefined) return mapped;
    // Plane has no reliable server-side updated-at filter, so this filters
    // client-side over the fetched scope. The bound is INCLUSIVE per the
    // adapter contract (the sync core's overlap window depends on it).
    const sinceMs = Date.parse(sinceIso);
    return mapped.filter((issue) => Date.parse(issue.updatedAt) >= sinceMs);
  }

  async listIssueIds(selection: TrackerSourceSelection): Promise<string[]> {
    const projectId = selection.containerId;
    const raw = await this.paginateAll<{ id: string }>(
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/`,
      // Slim response: the deletion sweep only needs ids.
      { fields: 'id' }
    );
    const scoped = await this.filterByNarrow(projectId, selection, raw);
    return scoped.map((issue) => composeId(projectId, issue.id));
  }

  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    const { projectId, issueId } = splitExternalId(externalId);
    const response = await this.send(
      'GET',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}/?expand=assignees`
    );
    if (response.status === 404) return null;
    this.assertOk(response);
    const raw = (await response.json()) as PlaneIssueWire;
    const identifier = await this.getProjectIdentifier(projectId);
    return this.mapIssue(projectId, identifier, raw);
  }

  async createSubIssue(
    parentExternalId: string,
    draft: SubIssueDraft,
    // Plane has no idempotency key on create (capabilities.idempotentCreate
    // = false) — the outbox reconciles ambiguous creates by listing the
    // parent's sub-issues, not by anything this adapter does with the key.
    _clientKey: string
  ): Promise<TrackerIssue> {
    const { projectId, issueId: parentIssueId } = splitExternalId(parentExternalId);
    const body: Record<string, unknown> = {
      name: draft.title,
      description_html: toDescriptionHtml(draft.description),
      parent: parentIssueId,
    };
    if (draft.stateId !== undefined) {
      body.state = draft.stateId;
    }
    const raw = await this.request<PlaneIssueWire>(
      'POST',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/`,
      body
    );
    const identifier = await this.getProjectIdentifier(projectId);
    return this.mapIssue(projectId, identifier, raw);
  }

  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    const { projectId, issueId } = splitExternalId(externalId);
    await this.request(
      'PATCH',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}/`,
      { state: stateId }
    );
  }

  // ---- internals -----------------------------------------------------

  /**
   * Narrows the already-fetched project issue list down to a cycle/module
   * membership set. Documented choice: Plane's cycle-issues/module-issues
   * endpoints return thin link records (issue id only, per the API's
   * `cycle-issues`/`module-issues` overview) rather than full issue objects,
   * so this filters the project-scoped fetch by membership instead of
   * re-mapping from the link endpoint directly — one shape to map, not two.
   */
  private async filterByNarrow<T extends { id: string }>(
    projectId: string,
    selection: TrackerSourceSelection,
    issues: T[]
  ): Promise<T[]> {
    if (selection.narrowKind === 'cycle') {
      return this.filterByMembership(
        issues,
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/cycles/${selection.narrowId}/cycle-issues/`
      );
    }
    if (selection.narrowKind === 'module') {
      return this.filterByMembership(
        issues,
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/modules/${selection.narrowId}/module-issues/`
      );
    }
    // 'all' (and any narrow kind Plane never emits, e.g. Linear's 'view') —
    // the whole project scope.
    return issues;
  }

  private async filterByMembership<T extends { id: string }>(
    issues: T[],
    membershipPath: string
  ): Promise<T[]> {
    const links = await this.paginateAll<PlaneMembershipLinkWire>(membershipPath);
    const memberIds = new Set(links.map((link) => link.issue));
    return issues.filter((issue) => memberIds.has(issue.id));
  }

  private async getProjectIdentifier(projectId: string): Promise<string> {
    const cached = this.projectIdentifierCache.get(projectId);
    if (cached !== undefined) return cached;
    const project = await this.request<PlaneProjectWire>(
      'GET',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/`
    );
    this.projectIdentifierCache.set(projectId, project.identifier);
    return project.identifier;
  }

  private mapIssue(projectId: string, identifier: string, raw: PlaneIssueWire): TrackerIssue {
    return {
      externalId: composeId(projectId, raw.id),
      identifier: `${identifier}-${raw.sequence_id}`,
      title: raw.name,
      description: mapDescription(raw),
      url: this.buildIssueUrl(projectId, raw.id),
      stateId: raw.state,
      assignee: mapAssignee(raw.assignees),
      estimate: raw.estimate_point ?? null,
      parentExternalId: raw.parent ? composeId(projectId, raw.parent) : null,
      updatedAt: raw.updated_at,
      archivedAt: raw.archived_at ?? null,
    };
  }

  private buildIssueUrl(projectId: string, issueId: string): string {
    // Documented choice: cloud API (api.plane.so) and cloud app
    // (app.plane.so) are separate hosts, so the default base URL can't
    // double as the web origin. Self-hosted instances serve app + API from
    // the same origin, so baseUrl IS the web origin there.
    const origin = this.baseUrl === DEFAULT_BASE_URL ? CLOUD_APP_ORIGIN : this.baseUrl;
    return `${origin}/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}`;
  }

  private async paginateAll<T>(
    pathFromApiV1: string,
    extraParams: Record<string, string> = {}
  ): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ per_page: '100', ...extraParams });
      if (cursor !== undefined) params.set('cursor', cursor);
      const page = await this.request<PlanePage<T>>('GET', `${pathFromApiV1}?${params.toString()}`);
      results.push(...page.results);
      if (!page.next_page_results || page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    return results;
  }

  private async request<T>(method: string, pathFromApiV1: string, body?: unknown): Promise<T> {
    const response = await this.send(method, pathFromApiV1, body);
    this.assertOk(response);
    if (response.status === 204) return undefined as unknown as T;
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  private send(method: string, pathFromApiV1: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/api/v1${pathFromApiV1}`, {
      method,
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private assertOk(response: Response): void {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new TrackerAuthError(PROVIDER, `request failed (${response.status})`, response.status);
    }
    throw new TrackerApiError(PROVIDER, `request failed (${response.status})`, response.status);
  }
}

// ---------------------------------------------------------------------------
// Free helpers (no adapter state needed).
// ---------------------------------------------------------------------------

function composeId(projectId: string, issueId: string): string {
  return `${projectId}/${issueId}`;
}

function splitExternalId(externalId: string): { projectId: string; issueId: string } {
  const separatorIndex = externalId.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === externalId.length - 1) {
    throw new Error(`[plane] malformed composite externalId: "${externalId}"`);
  }
  return {
    projectId: externalId.slice(0, separatorIndex),
    issueId: externalId.slice(separatorIndex + 1),
  };
}

function normalizeStateGroup(group: string): TrackerStateGroup {
  // Plane's own groups (backlog/unstarted/started/completed/cancelled) map
  // straight onto ours; Plane has no 'triage' group. An unrecognized group
  // (a future Plane addition) falls back to 'backlog' rather than throwing —
  // states only seed mapping defaults, they never gate the sync itself.
  return KNOWN_STATE_GROUPS.has(group) ? (group as TrackerStateGroup) : 'backlog';
}

function deriveActorLabel(user: PlaneUserWire): string {
  if (user.display_name && user.display_name.trim().length > 0) {
    return user.display_name.trim();
  }
  const fullName = [user.first_name, user.last_name]
    .filter((part) => part !== null && part !== undefined && part.trim().length > 0)
    .join(' ')
    .trim();
  if (fullName.length > 0) return fullName;
  if (user.email && user.email.trim().length > 0) return user.email.trim();
  return 'Plane user';
}

function mapDescription(raw: PlaneIssueWire): string | null {
  // Documented choice: prefer whichever plain-text field the endpoint
  // happens to carry (Plane's list/detail responses are inconsistent about
  // exposing `description_stripped` vs a plain `description`) over the rich
  // `description_html`, falling back to a naive tag-strip of the html.
  const plain = raw.description_stripped ?? raw.description ?? null;
  if (plain !== null && plain.trim().length > 0) return plain.trim();
  if (raw.description_html) {
    const naive = stripHtml(raw.description_html).trim();
    if (naive.length > 0) return naive;
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapAssignee(assignees: Array<string | PlaneUserWire> | undefined): TrackerUserRef | null {
  if (!assignees || assignees.length === 0) return null;
  const first = assignees[0];
  if (typeof first === 'string') {
    // Bare id, no expansion available — best effort, no display name to derive.
    return { id: first, name: first, initials: deriveInitials(first) };
  }
  const name = deriveActorLabel(first);
  return { id: first.id, name, initials: deriveInitials(name) };
}

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function toDescriptionHtml(markdown: string | undefined): string | undefined {
  if (markdown === undefined) return undefined;
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return '<p></p>';
  const escaped = escapeHtml(trimmed);
  return escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br />')}</p>`)
    .join('');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
