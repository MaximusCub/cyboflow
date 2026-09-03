/**
 * BeadsAdapter — tracker-sync provider adapter for beads (`bd`,
 * github.com/gastownhall/beads). Design: docs/proposals/tracker-beads-provider.md
 * in full; every "[Phase 0]" / "[Phase 2 check RESOLVED]" fact cited below was
 * LIVE-PROBED against `bd 1.2.2` on 2026-08-26/27 (verdict tables in
 * docs/proposals/tracker-beads-phase0/findings.md, raw transcripts alongside).
 *
 * This is the first NON-FETCH adapter: the transport is a spawned local binary
 * against an embedded single-writer Dolt database, not HTTPS. Five transport
 * decisions follow from that and shape everything below.
 *
 * 1. WORKSPACE PINNING IS ARGV-FIRST. Probed precedence is
 *    `--db` > `-C` > `BEADS_DIR` > cwd walk-up, and walk-up is SILENT (a
 *    wrong-cwd call operates on an ancestor's database with exit 0). So every
 *    spawn carries `-C <workspacePath>`, which beats an inherited `BEADS_DIR`
 *    by precedence, and the child env has `BEADS_DIR` DELETED as
 *    defense-in-depth. `--dolt-auto-commit on` rides the same prefix: the
 *    guarded-write machinery below needs one Dolt commit per write, and pinning
 *    it per spawn makes that hold by construction even if the user's config
 *    says `off`/`batch`.
 *
 * 2. IDENTITY IS A SANDWICH, NOT A PREFLIGHT. A pinned path is a location, not
 *    an identity: `rm -rf .beads && bd init` resolves cleanly at the same path
 *    with a fresh database, and a sweep run against it would archive every
 *    linked entity. The immutable anchor is `.beads/metadata.json` →
 *    `project_id` (proven to survive `bd rename-prefix` and to change on
 *    reinit; exposed by NO bd command, so this adapter reads the file). The
 *    issue PREFIX is a second, independent half of the invariant, because
 *    `bd rename-prefix` rewrites existing issue ids suffix-preserved
 *    (`chk-2lz` → `newpfx-2lz`) while `project_id` stays put. So: every LISTING
 *    re-checks identity AFTER collecting its output and before returning it;
 *    `getIssue` re-checks after its read; every MUTATION checks BEFORE the
 *    spawn and again AFTER the CLI exits, discarding the response on a
 *    post-write mismatch. The residual — a replacement landing INSIDE one
 *    spawn's window — cannot be closed from outside the process (a CLI spawn
 *    cannot be atomically bound to an instance id); the proposal's Phase-4
 *    resurrection rule closes it instead, by defining sweep archival as
 *    reversible so a wrongly-archived twin self-heals within one sweep.
 *
 * 3. THE TIMEOUT MANUFACTURES THE RETRY SIGNAL. bd NEVER reports lock
 *    contention on its own — it blocks on the whole-database flock forever
 *    (proven to 200.9s, then success; no timeout knob exists in bd). The
 *    classifiable `the database is locked by another dolt process` string is
 *    produced ONLY when the caller cancels a blocked child. So
 *    {@link BEADS_REQUEST_TIMEOUT_MS} + `execFile`'s SIGTERM is what creates
 *    the retryable signal, with a manual SIGKILL escalation because bd TRAPS
 *    SIGTERM (exit 1 + the string, never 143). Exit codes classify NOTHING
 *    here — every failure is exit 1 — so {@link classifyBdFailure} reads
 *    stderr CONTENT.
 *
 * 4. READS TAKE THE WRITE LOCK. `bd list` takes the same whole-database
 *    exclusive flock as a write; `--readonly` is not a parallelism lever, and
 *    one workspace hard-caps at ~2.7 ops/sec however wide the fan-out. Every
 *    spawn therefore serializes through a module-level per-workspace mutex:
 *    concurrent spawns would only queue on the flock and eat each other's
 *    timeout budget. The lock is per-SPAWN, not per-operation — holding it
 *    across a whole mutation would deadlock its own identity checks, and the
 *    sandwich above (not the mutex) is what makes an interleave safe.
 *
 * 5. THE JSON CONTRACT HAS HOLES. With `BD_JSON_ENVELOPE=1` the envelope shape
 *    differs BY VERB (`create` → bare object under `data`; `list`/`show`/
 *    `update`/`close`/`history` → array), errors are NEVER enveloped on
 *    stderr, `bd update <missing-id>` prints NOTHING on stdout while
 *    `show`/`close` print differently-worded JSON error objects, and the no-op
 *    paths (`bd reopen` on an open issue) print plain human text with exit 0
 *    DESPITE `--json`. Hence the two rules this file follows everywhere:
 *    tolerate non-JSON stdout on a known no-op path, and confirm a state
 *    change by RE-FETCH, never by success text.
 *
 * Three contract additions beads is the only user of:
 *   - `listIssueRevisions` + `TrackerIssue.revision` — a content FINGERPRINT
 *     the adapter derives itself ({@link beadsIssueFingerprint}), because no
 *     revision field exists in any bd output and `--format` go-templates
 *     iterate dependency EDGES rather than issues (silent 0-byte no-op). It is
 *     strictly stronger than a server revision: `bd label add`, `bd comment`
 *     and `bd dep add` do NOT bump `updated_at`, so those changes are invisible
 *     to any cursor and visible only to the fingerprint.
 *   - `expectedToken` + {@link TrackerRevisionMismatchError} — beads has no
 *     CAS/if-match primitive anywhere (`--claim` is advisory and scoped to
 *     (assignee, status)), `bd sql` is refused in embedded mode, and a direct
 *     `dolt sql` guard corrupts timestamps AND still loses updates inside
 *     `updated_at`'s 1-second resolution. So guarded writes are
 *     DETECT-AFTER-WRITE: the write always lands, and
 *     {@link BeadsAdapter.verifyGuardedWrite} diffs adjacent `bd history`
 *     snapshots back to the caller's token to attribute exactly which fields an
 *     interleaved commit changed.
 *   - {@link BeadsAdapter.workspaceHead} — the whole-workspace Dolt HEAD the
 *     sweep's archival guard compares. Identity catches a REPLACED database;
 *     this catches a concurrent write inside the same one, which is beads'
 *     expected mode of use. `bd history` is unfiltered, so the newest
 *     `CommitHash` for ANY linked id is the database head; BEST-EFFORT by
 *     contract, hence null rather than a throw whenever it cannot be read.
 *
 * `externalId` is the bare beads id (`bd-a1b2`, or a dotted child id like
 * `pfx-88w.1`), which doubles as `identifier` — beads mints nothing more
 * human-readable and has no web UI, so `url` is always `''` (the engine's three
 * link-write sites normalize that to NULL).
 */

import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerState,
  TrackerIssue,
  TrackerUserRef,
} from '../../../../shared/types/trackerSync';
import type {
  TrackerAdapter,
  TrackerAdapterCapabilities,
  IssueDraft,
  IssueContentPatch,
  TrackerFieldOptionsRaw,
} from './adapterTypes';
import { TrackerApiError, TrackerAuthError, TrackerRevisionMismatchError } from './errors';
import { PROVIDER_ARCHIVE_CAPABILITY } from './providerCapabilities';
import { buildCommandEnv } from '../../utils/runGit';

const PROVIDER: TrackerProvider = 'beads';

/** The binary this adapter spawns. Its PROCESS IMAGE is named `beads`, not `bd`. */
const BD_BIN = 'bd';

/**
 * The oldest `bd` every Phase-0 verdict certifies. Several of those verdicts are
 * version-SPECIFIC bugs (the dead go-template branch, the dead default
 * `--limit 50`, the display-round vs comparator-floor mismatch), so an older
 * binary is refused rather than probed around.
 */
const MIN_BD_VERSION = '1.2.2';

/**
 * Per-spawn wall budget. NOT the HTTP 30s copied over — it is measured against
 * bd's own numbers (~0.4s fixed process/engine boot, reads under write load
 * 0.35–5.4s, a contended write 9.8s, a pathological 12.3MB listing 0.6s), which
 * puts 30s comfortably above p99. It is also load-bearing rather than defensive:
 * bd blocks on the flock forever, so without this the retry path is dead code
 * and one wedged holder hangs sync for the life of the process.
 */
export const BEADS_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long after `execFile`'s own SIGTERM to escalate to SIGKILL. bd TRAPS
 * SIGTERM (it exits 1 with the lock-contention string rather than dying on the
 * signal), so a child that is wedged past its SIGTERM would otherwise outlive
 * the call that owns it.
 */
const SIGKILL_ESCALATION_MS = 5_000;

/** Ordinary point-call output ceiling (matches runGit's own default). */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Ceiling for the whole-workspace listings ({@link BeadsAdapter.listIssues},
 * the reconciliation sweep, client-key recovery). bd has NO embedded pagination
 * (`--offset` requires `--proxied-server`) and buffers output fully server-side
 * (TTFB = 91.5% of wall time), so a listing is single-shot or nothing. 64MB sits
 * far above beads' own 100k-issue guidance at the observed ~1.5KB/issue; the
 * 12.3MB probe workspace that motivated the raise was deliberately pathological
 * (80 issues × 150KB descriptions). Overflow past this is TERMINAL, never
 * retried — see {@link classifyBdFailure}.
 */
