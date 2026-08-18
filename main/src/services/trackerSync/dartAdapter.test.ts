/**
 * DartAdapter unit tests.
 *
 * Drives the adapter through an injected `fetchImpl` (see `scriptedFetch`) so
 * nothing touches the network — every route is matched by method + pathname
 * (+ optional query params) and the exact requests fired are captured for
 * assertion. Harness mirrors planeAdapter.test.ts.
 *
 * The emphasis is on what makes DART different from the other two providers
 * (see dartAdapter.ts's header), because that is where this adapter can be
 * wrong in ways the shared sync core cannot catch:
 *   - list responses OMIT the description, so listIssues must hydrate via
 *     GET /tasks/{id} — and a merge fed an un-hydrated null body would wipe a
 *     local one;
 *   - dartboards and statuses are addressed by TITLE, so a rename must fail
 *     LOUD rather than return an empty page the deletion sweep would act on;
 *   - statuses carry no group, so inferStateGroup guesses from the name;
 *   - creates are not idempotent, so every create stamps the
 *     `cyboflow-sync: <clientKey>` recovery marker, which must be stripped from
 *     every description the adapter returns while its key is surfaced first on
 *     `recoveryClientKey`.
 */
import { describe, it, expect, vi } from 'vitest';
import { DartAdapter, inferStateGroup } from './dartAdapter';
import type { FetchLike } from './adapterTypes';
import { TrackerApiError, TrackerAuthError } from './errors';
import type { TrackerSourceSelection } from '../../../../shared/types/trackerSync';

interface CapturedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface RouteHandler {
  test: (method: string, pathname: string, params: URLSearchParams) => boolean;
  respond: (body: unknown, params: URLSearchParams) => { status: number; body?: unknown };
}

function mockResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

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
    if (!handler) throw new Error(`scriptedFetch: unhandled request ${method} ${url}`);
    const { status, body: respBody } = handler.respond(body, searchParams);
    return mockResponse(respBody ?? {}, status);
  });
  return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
}

const BOARD = 'Engineering/Sprint';
const SELECTION: TrackerSourceSelection = { containerId: BOARD, narrowId: 'all', narrowKind: 'all' };
/** An outbox client key, in the shape writeBack mints (randomUUID). */
const CLIENT_KEY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

const CONFIG = {
  dartboards: [BOARD, 'Design/Backlog'],
  statuses: ['To-do', 'Doing', 'Done', "Won't do"],
};

/** `GET /config` — needed by nearly every path. */
function configRoute(): RouteHandler {
  return {
    test: (m, p) => m === 'GET' && p.endsWith('/config'),
    respond: () => ({ status: 200, body: CONFIG }),
  };
}

/** `GET /tasks/list` returning one page of concise rows. */
function listRoute(rows: unknown[], assertParams?: (p: URLSearchParams) => void): RouteHandler {
  return {
    test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
    respond: (_b, params) => {
      assertParams?.(params);
      // Honour BOTH limit and offset — a stub that ignores limit hands back the
      // whole set on page one and would silently pass a broken pager.
      const offset = Number(params.get('offset') ?? '0');
      const limit = Number(params.get('limit') ?? String(rows.length));
      const page = rows.slice(offset, offset + limit);
      return {
        status: 200,
        body: { count: rows.length, next: offset + page.length < rows.length ? 'next' : null, results: page },
      };
    },
  };
}

/** `GET /tasks/{id}` detail, keyed by id; an unknown id 404s. */
function makeDetailRoute(byId: Record<string, unknown | undefined>): RouteHandler {
  let lastPath = '';
  return {
    test: (m, p) => {
      const match = m === 'GET' && /\/tasks\/[^/]+$/.test(p) && !p.endsWith('/tasks/list');
      if (match) lastPath = p;
      return match;
    },
    respond: () => {
      const id = lastPath.slice(lastPath.lastIndexOf('/') + 1);
      const item = byId[id];
      return item === undefined ? { status: 404, body: { errors: ['Not found'] } } : { status: 200, body: { item } };
    },
  };
}

