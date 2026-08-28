/**
 * BeadsAdapter unit tests.
 *
 * Drives the adapter through an injected `execImpl` + `readFileImpl` (see
 * {@link scriptedExec}), so nothing forks a process or touches the filesystem —
 * every spawn is matched by binary + bd verb and the exact argv/env fired is
 * captured for assertion. Harness mirrors dartAdapter.test.ts's scriptedFetch.
 *
 * `getShellPath` is mocked because `buildCommandEnv` — which the adapter uses
 * for real, since the PATH resolution is part of what makes a spawn work in a
 * packaged macOS app — otherwise execs a login shell on first call. The mock
 * replaces only that probe: the env assembly under test (envelope opt-in,
 * `BEADS_DIR` scrubbing) is the adapter's own code, running unmocked.
 *
 * The emphasis is on what makes BEADS different from the three HTTP providers
 * (see beadsAdapter.ts's header) — the places where being subtly wrong is
 * invisible rather than loud:
 *   - the transport is argv, so workspace pinning (`-C`, scrubbed `BEADS_DIR`)
 *     is the only thing standing between a project's sync and someone else's
 *     database;
 *   - the JSON contract differs BY VERB and has exit-0 non-JSON no-op paths, so
 *     the parser has to tolerate one shape and refuse another;
 *   - a date-SHAPED invalid cursor makes bd silently drop the filter and return
 *     the whole workspace, so cursor normalization is a correctness gate;
 *   - `updated_at` misses whole change classes, so `revision` is a derived
 *     content fingerprint whose stability IS the sweep's ground truth;
 *   - writes cannot be made conditional, so the concurrency guarantee is a
 *     post-write history diff whose four outcomes have to be exactly right;
 *   - a workspace can be REPLACED under a stable path, which no listing would
 *     otherwise reveal until the sweep archived every linked entity.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/shellPath', () => ({
  getShellPath: () => '/usr/bin:/bin',
  clearShellPathCache: () => undefined,
  findExecutableInPath: () => null,
}));

import {
  BeadsAdapter,
  beadsIssueFingerprint,
  classifyBdFailure,
  normalizeCursor,
} from './beadsAdapter';
import type { BdExecImpl, BdExecOptions, BdExecResult } from './beadsAdapter';
import { TrackerApiError, TrackerAuthError, TrackerRevisionMismatchError } from './errors';
import type { TrackerSourceSelection } from '../../../../shared/types/trackerSync';
import type { ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE = '/repo';
const BEADS_DIR = '/repo/.beads';
const METADATA_PATH = '/repo/.beads/metadata.json';
const PREFIX = 'proj';
const INSTANCE_ID = '424690c9-d0de-4d11-8830-5f9a1f91ad7a';
/** The argv every bd spawn must begin with — the whole point of the pinning. */
const BD_PREFIX = ['-C', WORKSPACE, '--dolt-auto-commit', 'on'];

const SELECTION: TrackerSourceSelection = {
  containerId: 'workspace',
  narrowId: 'all',
  narrowKind: 'all',
};

/** An outbox client key, in the shape writeBack mints (randomUUID). */
const CLIENT_KEY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

interface CapturedSpawn {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  options: BdExecOptions;
}

interface Route {
  match: (spawn: CapturedSpawn) => boolean;
  respond: (spawn: CapturedSpawn) => BdExecResult | Promise<BdExecResult>;
}

/** The bd subcommand of a captured spawn, or undefined for a non-bd binary. */
function bdVerb(spawn: CapturedSpawn): string | undefined {
  return spawn.bin === 'bd' ? spawn.args[BD_PREFIX.length] : undefined;
}

/** A bd spawn's argv with the pinned prefix removed. */
function bdArgs(spawn: CapturedSpawn): string[] {
  return spawn.args.slice(BD_PREFIX.length);
}

function scriptedExec(routes: Route[]): { execImpl: BdExecImpl; calls: CapturedSpawn[] } {
  const calls: CapturedSpawn[] = [];
  const execImpl: BdExecImpl = async (bin, args, options) => {
    const spawn: CapturedSpawn = {
      bin,
      args: [...args],
      env: options.env,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      options,
    };
    calls.push(spawn);
    const route = routes.find((candidate) => candidate.match(spawn));
    if (route === undefined) {
      throw new Error(`scriptedExec: unhandled spawn ${bin} ${args.join(' ')}`);
    }
    return route.respond(spawn);
  };
  return { execImpl, calls };
}

function ok(stdout: string, stderr = ''): BdExecResult {
  return { stdout, stderr };
}

/** `BD_JSON_ENVELOPE=1` output: `data` plus the pinned schema version. */
function envelope(data: unknown, schemaVersion: unknown = 1): string {
  return JSON.stringify({ data, schema_version: schemaVersion });
}

/** An `execFile` rejection, in the shape Node actually produces. */
function execFailure(shape: {
  stdout?: string;
  stderr?: string;
  code?: string | number;
  signal?: string;
}): Error {
  return Object.assign(new Error('Command failed'), shape);
}

type BeadsRowFixture = Record<string, unknown>;

/** A bd issue row, with the fields bd always populates. */
function issueRow(overrides: BeadsRowFixture = {}): BeadsRowFixture {
  return {
    id: 'proj-a1b',
    title: 'first issue',
    status: 'open',
    priority: 2,
    issue_type: 'task',
    owner: 'kesteva@example.com',
    created_at: '2026-08-27T04:31:10Z',
    created_by: 'Krishna',
    updated_at: '2026-08-27T04:31:58Z',
    ...overrides,
  };
}

// --- routes ---------------------------------------------------------------

function on(verb: string, respond: Route['respond']): Route {
  return { match: (spawn) => bdVerb(spawn) === verb, respond };
}

function whereRoute(prefix = PREFIX, path = BEADS_DIR): Route {
  return on('where', () =>
    ok(envelope({ path, prefix, database_path: `${path}/embeddeddolt` })),
  );
}

function versionRoute(version = '1.2.2'): Route {
  return on('version', () => ok(`bd version ${version} (Homebrew)\n`));
}