const LISTING_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The `metadata` key every create stamps with the outbox row's client key.
 *
 * beads is the one provider where the recovery key does NOT ride the
 * description: it has a first-class arbitrary-JSON `metadata` field with an
 * exact-match `--metadata-field key=value` list filter (probed with every
 * negative control — wrong value, bogus key, and a uuid-PREFIX substring all
 * return 0 rows rather than everything). Two consequences, both deliberate:
 * a user reading `bd show` never sees sync plumbing in the body, and
 * {@link BeadsAdapter.updateIssueContent} needs NO marker re-append composition
 * at all (contrast `IssueContentPatch.description`'s caller-owns-the-marker
 * note, which exists because Dart/Plane keep the key in the description) — the
 * metadata key survives every body edit. beads reserves `bd:`/`_`-prefixed
 * metadata keys, so this name is safe.
 */
const CLIENT_KEY_METADATA_FIELD = 'cyboflow_client_key';

/**
 * How far back a guarded write's post-write verification reads history on its
 * first attempt. `bd history` is UNFILTERED — its entries are ≈ every DB commit
 * since the issue was created (33 entries for 1 real change was measured) — so
 * the walk is bounded and escalates to the full history (`--limit 0`) only when
 * the caller's token is not inside this window.
 */
const GUARD_HISTORY_LIMIT = 50;

/** The single degenerate container/group id (beads has no project/team level). */
const WORKSPACE_CONTAINER_ID = 'workspace';

const CAPABILITIES: TrackerAdapterCapabilities = {
  // beads has no native "auto-close parent when children complete" behavior
  // (parent-child is `--parent`/dotted hierarchical ids only) — same as Plane
  // and Dart, the shared close-parent write is the only path.
  nativeParentAutoClose: false,
  // beads has no HTTP origin to self-host; the transport is a local CLI spawn
  // against the project's own workspace.
  selfHostedBaseUrl: false,
  // `bd create` mints its own id; there is no client-supplied-id equivalent
  // to Linear's idempotent issueCreate. Recovery for a lost create's response
  // is {@link BeadsAdapter.findIssueByClientKey}'s `--metadata-field` filter.
  idempotentCreate: false,
  // `bd update` writes all four fields directly (`--title`, `-d`, `-p`, `-t`).
  contentWrite: { title: true, description: true, priority: true, category: true },
  // Read from the shared table so the outbound trigger — which gates on the
  // capability WITHOUT an adapter in hand — can never disagree with this
  // adapter. beads exposes no archive/trash endpoint (`bd delete` is a HARD
  // delete), so this resolves to 'none'.
  archive: PROVIDER_ARCHIVE_CAPABILITY.beads,
  // A `bd dolt pull` preserves each issue's original `updated_at`, and
  // label/comment/dependency edits never bump it at all — the incremental
  // cursor alone can miss real changes permanently, so the deletion sweep
  // reconciles by full id+fingerprint listing instead of a bare id set. See
  // {@link BeadsAdapter.listIssueRevisions}.
  requiresIdReconciliation: true,
  // No CAS/if-match primitive exists, so every existing-issue mutation is
  // guarded by a detect-after-write history diff — see
  // {@link BeadsAdapter.verifyGuardedWrite}.
  guardedUpdates: true,
};

// ---------------------------------------------------------------------------
// Exec seam
// ---------------------------------------------------------------------------

/** Both output streams of a completed `bd` (or `git`) child. */
export interface BdExecResult {
  stdout: string;
  stderr: string;
}

export interface BdExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** SIGTERM budget handed to `execFile` itself. */
  timeout: number;
  maxBuffer: number;
  /**
   * Handed the live child as soon as it exists. Two things need the handle and
   * neither can get it from the settled promise: the SIGKILL escalation past a
   * trapped SIGTERM, and the explicit reap on a `maxBuffer` overflow (Node does
   * NOT kill the child on that failure — probed: `killed`/`signal` both
   * undefined, stdout truncated at exactly the cap mid-string).
   */
  onSpawn?: (child: ChildProcess) => void;
}

/**
 * The `child_process.execFile`-shaped call this adapter spawns through,
 * injected at construction the same way the HTTP adapters inject `FetchLike` —
 * so a test never forks a process. ARGV-ONLY, never a shell.
 */
export type BdExecImpl = (
  bin: string,
  args: readonly string[],
  options: BdExecOptions,
) => Promise<BdExecResult>;

const execFileAsync = promisify(execFile);

/**
 * The real transport: `execFile` with the login-shell PATH resolved through
 * {@link buildCommandEnv} (a macOS GUI app inherits a minimal PATH, so a plain
 * `execFile('bd')` would miss a Homebrew/asdf install — the same problem
 * runGit.ts already solves) and the live child surfaced via `onSpawn`.
 */
export const defaultBdExec: BdExecImpl = async (bin, args, options) => {
  const pending = execFileAsync(bin, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    encoding: 'utf8',
  });
  options.onSpawn?.(pending.child);
  const { stdout, stderr } = await pending;
  return { stdout, stderr };
};

// ---------------------------------------------------------------------------
// Per-workspace spawn mutex
// ---------------------------------------------------------------------------

/**
 * One promise chain per workspace PATH (not per adapter instance): two
 * connections, or an inbound pass and an outbox drain, can hold separate
 * adapters over the same `.beads` and would otherwise both queue on the flock
 * and burn each other's timeout budget. Keyed by path because that is what the
 * flock is keyed by.
 */
const workspaceSpawnQueues = new Map<string, Promise<void>>();

