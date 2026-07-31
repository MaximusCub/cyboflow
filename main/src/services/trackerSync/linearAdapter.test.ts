/**
 * LinearAdapter unit tests.
 *
 * Drives the adapter through its injected `FetchLike` seam — no real network
 * call — so the GraphQL request shape (headers, variables, pagination) and
 * the response-mapping/error-classification logic are asserted
 * deterministically. Covers: bare-key auth + happy-path identity mapping,
 * HTTP-401 → TrackerAuthError, listIssues cross-page pagination with the
 * `updatedAt.gte` filter threaded through, Linear's "canceled" state type
 * mapping to the canonical "cancelled" group, createSubIssue's
 * client-key-as-id idempotency wiring, getIssue swallowing an
 * entity-not-found GraphQL error into `null`, and updateIssueState's
 * mutation shape.
 */
import { describe, it, expect } from 'vitest';
import { LinearAdapter } from './linearAdapter';
import { TrackerAuthError } from './errors';
import type { FetchLike, IssueDraft } from './adapterTypes';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

interface QueuedResponse {
  status: number;
  body: unknown;
}

/** A minimal `Response` stand-in — only `status`/`json()` are ever read. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Builds a `FetchLike` that answers with `responses` in order (the last
 * response repeats if more calls happen than were queued) and records every
 * call so tests can assert on the request shape.
 */
function createFetchMock(responses: QueuedResponse[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const queued = responses[calls.length - 1] ?? responses[responses.length - 1];
    return jsonResponse(queued.status, queued.body);
  }) as FetchLike;
  return { fetchImpl, calls };
}

function parseBody(call: RecordedCall): { query: string; variables?: Record<string, unknown> } {
  return JSON.parse(String(call.init.body)) as { query: string; variables?: Record<string, unknown> };
}

/** A GraphQL issue node shaped like Linear's `issues`/`issue` response. */
function issueNode(overrides: {
  id?: string;
  identifier?: string;
  parentId?: string | null;
}): unknown {
  return {
    id: overrides.id ?? 'issue-1',
    identifier: overrides.identifier ?? 'COR-1',
    title: 'Some issue',
    description: null,
    url: 'https://linear.app/acme/issue/COR-1',
    state: { id: 'state-1' },
    assignee: null,
    estimate: null,
    parent: overrides.parentId ? { id: overrides.parentId } : null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
  };
}

