/**
 * PlaneAdapter unit tests.
 *
 * Drives the adapter through an injected `fetchImpl` (see `scriptedFetch`
 * below) so nothing touches the network — every route is matched by method +
 * pathname (+ optional query params) and the exact requests fired are
 * captured for assertion. Covers: credential validation (happy path + 401 →
 * TrackerAuthError), the composite externalId round-trip across
 * listIssues → getIssue → updateIssueState, cursor pagination, INCLUSIVE
 * sinceIso filtering, createSubIssue's request shape (including the
 * `cyboflow-sync: <clientKey>` recovery marker every create stamps into the
 * description), the marker's removal on every read path AND the key it carries
 * being surfaced first on `recoveryClientKey` (what lets the inbound pass
 * recognize a lost create's child), the client-key lookup
 * ambiguous-create recovery runs, state-group passthrough including the
 * unknown-group → 'backlog' fallback, and the `/work-items/` ↔ `/issues/`
 * path-rename compatibility fallback (default segment, the 404→fallback
 * latch, and the both-404 error).
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

/** An outbox client key, in the shape writeBack mints (randomUUID). */
const CLIENT_KEY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

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
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/',
        respond: () => ({ status: 200, body: { results: [issueWire], next_cursor: null, next_page_results: false } }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj One', identifier: 'PROJ' } }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/iss1/',
        respond: () => ({ status: 200, body: issueWire }),
      },
      {
        test: (method, path) => method === 'PATCH' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/iss1/',
        respond: () => ({ status: 200, body: { ...issueWire, state: 'state-done' } }),
      },
    ]);
  }

  it('listIssues → getIssue → updateIssueState all hit the same project-scoped /work-items/ path', async () => {
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
      (c) => c.method === 'GET' && c.url.includes('/projects/proj1/work-items/iss1/')
    );
    expect(getCall).toBeDefined();
    const patchCall = calls.find((c) => c.method === 'PATCH');
    expect(patchCall?.url).toContain('/workspaces/acme/projects/proj1/work-items/iss1/');
    expect(patchCall?.body).toEqual({ state: 'state-done' });
    // Not the retired path — this is the regression the rename fix targets.
    expect(calls.every((c) => !c.url.includes('/projects/proj1/issues/'))).toBe(true);
  });

  it('getIssue returns null on a 404 rather than throwing (both /work-items/ and the fallback /issues/ miss)', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) =>
          method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/missing/',
        respond: () => ({ status: 404, body: { detail: 'not found' } }),
      },
      {
        test: (method, path) =>
          method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/issues/missing/',
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
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/',
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
  function createFetch(created: Record<string, unknown>) {
    return scriptedFetch([
      {
        test: (method, path) => method === 'POST' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/',
        respond: (body) => ({
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
            // Plane echoes the description it was handed — marker included.
            description_html: (body as { description_html?: string }).description_html ?? null,
            ...created,
          },
        }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
    ]);
  }

  it('posts the parent id + title, stamps the client-key marker, and composites the returned id', async () => {
    const { fetchImpl, calls } = createFetch({});
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.createSubIssue(
      'proj1/parentIss',
      { title: 'Sub task', description: 'do the thing', stateId: 'state9' },
      CLIENT_KEY
    );

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.body).toMatchObject({ name: 'Sub task', parent: 'parentIss', state: 'state9' });
    // The marker is the LAST paragraph, after the draft body.
    expect(postCall?.body).toHaveProperty(
      'description_html',
      `<p>do the thing</p><p>cyboflow-sync: ${CLIENT_KEY}</p>`
    );
    // It travels in the body, never in the path (Plane has no idempotency key).
    expect(postCall?.url).not.toContain(CLIENT_KEY);

    expect(issue.externalId).toBe('proj1/child1');
    expect(issue.parentExternalId).toBe('proj1/parentIss');
    expect(issue.identifier).toBe('PROJ-7');
    // ...and the marker never comes back out: this description is what the
    // outbox snapshots as the link's merge baseline.
    expect(issue.description).toBe('do the thing');
  });

  it('stamps the marker even when the draft carries no description', async () => {
    const { fetchImpl, calls } = createFetch({});
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    // Unconditional: recovery reads "no child carries the marker" as proof the
    // create never landed, which only holds if EVERY create sends one.
    const issue = await adapter.createSubIssue('proj1/parentIss', { title: 'Sub task' }, CLIENT_KEY);

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.body).toHaveProperty('description_html', `<p>cyboflow-sync: ${CLIENT_KEY}</p>`);
    expect(issue.description).toBeNull();
  });

  it('createIssue files into the selection PROJECT with no parent, marker included', async () => {
    const { fetchImpl, calls } = createFetch({ parent: null });
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.createIssue(
      // The narrow is a READ filter; a create targets the project only.
      { containerId: 'proj1', narrowId: 'cycle-3', narrowKind: 'cycle' },
      { title: 'Pushed idea', description: 'the idea body', stateId: 'state9' },
      CLIENT_KEY
    );

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.url).toContain('/projects/proj1/work-items/');
    expect(postCall?.body).toMatchObject({ name: 'Pushed idea', state: 'state9' });
    // No `parent` key at all — that is what makes it top-level.
    expect(postCall?.body).not.toHaveProperty('parent');
    // The recovery marker is UNCONDITIONAL here too: it is the only thing that
    // can identify a top-level create whose response was lost.
    expect(postCall?.body).toHaveProperty(
      'description_html',
      `<p>the idea body</p><p>cyboflow-sync: ${CLIENT_KEY}</p>`
    );

    expect(issue.externalId).toBe('proj1/child1');
    expect(issue.parentExternalId).toBeNull();
    expect(issue.description).toBe('the idea body');
  });
});