function gitRoute(name = 'Krishna'): Route {
  return { match: (spawn) => spawn.bin === 'git', respond: () => ok(`${name}\n`) };
}

function listRoute(rows: BeadsRowFixture[], inspect?: (args: string[]) => void): Route {
  return on('list', (spawn) => {
    inspect?.(bdArgs(spawn));
    return ok(envelope(rows));
  });
}

/** `bd show` answering from a lookup table; an unknown id fails as bd does. */
function showRoute(rowsById: Record<string, BeadsRowFixture | undefined>): Route {
  return on('show', (spawn) => {
    const id = bdArgs(spawn)[1];
    const row = rowsById[id];
    if (row === undefined) {
      throw execFailure({
        code: 1,
        stdout: envelope({ error: 'no issues found matching the provided IDs' }),
        stderr: `Error fetching ${id}: no issue found matching "${id}"`,
      });
    }
    return ok(envelope([row]));
  });
}

/** `bd show` returning a different row per call, for confirm-by-re-fetch paths. */
function showSequenceRoute(rows: BeadsRowFixture[]): Route {
  let index = 0;
  return on('show', () => {
    const row = rows[Math.min(index, rows.length - 1)];
    index += 1;
    return ok(envelope([row]));
  });
}

function historyRoute(entries: BeadsRowFixture[]): Route {
  return on('history', (spawn) => {
    const limit = Number(bdArgs(spawn)[3]);
    const window = limit === 0 ? entries : entries.slice(0, limit);
    return ok(envelope(window));
  });
}

function historyEntry(commitHash: string, issue: BeadsRowFixture): BeadsRowFixture {
  return {
    CommitHash: commitHash,
    Committer: 'root',
    CommitDate: '2026-08-26T21:32:01.431-07:00',
    Issue: issue,
  };
}

function makeAdapter(
  routes: Route[],
  overrides: {
    expectedInstanceId?: string | undefined;
    expectedPrefix?: string | undefined;
    expectedBeadsDir?: string | undefined;
    readFileImpl?: (path: string) => Promise<string>;
  } = {},
): { adapter: BeadsAdapter; calls: CapturedSpawn[] } {
  const { execImpl, calls } = scriptedExec(routes);
  const adapter = new BeadsAdapter({
    workspacePath: WORKSPACE,
    expectedInstanceId: 'expectedInstanceId' in overrides ? overrides.expectedInstanceId : INSTANCE_ID,
    expectedPrefix: 'expectedPrefix' in overrides ? overrides.expectedPrefix : PREFIX,
    expectedBeadsDir: overrides.expectedBeadsDir,
    execImpl,
    readFileImpl: overrides.readFileImpl ?? metadataFile(INSTANCE_ID),
  });
  return { adapter, calls };
}

function metadataFile(projectId: string): (path: string) => Promise<string> {
  return async (path: string) => {
    if (path !== METADATA_PATH) throw execFailure({ code: 'ENOENT' });
    return JSON.stringify({
      database: 'dolt',
      backend: 'dolt',
      dolt_mode: 'embedded',
      dolt_database: 'proj',
      project_id: projectId,
    });
  };
}

/** metadata.json whose project_id CHANGES after the first read (mid-pass reinit). */
function metadataFileSequence(projectIds: string[]): (path: string) => Promise<string> {
  let index = 0;
  return async (path: string) => {
    if (path !== METADATA_PATH) throw execFailure({ code: 'ENOENT' });
    const projectId = projectIds[Math.min(index, projectIds.length - 1)];
    index += 1;
    return JSON.stringify({ project_id: projectId });
  };
}

// ---------------------------------------------------------------------------
// 1. Workspace pinning
// ---------------------------------------------------------------------------