/** The body of the one `POST /tasks` in a captured call list. */
function postBody(calls: CapturedCall[]): unknown {
  const post = calls.find((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith('/tasks'));
  if (post === undefined) throw new Error('no POST /tasks was made');
  return post.body;
}

/** True for a `GET /tasks/{id}` detail call — NOT for `/tasks/list`. */
function isDetailCall(call: CapturedCall): boolean {
  const { pathname } = new URL(call.url);
  return /\/tasks\/[^/]+$/.test(pathname) && !pathname.endsWith('/tasks/list');
}

function task(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'AbCdEfGhIjKl',
    htmlUrl: 'https://app.dartai.com/t/AbCdEfGhIjKl',
    title: 'Ship the thing',
    parentId: null,
    dartboard: BOARD,
    status: 'Doing',
    description: 'Body text',
    assignee: 'Krishna Kesteva',
    size: 3,
    updatedAt: '2026-08-16T10:00:00Z',
    ...over,
  };
}

/** The same task as `task()` minus the description — Dart's ConciseTask shape. */
function concise(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = task(over);
  delete row.description;
  return row;
}

// ---------------------------------------------------------------------------

describe('DartAdapter.validateCredentials', () => {
  it('binds identity to the Dart ACCOUNT, since the API exposes no workspace', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/me'),
        respond: () => ({
          status: 200,
          body: { isLoggedIn: true, user: { id: 'usr_1', name: 'Krishna Kesteva', email: 'k@example.com' } },
        }),
      },
    ]);
    const identity = await new DartAdapter({ apiKey: 'k', fetchImpl }).validateCredentials();
    expect(identity).toEqual({
      workspaceId: 'usr_1',
      workspaceName: 'k@example.com',
      actorLabel: 'Krishna Kesteva',
    });
    // Bearer auth, not Plane's X-API-Key header.
    expect(calls[0].headers.Authorization).toBe('Bearer k');
    expect(calls[0].url).toBe('https://app.dartai.com/api/v0/public/me');
  });

  it('treats a 200 with isLoggedIn:false as an AUTH failure, not a generic one', async () => {
    // Dart can answer "this token resolves to no session" without a 401; taking
    // the auth path is what pauses the connection instead of retrying forever.
    const { fetchImpl } = scriptedFetch([
      {
        test: (m, p) => m === 'GET' && p.endsWith('/me'),
        respond: () => ({ status: 200, body: { isLoggedIn: false, user: {} } }),
      },
    ]);
    await expect(new DartAdapter({ apiKey: 'k', fetchImpl }).validateCredentials()).rejects.toBeInstanceOf(
      TrackerAuthError,
    );
  });

  it('maps a 401 to TrackerAuthError', async () => {
    const { fetchImpl } = scriptedFetch([
      { test: (m, p) => m === 'GET' && p.endsWith('/me'), respond: () => ({ status: 401 }) },
    ]);
    await expect(new DartAdapter({ apiKey: 'bad', fetchImpl }).validateCredentials()).rejects.toBeInstanceOf(
      TrackerAuthError,
    );
  });
});

describe('DartAdapter source discovery', () => {
  it('lists dartboards as containers whose id IS the title', async () => {
    const { fetchImpl } = scriptedFetch([configRoute()]);
    const tree = await new DartAdapter({ apiKey: 'k', fetchImpl }).listContainers();
    expect(tree.containerLabel).toBe('Dartboard');
    expect(tree.containers).toEqual([
      { id: BOARD, name: BOARD, key: null, openIssueCount: null },
      { id: 'Design/Backlog', name: 'Design/Backlog', key: null, openIssueCount: null },
    ]);
  });

  it("offers only the whole-dartboard narrow, and it is the contract's 'all'", async () => {
    const { fetchImpl } = scriptedFetch([configRoute()]);
    const narrows = await new DartAdapter({ apiKey: 'k', fetchImpl }).listNarrows(BOARD);
    expect(narrows).toHaveLength(1);
    expect(narrows[0].id).toBe('all');
    expect(narrows[0].kind).toBe('all');
  });

  it('derives state groups from status NAMES, since Dart publishes none', async () => {
    const { fetchImpl } = scriptedFetch([configRoute()]);
    const states = await new DartAdapter({ apiKey: 'k', fetchImpl }).listStates(SELECTION);
    expect(states).toEqual([
      { id: 'To-do', name: 'To-do', color: null, group: 'unstarted' },
      { id: 'Doing', name: 'Doing', color: null, group: 'started' },
      { id: 'Done', name: 'Done', color: null, group: 'completed' },
      { id: "Won't do", name: "Won't do", color: null, group: 'cancelled' },
    ]);
  });

  it('caches /config across calls on one adapter instance', async () => {
    const { fetchImpl, calls } = scriptedFetch([configRoute()]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });
    await adapter.listContainers();
    await adapter.listStates(SELECTION);
    expect(calls.filter((c) => c.url.endsWith('/config'))).toHaveLength(1);
  });
});