describe('PlaneAdapter marker stripping on read', () => {
  const base = {
    id: 'iss1',
    name: 'Fix the bug',
    sequence_id: 42,
    state: 'state-open',
    assignees: [] as string[],
    estimate_point: null,
    parent: null,
    updated_at: '2026-07-01T00:00:00.000Z',
    archived_at: null,
  };

  function readFetch(issueWire: Record<string, unknown>) {
    return scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/iss1/',
        respond: () => ({ status: 200, body: issueWire }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
    ]);
  }

  it('drops the marker paragraph from the html description it returns', async () => {
    const { fetchImpl } = readFetch({
      ...base,
      description_html: `<p>real body</p><p>cyboflow-sync: ${CLIENT_KEY}</p>`,
    });
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.getIssue('proj1/iss1');

    expect(issue?.description).toBe('real body');
  });

  it('drops the marker line from the plain-text description fields', async () => {
    const { fetchImpl } = readFetch({
      ...base,
      description_stripped: `real body\n\ncyboflow-sync: ${CLIENT_KEY}`,
    });
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.getIssue('proj1/iss1');

    expect(issue?.description).toBe('real body');
  });

  it('maps a marker-ONLY description to null (an empty body, not sync plumbing)', async () => {
    const { fetchImpl } = readFetch({
      ...base,
      description_stripped: `cyboflow-sync: ${CLIENT_KEY}`,
      description_html: `<p></p><p>cyboflow-sync: ${CLIENT_KEY}</p>`,
    });
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.getIssue('proj1/iss1');

    expect(issue?.description).toBeNull();
  });
});

describe('PlaneAdapter recovery-marker surfacing', () => {
  const base = {
    id: 'iss1',
    name: 'Fix the bug',
    sequence_id: 42,
    state: 'state-open',
    assignees: [] as string[],
    estimate_point: null,
    parent: null,
    updated_at: '2026-07-01T00:00:00.000Z',
    archived_at: null,
  };

  function detailFetch(issueWire: Record<string, unknown>) {
    return scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/iss1/',
        respond: () => ({ status: 200, body: issueWire }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
    ]);
  }

  it('surfaces the marker key on the mapped issue while still stripping it from the body', async () => {
    const { fetchImpl } = detailFetch({
      ...base,
      description_html: `<p>real body</p><p>cyboflow-sync: ${CLIENT_KEY}</p>`,
    });
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.getIssue('proj1/iss1');

    // Both halves of the contract: the key is READABLE by the sync core, and
    // the description it merges against is still marker-free.
    expect(issue?.recoveryClientKey).toBe(CLIENT_KEY);
    expect(issue?.description).toBe('real body');
  });

  it('leaves recoveryClientKey null on an issue that carries no marker', async () => {
    const { fetchImpl } = detailFetch({ ...base, description_html: '<p>real body</p>' });
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.getIssue('proj1/iss1');

    expect(issue?.recoveryClientKey).toBeNull();
    expect(issue?.description).toBe('real body');
  });

  it('surfaces it from a plain-text list payload too — the inbound pass reads listIssues', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/',
        respond: () => ({
          status: 200,
          body: {
            results: [
              { ...base, id: 'child1', description_stripped: `mine\n\ncyboflow-sync: ${CLIENT_KEY}` },
              { ...base, id: 'other1', description_stripped: 'someone else’s' },
            ],
            next_cursor: null,
            next_page_results: false,
          },
        }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issues = await adapter.listIssues(ALL_SELECTION);

    expect(issues.map((issue) => issue.recoveryClientKey)).toEqual([CLIENT_KEY, null]);
    expect(issues[0].description).toBe('mine');
  });

  it('surfaces it on the create response, which echoes the marker back', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) => method === 'POST' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/',
        respond: (body) => ({
          status: 201,
          body: {
            ...base,
            id: 'child1',
            parent: 'parentIss',
            description_html: (body as { description_html?: string }).description_html ?? null,
          },
        }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const issue = await adapter.createSubIssue('proj1/parentIss', { title: 'Sub task' }, CLIENT_KEY);

    expect(issue.recoveryClientKey).toBe(CLIENT_KEY);
  });
});

