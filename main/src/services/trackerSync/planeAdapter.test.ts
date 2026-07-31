/**
 * PlaneAdapter unit tests.
 *
 * Drives the adapter through an injected `fetchImpl` (see `scriptedFetch`
 * below) so nothing touches the network — every route is matched by method +
 * pathname (+ optional query params) and the exact requests fired are
 * captured for assertion. Covers: credential validation (happy path + 401 →
 * TrackerAuthError), the composite externalId round-trip across
 * listIssues → getIssue → updateIssueState, cursor pagination, INCLUSIVE
 * sinceIso filtering, createSubIssue's request shape (and that clientKey is
 * never sent — Plane has no idempotency key), and state-group passthrough
 * including the unknown-group → 'backlog' fallback.
 */
import { describe, it, expect, vi } from 'vitest';
import { PlaneAdapter } from './planeAdapter';
import type { FetchLike } from './adapterTypes';
import { TrackerApiError, TrackerAuthError } from './errors';
import type { TrackerSourceSelection } from '../../../../shared/types/trackerSync';

/** One `fetchImpl` request as captured by `scriptedFetch`. */
interface CapturedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface RouteHandler {
  test: (method: string, pathname: string, params: URLSearchParams) => boolean;
  respond: (body: unknown) => { status: number; body?: unknown };
}

function mockResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Builds a `FetchLike` mock that routes requests by method/pathname/query and records every call. */
function scriptedFetch(handlers: RouteHandler[]): { fetchImpl: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, headers, body });

    const { pathname, searchParams } = new URL(url);
    const handler = handlers.find((h) => h.test(method, pathname, searchParams));
    if (!handler) {
      throw new Error(`scriptedFetch: unhandled request ${method} ${url}`);
    }
    const { status, body: respBody } = handler.respond(body);
    return mockResponse(respBody ?? {}, status);
  });
  return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
}

const ALL_SELECTION: TrackerSourceSelection = {
  containerId: 'proj1',
  narrowId: 'all',
  narrowKind: 'all',
};