describe('inferStateGroup', () => {
  it('checks cancelled BEFORE completed so a wont-do name is not claimed as done', () => {
    expect(inferStateGroup("Won't do")).toBe('cancelled');
    expect(inferStateGroup('Cancelled')).toBe('cancelled');
    expect(inferStateGroup('Duplicate')).toBe('cancelled');
    expect(inferStateGroup('Done')).toBe('completed');
    expect(inferStateGroup('Shipped')).toBe('completed');
  });

  it('recognizes the common in-flight and not-started names', () => {
    expect(inferStateGroup('In Progress')).toBe('started');
    expect(inferStateGroup('In Review')).toBe('started');
    expect(inferStateGroup('To-do')).toBe('unstarted');
    expect(inferStateGroup('Up next')).toBe('unstarted');
    expect(inferStateGroup('Triage')).toBe('triage');
    expect(inferStateGroup('Backlog')).toBe('backlog');
  });

  it("falls back to 'backlog' for a name it cannot place, rather than throwing", () => {
    // A guess only SEEDS the wizard's mapping defaults, which the user overrides
    // — so an unplaceable custom status must not break discovery.
    expect(inferStateGroup('Marinating')).toBe('backlog');
    expect(inferStateGroup('')).toBe('backlog');
  });
});

describe('DartAdapter.listIssues', () => {
  it('HYDRATES every row, because the list shape omits the description', async () => {
    const rows = [concise({ id: 'aaaaaaaaaaaa' }), concise({ id: 'bbbbbbbbbbbb' })];
    const { fetchImpl, calls } = scriptedFetch([
      configRoute(),
      listRoute(rows),
      makeDetailRoute({
        aaaaaaaaaaaa: task({ id: 'aaaaaaaaaaaa', description: 'First body' }),
        bbbbbbbbbbbb: task({ id: 'bbbbbbbbbbbb', description: 'Second body' }),
      }),
    ]);
    const issues = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION);
    expect(issues.map((i) => i.description)).toEqual(['First body', 'Second body']);
    // One detail fetch per listed task — the cost the hydration note documents.
    expect(calls.filter(isDetailCall)).toHaveLength(2);
  });

  it('maps the full TrackerIssue shape off a hydrated task', async () => {
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise()]),
      makeDetailRoute({ AbCdEfGhIjKl: task() }),
    ]);
    const [issue] = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION);
    expect(issue).toEqual({
      externalId: 'AbCdEfGhIjKl',
      identifier: 'AbCdEfGhIjKl',
      title: 'Ship the thing',
      description: 'Body text',
      url: 'https://app.dartai.com/t/AbCdEfGhIjKl',
      stateId: 'Doing',
      assignee: { id: 'Krishna Kesteva', name: 'Krishna Kesteva', initials: 'KK' },
      estimate: 3,
      parentExternalId: null,
      updatedAt: '2026-08-16T10:00:00Z',
      archivedAt: null,
      recoveryClientKey: null,
    });
  });

  it('drops a row whose detail fetch 404s rather than returning a null-bodied issue', async () => {
    // A half-populated issue would merge as "the remote body was cleared" and
    // wipe the local one — so a task deleted between list and hydrate is dropped.
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise({ id: 'aaaaaaaaaaaa' }), concise({ id: 'gonegonegone' })]),
      makeDetailRoute({ aaaaaaaaaaaa: task({ id: 'aaaaaaaaaaaa' }) }),
    ]);
    const issues = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION);
    expect(issues.map((i) => i.externalId)).toEqual(['aaaaaaaaaaaa']);
  });

  it('widens the server-side since bound but applies an INCLUSIVE one client-side', async () => {
    const since = '2026-08-16T10:00:00.000Z';
    let sentAfter: string | null = null;
    const rows = [
      concise({ id: 'onbound00000', updatedAt: since }),
      concise({ id: 'older0000000', updatedAt: '2026-08-16T09:59:59.500Z' }),
      concise({ id: 'newer0000000', updatedAt: '2026-08-16T10:00:01.000Z' }),
    ];
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute(rows, (p) => {
        sentAfter = p.get('updated_at_after');
      }),
      makeDetailRoute({
        onbound00000: task({ id: 'onbound00000', updatedAt: since }),
        older0000000: task({ id: 'older0000000', updatedAt: '2026-08-16T09:59:59.500Z' }),
        newer0000000: task({ id: 'newer0000000', updatedAt: '2026-08-16T10:00:01.000Z' }),
      }),
    ]);
    const issues = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssues(SELECTION, since);
    // Sent a second EARLIER, so the contract holds under gt or gte semantics...
    expect(sentAfter).toBe('2026-08-16T09:59:59.000Z');
    // ...and the exact inclusive bound is enforced here: the on-bound task is
    // KEPT, the one half a second older is dropped.
    expect(issues.map((i) => i.externalId).sort()).toEqual(['newer0000000', 'onbound00000']);
  });

  it('fails LOUD when the dartboard title no longer exists', async () => {
    // A renamed dartboard makes GET /tasks/list return an EMPTY page, which
    // listIssueIds would hand the deletion sweep as "everything was deleted".
    const { fetchImpl } = scriptedFetch([configRoute(), listRoute([])]);
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl });
    const stale: TrackerSourceSelection = { containerId: 'Renamed/Board', narrowId: 'all', narrowKind: 'all' };
    await expect(adapter.listIssues(stale)).rejects.toThrow(/no longer exists/i);
    await expect(adapter.listIssueIds(stale)).rejects.toThrow(/no longer exists/i);
  });

  it('paginates to exhaustion via limit/offset', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => concise({ id: `id${String(i).padStart(10, '0')}` }));
    const detail: Record<string, unknown> = {};
    for (const r of rows) detail[r.id as string] = task({ id: r.id });
    const { fetchImpl, calls } = scriptedFetch([configRoute(), listRoute(rows), makeDetailRoute(detail)]);
    const ids = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssueIds(SELECTION);
    expect(ids).toHaveLength(250);
    const listCalls = calls.filter((c) => new URL(c.url).pathname.endsWith('/tasks/list'));
    expect(listCalls).toHaveLength(3);
    expect(new URL(listCalls[1].url).searchParams.get('offset')).toBe('100');
  });

  it('does NOT hydrate for listIssueIds — the sweep only needs ids', async () => {
    const rows = [concise({ id: 'aaaaaaaaaaaa' }), concise({ id: 'bbbbbbbbbbbb' })];
    const { fetchImpl, calls } = scriptedFetch([configRoute(), listRoute(rows)]);
    const ids = await new DartAdapter({ apiKey: 'k', fetchImpl }).listIssueIds(SELECTION);
    expect(ids).toEqual(['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
    expect(calls.some(isDetailCall)).toBe(false);
  });
});

