/**
 * LinearAdapter — the Linear implementation of the `TrackerAdapter` seam.
 * Design: docs/proposals/tracker-sync-integration.md ("Provider adapter
 * seam" + "Durability & failure semantics").
 *
 * Pure GraphQL API client: constructor-injected `FetchLike`, no sqlite, no
 * retries or timers of its own — the sync core owns durability (outbox,
 * cursor, sweep) and depends on these methods behaving as documented on
 * `TrackerAdapter`.
 *
 * Two Linear-specific wrinkles this file has to absorb:
 *  - Personal API keys go BARE in `Authorization` (no "Bearer" prefix — that
 *    prefix is OAuth2-only).
 *  - Linear reports GraphQL errors both as an HTTP 400/401 status AND as an
 *    `errors[]` array on an HTTP 200 partial-success response. Every request
 *    path below checks both; auth failures (HTTP 401, or an error whose
 *    `extensions.type`/`extensions.code` mentions "auth") throw
 *    `TrackerAuthError`, everything else throws `TrackerApiError` carrying
 *    the HTTP status.
 */

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerSourceTree,
  TrackerSourceContainer,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerState,
  TrackerStateGroup,
  TrackerIssue,
} from '../../../../shared/types/trackerSync';
import type { TrackerAdapter, TrackerAdapterCapabilities, FetchLike, SubIssueDraft } from './adapterTypes';
import { TrackerApiError, TrackerAuthError } from './errors';

const LINEAR_API_URL = 'https://api.linear.app/graphql';

// ---------------------------------------------------------------------------
// GraphQL envelope shapes
// ---------------------------------------------------------------------------

interface LinearGraphQLErrorExtensions {
  type?: string;
  code?: string;
}

interface LinearGraphQLError {
  message: string;
  extensions?: LinearGraphQLErrorExtensions;
}

interface LinearGraphQLResponse<T> {
  data?: T | null;
  errors?: LinearGraphQLError[];
}

interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface LinearConnection<TNode> {
  nodes: TNode[];
  pageInfo: LinearPageInfo;
}

function emptyConnection<TNode>(): LinearConnection<TNode> {
  return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
}

// ---------------------------------------------------------------------------
// Node/response shapes for the specific queries this adapter issues
// ---------------------------------------------------------------------------

interface LinearTeamNode {
  id: string;
  name: string;
  key: string;
}

interface LinearProjectNode {
  id: string;
  name: string;
}

interface LinearCycleNode {
  id: string;
  number: number;
  name: string | null;
}

interface LinearWorkflowStateNode {
  id: string;
  name: string;
  color: string | null;
  type: string;
}

interface LinearUserNode {
  id: string;
  name: string;
  displayName: string;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { id: string };
  assignee: LinearUserNode | null;
  estimate: number | null;
  parent: { id: string } | null;
  updatedAt: string;
  archivedAt: string | null;
}

interface ValidateCredentialsResponse {
  viewer: { id: string; name: string; displayName: string | null };
  organization: { id: string; name: string };
}

interface ListTeamsResponse {
  teams: LinearConnection<LinearTeamNode>;
}

interface ListTeamProjectsResponse {
  team: { projects: LinearConnection<LinearProjectNode> } | null;
}

interface ListTeamCyclesResponse {
  team: { cycles: LinearConnection<LinearCycleNode> } | null;
}

interface ListTeamStatesResponse {
  team: { states: { nodes: LinearWorkflowStateNode[] } } | null;
}

interface ListIssuesResponse {
  issues: LinearConnection<LinearIssueNode>;
}

interface ListIssueIdsResponse {
  issues: LinearConnection<{ id: string }>;
}

interface GetIssueResponse {
  issue: LinearIssueNode | null;
}

interface GetIssueTeamResponse {
  issue: { team: { id: string } } | null;
}

interface CreateSubIssueResponse {
  issueCreate: { success: boolean; issue: LinearIssueNode | null };
}

interface UpdateIssueStateResponse {
  issueUpdate: { success: boolean };
}

interface LinearIdEqFilter {
  eq: string;
}

interface LinearIssueFilter {
  team: { id: LinearIdEqFilter };
  project?: { id: LinearIdEqFilter };
  cycle?: { id: LinearIdEqFilter };
  updatedAt?: { gte: string };
}

interface LinearIssueCreateInput {
  id: string;
  teamId: string;
  parentId: string;
  title: string;
  description?: string;
  stateId?: string;
}

// ---------------------------------------------------------------------------
// Query/mutation text. The issue node field selection is shared across the
// three operations that return a full issue (listIssues, getIssue,
// createSubIssue) so they never drift out of sync with each other.
// ---------------------------------------------------------------------------