describe('PlaneAdapter.validateCredentials', () => {
  it('resolves workspace identity from /users/me/ + the slug probe', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/users/me/',
        respond: () => ({ status: 200, body: { id: 'u1', display_name: 'Ada Lovelace', email: 'ada@x.com' } }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/',
        respond: () => ({ status: 200, body: {} }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'secret-key', workspaceSlug: 'acme', fetchImpl });

    const identity = await adapter.validateCredentials();

    expect(identity).toEqual({ workspaceId: 'acme', workspaceName: 'acme', actorLabel: 'Ada Lovelace' });
    const meCall = calls.find((c) => c.url.includes('/users/me/'));
    expect(meCall?.headers['X-API-Key']).toBe('secret-key');
    expect(calls.some((c) => c.url.includes('/workspaces/acme/projects/'))).toBe(true);
  });

  it('falls back first_name+last_name, then email, when display_name is absent', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/users/me/',
        respond: () => ({ status: 200, body: { id: 'u1', first_name: 'Grace', last_name: 'Hopper' } }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/',
        respond: () => ({ status: 200, body: {} }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const identity = await adapter.validateCredentials();

    expect(identity.actorLabel).toBe('Grace Hopper');
  });

  it('rejects with TrackerAuthError on a 401 from /users/me/', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/users/me/',
        respond: () => ({ status: 401, body: { detail: 'invalid key' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'bad-key', workspaceSlug: 'acme', fetchImpl });

    await expect(adapter.validateCredentials()).rejects.toBeInstanceOf(TrackerAuthError);
    await expect(adapter.validateCredentials()).rejects.toMatchObject({ status: 401, provider: 'plane' });
  });

  it('rejects with TrackerApiError (not TrackerAuthError) on a non-auth failure', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/users/me/',
        respond: () => ({ status: 500, body: { detail: 'boom' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    await expect(adapter.validateCredentials()).rejects.toBeInstanceOf(TrackerApiError);
    await expect(adapter.validateCredentials()).rejects.not.toBeInstanceOf(TrackerAuthError);
  });
});

describe('PlaneAdapter composite externalId round-trip', () => {
  const issueWire = {
    id: 'iss1',
    name: 'Fix the bug',
    sequence_id: 42,
    description: 'plain description',
    state: 'state-open',
    assignees: [],
    estimate_point: 3,
    parent: null,
    updated_at: '2026-07-01T00:00:00.000Z',
    archived_at: null,
  };

  function projectScopedFetch() {
    return scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/issues/',
        respond: () => ({ status: 200, body: { results: [issueWire], next_cursor: null, next_page_results: false } }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj One', identifier: 'PROJ' } }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/issues/iss1/',
        respond: () => ({ status: 200, body: issueWire }),
      },
      {
        test: (method, path) => method === 'PATCH' && path === '/api/v1/workspaces/acme/projects/proj1/issues/iss1/',
        respond: () => ({ status: 200, body: { ...issueWire, state: 'state-done' } }),
      },
    ]);
  }

  it('listIssues → getIssue → updateIssueState all hit the same project-scoped path', async () => {
    const { fetchImpl, calls } = projectScopedFetch();
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issues = await adapter.listIssues(ALL_SELECTION);
    expect(issues).toHaveLength(1);
    expect(issues[0].externalId).toBe('proj1/iss1');
    expect(issues[0].identifier).toBe('PROJ-42');
    expect(issues[0].parentExternalId).toBeNull();

    const fetched = await adapter.getIssue(issues[0].externalId);
    expect(fetched).not.toBeNull();
    expect(fetched?.externalId).toBe('proj1/iss1');

    await adapter.updateIssueState(issues[0].externalId, 'state-done');

    const getCall = calls.find(
      (c) => c.method === 'GET' && c.url.includes('/projects/proj1/issues/iss1/')
    );
    expect(getCall).toBeDefined();
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.url).toContain('/workspaces/acme/projects/proj1/issues/iss1/');
    expect(patchCall?.body).toEqual({ state: 'state-done' });
  });

  it('getIssue returns null on a 404 rather than throwing', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/issues/missing/',
        respond: () => ({ status: 404, body: { detail: 'not found' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    await expect(adapter.getIssue('proj1/missing')).resolves.toBeNull();
  });
});

describe('PlaneAdapter pagination', () => {
  it('follows next_cursor until next_page_results is false', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (method, path, params) =>
          method === 'GET' && path === '/api/v1/workspaces/acme/projects/' && !params.has('cursor'),
        respond: () => ({
          status: 200,
          body: {
            results: [{ id: 'p1', name: 'Proj One', identifier: 'ONE' }],
            next_cursor: '100:1:0',
            next_page_results: true,
          },
        }),
      },
      {
        test: (method, path, params) =>
          method === 'GET' &&
          path === '/api/v1/workspaces/acme/projects/' &&
          params.get('cursor') === '100:1:0',
        respond: () => ({
          status: 200,
          body: {
            results: [{ id: 'p2', name: 'Proj Two', identifier: 'TWO' }],
            next_cursor: null,
            next_page_results: false,
          },
        }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const tree = await adapter.listContainers();

    expect(tree.containers.map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(calls.filter((c) => c.url.includes('/workspaces/acme/projects/'))).toHaveLength(2);
  });
});

describe('PlaneAdapter.listIssues sinceIso filtering', () => {
  it('is INCLUSIVE of an issue updated exactly at sinceIso', async () => {
    const base = {
      sequence_id: 1,
      state: 's1',
      assignees: [] as string[],
      estimate_point: null,
      parent: null,
      archived_at: null,
    };
    const issuesWire = [
      { ...base, id: 'before', name: 'Before', updated_at: '2026-07-01T00:00:00.000Z' },
      { ...base, id: 'exact', name: 'Exact', updated_at: '2026-07-02T00:00:00.000Z' },
      { ...base, id: 'after', name: 'After', updated_at: '2026-07-03T00:00:00.000Z' },
    ];
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/issues/',
        respond: () => ({ status: 200, body: { results: issuesWire, next_cursor: null, next_page_results: false } }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'P' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const filtered = await adapter.listIssues(ALL_SELECTION, '2026-07-02T00:00:00.000Z');

    expect(filtered.map((i) => i.externalId)).toEqual(['proj1/exact', 'proj1/after']);
  });
});

describe('PlaneAdapter.createSubIssue', () => {
  it('posts the parent id + title, ignores clientKey, and composites the returned id', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (method, path) => method === 'POST' && path === '/api/v1/workspaces/acme/projects/proj1/issues/',
        respond: () => ({
          status: 201,
          body: {
            id: 'child1',
            name: 'Sub task',
            sequence_id: 7,
            state: 'state9',
            parent: 'parentIss',
            assignees: [],
            estimate_point: null,
            updated_at: '2026-07-05T00:00:00.000Z',
            archived_at: null,
          },
        }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.createSubIssue(
      'proj1/parentIss',
      { title: 'Sub task', description: 'do the thing', stateId: 'state9' },
      'outbox-client-key-123'
    );

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.body).toMatchObject({ name: 'Sub task', parent: 'parentIss', state: 'state9' });
    expect(postCall?.body).toHaveProperty('description_html', '<p>do the thing</p>');
    // Plane has no idempotency key — the client key must never be sent.
    expect(JSON.stringify(postCall?.body)).not.toContain('outbox-client-key-123');
    expect(postCall?.url).not.toContain('outbox-client-key-123');

    expect(issue.externalId).toBe('proj1/child1');
    expect(issue.parentExternalId).toBe('proj1/parentIss');
    expect(issue.identifier).toBe('PROJ-7');
  });
});

describe('PlaneAdapter.listStates', () => {
  it('passes through canonical groups and maps an unrecognized group to backlog', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/states/',
        respond: () => ({
          status: 200,
          body: {
            results: [
              { id: 's1', name: 'Todo', color: '#e5e5e5', group: 'unstarted' },
              { id: 's2', name: 'Done', color: '#22c55e', group: 'completed' },
              { id: 's3', name: 'Mystery', color: null, group: 'some-future-group' },
            ],
            next_cursor: null,
            next_page_results: false,
          },
        }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const states = await adapter.listStates(ALL_SELECTION);

    expect(states).toEqual([
      { id: 's1', name: 'Todo', color: '#e5e5e5', group: 'unstarted' },
      { id: 's2', name: 'Done', color: '#22c55e', group: 'completed' },
      { id: 's3', name: 'Mystery', color: null, group: 'backlog' },
    ]);
  });
});