describe('DartAdapter.getIssue', () => {
  it('returns null on 404 so the sweep can tell "deleted" from "failed"', async () => {
    const { fetchImpl } = scriptedFetch([makeDetailRoute({})]);
    expect(await new DartAdapter({ apiKey: 'k', fetchImpl }).getIssue('missing00000')).toBeNull();
  });
});

describe('DartAdapter creates', () => {
  it('stamps the recovery marker into every create and enveloped as { item }', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
        respond: (body) => {
          const item = (body as { item: Record<string, unknown> }).item;
          return { status: 200, body: { item: task({ ...item, id: 'newnewnewnew' }) } };
        },
      },
    ]);
    const issue = await new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(
      SELECTION,
      { title: 'New task', description: 'Do the work' },
      CLIENT_KEY,
    );
    expect(calls[0].body).toEqual({
      item: {
        dartboard: BOARD,
        title: 'New task',
        description: `Do the work\n\ncyboflow-sync: ${CLIENT_KEY}`,
      },
    });
    // The marker is plumbing: stripped from the returned description, but its
    // key surfaced first so the inbound pass can recognize a lost create.
    expect(issue.description).toBe('Do the work');
    expect(issue.recoveryClientKey).toBe(CLIENT_KEY);
  });

  it('stamps the marker even on an EMPTY body — the absence proof depends on it', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      makeDetailRoute({ parentparent: task({ id: 'parentparent', dartboard: BOARD }) }),
      {
        test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
        respond: (body) => ({
          status: 200,
          body: { item: task({ ...(body as { item: object }).item, id: 'newnewnewnew' }) },
        }),
      },
    ]);
    const issue = await new DartAdapter({ apiKey: 'k', fetchImpl }).createSubIssue(
      'parentparent',
      { title: 'Child' },
      CLIENT_KEY,
    );
    const sent = (postBody(calls) as { item: Record<string, unknown> }).item;
    expect(sent.description).toBe(`cyboflow-sync: ${CLIENT_KEY}`);
    expect(sent.parentId).toBe('parentparent');
    // A body that is NOTHING but the marker reads as an empty description.
    expect(issue.description).toBeNull();
  });

  it('files a sub-issue on the PARENT\'s dartboard, not the account default', async () => {
    // MEASURED against a live Dart space: a `parentId`-only create lands the
    // child on the API user's DEFAULT dartboard, which this connection's
    // dartboard-scoped listIssues/listIssueIds can never see. The parent's own
    // board must therefore be read and named explicitly.
    const { fetchImpl, calls } = scriptedFetch([
      makeDetailRoute({ parentparent: task({ id: 'parentparent', dartboard: 'Design/Backlog' }) }),
      {
        test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
        respond: (body) => ({
          status: 200,
          body: { item: task({ ...(body as { item: object }).item, id: 'newnewnewnew' }) },
        }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).createSubIssue(
      'parentparent',
      { title: 'Child' },
      CLIENT_KEY,
    );
    const sent = (postBody(calls) as { item: Record<string, unknown> }).item;
    expect(sent.dartboard).toBe('Design/Backlog');
    expect(sent.parentId).toBe('parentparent');
  });

  it('refuses to mirror under a parent that no longer exists, TERMINALLY', async () => {
    // 404 (not a null status) so the outbox drops the row instead of pinning it
    // on a retry that can never succeed.
    const { fetchImpl } = scriptedFetch([makeDetailRoute({})]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).createSubIssue('goneparentx0', { title: 'C' }, CLIENT_KEY),
    ).rejects.toMatchObject({ name: 'TrackerApiError', status: 404 });
  });

  it('passes the initial state through as the status title', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'POST' && p.endsWith('/tasks'),
        respond: (body) => ({
          status: 200,
          body: { item: task({ ...(body as { item: object }).item, id: 'newnewnewnew' }) },
        }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).createIssue(
      SELECTION,
      { title: 'T', stateId: 'Doing' },
      CLIENT_KEY,
    );
    expect((calls[0].body as { item: Record<string, unknown> }).item.status).toBe('Doing');
  });
});