describe('LinearAdapter.validateCredentials', () => {
  it('resolves workspace identity and sends the bare API key (no Bearer prefix)', async () => {
    const { fetchImpl, calls } = createFetchMock([
      {
        status: 200,
        body: {
          data: {
            viewer: { id: 'u1', name: 'Jane Doe', displayName: 'jane' },
            organization: { id: 'org-1', name: 'Acme' },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'lin_api_secret', fetchImpl });

    const identity = await adapter.validateCredentials();

    expect(identity).toEqual({ workspaceId: 'org-1', workspaceName: 'Acme', actorLabel: 'jane' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.linear.app/graphql');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('lin_api_secret');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('LinearAdapter auth failures', () => {
  it('throws TrackerAuthError on an HTTP 401', async () => {
    const { fetchImpl } = createFetchMock([
      { status: 401, body: { errors: [{ message: 'Authentication required.' }] } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'revoked-key', fetchImpl });

    await expect(adapter.validateCredentials()).rejects.toBeInstanceOf(TrackerAuthError);
  });

  it('throws TrackerAuthError for an authentication-coded error on an HTTP 200', async () => {
    const { fetchImpl } = createFetchMock([
      {
        status: 200,
        body: {
          errors: [{ message: 'Invalid API key', extensions: { type: 'authentication_error' } }],
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'bad-key', fetchImpl });

    await expect(adapter.validateCredentials()).rejects.toBeInstanceOf(TrackerAuthError);
  });
});

describe('LinearAdapter.listIssues', () => {
  it('paginates across two pages and threads the updatedAt gte filter through', async () => {
    const { fetchImpl, calls } = createFetchMock([
      {
        status: 200,
        body: {
          data: {
            issues: {
              nodes: [issueNode({ id: 'issue-1' })],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            issues: {
              nodes: [issueNode({ id: 'issue-2' })],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const issues = await adapter.listIssues(
      { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' },
      '2026-06-01T00:00:00.000Z'
    );

    expect(issues.map((issue) => issue.externalId)).toEqual(['issue-1', 'issue-2']);
    expect(calls).toHaveLength(2);

    const firstVariables = parseBody(calls[0]).variables ?? {};
    expect(firstVariables.after).toBeNull();
    expect(firstVariables.filter).toMatchObject({
      team: { id: { eq: 'team-1' } },
      updatedAt: { gte: '2026-06-01T00:00:00.000Z' },
    });

    const secondVariables = parseBody(calls[1]).variables ?? {};
    expect(secondVariables.after).toBe('cursor-1');
    expect(secondVariables.filter).toMatchObject({
      updatedAt: { gte: '2026-06-01T00:00:00.000Z' },
    });
  });
});

describe('LinearAdapter.listStates', () => {
  it('maps the "canceled" workflow-state type to the canonical "cancelled" group', async () => {
    const { fetchImpl } = createFetchMock([
      {
        status: 200,
        body: {
          data: {
            team: {
              states: {
                nodes: [
                  { id: 'state-cancel', name: 'Canceled', color: '#ff0000', type: 'canceled' },
                  { id: 'state-done', name: 'Done', color: '#00ff00', type: 'completed' },
                ],
              },
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const states = await adapter.listStates({ containerId: 'team-1', narrowId: 'all', narrowKind: 'all' });

    expect(states.find((state) => state.id === 'state-cancel')?.group).toBe('cancelled');
    expect(states.find((state) => state.id === 'state-done')?.group).toBe('completed');
  });
});

describe('LinearAdapter.createSubIssue', () => {
  it('sends the client key as the created issue id, and the parent id, in the mutation variables', async () => {
    const { fetchImpl, calls } = createFetchMock([
      // 1) resolve the parent's team
      { status: 200, body: { data: { issue: { team: { id: 'team-1' } } } } },
      // 2) the issueCreate mutation
      {
        status: 200,
        body: {
          data: {
            issueCreate: {
              success: true,
              issue: issueNode({ id: 'client-key-123', identifier: 'COR-2', parentId: 'parent-1' }),
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });
    const draft: IssueDraft = { title: 'Sub issue', description: 'desc', stateId: 'state-todo' };

    const created = await adapter.createSubIssue('parent-1', draft, 'client-key-123');

    expect(created.externalId).toBe('client-key-123');
    expect(created.parentExternalId).toBe('parent-1');
    expect(calls).toHaveLength(2);

    const mutationVariables = parseBody(calls[1]).variables ?? {};
    expect(mutationVariables.input).toMatchObject({
      id: 'client-key-123',
      parentId: 'parent-1',
      teamId: 'team-1',
      title: 'Sub issue',
      description: 'desc',
      stateId: 'state-todo',
    });
  });
});

describe('LinearAdapter.createIssue', () => {
  it('files a TOP-LEVEL issue against the selection team, with no parent and the client key as its id', async () => {
    const { fetchImpl, calls } = createFetchMock([
      // ONE call: no parent to resolve a team from — the selection IS the team.
      {
        status: 200,
        body: {
          data: {
            issueCreate: {
              success: true,
              issue: issueNode({ id: 'client-key-push', identifier: 'COR-9' }),
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const created = await adapter.createIssue(
      { containerId: 'team-1', narrowId: 'cycle-3', narrowKind: 'cycle' },
      { title: 'Pushed idea', description: 'body', stateId: 'state-todo' },
      'client-key-push',
    );

    expect(created.externalId).toBe('client-key-push');
    expect(created.parentExternalId).toBeNull();
    expect(calls).toHaveLength(1);

    const input = (parseBody(calls[0]).variables ?? {}).input as Record<string, unknown>;
    expect(input).toMatchObject({
      id: 'client-key-push',
      teamId: 'team-1',
      title: 'Pushed idea',
      description: 'body',
      stateId: 'state-todo',
    });
    // No parent — that is what makes it top-level.
    expect(input.parentId).toBeUndefined();
  });

  it('throws when issueCreate reports failure', async () => {
    const { fetchImpl } = createFetchMock([
      { status: 200, body: { data: { issueCreate: { success: false, issue: null } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(
      adapter.createIssue(
        { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' },
        { title: 'Pushed idea' },
        'client-key-push',
      ),
    ).rejects.toThrow(/issueCreate reported failure/);
  });
});

describe('LinearAdapter.getIssue', () => {
  it('returns null on an entity-not-found GraphQL error instead of throwing', async () => {
    const { fetchImpl } = createFetchMock([
      {
        status: 200,
        body: {
          data: null,
          errors: [{ message: 'Entity not found: Issue', extensions: { type: 'not_found' } }],
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(adapter.getIssue('missing-id')).resolves.toBeNull();
  });
});

describe('LinearAdapter.updateIssueState', () => {
  it('posts the issueUpdate mutation with the external id and target state id', async () => {
    const { fetchImpl, calls } = createFetchMock([
      { status: 200, body: { data: { issueUpdate: { success: true } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await adapter.updateIssueState('issue-99', 'state-done');

    expect(calls).toHaveLength(1);
    const body = parseBody(calls[0]);
    expect(body.query).toContain('mutation UpdateIssueState');
    expect(body.variables).toEqual({ id: 'issue-99', input: { stateId: 'state-done' } });
  });
});