describe('PlaneAdapter.findIssueByClientKey', () => {
  const childBase = {
    sequence_id: 1,
    state: 's1',
    assignees: [] as string[],
    estimate_point: null,
    updated_at: '2026-07-01T00:00:00.000Z',
    archived_at: null,
  };

  function listFetch(results: Array<Record<string, unknown>>, details: Record<string, unknown> = {}) {
    return scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/',
        respond: () => ({ status: 200, body: { results, next_cursor: null, next_page_results: false } }),
      },
      {
        test: (method, path) =>
          method === 'GET' && /^\/api\/v1\/workspaces\/acme\/projects\/proj1\/work-items\/[^/]+\/$/.test(path),
        respond: () => ({ status: 200, body: details }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
    ]);
  }

  it('returns the child carrying the marker, NOT a same-title sibling', async () => {
    const { fetchImpl } = listFetch([
      // Same parent, same title, someone else's issue — the old match adopted this.
      { ...childBase, id: 'sibling', name: 'Sub task', parent: 'parentIss', description_html: '<p>theirs</p>' },
      {
        ...childBase,
        id: 'ours',
        name: 'Sub task',
        parent: 'parentIss',
        description_html: `<p>mine</p><p>cyboflow-sync: ${CLIENT_KEY}</p>`,
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const found = await adapter.findIssueByClientKey({ containerId: 'proj1', parentExternalId: 'proj1/parentIss' }, CLIENT_KEY);

    expect(found?.externalId).toBe('proj1/ours');
    expect(found?.description).toBe('mine');
  });

  it('returns null when no child carries the marker (proof the create never landed)', async () => {
    const { fetchImpl } = listFetch([
      { ...childBase, id: 'sibling', name: 'Sub task', parent: 'parentIss', description_html: '<p>theirs</p>' },
      // Our marker, but under a DIFFERENT parent — not the child we are recovering.
      {
        ...childBase,
        id: 'elsewhere',
        name: 'Sub task',
        parent: 'otherParent',
        description_html: `<p>cyboflow-sync: ${CLIENT_KEY}</p>`,
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    await expect(adapter.findIssueByClientKey({ containerId: 'proj1', parentExternalId: 'proj1/parentIss' }, CLIENT_KEY)).resolves.toBeNull();
  });

  it('falls back to the detail endpoint when the list payload carries no description', async () => {
    const { fetchImpl, calls } = listFetch(
      [{ ...childBase, id: 'ours', name: 'Sub task', parent: 'parentIss' }],
      {
        ...childBase,
        id: 'ours',
        name: 'Sub task',
        parent: 'parentIss',
        description_html: `<p>mine</p><p>cyboflow-sync: ${CLIENT_KEY}</p>`,
      }
    );
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const found = await adapter.findIssueByClientKey({ containerId: 'proj1', parentExternalId: 'proj1/parentIss' }, CLIENT_KEY);

    expect(found?.externalId).toBe('proj1/ours');
    expect(calls.some((c) => c.url.includes('/projects/proj1/work-items/ours/'))).toBe(true);
  });

  it('with NO parent, searches the whole container — the top-level push form', async () => {
    const { fetchImpl } = listFetch([
      // A top-level issue somebody else filed, same title.
      { ...childBase, id: 'theirs', name: 'Pushed idea', parent: null, description_html: '<p>theirs</p>' },
      {
        ...childBase,
        id: 'ours',
        name: 'Pushed idea',
        parent: null,
        description_html: `<p>mine</p><p>cyboflow-sync: ${CLIENT_KEY}</p>`,
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const found = await adapter.findIssueByClientKey(
      { containerId: 'proj1', parentExternalId: null },
      CLIENT_KEY
    );

    expect(found?.externalId).toBe('proj1/ours');
    expect(found?.parentExternalId).toBeNull();
  });

  it('throws rather than answering "not there" when it has neither a parent nor a container', async () => {
    const { fetchImpl } = listFetch([]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    // A null answer would read as "the create never landed" and license a
    // retry that could duplicate a live issue.
    await expect(
      adapter.findIssueByClientKey({ containerId: null, parentExternalId: null }, CLIENT_KEY)
    ).rejects.toBeInstanceOf(TrackerApiError);
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

describe('PlaneAdapter /work-items/ ↔ /issues/ path-rename compatibility', () => {
  const workItemBase = {
    name: 'Fix the bug',
    sequence_id: 42,
    description: null as string | null,
    state: 'state-open',
    assignees: [] as string[],
    estimate_point: null,
    parent: null as string | null,
    updated_at: '2026-07-01T00:00:00.000Z',
    archived_at: null,
  };

  it('defaults list, detail, create, and update to /work-items/ — never the retired /issues/', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/',
        respond: () => ({
          status: 200,
          body: { results: [{ ...workItemBase, id: 'iss1' }], next_cursor: null, next_page_results: false },
        }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
      {
        test: (method, path) =>
          method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/iss1/',
        respond: () => ({ status: 200, body: { ...workItemBase, id: 'iss1' } }),
      },
      {
        test: (method, path) => method === 'POST' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/',
        respond: () => ({ status: 201, body: { ...workItemBase, id: 'child1', parent: 'iss1' } }),
      },
      {
        test: (method, path) =>
          method === 'PATCH' && path === '/api/v1/workspaces/acme/projects/proj1/work-items/iss1/',
        respond: () => ({ status: 200, body: { ...workItemBase, id: 'iss1', state: 'state-done' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const listed = await adapter.listIssues(ALL_SELECTION);
    const fetched = await adapter.getIssue('proj1/iss1');
    const created = await adapter.createSubIssue('proj1/iss1', { title: 'Sub task' }, CLIENT_KEY);
    await adapter.updateIssueState('proj1/iss1', 'state-done');

    expect(listed[0]?.externalId).toBe('proj1/iss1');
    expect(fetched?.externalId).toBe('proj1/iss1');
    expect(created.externalId).toBe('proj1/child1');
    // Every request landed on /work-items/; the retired /issues/ segment was
    // never touched. This is the regression the path-rename fix targets —
    // without it, every one of these calls would 404 against the handlers
    // above (which only answer on /work-items/) and the test would fail
    // with "unhandled request" for the /issues/ URLs the old adapter sent.
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(calls.every((c) => !c.url.includes('/projects/proj1/issues/'))).toBe(true);
    expect(calls.filter((c) => c.url.includes('/projects/proj1/work-items')).length).toBe(calls.length - 1); // -1 for the project-identifier GET
  });

  it('falls back to /issues/ on a 404 from /work-items/ and latches — the next request skips the probe entirely', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      // Simulates an older self-hosted instance: the /work-items/ route does
      // not exist at all, so every request against it 404s regardless of id.
      {
        test: (_method, path) => path.includes('/work-items/'),
        respond: () => ({ status: 404, body: { detail: 'not found' } }),
      },
      {
        test: (method, path) =>
          method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/issues/iss1/',
        respond: () => ({ status: 200, body: { ...workItemBase, id: 'iss1' } }),
      },
      {
        test: (method, path) =>
          method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/issues/iss2/',
        respond: () => ({ status: 200, body: { ...workItemBase, id: 'iss2' } }),
      },
      {
        test: (method, path) => method === 'GET' && path === '/api/v1/workspaces/acme/projects/proj1/',
        respond: () => ({ status: 200, body: { id: 'proj1', name: 'Proj', identifier: 'PROJ' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    const first = await adapter.getIssue('proj1/iss1');
    expect(first?.externalId).toBe('proj1/iss1');
    // Exactly one probe against the retired path before the fallback landed.
    expect(calls.filter((c) => c.url.includes('/work-items/')).length).toBe(1);
    expect(calls.filter((c) => c.url.includes('/issues/iss1/')).length).toBe(1);

    const second = await adapter.getIssue('proj1/iss2');

    expect(second?.externalId).toBe('proj1/iss2');
    // Latched: the second request goes straight to /issues/ — no re-probe of
    // /work-items/. Without the latch this would be 2, not 1.
    expect(calls.filter((c) => c.url.includes('/work-items/')).length).toBe(1);
    expect(calls.filter((c) => c.url.includes('/issues/iss2/')).length).toBe(1);
  });

  it('throws TrackerApiError when both /work-items/ and /issues/ 404 (a real 404, not a naming mismatch)', async () => {
    const { fetchImpl } = scriptedFetch([
      {
        test: (method, path) =>
          method === 'PATCH' &&
          (path === '/api/v1/workspaces/acme/projects/proj1/work-items/missing/' ||
            path === '/api/v1/workspaces/acme/projects/proj1/issues/missing/'),
        respond: () => ({ status: 404, body: { detail: 'not found' } }),
      },
    ]);
    const adapter = new PlaneAdapter({ apiKey: 'k', workspaceSlug: 'acme', fetchImpl });

    await expect(adapter.updateIssueState('proj1/missing', 'state-x')).rejects.toBeInstanceOf(TrackerApiError);
  });
});