function withWorkspaceLock<T>(workspacePath: string, run: () => Promise<T>): Promise<T> {
  const previous = workspaceSpawnQueues.get(workspacePath) ?? Promise.resolve();
  // `.then(run, run)` rather than `.then(run)`: a spawn that FAILED must not
  // wedge every later spawn behind a rejected tail.
  const result = previous.then(run, run);
  // The stored tail is deliberately a swallowed copy — the real rejection goes
  // to this call's own caller, and an unhandled one on the chain would crash
  // the process.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  workspaceSpawnQueues.set(workspacePath, tail);
  void tail.then(() => {
    // Drop the entry once this call is the last one out, so a long-lived
    // process does not accumulate one resolved promise per workspace ever seen.
    if (workspaceSpawnQueues.get(workspacePath) === tail) {
      workspaceSpawnQueues.delete(workspacePath);
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * stderr substrings that mean a DETERMINISTIC failure: retrying cannot fix it,
 * so the connection pauses with the actionable text in its banner and a
 * re-detect resumes. Matched on stderr CONTENT rather than on the exit code
 * because every bd failure is exit 1 — and because the retryable and the
 * corrupt-store strings share a byte-identical 68-character PREFIX
 * (`Error: failed to open database: embeddeddolt: init schema: embeddeddolt:
 * open db: `), which a prefix match would conflate.
 */
const TERMINAL_STDERR_MARKERS: readonly string[] = [
  // Workspace unresolved. Identical text whether `.beads` is missing, renamed,
  // or a `BEADS_DIR` dangles — bd cannot distinguish them.
  'no beads database found',
  // Same condition when the workspace is pinned via `-C` (which every spawn
  // here is): bd 1.2.2 says `cannot use -C directory "...": no beads project
  // found` instead of the walk-up wording above.
  'no beads project found',
  // Corrupt store: a truncated manifest surfaces as an EOF, or leaks the raw Go
  // parse error. `bd doctor` is a no-op in embedded mode, so this cannot be
  // self-healed.
  'open db: EOF',
  'strconv.ParseUint',
  // Store gutted (the Dolt database directory is gone under a live `.beads`).
  'Error 1049',
  // Config bug: someone pinned `--readonly`/`readonly: true` on a connection
  // that must write.
  'is not allowed in read-only mode',
  // A downgrade (or an upstream rename) took a flag this adapter pins.
  'unknown flag',
  'unknown shorthand flag',
  'unknown command',
];

/** The lock-contention string, reachable ONLY when we SIGTERM our own child. */
const LOCK_CONTENTION_MARKER = 'the database is locked by another dolt process';

/** Per-ITEM, never per-connection: the id is gone, the workspace is fine. */
const UNKNOWN_ID_MARKER = 'no issue found matching';

/** The `data.error` text `bd show`/`bd close` put on STDOUT for a missing id. */
const UNKNOWN_ID_STDOUT_MARKER = 'no issue';

interface ExecFailureShape {
  message: string;
  code?: string | number;
  signal?: string;
  stdout?: string;
  stderr?: string;
}

function readExecFailure(err: unknown): ExecFailureShape {
  if (typeof err !== 'object' || err === null) {
    return { message: String(err) };
  }
  const raw = err as Record<string, unknown>;
  const code = raw.code;
  const signal = raw.signal;
  return {
    message: typeof raw.message === 'string' ? raw.message : String(err),
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    signal: typeof signal === 'string' ? signal : undefined,
    stdout: typeof raw.stdout === 'string' ? raw.stdout : undefined,
    stderr: typeof raw.stderr === 'string' ? raw.stderr : undefined,
  };
}

/**
 * Map one `bd` spawn failure onto the typed error the sync core branches on.
 * Exported for the table-driven test that pins every probed string.
 *
 * The default is RETRYABLE (`TrackerApiError` with a null status, which
 * outboxWorker's `isTerminalApiError` takes down the backoff path), because an
 * unrecognized failure is more likely a transient we have not seen than a
 * permanent one — but only because the ENGINE owns the consecutive-failure
 * escalation that stops an unknown deterministic failure from looping silently.
 * That escalation is not this function's job.
 */
export function classifyBdFailure(err: unknown): TrackerApiError {
  const failure = readExecFailure(err);
  const stderr = failure.stderr ?? '';
  const stdout = failure.stdout ?? '';
  const detail = stderr.trim().length > 0 ? stderr.trim() : failure.message;

  // The listing outgrew its buffer. TERMINAL, deliberately: classified as
  // transient it would stall initial import (or every sweep) in an infinite
  // retry loop, and the stdout that came back is truncated mid-string and
  // unparseable, so there is nothing to salvage by trying again.
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new TrackerAuthError(
      PROVIDER,
      'this beads workspace is too large to read in one call — `bd` output exceeded the buffer ' +
        'ceiling and arrived truncated mid-string. See ' +
        'docs/proposals/tracker-beads-provider.md ("Bounded listings"); sync cannot proceed ' +
        'until the workspace is trimmed (`bd compact`) or split.',
      null,
    );
  }

  // `bd` is not installed, or not on the login-shell PATH this adapter resolves.
  if (failure.code === 'ENOENT') {
    return new TrackerAuthError(
      PROVIDER,
      '`bd` was not found on PATH — install beads (github.com/gastownhall/beads) and re-detect ' +
        'this connection.',
      null,
    );
  }

  // Our own timeout's SIGTERM landed on a child blocked behind the flock. bd
  // traps the signal and exits 1 with this string rather than dying on it.
  if (stderr.includes(LOCK_CONTENTION_MARKER)) {
    return new TrackerApiError(
      PROVIDER,
      `the beads workspace was locked by another \`bd\` process for longer than ` +
        `${BEADS_REQUEST_TIMEOUT_MS}ms — retrying`,
      null,
    );
  }

  // Our SIGKILL escalation, for a child that outlived its SIGTERM. Nothing is
  // written to stderr on that path, so the empty-stderr half of the match is
  // what distinguishes it from a real failure that happened to be killed.
  if ((failure.code === 137 || failure.signal === 'SIGKILL') && stderr.trim().length === 0) {
    return new TrackerApiError(
      PROVIDER,
      `\`bd\` did not exit within ${BEADS_REQUEST_TIMEOUT_MS + SIGKILL_ESCALATION_MS}ms and was ` +
        'killed — retrying',
      null,
    );
  }

  // Terminal PER ITEM, not per connection: the workspace answered correctly,
  // this one id is simply gone. Carried as a 404 — the ONE status this adapter
  // ever mints — so the outbox terminalizes the row (its 4xx rule) instead of
  // retrying a lookup that can never succeed, and so {@link isUnknownIdFailure}
  // can recognize the answer after classification. NOT a TrackerAuthError,
  // which would pause the whole connection over one missing issue.
  //
  // BOTH streams carry it, in two different wordings and not always together:
  // `bd update` puts `no issue found matching "<id>"` on stderr with an EMPTY
  // stdout, while `bd show`/`bd close` put an enveloped `{"error": "no issues
  // found matching the provided IDs"}` on stdout.
  const stdoutError = readEnvelopeErrorText(stdout);
  if (
    stderr.includes(UNKNOWN_ID_MARKER) ||
    (stdoutError !== null && stdoutError.toLowerCase().includes(UNKNOWN_ID_STDOUT_MARKER))
  ) {
    return new TrackerApiError(PROVIDER, stderr.trim().length > 0 ? detail : (stdoutError ?? detail), 404);
  }

  for (const marker of TERMINAL_STDERR_MARKERS) {
    if (stderr.includes(marker)) {
      return new TrackerAuthError(PROVIDER, detail, null);
    }
  }

  // Some other enveloped error on stdout with an otherwise silent stderr.
  if (stdoutError !== null) {
    return new TrackerApiError(PROVIDER, `bd reported: ${stdoutError}`, null);
  }

  return new TrackerApiError(PROVIDER, detail, null);
}

/**
 * True when a failure is the "this id does not exist" answer.
 *
 * Reads the CLASSIFIED error, because every spawn is classified before it
 * leaves {@link BeadsAdapter} — 404 is the only status this adapter mints, and
 * it means exactly this. The raw-shape fallback covers a caller that has not
 * been through the classifier yet.
 */
function isUnknownIdFailure(err: unknown): boolean {
  if (err instanceof TrackerApiError) return err.status === 404;
  const failure = readExecFailure(err);
  if ((failure.stderr ?? '').includes(UNKNOWN_ID_MARKER)) return true;
  const stdoutError = readEnvelopeErrorText(failure.stdout ?? '');
  return stdoutError !== null && stdoutError.toLowerCase().includes(UNKNOWN_ID_STDOUT_MARKER);
}

/** The `data.error` string out of an enveloped error payload, if that is what this is. */
function readEnvelopeErrorText(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  if (envelope === null) return null;
  const data = asRecord(envelope.data);
  const error = data?.error;
  return typeof error === 'string' ? error : null;
}

// ---------------------------------------------------------------------------
// Shared transport
// ---------------------------------------------------------------------------

/**
 * The child environment every `bd` spawn here runs with: the login-shell PATH
 * (macOS GUI apps inherit a minimal one), the envelope opt-in, and `BEADS_DIR`
 * REMOVED.
 *
 * The removal is defense-in-depth rather than the primary lever — `-C` beats
 * `BEADS_DIR` by bd's own proven precedence — but it is cheap, and the failure
 * it guards is silent and total: an app launched with `BEADS_DIR` set (a
 * documented beads usage pattern) would otherwise probe, import, close and
 * update issues in that ONE workspace for every project, with each connection
 * still looking valid. It matters MORE for {@link initializeBeadsWorkspace},
 * which has no `-C` to be beaten by.
 */
function beadsChildEnv(): NodeJS.ProcessEnv {
  const env = buildCommandEnv({ BD_JSON_ENVELOPE: '1' });
  delete env.BEADS_DIR;
  return env;
}

/**
 * One `bd` (or `git`) spawn with everything that must wrap it: the
 * per-workspace mutex, the timeout plus SIGKILL escalation, the `maxBuffer`
 * orphan reap, and the failure classification.
 *
 * Module-level rather than a method because {@link initializeBeadsWorkspace}
 * runs BEFORE any adapter can exist for the workspace and must still queue on
 * the same flock chain as an adapter's spawns.
 */
function spawnBd(
  execImpl: BdExecImpl,
  workspacePath: string,
  bin: string,
  args: readonly string[],
  maxBuffer: number,
): Promise<BdExecResult> {
  return withWorkspaceLock(workspacePath, async () => {
    let child: ChildProcess | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    try {
      return await execImpl(bin, args, {
        cwd: workspacePath,
        env: beadsChildEnv(),
        timeout: BEADS_REQUEST_TIMEOUT_MS,
        maxBuffer,
        onSpawn: (spawned) => {
          child = spawned;
          escalation = setTimeout(() => {
            try {
              spawned.kill('SIGKILL');
            } catch {
              // Already reaped between the timer firing and this call.
            }
          }, BEADS_REQUEST_TIMEOUT_MS + SIGKILL_ESCALATION_MS);
          escalation.unref?.();
        },
      });
    } catch (err) {
      // Node does NOT kill the child on a maxBuffer overflow — it just stops
      // reading and rejects — so the orphan is reaped here or not at all.
      if (readExecFailure(err).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        try {
          child?.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
      throw classifyBdFailure(err);
    } finally {
      if (escalation !== undefined) clearTimeout(escalation);
    }
  });
}

// ---------------------------------------------------------------------------
// Workspace initialization
// ---------------------------------------------------------------------------

/**
 * Create a beads workspace in `workspacePath` — what the wizard's
 * "Initialize beads here" button runs when Detect finds none.
 *
 * `bd init` MUST run with the target folder as CWD and WITHOUT `-C`: bd 1.2.2
 * answers `bd -C <dir> init` with "no beads project found", because `-C`
 * resolves an EXISTING workspace, which is the one thing init does not have.
 * That is why this cannot go through {@link BeadsAdapter.bd}, whose whole job
 * is pinning `-C`.
 *
 * `--stealth` is the only variant that commits NOTHING: the ignore entry lands
 * in `.git/info/exclude` (local-only), so `git status` stays empty and no
 * collaborator inherits a `.claude/settings.json` hook. A folder that is not a
 * git repository becomes one (`.git`, branch `main`) — bd's own behavior, not
 * something this adds. No `--prefix`: bd derives the issue prefix from the
 * folder name, which is what the user sees in the wizard afterwards.
 *
 * Re-running on an initialized workspace exits 1 with "This workspace is
 * already initialized", which reaches the caller verbatim through
 * {@link classifyBdFailure} — it is self-explanatory and needs no rewording.
 */
export async function initializeBeadsWorkspace(
  workspacePath: string,
  exec: BdExecImpl = defaultBdExec,
): Promise<void> {
  await spawnBd(exec, workspacePath, BD_BIN, ['init', '--stealth'], DEFAULT_MAX_BUFFER);
  try {
    await spawnBd(exec, workspacePath, BD_BIN, ['metrics', 'off'], DEFAULT_MAX_BUFFER);
  } catch {
    // Best-effort by design: `bd metrics off` is a GLOBAL setting, not part of
    // the workspace this call created. The workspace exists either way, and
    // failing the init over a telemetry toggle would leave the user with a
    // usable workspace and an error saying otherwise.
  }
}

// ---------------------------------------------------------------------------
// Envelope + row parsing
// ---------------------------------------------------------------------------

/** A raw bd issue row. Optional fields are OMITTED when unset, never null. */
type BeadsRow = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(row: BeadsRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * `data` out of a `BD_JSON_ENVELOPE=1` payload, or `undefined` when stdout is
 * not JSON at all — which is a REAL, exit-0 shape on the no-op paths
 * (`bd reopen` on an already-open issue prints `<id> is already open`), so the
 * caller decides whether to tolerate it rather than this parser deciding for
 * everyone.
 *
 * A `schema_version` other than 1 is TERMINAL: the envelope was opted into
 * precisely to pin the output shape across beads' announced v2.0 break, so a
 * different version means this adapter is reading a contract it was never
 * verified against.
 */
function parseEnvelope(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const envelope = asRecord(parsed);
  if (envelope === null) return undefined;
  if (!('schema_version' in envelope)) return undefined;
  if (envelope.schema_version !== 1) {
    throw new TrackerAuthError(
      PROVIDER,
      `bd emitted JSON schema_version ${JSON.stringify(envelope.schema_version)}; this adapter ` +
        `is verified only against schema_version 1 (bd ${MIN_BD_VERSION}). Upgrade cyboflow or ` +
        'pin an older bd.',
      null,
    );
  }
  return envelope.data;
}

/** {@link parseEnvelope}, but a non-JSON stdout is itself the failure. */
function requireEnvelope(stdout: string, verb: string): unknown {
  const data = parseEnvelope(stdout);
  if (data === undefined) {
    throw new TrackerAuthError(
      PROVIDER,
      `bd ${verb} did not emit a JSON envelope (got ${JSON.stringify(stdout.slice(0, 200))}) — ` +
        'the installed bd is not the verified output contract.',
      null,
    );
  }
  return data;
}

/** `list`/`show`/`update`/`close`/`history` wrap their payload as an ARRAY. */
function envelopeRows(stdout: string, verb: string): BeadsRow[] {
  const data = requireEnvelope(stdout, verb);
  if (!Array.isArray(data)) {
    throw new TrackerAuthError(
      PROVIDER,
      `bd ${verb} returned a non-array envelope payload; expected an array of rows.`,
      null,
    );
  }
  const rows: BeadsRow[] = [];
  for (const entry of data) {
    const row = asRecord(entry);
    if (row !== null) rows.push(row);
  }
  return rows;
}

/** `create` is the one verb whose payload is a BARE OBJECT, not an array. */
function envelopeObject(stdout: string, verb: string): BeadsRow {
  const data = requireEnvelope(stdout, verb);
  const row = asRecord(data);
  if (row === null) {
    throw new TrackerAuthError(
      PROVIDER,
      `bd ${verb} returned a non-object envelope payload; expected a single object.`,
      null,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Content fingerprint
// ---------------------------------------------------------------------------

/**
 * The raw-row fields the fingerprint is defined over, ALREADY SORTED so the
 * projected object's key order is deterministic without a second sort.
 *
 * An ALLOW-LIST, not a deny-list: a field beads adds in a future release must
 * not silently start flapping every issue's fingerprint on upgrade. The set is
 * everything sync-relevant plus the three counters and `labels`, which are here
 * precisely BECAUSE `bd label add`/`bd comment`/`bd dep add` do not bump
 * `updated_at` — catching those is the whole reason the sweep is fingerprinted
 * rather than cursored.
 *
 * `bd list` and `bd show` carry the SAME key set for a given issue (they differ
 * only in key ORDER, which the canonicalization removes), so both sources hash
 * an unchanged issue identically. A create/update ECHO row is the one narrower
 * shape — it omits the counters and `labels` — so a fingerprint stamped from a
 * write echo differs from the same issue's listing fingerprint and costs one
 * point fetch on the next sweep, after which the baseline re-stamps from the
 * (listing-shaped) point fetch and matches. That is a bounded cost, not a
 * correctness gap: `revision` is contractually compare-for-equality only.
 */
const FINGERPRINT_FIELDS: readonly string[] = [
  'assignee',
  'close_reason',
  'closed_at',
  'comment_count',
  'created_at',
  'created_by',
  'dependencies',
  'dependency_count',
  'dependent_count',
  'description',
  'id',
  'issue_type',
  'labels',
  'metadata',
  'owner',
  'parent',
  'priority',
  'status',
  'title',
  'updated_at',
];

/** Recursively key-sort every object so JSON.stringify is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asRecord(value);
  if (record === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = canonicalize(record[key]);
  return sorted;
}

/**
 * The opaque content fingerprint this adapter reports as
 * {@link TrackerIssue.revision} — sha256 over the canonical JSON of
 * {@link FINGERPRINT_FIELDS}. Exported for tests and for the reconciliation
 * sweep's ledger, which stores the same string.
 *
 * `labels` is SORTED before hashing: bd's label order is presentation, not
 * content, and an unordered re-emit would otherwise read as a change. Absent
 * fields are OMITTED (bd never emits null for an unset field), which is what
 * keeps a list row and a show row of the same issue identical.
 */
export function beadsIssueFingerprint(row: BeadsRow): string {
  const projected: Record<string, unknown> = {};
  for (const field of FINGERPRINT_FIELDS) {
    const value = row[field];
    if (value === undefined) continue;
    projected[field] =
      field === 'labels' && Array.isArray(value)
        ? [...value].map((entry) => String(entry)).sort()
        : canonicalize(value);
  }
  return createHash('sha256').update(JSON.stringify(projected)).digest('hex');
}

// ---------------------------------------------------------------------------
// States + field vocabularies
// ---------------------------------------------------------------------------

/**
 * beads' SEVEN built-in statuses, mapped onto the canonical groups that seed
 * the wizard's mapping table. The grouping only ever SEEDS a default the user
 * then overrides — it never gates the sync — which is why the three genuinely
 * ambiguous rungs below are a judgement call rather than a blocker.
 *
 * CUSTOM statuses are deliberately OUT of v1 scope. beads supports them
 * (`statuses.custom` config), but Phase 0 found no command that enumerates a
 * workspace's effective status list with its behavior category attached — and
 * inventing one from a config file we do not otherwise read would produce a
 * mapping table that silently disagrees with what bd accepts on a write. A
 * custom status therefore arrives inbound as an unmapped state (skipped, per
 * the state-mapping resolver's default) rather than as a wrong mapping.
 */
const BEADS_STATES: readonly TrackerState[] = [
  // The create default: filed, not started.
  { id: 'open', name: 'Open', color: null, group: 'unstarted' },
  { id: 'in_progress', name: 'In progress', color: null, group: 'started' },
  // Started-but-stuck, not backlogged: work exists and someone is waiting on
  // something. Grouped with `started` so it seeds Ready-for-development.
  { id: 'blocked', name: 'Blocked', color: null, group: 'started' },
  // bd's "frozen" category — deliberately parked, which is backlog, not queued.
  { id: 'deferred', name: 'Deferred', color: null, group: 'backlog' },
  { id: 'closed', name: 'Closed', color: null, group: 'completed' },
  // Also "frozen": pinned issues are excluded from the default listing exactly
  // like closed ones, so they are parked rather than in flight.
  { id: 'pinned', name: 'Pinned', color: null, group: 'backlog' },
  // Waiting on an external hook to fire — in flight, not parked.
  { id: 'hooked', name: 'Hooked', color: null, group: 'started' },
];

/**
 * beads' priority scale, `'0'`..`'4'` with 0 the highest and 2 the create
 * default. STATIC, not discovered: bd's priorities are integers, not a
 * renameable workspace vocabulary like Dart's.
 */
const BEADS_PRIORITIES: readonly string[] = ['0', '1', '2', '3', '4'];

/**
 * The issue TYPES `bd create --type` / `bd update --type` accept without custom
 * config. Also static — and deliberately excluding the exotic types Phase 0
 * found creatable but out of sync scope (`gate`, `molecule`, `message`), which
 * map inbound through the category overlay like any other unrecognized type.
 */
const BEADS_CATEGORIES: readonly string[] = ['bug', 'feature', 'task', 'epic', 'chore'];

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** The identity half of a workspace probe — both halves of the invariant. */
export interface BeadsWorkspaceIdentity {
  /** `.beads/metadata.json` → `project_id`; immutable per database instance. */
  instanceId: string;
  /** The issue-id prefix. Survives a reinit, changes on `bd rename-prefix`. */
  prefix: string;
  /** The resolved `.beads` directory `-C` landed on. */
  beadsDir: string;
}

export interface BeadsAdapterOptions {
  /** The `bd` workspace root every spawn is pinned to with `-C`. */
  workspacePath: string;
  /**
   * The connection's stored `workspace_id`. When set, every sandwich checkpoint
   * compares it and a mismatch pauses the connection rather than acting on a
   * different database's data. Absent during the wizard's own Detect probe,
   * which is where the value comes FROM.
   */
  expectedInstanceId?: string;
  /** The connection's stored `workspace_name` (the issue prefix). See above. */
  expectedPrefix?: string;
  /** The connection's stored resolved `.beads` path. See above. */
  expectedBeadsDir?: string;
  /** Injected for tests; defaults to {@link defaultBdExec}. */
  execImpl?: BdExecImpl;
  /** Injected for tests; defaults to a utf8 `fs/promises.readFile`. */
  readFileImpl?: (path: string) => Promise<string>;
}

export class BeadsAdapter implements TrackerAdapter {
  readonly provider: TrackerProvider = PROVIDER;
  readonly capabilities: TrackerAdapterCapabilities = CAPABILITIES;

  private readonly workspacePath: string;
  private readonly expectedInstanceId: string | undefined;
  private readonly expectedPrefix: string | undefined;
  private readonly expectedBeadsDir: string | undefined;
  private readonly execImpl: BdExecImpl;
  private readonly readFileImpl: (path: string) => Promise<string>;

  constructor(options: BeadsAdapterOptions) {
    this.workspacePath = options.workspacePath;
    this.expectedInstanceId = options.expectedInstanceId;
    this.expectedPrefix = options.expectedPrefix;
    this.expectedBeadsDir = options.expectedBeadsDir;
    this.execImpl = options.execImpl ?? defaultBdExec;
    this.readFileImpl =
      options.readFileImpl ?? ((path: string) => readFile(path, { encoding: 'utf8' }));
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * `bd version` (pinning the minimum), then the identity probe, then the local
   * git identity for display attribution.
   *
   * There is nothing to authenticate — beads is keyless (its "credential" is
   * that the project has a `bd init`ed workspace at all), so this method's real
   * job is the two things `connect()` persists: the immutable instance id it
   * binds the connection to, and the prefix half of the identity invariant.
   */
  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    const { stdout } = await this.bd(['version']);
    const version = parseBdVersion(stdout);
    if (version === null) {
      throw new TrackerAuthError(
        PROVIDER,
        `could not read a version out of \`bd version\` (${JSON.stringify(stdout.trim())}); ` +
          `beads ${MIN_BD_VERSION} or newer is required.`,
        null,
      );
    }
    if (!isAtLeastVersion(version, MIN_BD_VERSION)) {
      throw new TrackerAuthError(
        PROVIDER,
        `beads ${version} is older than the minimum supported ${MIN_BD_VERSION} — several ` +
          'behaviours this adapter depends on differ in earlier releases. Upgrade `bd` and ' +
          're-detect.',
        null,
      );
    }

    const identity = await this.assertIdentity();
    return {
      workspaceId: identity.instanceId,
      workspaceName: identity.prefix,
      actorLabel: await this.resolveActorLabel(),
    };
  }

  /**
   * beads has no project/team/board level at all — one workspace holds one flat
   * issue space — so the Map step gets a single degenerate group, the same
   * shape Dart's loose-dartboard groups take. Its name is the issue PREFIX,
   * which is the only workspace-identifying string a user recognizes.
   */
  async listGroups(): Promise<TrackerGroupTree> {
    const identity = await this.assertIdentity();
    return {
      sections: [
        {
          label: 'Workspace',
          groups: [
            {
              id: WORKSPACE_CONTAINER_ID,
              name: identity.prefix,
              key: identity.prefix,
              sourceLabel: identity.prefix,
              selection: {
                containerId: WORKSPACE_CONTAINER_ID,
                narrowId: 'all',
                narrowKind: 'all',
              },
              // One state list for the whole provider, so the States step
              // renders exactly one mapping table.
              stateScopeKey: WORKSPACE_CONTAINER_ID,
            },
          ],
        },
      ],
    };
  }

  async listContainers(): Promise<TrackerSourceTree> {
    const identity = await this.assertIdentity();
    return {
      containerLabel: 'Workspace',
      containers: [
        {
          id: WORKSPACE_CONTAINER_ID,
          name: identity.prefix,
          key: identity.prefix,
          // bd has no cheap open-issue count that does not cost a full listing.
          openIssueCount: null,
        },
      ],
    };
  }

  async listNarrows(_containerId: string): Promise<TrackerSourceNarrow[]> {
    // beads models no view/cycle/module to narrow by, so the whole workspace is
    // the only scope on offer — and the contract requires 'all' to be present,
    // which here is the entire list.
    return [
      { id: 'all', kind: 'all', name: 'Whole workspace · all issues', issueCount: null },
    ];
  }

  async listStates(_selection: TrackerSourceSelection): Promise<TrackerState[]> {
    // Static, and selection-free: beads' status vocabulary is workspace-wide
    // and its seven built-ins are hardcoded in bd itself. See BEADS_STATES for
    // why custom statuses are out of v1 scope.
    return [...BEADS_STATES];
  }

  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    // Both scales are STATIC (see BEADS_PRIORITIES / BEADS_CATEGORIES) — unlike
    // Dart there is no live workspace vocabulary to fetch, and unlike
    // Linear/Plane beads DOES have a type field, so `categories` is non-null.
    return { priorities: [...BEADS_PRIORITIES], categories: [...BEADS_CATEGORIES] };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * `bd list --all --json --limit 0`, optionally cursored.
   *
   * `--all` is LOAD-BEARING: the default listing hides exactly `{closed,
   * pinned}` (hardcoded in bd, not derived from its status taxonomy), so
   * without it a remote closure would never sync and the sweep would read every
   * closed linked issue as deleted. `--limit 0` is belt-and-braces: the
   * documented default `--limit 50` is DEAD in 1.2.2, but upstream could
   * "fix" that at any release.
   *
   * Gates and ephemeral/wisp beads stay out of scope by construction — neither
   * `--include-gates` nor `--include-infra` is ever passed, on this path OR the
   * sweep's, so the two views can never disagree about what exists.
   */
  async listIssues(_selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]> {
    // The selection is unused on purpose: beads has exactly one issue space per
    // workspace and no view/cycle/module to narrow by, so every selection this
    // adapter can mint resolves to the same whole-workspace listing.
    const rows = await this.listRows(sinceIso);
    return rows.map((row) => this.mapIssue(row));
  }

  /**
   * The bare id set. Present for contract completeness only: beads declares
   * `requiresIdReconciliation`, so the deletion sweep calls
   * {@link listIssueRevisions} instead and this path is not on the sweep's
   * hot line. Same `--all --limit 0` ground rules — `bd delete` is a HARD
   * delete and `bd prune`/`bd gc`-decayed issues drop out, both of which the
   * sweep correctly reads as "gone".
   */
  async listIssueIds(_selection: TrackerSourceSelection): Promise<string[]> {
    const rows = await this.listRows(undefined);
    return rows.map((row) => readString(row, 'id') ?? '').filter((id) => id.length > 0);
  }

  /**
   * The reconciliation sweep's ground truth: every id paired with its content
   * fingerprint. Timestamp-INDEPENDENT by construction, which is the point —
   * a `bd dolt pull` preserves each issue's origin `updated_at` (so a
   * pulled-in issue can predate the cursor forever), and label/comment/
   * dependency edits never bump it at all.
   */
  async listIssueRevisions(
    _selection: TrackerSourceSelection,
  ): Promise<Array<{ id: string; revision: string }>> {
    const rows = await this.listRows(undefined);
    const pairs: Array<{ id: string; revision: string }> = [];
    for (const row of rows) {
      const id = readString(row, 'id');
      if (id === undefined || id.length === 0) continue;
      pairs.push({ id, revision: beadsIssueFingerprint(row) });
    }
    return pairs;
  }

  /**
   * `bd show <id> --json`, plus one bounded `bd history` for the concurrency
   * token.
   *
   * A missing id arrives on BOTH streams at once and in two different wordings
   * (`bd show` puts `{"data":{"error":"no issues found matching the provided
   * IDs"}}` on stdout AND `no issue found matching "<id>"` on stderr, exit 1),
   * so both shapes are read as null rather than as a failure — and the history
   * spawn is skipped entirely, since there is no issue to token.
   */
  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    let stdout: string;
    try {
      ({ stdout } = await this.bd(['show', externalId, '--json']));
    } catch (err) {
      if (isUnknownIdFailure(err)) return null;
      throw err;
    }
    const rows = envelopeRows(stdout, 'show');
    if (rows.length === 0) return null;
    const row = rows[0];

    await this.assertIdentity();

    // One extra serialized spawn, and only here: the token is the pre-send read's
    // half of a guarded write, so it is worth a spawn on the path the outbox
    // drain actually takes and worth nothing on the listing paths.
    const history = await this.readHistory(externalId, 1);
    const token = history === null ? undefined : readString(history[0] ?? {}, 'CommitHash');
    return this.mapIssue(row, token);
  }

  // -------------------------------------------------------------------------
  // Creates
  // -------------------------------------------------------------------------

  /**
   * A child of `parentExternalId`. beads models hierarchy natively (`--parent`,
   * dotted child ids like `pfx-88w.1`), and the child row carries an explicit
   * `parent`, so nothing has to be inferred from the id shape.
   */
  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    return this.create(draft, clientKey, parentExternalId);
  }

  /**
   * A top-level issue. beads has exactly one place to file against — the
   * workspace — so unlike Linear/Plane/Dart the selection names no create
   * target and is unused here.
   */
  async createIssue(
    _selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string,
  ): Promise<TrackerIssue> {
    return this.create(draft, clientKey, null);
  }

  /**
   * Ambiguous-create recovery (see outboxWorker's `findByClientKey`): the issue
   * carrying `clientKey` in its `metadata`, or null when none does — which,
   * because EVERY create stamps the key, proves the create never landed and a
   * retry is safe.
   *
   * `--all` is as load-bearing here as on the listing: a create that lands,
   * loses its response, and is CLOSED before recovery runs (an app restart in
   * between, say) would otherwise report "no match" and the non-idempotent
   * retry would duplicate it.
   *
   * `scope` is accepted for the seam's shape and deliberately not applied: the
   * key is a UUID minted for exactly one outbox row, so a match is conclusive
   * on its own, whereas narrowing by parent or container could turn a landed
   * create into a false "never landed" — the one error this method must never
   * make.
   *
   * Not part of `TrackerAdapter`, matching Dart/Plane: the outbox discovers it
   * structurally.
   */
  async findIssueByClientKey(
    _scope: {
      containerId: string | null;
      parentExternalId: string | null;
      updatedAfterIso?: string | null;
    },
    clientKey: string,
  ): Promise<TrackerIssue | null> {
    const { stdout } = await this.bd(
      [
        'list',
        '--all',
        '--json',
        '--limit',
        '0',
        '--metadata-field',
        `${CLIENT_KEY_METADATA_FIELD}=${clientKey}`,
      ],
      LISTING_MAX_BUFFER,
    );
    const rows = envelopeRows(stdout, 'list');
    await this.assertIdentity();
    return rows.length === 0 ? null : this.mapIssue(rows[0]);
  }

  // -------------------------------------------------------------------------
  // Guarded mutations
  // -------------------------------------------------------------------------

  /**
   * Move an issue to a beads status.
   *
   * `closed` goes through `bd close`, not `bd update --status closed`, because
   * only `close` also sets `closed_at`/`close_reason` — the fields every later
   * read and the sweep's own classification rely on. Every other target goes
   * through `bd update --status`, which was probed against all seven built-ins.
   *
   * Lifting an issue OFF `closed` needs `bd reopen` (it clears
   * `closed_at`/`close_reason`; a bare `--status` write does not), and whether
   * a given issue is closed is not known here without a read — so rather than
   * spend a pre-read on every call, the CONFIRMING re-fetch decides: if the
   * issue is still closed after the status write, reopen and re-apply. That
   * also covers the double-close no-op, whose success line LIES (it echoes the
   * new reason while persisting nothing) — which is exactly why state is
   * confirmed by re-fetch and never by success text.
   */
  async updateIssueState(
    externalId: string,
    stateId: string,
    expectedToken?: string,
  ): Promise<void> {
    await this.assertIdentity();

    if (stateId === 'closed') {
      await this.runTolerantWrite(['close', externalId, '--json']);
    } else {
      await this.runTolerantWrite(['update', externalId, '--status', stateId, '--json']);
    }

    let confirmed = await this.showRow(externalId);
    if (
      stateId !== 'closed' &&
      confirmed !== null &&
      (readString(confirmed, 'status') !== stateId || readString(confirmed, 'closed_at') !== undefined)
    ) {
      await this.runTolerantWrite(['reopen', externalId, '--json']);
      if (stateId !== 'open') {
        await this.runTolerantWrite(['update', externalId, '--status', stateId, '--json']);
      }
      confirmed = await this.showRow(externalId);
    }

    await this.assertIdentity();

    if (confirmed === null) {
      throw new TrackerApiError(
        PROVIDER,
        `issue ${externalId} disappeared while its status was being written`,
        404,
      );
    }
    const finalStatus = readString(confirmed, 'status');
    if (finalStatus !== stateId) {
      throw new TrackerApiError(
        PROVIDER,
        `bd accepted the write but issue ${externalId} is still in status ` +
          `${JSON.stringify(finalStatus ?? null)} rather than ${JSON.stringify(stateId)}`,
        null,
      );
    }

    if (expectedToken !== undefined) {
      await this.verifyGuardedWrite(externalId, { status: stateId }, expectedToken);
    }
  }

  /**
   * `bd update <id>` with ONLY the flags `patch` actually carries — an absent
   * field means "leave alone" (checked via `!== undefined`, never truthiness,
   * per {@link IssueContentPatch}'s contract).
   *
   * NO MARKER COMPOSITION happens here, and none is needed: beads is the one
   * provider whose recovery key lives in `metadata` rather than the
   * description, and metadata survives every body edit
   * (see {@link CLIENT_KEY_METADATA_FIELD}).
   *
   * Two `null` halves of the patch have no beads spelling and are therefore
   * SKIPPED rather than sent: `priority` is always an integer 0-4 (defaulting
   * to 2) and `issue_type` always has a value, so neither models an absence the
   * way Dart's omitted keys do — the same shape as Linear's `'0'` and Plane's
   * `'none'`, which are real rungs rather than clearings. A `null` DESCRIPTION
   * is sent as the empty string, which is the closest bd offers: its only
   * documented clearing path is `--allow-empty-description` alongside
   * `--body-file`/`--stdin`, neither of which this argv-only transport uses.
   */
  async updateIssueContent(
    externalId: string,
    patch: IssueContentPatch,
    expectedToken?: string,
  ): Promise<TrackerIssue | null> {
    const args: string[] = ['update', externalId];
    const written: BeadsRow = {};
    if (patch.title !== undefined) {
      args.push('--title', patch.title);
      written.title = patch.title;
    }
    if (patch.description !== undefined) {
      const body = patch.description ?? '';
      args.push('--description', body);
      written.description = body;
    }
    if (patch.priority !== undefined && patch.priority !== null) {
      args.push('--priority', patch.priority);
      written.priority = Number(patch.priority);
    }
    if (patch.category !== undefined && patch.category !== null) {
      args.push('--type', patch.category);
      written.issue_type = patch.category;
    }

    // Nothing writable in this patch (a category/priority clear on a provider
    // with no clearing spelling). A no-op write would be a wasted spawn AND a
    // spurious Dolt commit that later guards would have to reason about, so
    // this reads the current state instead.
    if (args.length === 2) {
      const current = await this.showRow(externalId);
      // A read, so it takes the inbound half of the sandwich: nothing collected
      // from a replaced workspace may reach a caller.
      await this.assertIdentity();
      return current === null ? null : this.mapIssue(current);
    }

    await this.assertIdentity();
    args.push('--json');
    const echo = await this.runTolerantWrite(args);
    // The echo is the ordinary path; a tolerated non-JSON no-op line means the
    // post-write state has to come from a re-fetch instead.
    const row = echo ?? (await this.showRow(externalId));
    await this.assertIdentity();

    if (expectedToken !== undefined) {
      await this.verifyGuardedWrite(externalId, written, expectedToken);
    }
    return row === null ? null : this.mapIssue(row);
  }

  /**
   * Unreachable by construction — `capabilities.archive === 'none'` (the shared
   * table's value), so the caller must fall back to the cancelled-state write
   * before ever calling this. beads' only removal verb is `bd delete --force`,
   * which is a HARD delete, and the locked scope decision forbids outbound
   * archive ever being one.
   */
  async archiveIssue(_externalId: string): Promise<void> {
    throw new TrackerApiError(
      PROVIDER,
      'beads archive is unsupported: `bd delete` is a HARD delete and beads models no ' +
        "trash/archive state. The caller must gate on capabilities.archive === 'none' before " +
        'ever calling this.',
      null,
    );
  }

  /**
   * The workspace's current Dolt HEAD — the newest `CommitHash` in any linked
   * issue's history — or null when it cannot be read.
   *
   * WHY ANY ID ANSWERS FOR THE WHOLE DATABASE: `bd history` is UNFILTERED. It
   * reports one entry per DB commit (each carrying that commit's snapshot of the
   * issue asked about), so `--limit 1` on ANY resolvable id yields the newest
   * commit in the database, which IS the head. Phase 0 demoted this to
   * best-effort precisely because no cheaper anchor exists — there is no
   * `bd dolt log` — and Phase 2 then proved `--limit` real, which is what makes
   * the read O(1) instead of O(all commits).
   *
   * The sweep's archival guard is its only caller
   * (docs/proposals/tracker-beads-provider.md, round 16): identity catches a
   * REPLACED database, not a concurrent `bd dolt pull` restoring an issue inside
   * the same one. Null on an unresolvable id or an unavailable history rather
   * than a throw — a guard that cannot read the head must degrade to "no guard",
   * never to a failed sweep, since reversible archival is the primary defense.
   *
   * Identity-sandwiched like every other read here: the history is collected
   * first, then the identity is re-checked before the value is handed back, so a
   * head read off a replaced database can never be compared against one read off
   * the original.
   */
  async workspaceHead(anyLinkedExternalId: string): Promise<string | null> {
    const history = await this.readHistory(anyLinkedExternalId, 1);
    if (history === null || history.length === 0) return null;
    await this.assertIdentity();
    return readString(history[0], 'CommitHash') ?? null;
  }

  // -------------------------------------------------------------------------
  // Internals — transport
  // -------------------------------------------------------------------------

  /**
   * One `bd` spawn, with the workspace pinning, the envelope opt-in, the
   * timeout/SIGKILL escalation and the per-workspace mutex all applied.
   */
  private bd(args: readonly string[], maxBuffer = DEFAULT_MAX_BUFFER): Promise<BdExecResult> {
    return this.spawn(
      BD_BIN,
      ['-C', this.workspacePath, '--dolt-auto-commit', 'on', ...args],
      maxBuffer,
    );
  }

  private spawn(
    bin: string,
    args: readonly string[],
    maxBuffer: number,
  ): Promise<BdExecResult> {
    return spawnBd(this.execImpl, this.workspacePath, bin, args, maxBuffer);
  }

  // -------------------------------------------------------------------------
  // Internals — identity sandwich
  // -------------------------------------------------------------------------

  /**
   * Resolve the workspace `-C` actually landed on: `bd where` for the `.beads`
   * path and the prefix, then `metadata.json` for the immutable `project_id`.
   *
   * The instance id is read from DISK because no bd command exposes it —
   * `bd info`/`bd context`/`bd config list` all omit it, `bd info --json`
   * ignores `--json` entirely, and `bd context` unconditionally refuses any
   * workspace under `/private/tmp`. The init banner's "Repository ID"/"Clone
   * ID" are unusable: deterministically derived (identical across a same-path
   * reinit) and persisted nowhere.
   */
  private async probeIdentity(): Promise<BeadsWorkspaceIdentity> {
    const { beadsDir, prefix } = await this.probeWorkspace();
    return { instanceId: await this.readInstanceId(beadsDir), prefix, beadsDir };
  }

  /** The `bd where` half — the resolved `.beads` directory and the issue prefix. */
  private async probeWorkspace(): Promise<{ beadsDir: string; prefix: string }> {
    const { stdout } = await this.bd(['where', '--json']);
    const where = envelopeObject(stdout, 'where');
    const beadsDir = readString(where, 'path');
    const prefix = readString(where, 'prefix');
    if (beadsDir === undefined || prefix === undefined) {
      throw new TrackerAuthError(
        PROVIDER,
        '`bd where` did not report a workspace path and prefix — this project has no resolvable ' +
          'beads workspace. Run `bd init` in it, then re-detect.',
        null,
      );
    }
    return { beadsDir, prefix };
  }

  /** The on-disk half — the immutable `project_id` under a resolved `.beads`. */
  private async readInstanceId(beadsDir: string): Promise<string> {
    const metadataPath = `${beadsDir}/metadata.json`;
    let raw: string;
    try {
      raw = await this.readFileImpl(metadataPath);
    } catch (err) {
      throw new TrackerAuthError(
        PROVIDER,
        `could not read ${metadataPath}, which carries this workspace's immutable database id: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TrackerAuthError(PROVIDER, `${metadataPath} is not valid JSON`, null);
    }
    const metadata = asRecord(parsed);
    const instanceId = metadata === null ? undefined : readString(metadata, 'project_id');
    if (instanceId === undefined || instanceId.length === 0) {
      throw new TrackerAuthError(
        PROVIDER,
        `${metadataPath} carries no project_id — cyboflow binds a beads connection to that id, ` +
          'so a workspace without one cannot be synced safely.',
        null,
      );
    }
    return instanceId;
  }

  /**
   * {@link probeIdentity}, compared against whatever the connection was bound
   * to. THE sandwich checkpoint: called after every listing's output is
   * collected and before it is returned, after `getIssue`'s read, and on both
   * sides of every mutation.
   *
   * The two halves fail differently on purpose, because they need different
   * recoveries: a changed INSTANCE ID means the workspace was replaced
   * (`rm -rf .beads && bd init`) and every retained link points at issues that
   * no longer exist, while a changed PREFIX means `bd rename-prefix` rewrote
   * every issue id suffix-preserved (`chk-2lz` → `newpfx-2lz`) — the same
   * issues under new names, which a deterministic link remap can recover and a
   * sweep would catastrophically read as "everything was deleted".
   */
  private async assertIdentity(): Promise<BeadsWorkspaceIdentity> {
    // The `bd where` halves are compared FIRST, before the metadata read: a
    // workspace that has moved out from under this connection would otherwise
    // be reported as "cannot read <some other path>/metadata.json", which names
    // the symptom rather than the cause.
    const { beadsDir, prefix } = await this.probeWorkspace();

    if (this.expectedBeadsDir !== undefined && beadsDir !== this.expectedBeadsDir) {
      throw new TrackerAuthError(
        PROVIDER,
        `this project's \`bd\` workspace now resolves to ${beadsDir}, not the ` +
          `${this.expectedBeadsDir} this connection was detected against. Re-detect to confirm ` +
          'which workspace to sync.',
        null,
      );
    }
    if (this.expectedPrefix !== undefined && prefix !== this.expectedPrefix) {
      throw new TrackerAuthError(
        PROVIDER,
        `this beads workspace's issue prefix was RENAMED from ${this.expectedPrefix} to ` +
          `${prefix} (\`bd rename-prefix\`), which rewrote every existing issue id. The ` +
          "database is the same one; re-detect to remap this connection's links onto the new " +
          'ids.',
        null,
      );
    }

    const instanceId = await this.readInstanceId(beadsDir);
    if (this.expectedInstanceId !== undefined && instanceId !== this.expectedInstanceId) {
      throw new TrackerAuthError(
        PROVIDER,
        `this beads workspace was REPLACED: its database instance id is now ${instanceId}, not ` +
          `the ${this.expectedInstanceId} this connection is bound to. A \`.beads\` directory ` +
          'was deleted and re-initialized at the same path, so every linked issue belongs to a ' +
          'database that no longer exists. Re-detect to adopt the new workspace.',
        null,
      );
    }
    return { instanceId, prefix, beadsDir };
  }

  // -------------------------------------------------------------------------
  // Internals — reads
  // -------------------------------------------------------------------------

  /**
   * The whole-workspace listing every read path shares, with the identity
   * re-check applied AFTER collection and BEFORE the rows are handed back — so
   * no caller can act on a batch a replaced workspace produced.
   */
  private async listRows(sinceIso: string | undefined): Promise<BeadsRow[]> {
    const args = ['list', '--all', '--json', '--limit', '0'];
    if (sinceIso !== undefined) args.push('--updated-after', normalizeCursor(sinceIso));
    const { stdout } = await this.bd(args, LISTING_MAX_BUFFER);
    const rows = envelopeRows(stdout, 'list');
    await this.assertIdentity();
    return rows;
  }

  /** `bd show <id>` as a raw row, or null when the id does not resolve. */
  private async showRow(externalId: string): Promise<BeadsRow | null> {
    try {
      const { stdout } = await this.bd(['show', externalId, '--json']);
      const rows = envelopeRows(stdout, 'show');
      return rows.length === 0 ? null : rows[0];
    } catch (err) {
      if (isUnknownIdFailure(err)) return null;
      throw err;
    }
  }

  /**
   * `bd history <id> --limit N --json`, NEWEST FIRST (verified against the
   * Phase-0 group-D transcript: `data[0]` is the most recent commit and the
   * last entry is the issue's creation).
   *
   * Returns null when history is UNAVAILABLE rather than empty — bd's only
   * exit-0 error shape (empty stdout, message on stderr only) plus the
   * post-squash case, both of which mean "there is no token space to verify
   * against" and both of which the guarded path treats as re-baseline rather
   * than as a failure.
   */
  private async readHistory(externalId: string, limit: number): Promise<BeadsRow[] | null> {
    let result: BdExecResult;
    try {
      result = await this.bd(['history', externalId, '--limit', String(limit), '--json']);
    } catch (err) {
      if (isUnknownIdFailure(err)) return null;
      throw err;
    }
    const data = parseEnvelope(result.stdout);
    if (data === undefined) {
      // Exit 0, nothing parseable: the unresolvable-history shape.
      return null;
    }
    if (!Array.isArray(data)) return null;
    const entries: BeadsRow[] = [];
    for (const entry of data) {
      const row = asRecord(entry);
      if (row !== null) entries.push(row);
    }
    return entries;
  }

  // -------------------------------------------------------------------------
  // Internals — writes
  // -------------------------------------------------------------------------

  /**
   * Run a write and return its echoed row, or `null` when bd took a no-op path
   * and printed plain human text with exit 0 DESPITE `--json` (`bd reopen` on
   * an already-open issue is the probed case). The caller then confirms state
   * by re-fetch, which is the rule everywhere on this transport.
   */
  private async runTolerantWrite(args: readonly string[]): Promise<BeadsRow | null> {
    const { stdout } = await this.bd(args);
    const data = parseEnvelope(stdout);
    if (data === undefined) return null;
    if (Array.isArray(data)) return asRecord(data[0]);
    return asRecord(data);
  }

  /**
   * The create both entry points share: `bd create` with the client key in
   * `metadata`, then — only when the draft names a non-default status — the
   * separate `bd update --status` that applies it.
   *
   * The status is NOT sent on the create itself: Phase 0 exercised
   * `bd update --status` against all seven built-ins but never a `--status` on
   * `create`, and an unknown flag is a TERMINAL failure that would break every
   * create rather than one. A second spawn on the minority path is the cheaper
   * side of that trade.
   */
  private async create(
    draft: IssueDraft,
    clientKey: string,
    parentExternalId: string | null,
  ): Promise<TrackerIssue> {
    await this.assertIdentity();

    // `--title` rather than the positional form: a title beginning with `-`
    // would otherwise be parsed as a flag by bd's own argv parser.
    const args = ['create', '--title', draft.title];
    if (draft.description !== undefined) args.push('--description', draft.description);
    if (draft.priority !== undefined && draft.priority !== null) {
      args.push('--priority', draft.priority);
    }
    if (draft.category !== undefined && draft.category !== null) {
      args.push('--type', draft.category);
    }
    if (parentExternalId !== null) args.push('--parent', parentExternalId);
    args.push('--metadata', JSON.stringify({ [CLIENT_KEY_METADATA_FIELD]: clientKey }), '--json');

    const { stdout } = await this.bd(args);
    // `create` is the ONE verb whose envelope payload is a bare object.
    let row = envelopeObject(stdout, 'create');
    const externalId = readString(row, 'id');
    if (externalId === undefined || externalId.length === 0) {
      throw new TrackerApiError(PROVIDER, 'bd create returned an issue with no id', null);
    }

    if (draft.stateId !== undefined && readString(row, 'status') !== draft.stateId) {
      if (draft.stateId === 'closed') {
        await this.runTolerantWrite(['close', externalId, '--json']);
      } else {
        await this.runTolerantWrite(['update', externalId, '--status', draft.stateId, '--json']);
      }
      row = (await this.showRow(externalId)) ?? row;
    }

    // Post-write half of the outbound sandwich: a create that SUCCEEDS against
    // a replacement database must never reach local bookkeeping, or the link,
    // the baseline and the settled outbox row all bind to the wrong workspace
    // with recovery never entered.
    await this.assertIdentity();
    return this.mapIssue(row);
  }

  /**
   * Detect-after-write verification for one guarded mutation.
   *
   * beads cannot refuse a write, so this runs AFTER it: read history back to
   * the caller's `expectedToken`, find our own write's commit, and diff
   * ADJACENT snapshots for every commit in between to attribute exactly which
   * fields each interleaved write changed. Because `bd update` patches only the
   * flags it is given (per-field, unlike an HTTP PUT), the ONLY hazard is an
   * interleaved write to a field WE also wrote:
   *
   *   - interleaved commit touched no patched field → nothing was clobbered;
   *   - interleaved commit set a patched field to a DIFFERENT value → we
   *     clobbered it: {@link TrackerRevisionMismatchError}, carrying the
   *     overwritten value recovered from that commit's own snapshot (strictly
   *     better than the HTTP providers, where the raced value is unrecoverable);
   *   - interleaved commit set a patched field to the SAME value → converged.
   *
   * A token that is not in the bounded window escalates to the full history
   * once; a token that is in NEITHER means `bd compact`/`flatten`/`gc` squashed
   * it away, and the only sound response is to re-baseline — verification is
   * skipped rather than reported as a conflict that cannot be substantiated.
   */
  private async verifyGuardedWrite(
    externalId: string,
    written: BeadsRow,
    expectedToken: string,
  ): Promise<void> {
    const fields = Object.keys(written);
    if (fields.length === 0) return;

    const bounded = await this.readHistory(externalId, GUARD_HISTORY_LIMIT);
    if (bounded === null) return;
    const tokenIn = (entries: BeadsRow[]): number =>
      entries.findIndex((entry) => readString(entry, 'CommitHash') === expectedToken);

    let history = bounded;
    let tokenIndex = tokenIn(history);
    if (tokenIndex === -1) {
      const full = await this.readHistory(externalId, 0);
      if (full === null) return;
      history = full;
      tokenIndex = tokenIn(history);
      // Not in the FULL history either: `bd compact`/`flatten`/`gc` squashed
      // the token away. There is nothing left to verify against, so the sound
      // answer is to re-baseline — never to report a conflict this adapter
      // cannot substantiate.
      if (tokenIndex === -1) return;
    }

    const snapshotAt = (index: number): BeadsRow => asRecord(history[index]?.Issue) ?? {};

    // Our own write is the NEWEST commit whose snapshot carries every patched
    // field at the value we sent. Falling back to index 0 when none matches is
    // deliberate: that means something landed on top of us AFTER our write, and
    // the walk below is still the right question to ask about the window.
    let ourIndex = 0;
    for (let index = 0; index < tokenIndex; index += 1) {
      if (fields.every((field) => valuesEqual(snapshotAt(index)[field], written[field]))) {
        ourIndex = index;
        break;
      }
    }

    const conflicting = new Set<string>();
    let recoveredFrom: BeadsRow | null = null;
    for (let index = ourIndex + 1; index < tokenIndex; index += 1) {
      const snapshot = snapshotAt(index);
      const previous = snapshotAt(index + 1);
      for (const field of fields) {
        // Attribution is per-commit: a field this commit did not change is
        // churn from further back and was never at risk from our write.
        if (valuesEqual(snapshot[field], previous[field])) continue;
        if (valuesEqual(snapshot[field], written[field])) continue;
        conflicting.add(field);
        recoveredFrom ??= snapshot;
      }
    }

    if (conflicting.size === 0) return;
    const reported = [...conflicting].map(reportedFieldName);
    throw new TrackerRevisionMismatchError(
      `[${PROVIDER}] issue ${externalId}: an interleaved \`bd\` write changed ` +
        `${reported.join(', ')} between the pre-send read and this write, and this write ` +
        'overwrote it',
      reported,
      recoveredFrom === null ? null : this.mapIssue(recoveredFrom),
    );
  }

  // -------------------------------------------------------------------------
  // Internals — mapping
  // -------------------------------------------------------------------------

  private mapIssue(row: BeadsRow, concurrencyToken?: string): TrackerIssue {
    const assignee = readString(row, 'assignee');
    const priority = row.priority;
    const issue: TrackerIssue = {
      externalId: readString(row, 'id') ?? '',
      // beads mints no second human ref: the id (`bd-a1b2`, or a dotted child
      // id) IS the readable identifier, like Dart's.
      identifier: readString(row, 'id') ?? '',
      title: readString(row, 'title') ?? '',
      description: readString(row, 'description') ?? null,
      // beads has no web UI and no per-issue URL. The three engine link-write
      // sites normalize this empty string to NULL so no "open in tracker"
      // affordance ever renders a dead link.
      url: '',
      stateId: readString(row, 'status') ?? '',
      // bd carries a bare assignee STRING (an identity, not a user object), so
      // the id and the display name are necessarily the same value.
      assignee: assignee === undefined ? null : mapAssignee(assignee),
      // `bd update -e/--estimate` exists (minutes), but nothing in this sync
      // reads or writes it and it is absent from every listing row probed.
      estimate: null,
      parentExternalId: readString(row, 'parent') ?? null,
      updatedAt: readString(row, 'updated_at') ?? '',
      // beads models no archived state at all: `bd delete --force` is a HARD
      // delete, so an issue is either present or gone — which the sweep's own
      // absence check already classifies.
      archivedAt: null,
      // Provider-RAW, as the contract requires. bd always populates an integer
      // (create defaults to 2), so this is effectively never null.
      priority: typeof priority === 'number' ? String(priority) : (readString(row, 'priority') ?? null),
      category: readString(row, 'issue_type') ?? null,
      // The metadata channel, not a description marker — see
      // CLIENT_KEY_METADATA_FIELD. Read on EVERY mapped row (listing, point
      // fetch, create echo) so a lost create's issue surfaces its key no matter
      // how it was found.
      recoveryClientKey: readClientKey(row),
      revision: beadsIssueFingerprint(row),
    };
    if (concurrencyToken !== undefined) issue.concurrencyToken = concurrencyToken;
    return issue;
  }

  /**
   * Display attribution for the connected view. beads has no accounts — every
   * Dolt commit's `Committer` is the literal `root` — so the local git identity
   * is the only meaningful "who is this connection acting as", with the OS user
   * as the fallback when git has none configured.
   */
  private async resolveActorLabel(): Promise<string> {
    try {
      const { stdout } = await this.spawn('git', ['config', 'user.name'], DEFAULT_MAX_BUFFER);
      const name = stdout.trim();
      if (name.length > 0) return name;
    } catch {
      // No git identity here; fall through to the OS user.
    }
    try {
      return userInfo().username;
    } catch {
      return 'unknown';
    }
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/**
 * The strict RFC3339 UTC form bd's `--updated-after` comparator is safe with.
 *
 * VALIDATED, not passed through, because the failure mode is silent and total:
 * a date-SHAPED but invalid value (`2026-13-45`) makes bd DROP the filter
 * entirely — exit 0, output byte-identical to no filter at all — and a
 * date-ONLY value resolves to LOCAL midnight rather than UTC. Fractional
 * seconds are silently discarded by bd, so they are dropped here too rather
 * than being emitted and quietly truncated.
 *
 * The remaining 1-second skew (bd FLOORS the comparator while every read path
 * ROUNDS `updated_at` for display) is swallowed by the engine's own 10-minute
 * overlap window, which is why nothing is subtracted here.
 */
export function normalizeCursor(sinceIso: string): string {
  const parsed = new Date(sinceIso);
  if (Number.isNaN(parsed.getTime())) {
    throw new TrackerApiError(
      PROVIDER,
      `refusing to send ${JSON.stringify(sinceIso)} as a beads sync cursor: bd silently DROPS a ` +
        'date-shaped invalid --updated-after value and returns the whole workspace instead of ' +
        'failing.',
      null,
    );
  }
  return `${parsed.toISOString().slice(0, 19)}Z`;
}

/** `bd version 1.2.2 (Homebrew)` → `1.2.2`. */
function parseBdVersion(stdout: string): string | null {
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(stdout);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

function isAtLeastVersion(actual: string, minimum: string): boolean {
  const left = actual.split('.').map((part) => Number(part));
  const right = minimum.split('.').map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * Structural equality over the JSON scalars and containers a bd snapshot can
 * hold. Deliberately canonicalizing rather than `===`: a `metadata` object
 * re-serialized in a different key order is the same value, and reading it as a
 * change would manufacture a conflict out of nothing.
 */
function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

/**
 * The RAW bd field names this adapter guards on, reported back in
 * {@link TrackerRevisionMismatchError.conflictingFields} as the corresponding
 * {@link TrackerIssue} field — the space the outbox drain's patch is expressed
 * in, and therefore the only naming a consumer can act on.
 */
function reportedFieldName(rawField: string): string {
  switch (rawField) {
    case 'status':
      return 'stateId';
    case 'issue_type':
      return 'category';
    default:
      return rawField;
  }
}

function readClientKey(row: BeadsRow): string | null {
  const metadata = asRecord(row.metadata);
  if (metadata === null) return null;
  const key = metadata[CLIENT_KEY_METADATA_FIELD];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

function mapAssignee(assignee: string): TrackerUserRef {
  return { id: assignee, name: assignee, initials: deriveInitials(assignee) };
}

/** Two-letter avatar initials; beads publishes no avatar or display name. */
function deriveInitials(name: string): string {
  const parts = name
    .replace(/[<>@].*$/, '')
    .split(/[\s._-]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