describe('BeadsAdapter — workspace pinning', () => {
  it('prefixes every bd spawn with -C <workspace> --dolt-auto-commit on', async () => {
    const { adapter, calls } = makeAdapter([whereRoute(), listRoute([issueRow()])]);
    await adapter.listIssues(SELECTION);

    const bdCalls = calls.filter((call) => call.bin === 'bd');
    expect(bdCalls.length).toBeGreaterThan(1);
    for (const call of bdCalls) {
      expect(call.args.slice(0, BD_PREFIX.length)).toEqual(BD_PREFIX);
    }
  });

  it('sets BD_JSON_ENVELOPE and scrubs an inherited BEADS_DIR from the child env', async () => {
    const previous = process.env.BEADS_DIR;
    // The exact hazard: an app launched with BEADS_DIR set would otherwise
    // read, close and update issues in that ONE workspace for every project,
    // with each connection still looking valid.
    process.env.BEADS_DIR = '/somewhere/else/.beads';
    try {
      const { adapter, calls } = makeAdapter([whereRoute(), listRoute([issueRow()])]);
      await adapter.listIssues(SELECTION);

      for (const call of calls) {
        expect(call.env.BD_JSON_ENVELOPE).toBe('1');
        expect(call.env.BEADS_DIR).toBeUndefined();
      }
    } finally {
      if (previous === undefined) delete process.env.BEADS_DIR;
      else process.env.BEADS_DIR = previous;
    }
  });

  it('raises maxBuffer only for the whole-workspace listings', async () => {
    const { adapter, calls } = makeAdapter([whereRoute(), listRoute([issueRow()])]);
    await adapter.listIssues(SELECTION);

    const list = calls.find((call) => bdVerb(call) === 'list');
    const where = calls.find((call) => bdVerb(call) === 'where');
    expect(list?.maxBuffer).toBe(64 * 1024 * 1024);
    expect(where?.maxBuffer).toBe(10 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// 2. Envelope parsing
// ---------------------------------------------------------------------------

describe('BeadsAdapter — JSON envelope', () => {
  it('reads create as a bare OBJECT and list/show/update as an ARRAY', async () => {
    const created = issueRow({
      id: 'proj-new',
      metadata: { cyboflow_client_key: CLIENT_KEY },
    });
    const { adapter } = makeAdapter([
      whereRoute(),
      // create: `data` is the issue itself, not a one-element array.
      on('create', () => ok(envelope(created))),
      listRoute([issueRow()]),
    ]);

    const issue = await adapter.createIssue(SELECTION, { title: 'first issue' }, CLIENT_KEY);
    expect(issue.externalId).toBe('proj-new');

    const listed = await adapter.listIssues(SELECTION);
    expect(listed).toHaveLength(1);
  });

  it('refuses a schema_version other than 1 rather than guessing at the shape', async () => {
    const { adapter } = makeAdapter([
      whereRoute(),
      on('list', () => ok(envelope([issueRow()], 2))),
    ]);
    await expect(adapter.listIssues(SELECTION)).rejects.toBeInstanceOf(TrackerAuthError);
    await expect(adapter.listIssues(SELECTION)).rejects.toThrow(/schema_version/);
  });

  it('tolerates a no-op path printing plain text with exit 0, and confirms by re-fetch', async () => {
    // `bd reopen` on an already-open issue prints `<id> is already open` —
    // human text on stdout, exit 0, DESPITE --json.
    const reopenCalls: string[][] = [];
    const { adapter, calls } = makeAdapter([
      whereRoute(),
      on('update', () => ok(envelope([issueRow({ status: 'closed', closed_at: '2026-08-27T04:33:08Z' })]))),
      on('reopen', (spawn) => {
        reopenCalls.push(bdArgs(spawn));
        return ok('proj-a1b is already open\n');
      }),
      showSequenceRoute([
        // First confirm: the plain `--status` write could not lift `closed`.
        issueRow({ status: 'closed', closed_at: '2026-08-27T04:33:08Z' }),
        // After the reopen, the state is real.
        issueRow({ status: 'open' }),
      ]),
    ]);

    await expect(adapter.updateIssueState('proj-a1b', 'open')).resolves.toBeUndefined();
    expect(reopenCalls).toHaveLength(1);
    // The verdict came from `bd show`, never from the reopen's success text.
    expect(calls.filter((call) => bdVerb(call) === 'show')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Cursor normalization
// ---------------------------------------------------------------------------

describe('BeadsAdapter — listIssues cursor', () => {
  it('always passes --all and --limit 0', async () => {
    let seen: string[] = [];
    const { adapter } = makeAdapter([whereRoute(), listRoute([], (args) => (seen = args))]);
    await adapter.listIssues(SELECTION);
    expect(seen).toEqual(['list', '--all', '--json', '--limit', '0']);
  });

  it('re-emits an offset cursor as strict UTC', async () => {
    let seen: string[] = [];
    const { adapter } = makeAdapter([whereRoute(), listRoute([], (args) => (seen = args))]);
    await adapter.listIssues(SELECTION, '2026-08-27T06:31:58+02:00');
    expect(seen).toContain('--updated-after');
    expect(seen[seen.indexOf('--updated-after') + 1]).toBe('2026-08-27T04:31:58Z');
  });

  it('never sends a bare date — bd resolves those to LOCAL midnight', async () => {
    let seen: string[] = [];
    const { adapter } = makeAdapter([whereRoute(), listRoute([], (args) => (seen = args))]);
    await adapter.listIssues(SELECTION, '2026-08-27');
    expect(seen[seen.indexOf('--updated-after') + 1]).toBe('2026-08-27T00:00:00Z');
  });

  it('drops fractional seconds rather than letting bd truncate them', () => {
    expect(normalizeCursor('2026-08-27T04:31:58.123456Z')).toBe('2026-08-27T04:31:58Z');
  });

  it('refuses a date-SHAPED invalid cursor instead of silently fetching everything', async () => {
    const { adapter, calls } = makeAdapter([whereRoute(), listRoute([issueRow()])]);
    // bd answers `2026-13-45` with exit 0 and the FULL unfiltered workspace.
    await expect(adapter.listIssues(SELECTION, '2026-13-45')).rejects.toBeInstanceOf(
      TrackerApiError,
    );
    expect(calls.filter((call) => bdVerb(call) === 'list')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Content fingerprint
// ---------------------------------------------------------------------------

describe('beadsIssueFingerprint', () => {
  it('is stable under key reordering, at every nesting level', () => {
    const a = { id: 'proj-1', title: 'x', metadata: { b: 1, a: 2 }, status: 'open' };
    const b = { status: 'open', metadata: { a: 2, b: 1 }, title: 'x', id: 'proj-1' };
    expect(beadsIssueFingerprint(a)).toBe(beadsIssueFingerprint(b));
  });

  it('changes when a label is added — the case `updated_at` never catches', () => {
    const before = issueRow({ labels: ['infra'] });
    const after = issueRow({ labels: ['infra', 'urgent'] });
    // Same updated_at on both: `bd label add` does not bump it.
    expect(after.updated_at).toBe(before.updated_at);
    expect(beadsIssueFingerprint(after)).not.toBe(beadsIssueFingerprint(before));
  });

  it('ignores label ORDER, which is presentation rather than content', () => {
    expect(beadsIssueFingerprint(issueRow({ labels: ['a', 'b'] }))).toBe(
      beadsIssueFingerprint(issueRow({ labels: ['b', 'a'] })),
    );
  });

  it('matches between a list row and a show row of the same issue', () => {
    // bd emits the same key SET from both verbs, differing only in key order.
    const listRow = issueRow({ dependency_count: 0, dependent_count: 0, comment_count: 0 });
    const showRow: BeadsRowFixture = {
      dependent_count: 0,
      dependency_count: 0,
      comment_count: 0,
      updated_at: listRow.updated_at,
      created_by: listRow.created_by,
      created_at: listRow.created_at,
      owner: listRow.owner,
      issue_type: listRow.issue_type,
      priority: listRow.priority,
      status: listRow.status,
      title: listRow.title,
      id: listRow.id,
    };
    expect(beadsIssueFingerprint(showRow)).toBe(beadsIssueFingerprint(listRow));
  });

  it('ignores fields outside the allow-list, so a bd upgrade cannot flap every issue', () => {
    expect(beadsIssueFingerprint(issueRow({ some_new_bd_field: 'x' }))).toBe(
      beadsIssueFingerprint(issueRow()),
    );
  });
});

// ---------------------------------------------------------------------------
// 4b. workspaceHead — the sweep's archival guard anchor
// ---------------------------------------------------------------------------

describe('BeadsAdapter — workspaceHead', () => {
  it('reads the NEWEST CommitHash with a bounded history spawn', async () => {
    const { adapter, calls } = makeAdapter([
      whereRoute(),
      historyRoute([
        historyEntry('headhash', issueRow()),
        historyEntry('olderhash', issueRow({ title: 'before' })),
      ]),
    ]);

    await expect(adapter.workspaceHead('proj-a1b')).resolves.toBe('headhash');
    // `--limit 1` is what makes this O(1): bd's history is unfiltered, so the
    // newest entry for ANY id is the database head, and an unbounded call would
    // stream a full issue snapshot per commit in the whole database.
    const history = calls.filter((call) => bdVerb(call) === 'history');
    expect(history).toHaveLength(1);
    expect(bdArgs(history[0])).toEqual(['history', 'proj-a1b', '--limit', '1', '--json']);
  });

  it('re-checks identity AFTER the read, so a head from a replaced database never escapes', async () => {
    // The workspace was replaced while the history spawn was in flight, so the
    // only metadata read this method makes — the one AFTER the read — sees the
    // new instance.
    const { adapter } = makeAdapter([whereRoute(), historyRoute([historyEntry('h1', issueRow())])], {
      readFileImpl: metadataFile('a-different-instance'),
    });

    await expect(adapter.workspaceHead('proj-a1b')).rejects.toThrow(TrackerAuthError);
  });

  it('answers null for an unresolvable id rather than throwing', async () => {
    const { adapter } = makeAdapter([
      whereRoute(),
      on('history', () =>
        Promise.reject(
          execFailure({
            code: 1,
            stdout: '',
            stderr: 'Error fetching proj-gone: no issue found matching "proj-gone"',
          }),
        ),
      ),
    ]);

    // BEST-EFFORT is the contract: the sweep must degrade to no guard, never to
    // a failed sweep, so an id that no longer resolves is an absent token.
    await expect(adapter.workspaceHead('proj-gone')).resolves.toBeNull();
  });

  it('answers null for the exit-0 unavailable-history shape and for an empty window', async () => {
    const { adapter: unavailable } = makeAdapter([whereRoute(), on('history', () => ok(''))]);
    await expect(unavailable.workspaceHead('proj-a1b')).resolves.toBeNull();

    const { adapter: empty } = makeAdapter([whereRoute(), historyRoute([])]);
    await expect(empty.workspaceHead('proj-a1b')).resolves.toBeNull();
  });
});

describe('BeadsAdapter — revision', () => {
  it('is populated on listed, fetched and update-echo issues alike', async () => {
    const row = issueRow();
    const { adapter } = makeAdapter([
      whereRoute(),
      listRoute([row]),
      showRoute({ 'proj-a1b': row }),
      historyRoute([historyEntry('newest', row)]),
      on('update', () => ok(envelope([issueRow({ title: 'renamed' })]))),
    ]);

    const [listed] = await adapter.listIssues(SELECTION);
    const fetched = await adapter.getIssue('proj-a1b');
    const echoed = await adapter.updateIssueContent('proj-a1b', { title: 'renamed' });

    expect(listed.revision).toBe(beadsIssueFingerprint(row));
    expect(fetched?.revision).toBe(beadsIssueFingerprint(row));
    expect(echoed?.revision).toBe(beadsIssueFingerprint(issueRow({ title: 'renamed' })));
  });

  it('listIssueRevisions pairs every id with its fingerprint', async () => {
    const rows = [issueRow(), issueRow({ id: 'proj-b2c', title: 'second' })];
    const { adapter } = makeAdapter([whereRoute(), listRoute(rows)]);
    await expect(adapter.listIssueRevisions(SELECTION)).resolves.toEqual([
      { id: 'proj-a1b', revision: beadsIssueFingerprint(rows[0]) },
      { id: 'proj-b2c', revision: beadsIssueFingerprint(rows[1]) },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. getIssue
// ---------------------------------------------------------------------------

describe('BeadsAdapter — getIssue', () => {
  it('reads the enveloped JSON error object as null, and spawns no history', async () => {
    const { adapter, calls } = makeAdapter([
      whereRoute(),
      on('show', () =>
        Promise.reject(
          execFailure({
            code: 1,
            stdout: envelope({ error: 'no issues found matching the provided IDs' }),
            stderr: '',
          }),
        ),
      ),
    ]);
    await expect(adapter.getIssue('proj-gone')).resolves.toBeNull();
    expect(calls.filter((call) => bdVerb(call) === 'history')).toHaveLength(0);
  });

  it('reads the stderr wording as null too (the two shapes are worded differently)', async () => {
    const { adapter } = makeAdapter([
      whereRoute(),
      on('show', () =>
        Promise.reject(
          execFailure({
            code: 1,
            stdout: '',
            stderr: 'Error fetching proj-gone: no issue found matching "proj-gone"',
          }),
        ),
      ),
    ]);
    await expect(adapter.getIssue('proj-gone')).resolves.toBeNull();
  });

  it('carries the newest CommitHash as the concurrency token', async () => {
    const row = issueRow();
    const { adapter } = makeAdapter([
      whereRoute(),
      showRoute({ 'proj-a1b': row }),
      // Newest-first, exactly as `bd history --json` emits it.
      historyRoute([historyEntry('newesthash', row), historyEntry('olderhash', row)]),
    ]);
    const issue = await adapter.getIssue('proj-a1b');
    expect(issue?.concurrencyToken).toBe('newesthash');
  });

  it('maps a beads row onto the TrackerIssue shape', async () => {
    const row = issueRow({
      assignee: 'ada.lovelace',
      description: 'body',
      parent: 'proj-parent',
      priority: 0,
      issue_type: 'bug',
      metadata: { cyboflow_client_key: CLIENT_KEY },
    });
    const { adapter } = makeAdapter([
      whereRoute(),
      showRoute({ 'proj-a1b': row }),
      historyRoute([historyEntry('h1', row)]),
    ]);
    const issue = await adapter.getIssue('proj-a1b');
    expect(issue).toMatchObject({
      externalId: 'proj-a1b',
      identifier: 'proj-a1b',
      description: 'body',
      // beads has no web UI, so there is no per-issue URL to report.
      url: '',
      stateId: 'open',
      parentExternalId: 'proj-parent',
      archivedAt: null,
      estimate: null,
      // Provider-RAW: the integer becomes its own string, never a local Priority.
      priority: '0',
      category: 'bug',
      recoveryClientKey: CLIENT_KEY,
    });
    expect(issue?.assignee).toEqual({ id: 'ada.lovelace', name: 'ada.lovelace', initials: 'AL' });
  });
});

// ---------------------------------------------------------------------------
// 6. Creates
// ---------------------------------------------------------------------------

describe('BeadsAdapter — creates', () => {
  it('stamps the client key into metadata and reads it back off the echo', async () => {
    let seen: string[] = [];
    const created = issueRow({
      id: 'proj-new',
      metadata: { cyboflow_client_key: CLIENT_KEY },
    });
    const { adapter } = makeAdapter([
      whereRoute(),
      on('create', (spawn) => {
        seen = bdArgs(spawn);
        return ok(envelope(created));
      }),
    ]);

    const issue = await adapter.createIssue(
      SELECTION,
      { title: 'first issue', description: 'body', priority: '1', category: 'bug' },
      CLIENT_KEY,
    );

    expect(seen).toContain('--metadata');
    expect(seen[seen.indexOf('--metadata') + 1]).toBe(
      JSON.stringify({ cyboflow_client_key: CLIENT_KEY }),
    );
    // `--title` rather than the positional form: a title starting with `-`
    // would otherwise be parsed as a flag.
    expect(seen[seen.indexOf('--title') + 1]).toBe('first issue');
    expect(seen[seen.indexOf('--description') + 1]).toBe('body');
    expect(seen[seen.indexOf('--priority') + 1]).toBe('1');
    expect(seen[seen.indexOf('--type') + 1]).toBe('bug');
    expect(issue.recoveryClientKey).toBe(CLIENT_KEY);
  });

  it('omits the flags an absent draft field would carry', async () => {
    let seen: string[] = [];
    const { adapter } = makeAdapter([
      whereRoute(),
      on('create', (spawn) => {
        seen = bdArgs(spawn);
        return ok(envelope(issueRow({ id: 'proj-new' })));
      }),
    ]);
    await adapter.createIssue(SELECTION, { title: 'bare' }, CLIENT_KEY);
    expect(seen).not.toContain('--description');
    expect(seen).not.toContain('--priority');
    expect(seen).not.toContain('--type');
    expect(seen).not.toContain('--parent');
  });

  it('files a sub-issue under --parent', async () => {
    let seen: string[] = [];
    const { adapter } = makeAdapter([
      whereRoute(),
      on('create', (spawn) => {
        seen = bdArgs(spawn);
        return ok(envelope(issueRow({ id: 'proj-88w.1', parent: 'proj-88w' })));
      }),
    ]);
    const issue = await adapter.createSubIssue('proj-88w', { title: 'child' }, CLIENT_KEY);
    expect(seen[seen.indexOf('--parent') + 1]).toBe('proj-88w');
    expect(issue.parentExternalId).toBe('proj-88w');
  });

  it('applies a non-default draft status with a separate proven update', async () => {
    // `bd create --status` is unproven; `bd update --status` was probed against
    // all seven built-ins, so the create is followed by one rather than risking
    // an unknown-flag failure on EVERY create.
    let updateArgs: string[] = [];
    const { adapter } = makeAdapter([
      whereRoute(),
      on('create', () => ok(envelope(issueRow({ id: 'proj-new' })))),
      on('update', (spawn) => {
        updateArgs = bdArgs(spawn);
        return ok(envelope([issueRow({ id: 'proj-new', status: 'in_progress' })]));
      }),
      showRoute({ 'proj-new': issueRow({ id: 'proj-new', status: 'in_progress' }) }),
    ]);

    const issue = await adapter.createIssue(
      SELECTION,
      { title: 'started', stateId: 'in_progress' },
      CLIENT_KEY,
    );
    expect(updateArgs).toEqual(['update', 'proj-new', '--status', 'in_progress', '--json']);
    expect(issue.stateId).toBe('in_progress');
  });

  it('recovers a lost create by its metadata client key, across --all', async () => {
    let seen: string[] = [];
    const { adapter } = makeAdapter([
      whereRoute(),
      listRoute([issueRow({ id: 'proj-lost', metadata: { cyboflow_client_key: CLIENT_KEY } })], (args) => {
        seen = args;
      }),
    ]);
    const found = await adapter.findIssueByClientKey(
      { containerId: null, parentExternalId: null },
      CLIENT_KEY,
    );
    expect(seen).toContain('--all');
    expect(seen[seen.indexOf('--metadata-field') + 1]).toBe(`cyboflow_client_key=${CLIENT_KEY}`);
    expect(found?.externalId).toBe('proj-lost');
  });

  it('reports "never landed" only when no issue carries the key', async () => {
    const { adapter } = makeAdapter([whereRoute(), listRoute([])]);
    await expect(
      adapter.findIssueByClientKey({ containerId: null, parentExternalId: null }, CLIENT_KEY),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Guarded updates (detect-after-write)
// ---------------------------------------------------------------------------

describe('BeadsAdapter — guarded updates', () => {
  const base = issueRow({ title: 'base title', priority: 2 });

  function guardedContentAdapter(entries: BeadsRowFixture[]): {
    adapter: BeadsAdapter;
    calls: CapturedSpawn[];
  } {
    return makeAdapter([
      whereRoute(),
      on('update', () => ok(envelope([issueRow({ title: 'ours' })]))),
      historyRoute(entries),
      showRoute({ 'proj-a1b': issueRow({ title: 'ours' }) }),
    ]);
  }

  it('throws with the clobbered value when an interleaved commit wrote the SAME field', async () => {
    const { adapter } = guardedContentAdapter([
      historyEntry('ours', issueRow({ title: 'ours' })),
      historyEntry('theirs', issueRow({ title: 'their title' })),
      historyEntry('base', base),
    ]);

    const failure = await adapter
      .updateIssueContent('proj-a1b', { title: 'ours' }, 'base')
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(failure).toBeInstanceOf(TrackerRevisionMismatchError);
    const mismatch = failure as TrackerRevisionMismatchError;
    expect(mismatch.conflictingFields).toEqual(['title']);
    // Strictly better than the HTTP providers: the raced value is recoverable.
    expect(mismatch.recoveredIssue?.title).toBe('their title');
  });

  it('settles an interleaved write to an UNRELATED field — nothing was clobbered', async () => {
    // `bd update` patches only the flags it is given, so churn on another field
    // is never overwritten by our title write.
    const { adapter } = guardedContentAdapter([
      historyEntry('ours', issueRow({ title: 'ours', priority: 4 })),
      historyEntry('theirs', issueRow({ title: 'base title', priority: 4 })),
      historyEntry('base', base),
    ]);
    await expect(
      adapter.updateIssueContent('proj-a1b', { title: 'ours' }, 'base'),
    ).resolves.toMatchObject({ title: 'ours' });
  });

  it('settles a CONVERGED interleave — someone else wrote the value we were writing', async () => {
    const { adapter } = guardedContentAdapter([
      historyEntry('ours', issueRow({ title: 'ours' })),
      historyEntry('theirs', issueRow({ title: 'ours' })),
      historyEntry('base', base),
    ]);
    await expect(
      adapter.updateIssueContent('proj-a1b', { title: 'ours' }, 'base'),
    ).resolves.toMatchObject({ title: 'ours' });
  });

  it('escalates to the full history before giving up on a token', async () => {
    const limits: number[] = [];
    const entries = [
      historyEntry('ours', issueRow({ title: 'ours' })),
      historyEntry('theirs', issueRow({ title: 'their title' })),
      historyEntry('base', base),
    ];
    const { adapter } = makeAdapter([
      whereRoute(),
      on('update', () => ok(envelope([issueRow({ title: 'ours' })]))),
      on('history', (spawn) => {
        const limit = Number(bdArgs(spawn)[3]);
        limits.push(limit);
        // The bounded window is short of the token; the full history has it.
        return ok(envelope(limit === 0 ? entries : entries.slice(0, 1)));
      }),
    ]);

    await expect(
      adapter.updateIssueContent('proj-a1b', { title: 'ours' }, 'base'),
    ).rejects.toBeInstanceOf(TrackerRevisionMismatchError);
    expect(limits).toEqual([50, 0]);
  });

  it('re-baselines when the token is in NEITHER window (history was squashed)', async () => {
    // `bd compact`/`flatten`/`gc` invalidate stored tokens; reporting a conflict
    // this adapter cannot substantiate would be worse than re-baselining.
    const { adapter } = guardedContentAdapter([
      historyEntry('ours', issueRow({ title: 'ours' })),
      historyEntry('unrelated', issueRow({ title: 'ours' })),
    ]);
    await expect(
      adapter.updateIssueContent('proj-a1b', { title: 'ours' }, 'squashed-away'),
    ).resolves.toMatchObject({ title: 'ours' });
  });

  it('spawns no history at all for an UNGUARDED write', async () => {
    const { adapter, calls } = guardedContentAdapter([]);
    await adapter.updateIssueContent('proj-a1b', { title: 'ours' });
    expect(calls.filter((call) => bdVerb(call) === 'history')).toHaveLength(0);
  });

  it('guards a STATE write the same way, reporting the field as stateId', async () => {
    const { adapter } = makeAdapter([
      whereRoute(),
      on('close', () => ok(envelope([issueRow({ status: 'closed' })]))),
      showRoute({ 'proj-a1b': issueRow({ status: 'closed' }) }),
      historyRoute([
        historyEntry('ours', issueRow({ status: 'closed' })),
        historyEntry('theirs', issueRow({ status: 'in_progress' })),
        historyEntry('base', issueRow({ status: 'open' })),
      ]),
    ]);

    const failure = await adapter.updateIssueState('proj-a1b', 'closed', 'base').then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(TrackerRevisionMismatchError);
    expect((failure as TrackerRevisionMismatchError).conflictingFields).toEqual(['stateId']);
  });
});

// ---------------------------------------------------------------------------
// 8. Error taxonomy
// ---------------------------------------------------------------------------

describe('classifyBdFailure', () => {
  const retryable: Array<[string, Error]> = [
    [
      'lock contention (our own SIGTERM landing on a blocked child)',
      execFailure({
        code: 1,
        stderr:
          'Error: failed to open database: embeddeddolt: init schema: embeddeddolt: open db: ' +
          'failed to load database "elock": the database is locked by another dolt process',
      }),
    ],
    ['SIGKILL escalation (exit 137, empty stderr)', execFailure({ code: 137, stderr: '' })],
    ['an unrecognized failure', execFailure({ code: 1, stderr: 'Error: something new' })],
  ];

  it.each(retryable)('classifies %s as retryable', (_label, err) => {
    const classified = classifyBdFailure(err);
    expect(classified).toBeInstanceOf(TrackerApiError);
    expect(classified).not.toBeInstanceOf(TrackerAuthError);
    expect(classified.status).toBeNull();
  });

  const terminal: Array<[string, Error]> = [
    ['workspace unresolved', execFailure({ code: 1, stderr: 'Error: no beads database found' })],
    [
      // Live-smoked against bd 1.2.2 (2026-08-27): the `-C`-pinned wording for
      // the same condition — every adapter spawn pins via `-C`.
      'workspace unresolved under -C pin',
      execFailure({
        code: 1,
        stderr: 'Error: cannot use -C directory "/tmp/norepo": no beads project found',
      }),
    ],
    [
      'corrupt store (EOF suffix — same 68-char prefix as the retryable one)',
      execFailure({
        code: 1,
        stderr:
          'Error: failed to open database: embeddeddolt: init schema: embeddeddolt: open db: EOF',
      }),
    ],
    [
      'corrupt manifest leaking a raw Go error',
      execFailure({ code: 1, stderr: 'strconv.ParseUint: parsing "": invalid syntax' }),
    ],
    ['store gutted', execFailure({ code: 1, stderr: 'Error 1049: database not found' })],
    [
      'read-only misconfiguration',
      execFailure({ code: 1, stderr: "Error: operation 'update' is not allowed in read-only mode" }),
    ],
    ['a flag a downgraded bd does not know', execFailure({ code: 1, stderr: 'Error: unknown flag: --dolt-auto-commit' })],
    ['bd missing from PATH', execFailure({ code: 'ENOENT', stderr: '' })],
    [
      'a listing that outgrew its buffer',
      execFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '{"data":[' }),
    ],
  ];

  it.each(terminal)('pauses the connection on %s', (_label, err) => {
    expect(classifyBdFailure(err)).toBeInstanceOf(TrackerAuthError);
  });

  it('treats an unknown id as terminal PER ITEM, never as a paused connection', () => {
    const classified = classifyBdFailure(
      execFailure({ code: 1, stderr: 'Error resolving proj-x: no issue found matching "proj-x"' }),
    );
    expect(classified).not.toBeInstanceOf(TrackerAuthError);
    // A 4xx, so the outbox terminalizes the row instead of retrying forever.
    expect(classified.status).toBe(404);
  });

  it('names the docs when a workspace is too large to read in one call', () => {
    expect(
      classifyBdFailure(execFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).message,
    ).toMatch(/too large/i);
  });
});

describe('BeadsAdapter — maxBuffer overflow', () => {
  it('reaps the orphaned child itself, because Node does not', async () => {
    const kill = vi.fn();
    const execImpl: BdExecImpl = async (_bin, _args, options) => {
      options.onSpawn?.({ kill } as unknown as ChildProcess);
      throw execFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: '{"data":[' });
    };
    const adapter = new BeadsAdapter({
      workspacePath: WORKSPACE,
      execImpl,
      readFileImpl: metadataFile(INSTANCE_ID),
    });

    await expect(adapter.listIssues(SELECTION)).rejects.toBeInstanceOf(TrackerAuthError);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });
});

// ---------------------------------------------------------------------------
// 9. Identity sandwich
// ---------------------------------------------------------------------------

describe('BeadsAdapter — identity sandwich', () => {
  it('discards a listing collected from a REPLACED workspace', async () => {
    const { adapter } = makeAdapter([whereRoute(), listRoute([issueRow()])], {
      readFileImpl: metadataFile('99999999-0000-0000-0000-000000000000'),
    });
    const failure = await adapter.listIssues(SELECTION).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(TrackerAuthError);
    expect((failure as Error).message).toMatch(/REPLACED/);
    // Nothing resolved, so no caller can act on the collected batch.
    expect(failure).not.toBeNull();
  });

  it('distinguishes a prefix RENAME from a replacement — they need different recoveries', async () => {
    const { adapter } = makeAdapter([whereRoute('newpfx'), listRoute([issueRow()])]);
    const failure = await adapter.listIssues(SELECTION).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(TrackerAuthError);
    expect((failure as Error).message).toMatch(/RENAMED/);
    expect((failure as Error).message).not.toMatch(/REPLACED/);
  });

  it('refuses a workspace that resolves to a different .beads path', async () => {
    const { adapter } = makeAdapter([whereRoute(PREFIX, '/elsewhere/.beads'), listRoute([])], {
      expectedBeadsDir: BEADS_DIR,
    });
    await expect(adapter.listIssues(SELECTION)).rejects.toThrow(/resolves to \/elsewhere/);
  });

  it('discards a write response when the workspace was replaced mid-write', async () => {
    // Pre-check passes, the CLI succeeds, and the post-check catches it — which
    // is what keeps a create that landed in a replacement database out of the
    // link table, the baseline and the settled outbox row.
    const { adapter } = makeAdapter(
      [whereRoute(), on('create', () => ok(envelope(issueRow({ id: 'proj-new' }))))],
      { readFileImpl: metadataFileSequence([INSTANCE_ID, 'ffffffff-0000-0000-0000-000000000000']) },
    );
    await expect(
      adapter.createIssue(SELECTION, { title: 'lands in the wrong db' }, CLIENT_KEY),
    ).rejects.toBeInstanceOf(TrackerAuthError);
  });

  it('checks identity BEFORE the write too, so a known-replaced workspace is never written to', async () => {
    const { adapter, calls } = makeAdapter(
      [whereRoute(), on('create', () => ok(envelope(issueRow())))],
      { readFileImpl: metadataFile('ffffffff-0000-0000-0000-000000000000') },
    );
    await expect(
      adapter.createIssue(SELECTION, { title: 'never sent' }, CLIENT_KEY),
    ).rejects.toBeInstanceOf(TrackerAuthError);
    expect(calls.filter((call) => bdVerb(call) === 'create')).toHaveLength(0);
  });

  it('fails loud when metadata.json carries no project_id to bind to', async () => {
    const { adapter } = makeAdapter([whereRoute(), listRoute([])], {
      readFileImpl: async () => JSON.stringify({ database: 'dolt' }),
    });
    await expect(adapter.listIssues(SELECTION)).rejects.toThrow(/project_id/);
  });
});

// ---------------------------------------------------------------------------
// 10. validateCredentials + discovery
// ---------------------------------------------------------------------------

describe('BeadsAdapter — validateCredentials', () => {
  it('returns the instance id, the prefix and the git actor', async () => {
    const { adapter } = makeAdapter(
      [versionRoute(), whereRoute(), gitRoute('Krishna')],
      { expectedInstanceId: undefined, expectedPrefix: undefined },
    );
    await expect(adapter.validateCredentials()).resolves.toEqual({
      workspaceId: INSTANCE_ID,
      workspaceName: PREFIX,
      actorLabel: 'Krishna',
    });
  });

  it('refuses a bd older than the version every Phase-0 verdict certifies', async () => {
    const { adapter } = makeAdapter([versionRoute('1.1.0'), whereRoute(), gitRoute()], {
      expectedInstanceId: undefined,
      expectedPrefix: undefined,
    });
    await expect(adapter.validateCredentials()).rejects.toBeInstanceOf(TrackerAuthError);
    await expect(adapter.validateCredentials()).rejects.toThrow(/1\.2\.2/);
  });

  it('falls back to the OS user when git has no configured name', async () => {
    const { adapter } = makeAdapter(
      [
        versionRoute(),
        whereRoute(),
        { match: (spawn) => spawn.bin === 'git', respond: () => ok('\n') },
      ],
      { expectedInstanceId: undefined, expectedPrefix: undefined },
    );
    const identity = await adapter.validateCredentials();
    expect(identity.actorLabel.length).toBeGreaterThan(0);
    expect(identity.actorLabel).not.toBe('');
  });
});

describe('BeadsAdapter — discovery', () => {
  it('offers one degenerate workspace group named for the issue prefix', async () => {
    const { adapter } = makeAdapter([whereRoute()]);
    const tree = await adapter.listGroups();
    expect(tree.sections).toHaveLength(1);
    expect(tree.sections[0].groups).toHaveLength(1);
    expect(tree.sections[0].groups[0]).toMatchObject({
      id: 'workspace',
      name: PREFIX,
      selection: { containerId: 'workspace', narrowId: 'all', narrowKind: 'all' },
    });
  });

  it("offers 'all' as the only narrow — beads models no view/cycle/module", async () => {
    const { adapter } = makeAdapter([]);
    await expect(adapter.listNarrows('workspace')).resolves.toEqual([
      { id: 'all', kind: 'all', name: 'Whole workspace · all issues', issueCount: null },
    ]);
  });

  it('maps the seven built-in statuses onto canonical groups', async () => {
    const { adapter } = makeAdapter([]);
    const states = await adapter.listStates(SELECTION);
    expect(states.map((state) => state.id)).toEqual([
      'open',
      'in_progress',
      'blocked',
      'deferred',
      'closed',
      'pinned',
      'hooked',
    ]);
    const groups = Object.fromEntries(states.map((state) => [state.id, state.group]));
    expect(groups.open).toBe('unstarted');
    expect(groups.in_progress).toBe('started');
    expect(groups.closed).toBe('completed');
    // The two "frozen" rungs are parked work, not queued work.
    expect(groups.deferred).toBe('backlog');
    expect(groups.pinned).toBe('backlog');
  });

  it('reports both static field vocabularies (beads is the only CLI provider with a type field)', async () => {
    const { adapter } = makeAdapter([]);
    await expect(adapter.listFieldOptions()).resolves.toEqual({
      priorities: ['0', '1', '2', '3', '4'],
      categories: ['bug', 'feature', 'task', 'epic', 'chore'],
    });
  });
});

// ---------------------------------------------------------------------------
// 11. Per-workspace spawn mutex
// ---------------------------------------------------------------------------

describe('BeadsAdapter — spawn serialization', () => {
  it('never has two spawns in flight against one workspace', async () => {
    // Reads take the same whole-database exclusive flock as writes, so two
    // concurrent spawns would only queue on it and eat each other's timeout
    // budget (one workspace caps at ~2.7 ops/sec however wide the fan-out).
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const execImpl: BdExecImpl = async (bin, args) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      const verb = args[BD_PREFIX.length];
      if (verb === 'where') {
        return ok(envelope({ path: BEADS_DIR, prefix: PREFIX, database_path: BEADS_DIR }));
      }
      return ok(envelope([issueRow()]));
    };
    const adapter = new BeadsAdapter({
      workspacePath: WORKSPACE,
      expectedInstanceId: INSTANCE_ID,
      expectedPrefix: PREFIX,
      execImpl,
      readFileImpl: metadataFile(INSTANCE_ID),
    });

    const both = Promise.all([adapter.listIssues(SELECTION), adapter.listIssues(SELECTION)]);
    // Release one waiter per turn of the event loop; anything queued behind the
    // mutex cannot even reach `gates` until its predecessor has finished.
    for (let turn = 0; turn < 40; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      gates.shift()?.();
    }
    const [first, second] = await both;

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(peak).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 12. archiveIssue
// ---------------------------------------------------------------------------

describe('BeadsAdapter — archiveIssue', () => {
  it('throws: `bd delete` is a HARD delete, so the capability is none', async () => {
    const { adapter } = makeAdapter([]);
    await expect(adapter.archiveIssue('proj-a1b')).rejects.toThrow(/unsupported/i);
  });
});

// ---------------------------------------------------------------------------
// updateIssueContent field presence
// ---------------------------------------------------------------------------

describe('BeadsAdapter — updateIssueContent', () => {
  it('sends only the flags the patch carries, branching on !== undefined', async () => {
    let seen: string[] = [];
    const { adapter } = makeAdapter([
      whereRoute(),
      on('update', (spawn) => {
        seen = bdArgs(spawn);
        return ok(envelope([issueRow({ title: 'renamed' })]));
      }),
    ]);
    await adapter.updateIssueContent('proj-a1b', { title: 'renamed' });
    expect(seen).toEqual(['update', 'proj-a1b', '--title', 'renamed', '--json']);
  });

  it('writes a null description as the empty string — bd has no argv clearing path', async () => {
    let seen: string[] = [];
    const { adapter } = makeAdapter([
      whereRoute(),
      on('update', (spawn) => {
        seen = bdArgs(spawn);
        return ok(envelope([issueRow({ description: '' })]));
      }),
    ]);
    await adapter.updateIssueContent('proj-a1b', { description: null });
    expect(seen[seen.indexOf('--description') + 1]).toBe('');
  });

  it('skips a null priority/category — beads models no absence for either', async () => {
    // Both fields always carry a value in bd (priority defaults to 2,
    // issue_type to `task`), so there is no clearing token to send and a patch
    // of nothing but clears must not spend a write.
    const { adapter, calls } = makeAdapter([
      whereRoute(),
      showRoute({ 'proj-a1b': issueRow() }),
    ]);
    const issue = await adapter.updateIssueContent('proj-a1b', {
      priority: null,
      category: null,
    });
    expect(calls.filter((call) => bdVerb(call) === 'update')).toHaveLength(0);
    expect(issue?.priority).toBe('2');
  });
});