const ISSUE_NODE_FIELDS = `
    id
    identifier
    title
    description
    url
    state {
      id
    }
    assignee {
      id
      name
      displayName
    }
    estimate
    parent {
      id
    }
    updatedAt
    archivedAt
`;

const VALIDATE_CREDENTIALS_QUERY = `
  query ValidateCredentials {
    viewer {
      id
      name
      displayName
    }
    organization {
      id
      name
    }
  }
`;

const LIST_TEAMS_QUERY = `
  query ListTeams($after: String) {
    teams(first: 100, after: $after) {
      nodes {
        id
        name
        key
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const LIST_TEAM_PROJECTS_QUERY = `
  query ListTeamProjects($teamId: String!, $after: String) {
    team(id: $teamId) {
      projects(first: 100, after: $after) {
        nodes {
          id
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const LIST_TEAM_CYCLES_QUERY = `
  query ListTeamCycles($teamId: String!, $after: String) {
    team(id: $teamId) {
      cycles(first: 100, after: $after) {
        nodes {
          id
          number
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const LIST_TEAM_STATES_QUERY = `
  query ListTeamStates($teamId: String!) {
    team(id: $teamId) {
      states(first: 100) {
        nodes {
          id
          name
          color
          type
        }
      }
    }
  }
`;

const LIST_ISSUES_QUERY = `
  query ListIssues($filter: IssueFilter, $after: String) {
    issues(filter: $filter, first: 100, after: $after, includeArchived: true) {
      nodes {
${ISSUE_NODE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const LIST_ISSUE_IDS_QUERY = `
  query ListIssueIds($filter: IssueFilter, $after: String) {
    issues(filter: $filter, first: 100, after: $after, includeArchived: true) {
      nodes {
        id
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const GET_ISSUE_QUERY = `
  query GetIssue($id: String!) {
    issue(id: $id) {
${ISSUE_NODE_FIELDS}
    }
  }
`;

const GET_ISSUE_TEAM_QUERY = `
  query GetIssueTeam($id: String!) {
    issue(id: $id) {
      team {
        id
      }
    }
  }
`;

const CREATE_SUB_ISSUE_MUTATION = `
  mutation CreateSubIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
${ISSUE_NODE_FIELDS}
      }
    }
  }
`;

const UPDATE_ISSUE_STATE_MUTATION = `
  mutation UpdateIssueState($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
    }
  }
`;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Linear `WorkflowState.type` → cyboflow's canonical `TrackerStateGroup`. */
const STATE_TYPE_TO_GROUP: Record<string, TrackerStateGroup> = {
  triage: 'triage',
  backlog: 'backlog',
  unstarted: 'unstarted',
  started: 'started',
  completed: 'completed',
  canceled: 'cancelled',
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Linear's own error taxonomy isn't published as a stable enum; the
 * `extensions.type`/`extensions.code` values observed in practice are
 * lowercase snake_case strings like `authentication_error`. We match
 * defensively on substring rather than an exact value so a provider-side
 * rename doesn't silently stop us from recognizing an auth failure.
 */
function isAuthError(errors: LinearGraphQLError[]): boolean {
  return errors.some((error) => {
    const marker = `${error.extensions?.type ?? ''} ${error.extensions?.code ?? ''}`.toLowerCase();
    return marker.includes('auth');
  });
}

/** Same defensive-substring approach for the "entity not found" case `getIssue` needs to swallow. */
function isEntityNotFoundError(errors: LinearGraphQLError[]): boolean {
  return errors.some((error) => {
    const marker = `${error.extensions?.type ?? ''} ${error.extensions?.code ?? ''}`.toLowerCase();
    return marker.includes('not_found') || error.message.toLowerCase().includes('entity not found');
  });
}

function authMessage(errors: LinearGraphQLError[], status: number): string {
  if (errors.length > 0) {
    return errors.map((error) => error.message).join('; ');
  }
  return `authentication failed (HTTP ${status})`;
}

function httpOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Two-letter avatar initials; Linear has no dedicated initials field so every caller derives one. */
function deriveInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '?';
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

function mapIssueNode(node: LinearIssueNode): TrackerIssue {
  return {
    externalId: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description && node.description.length > 0 ? node.description : null,
    url: node.url,
    stateId: node.state.id,
    assignee: node.assignee
      ? {
          id: node.assignee.id,
          name: node.assignee.name,
          initials: deriveInitials(node.assignee.displayName || node.assignee.name),
        }
      : null,
    estimate: node.estimate,
    parentExternalId: node.parent?.id ?? null,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt,
    // ALWAYS null for Linear, and stated explicitly rather than left off: this
    // adapter has `capabilities.idempotentCreate`, so the outbox's client key IS
    // the created issue's id. A lost create is recovered by external id (a
    // point lookup), no marker is ever written into a body, and there is
    // therefore nothing to surface here. See TrackerIssue.recoveryClientKey.
    recoveryClientKey: null,
  };
}

function buildIssueFilter(selection: TrackerSourceSelection, sinceIso?: string): LinearIssueFilter {
  const filter: LinearIssueFilter = { team: { id: { eq: selection.containerId } } };
  if (selection.narrowKind === 'project') {
    filter.project = { id: { eq: selection.narrowId } };
  } else if (selection.narrowKind === 'cycle') {
    filter.cycle = { id: { eq: selection.narrowId } };
  }
  // 'all' (and 'view'/'module', which listNarrows never produces for Linear)
  // fall through to the team-only filter.
  if (sinceIso) {
    filter.updatedAt = { gte: sinceIso };
  }
  return filter;
}

async function paginateConnection<TNode>(
  fetchPage: (after: string | null) => Promise<LinearConnection<TNode>>
): Promise<TNode[]> {
  const collected: TNode[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await fetchPage(after);
    collected.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) {
      break;
    }
    after = page.pageInfo.endCursor;
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface LinearAdapterOptions {
  apiKey: string;
  /** Injected at construction so adapter tests never touch the network. */
  fetchImpl?: FetchLike;
}

export class LinearAdapter implements TrackerAdapter {
  readonly provider: TrackerProvider = 'linear';
  readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: true,
    selfHostedBaseUrl: false,
    idempotentCreate: true,
  };

  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: LinearAdapterOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    const data = await this.request<ValidateCredentialsResponse>(VALIDATE_CREDENTIALS_QUERY);
    return {
      workspaceId: data.organization.id,
      workspaceName: data.organization.name,
      actorLabel: data.viewer.displayName ?? data.viewer.name,
    };
  }

  async listContainers(): Promise<TrackerSourceTree> {
    const nodes = await paginateConnection<LinearTeamNode>((after) =>
      this.request<ListTeamsResponse>(LIST_TEAMS_QUERY, { after }).then((data) => data.teams)
    );
    const containers: TrackerSourceContainer[] = nodes.map((node) => ({
      id: node.id,
      name: node.name,
      key: node.key,
      // The exact open-issue count requires a separate expensive query per
      // team; skipped for v1 per the design doc.
      openIssueCount: null,
    }));
    return { containerLabel: 'Team', containers };
  }

  async listNarrows(containerId: string): Promise<TrackerSourceNarrow[]> {
    const [projects, cycles] = await Promise.all([
      paginateConnection<LinearProjectNode>((after) =>
        this.request<ListTeamProjectsResponse>(LIST_TEAM_PROJECTS_QUERY, { teamId: containerId, after }).then(
          (data) => data.team?.projects ?? emptyConnection<LinearProjectNode>()
        )
      ),
      paginateConnection<LinearCycleNode>((after) =>
        this.request<ListTeamCyclesResponse>(LIST_TEAM_CYCLES_QUERY, { teamId: containerId, after }).then(
          (data) => data.team?.cycles ?? emptyConnection<LinearCycleNode>()
        )
      ),
    ]);

    const narrows: TrackerSourceNarrow[] = [
      { id: 'all', kind: 'all', name: 'Whole team · all open issues', issueCount: null },
      ...projects.map((project) => ({
        id: project.id,
        kind: 'project' as const,
        name: project.name,
        issueCount: null,
      })),
      ...cycles.map((cycle) => ({
        id: cycle.id,
        kind: 'cycle' as const,
        name: cycle.name ? `Cycle ${cycle.number} · ${cycle.name}` : `Cycle ${cycle.number}`,
        issueCount: null,
      })),
    ];
    // Linear custom views are deliberately out of v1 scope (design doc "V2").
    return narrows;
  }

  async listStates(selection: TrackerSourceSelection): Promise<TrackerState[]> {
    const data = await this.request<ListTeamStatesResponse>(LIST_TEAM_STATES_QUERY, {
      teamId: selection.containerId,
    });
    const nodes = data.team?.states.nodes ?? [];
    return nodes.map((node) => ({
      id: node.id,
      name: node.name,
      color: node.color,
      group: STATE_TYPE_TO_GROUP[node.type] ?? 'backlog',
    }));
  }

  async listIssues(selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]> {
    const filter = buildIssueFilter(selection, sinceIso);
    const nodes = await paginateConnection<LinearIssueNode>((after) =>
      this.request<ListIssuesResponse>(LIST_ISSUES_QUERY, { filter, after }).then((data) => data.issues)
    );
    return nodes.map(mapIssueNode);
  }

  async listIssueIds(selection: TrackerSourceSelection): Promise<string[]> {
    const filter = buildIssueFilter(selection);
    const nodes = await paginateConnection<{ id: string }>((after) =>
      this.request<ListIssueIdsResponse>(LIST_ISSUE_IDS_QUERY, { filter, after }).then((data) => data.issues)
    );
    return nodes.map((node) => node.id);
  }

  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    const { data, errors, status } = await this.execute<GetIssueResponse>(GET_ISSUE_QUERY, { id: externalId });
    if (status === 401 || isAuthError(errors)) {
      throw new TrackerAuthError('linear', authMessage(errors, status), status);
    }
    if (isEntityNotFoundError(errors)) {
      return null;
    }
    if (errors.length > 0) {
      throw new TrackerApiError('linear', errors.map((error) => error.message).join('; '), status);
    }
    if (!httpOk(status)) {
      throw new TrackerApiError('linear', `unexpected HTTP status ${status}`, status);
    }
    const issue = data?.issue ?? null;
    return issue ? mapIssueNode(issue) : null;
  }

  async createSubIssue(parentExternalId: string, draft: SubIssueDraft, clientKey: string): Promise<TrackerIssue> {
    const { data, errors, status } = await this.execute<GetIssueTeamResponse>(GET_ISSUE_TEAM_QUERY, {
      id: parentExternalId,
    });
    if (status === 401 || isAuthError(errors)) {
      throw new TrackerAuthError('linear', authMessage(errors, status), status);
    }
    if (isEntityNotFoundError(errors) || !data?.issue) {
      throw new TrackerApiError('linear', `parent issue not found: ${parentExternalId}`, status);
    }
    if (errors.length > 0) {
      throw new TrackerApiError('linear', errors.map((error) => error.message).join('; '), status);
    }
    if (!httpOk(status)) {
      throw new TrackerApiError('linear', `unexpected HTTP status ${status}`, status);
    }

    const input: LinearIssueCreateInput = {
      // The client-supplied id IS the idempotency mechanism: outbox recovery
      // is a getIssue(clientKey) lookup after a lost response/crash.
      id: clientKey,
      teamId: data.issue.team.id,
      parentId: parentExternalId,
      title: draft.title,
      description: draft.description,
      stateId: draft.stateId,
    };
    const created = await this.request<CreateSubIssueResponse>(CREATE_SUB_ISSUE_MUTATION, { input });
    if (!created.issueCreate.success || !created.issueCreate.issue) {
      throw new TrackerApiError('linear', 'issueCreate reported failure', null);
    }
    return mapIssueNode(created.issueCreate.issue);
  }

  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    const data = await this.request<UpdateIssueStateResponse>(UPDATE_ISSUE_STATE_MUTATION, {
      id: externalId,
      input: { stateId },
    });
    if (!data.issueUpdate.success) {
      throw new TrackerApiError('linear', `issueUpdate reported failure for ${externalId}`, null);
    }
  }

  /** Low-level POST + JSON parse; never throws on GraphQL-level errors — callers decide. */
  private async execute<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ data: T | null; errors: LinearGraphQLError[]; status: number }> {
    let httpResponse: Response;
    try {
      httpResponse = await this.fetchImpl(LINEAR_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Personal API keys go BARE — no "Bearer" prefix (that's OAuth2-only).
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new TrackerApiError('linear', `network request failed: ${errorMessage(err)}`, null);
    }

    let body: LinearGraphQLResponse<T>;
    try {
      body = (await httpResponse.json()) as LinearGraphQLResponse<T>;
    } catch (err) {
      throw new TrackerApiError('linear', `invalid JSON response: ${errorMessage(err)}`, httpResponse.status);
    }

    return { data: body.data ?? null, errors: body.errors ?? [], status: httpResponse.status };
  }

  /** Standard request path: throws typed errors, asserts `data` is present. */
  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const { data, errors, status } = await this.execute<T>(query, variables);
    if (status === 401 || isAuthError(errors)) {
      throw new TrackerAuthError('linear', authMessage(errors, status), status);
    }
    if (errors.length > 0) {
      throw new TrackerApiError('linear', errors.map((error) => error.message).join('; '), status);
    }
    if (!httpOk(status)) {
      throw new TrackerApiError('linear', `unexpected HTTP status ${status}`, status);
    }
    if (data === null) {
      throw new TrackerApiError('linear', 'empty response body', status);
    }
    return data;
  }
}