describe('DartAdapter.updateIssueState', () => {
  it('PUTs the id inside the item as well as on the path', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      {
        test: (m, p) => m === 'PUT' && /\/tasks\/[^/]+$/.test(p),
        respond: () => ({ status: 200, body: { item: task({ status: 'Done' }) } }),
      },
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).updateIssueState('AbCdEfGhIjKl', 'Done');
    expect(new URL(calls[0].url).pathname).toBe('/api/v0/public/tasks/AbCdEfGhIjKl');
    expect(calls[0].body).toEqual({ item: { id: 'AbCdEfGhIjKl', status: 'Done' } });
  });
});

describe('DartAdapter.findIssueByClientKey', () => {
  const marked = task({ id: 'foundfoundfo', description: `Body\n\ncyboflow-sync: ${CLIENT_KEY}` });

  it('adopts the marked task via the server-side description fast path', async () => {
    let filterUsed: string | null = null;
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          filterUsed = params.get('description');
          return {
            status: 200,
            body: { count: 1, next: null, results: [concise({ id: 'foundfoundfo' })] },
          };
        },
      },
      makeDetailRoute({ foundfoundfo: marked }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(filterUsed).toBe(`cyboflow-sync: ${CLIENT_KEY}`);
    expect(found?.externalId).toBe('foundfoundfo');
    // The marker never reaches the mapped description.
    expect(found?.description).toBe('Body');
  });

  it('FALLS BACK to a full scan when the description filter matches nothing', async () => {
    // The filter's semantics (exact vs contains) are unspecified, so a miss must
    // cost time, never correctness — trusting it would duplicate a landed create.
    let sawFilteredCall = false;
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          if (params.get('description') !== null) {
            sawFilteredCall = true;
            // Simulate an EXACT-match filter: no hit despite the task existing.
            return { status: 200, body: { count: 0, next: null, results: [] } };
          }
          return {
            status: 200,
            body: { count: 1, next: null, results: [concise({ id: 'foundfoundfo' })] },
          };
        },
      },
      makeDetailRoute({ foundfoundfo: marked }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(sawFilteredCall).toBe(true);
    expect(found?.externalId).toBe('foundfoundfo');
  });

  it('returns null when nothing carries the key — the proof a retry is safe', async () => {
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise({ id: 'siblingsibs1' })]),
      makeDetailRoute({ siblingsibs1: task({ id: 'siblingsibs1', description: 'Unrelated' }) }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(found).toBeNull();
  });

  it('does NOT adopt a same-title sibling that lacks the key', async () => {
    // Title is deliberately not a criterion: adopting the wrong task would
    // redirect every later write-back onto an unrelated one.
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      listRoute([concise({ id: 'twintwintwin', title: 'Ship the thing' })]),
      makeDetailRoute({
        twintwintwin: task({ id: 'twintwintwin', title: 'Ship the thing', description: 'No marker here' }),
      }),
    ]);
    const found = await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: BOARD, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(found).toBeNull();
  });

  it('scopes to one parent via the server-side parent_id filter when given one', async () => {
    let sentParent: string | null = null;
    const { fetchImpl } = scriptedFetch([
      configRoute(),
      {
        test: (m, p) => m === 'GET' && p.endsWith('/tasks/list'),
        respond: (_b, params) => {
          sentParent = params.get('parent_id');
          return { status: 200, body: { count: 1, next: null, results: [concise({ id: 'foundfoundfo' })] } };
        },
      },
      makeDetailRoute({ foundfoundfo: marked }),
    ]);
    await new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
      { containerId: null, parentExternalId: 'parentparent' },
      CLIENT_KEY,
    );
    expect(sentParent).toBe('parentparent');
  });

  it('refuses a scope with neither a parent nor a dartboard', async () => {
    const { fetchImpl } = scriptedFetch([configRoute()]);
    await expect(
      new DartAdapter({ apiKey: 'k', fetchImpl }).findIssueByClientKey(
        { containerId: null, parentExternalId: null },
        CLIENT_KEY,
      ),
    ).rejects.toBeInstanceOf(TrackerApiError);
  });
});

describe('DartAdapter transport failures', () => {
  it('surfaces a timeout as a NULL-status TrackerApiError, keeping it retryable', async () => {
    // outboxWorker only terminalizes a 4xx, so a null status takes the backoff
    // path — a timeout says nothing about whether the write is valid.
    const fetchImpl = (async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as FetchLike;
    const adapter = new DartAdapter({ apiKey: 'k', fetchImpl, requestTimeoutMs: 5 });
    await expect(adapter.validateCredentials()).rejects.toMatchObject({
      name: 'TrackerApiError',
      status: null,
    });
    await expect(adapter.validateCredentials()).rejects.toThrow(/timed out after 5ms/);
  });

  it('maps a 5xx to a retryable TrackerApiError rather than an auth error', async () => {
    const { fetchImpl } = scriptedFetch([
      { test: (m, p) => m === 'GET' && p.endsWith('/config'), respond: () => ({ status: 503 }) },
    ]);
    const err = await new DartAdapter({ apiKey: 'k', fetchImpl }).listContainers().catch((e) => e);
    expect(err).toBeInstanceOf(TrackerApiError);
    expect(err).not.toBeInstanceOf(TrackerAuthError);
    expect(err.status).toBe(503);
  });
});
