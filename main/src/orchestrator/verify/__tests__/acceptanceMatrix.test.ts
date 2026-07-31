/**
 * THE §5.4 ACCEPTANCE FAILURE-INJECTION MATRIX
 * (docs/proposals/verification-setup-flow.md §5.4), as scripted scenarios.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT MORE UNIT TESTS. Every module in
 * `verify/` already has a suite proving its own contract in isolation, and v1 of
 * the proposal proposed "3 consecutive green runs" as the acceptance bar. v2
 * threw that out with a one-line argument worth restating: *three warmed
 * happy-path passes prove none of the guarantees this proposal exists for.* The
 * failures this phase was built to stop are all COMPOSITIONAL — a squatted port
 * that becomes a lane-blocking FAIL because the classifier never saw the
 * preflight; a drifted runbook that still executes because the demotion happened
 * in a store nobody re-read; an install command that reaches a snapshot because
 * one of the two enqueue seams forgot the guard. None of those can fail in a
 * module test, because in a module test the collaborator that would have caught
 * them is a stub.
 *
 * So each row below drives the REAL {@link VerificationScheduler}, the REAL
 * {@link VerificationAgentRunner}, the REAL {@link VerifyRunbookStore} /
 * {@link VerifyCapabilityStore}, and the REAL enqueue seam
 * ({@link prepareVerificationEnqueue}) over a migration-backed in-memory DB. Only
 * the OUTSIDE WORLD is faked, and only at the seams the modules already inject
 * for exactly this purpose: the SDK query, the chromium/port/screen probes, the
 * driver-written attestation file, and (for the two dependency rows) the `cp`
 * that builds a mirror. Nothing between `enqueue()` and the persisted terminal
 * row is a stub — which is the only way a row can be evidence about the SYSTEM
 * rather than about one module's opinion of its neighbours.
 *
 * ONE ROW IS DELIBERATELY NOT AUTOMATED. §5.4 says "every row is a scripted
 * scenario, runnable unattended EXCEPT the consent row" — the native-screen
 * consent gate moves the user's real pointer, and §4's v1 policy is explicit
 * per-run go-ahead. That row is a `it.todo` naming the decision it is waiting
 * on; what IS asserted here is the contract that actually exists today
 * (observe-only: `requiresDrive` behaviors coerced to `not_testable`, and a
 * capability-less host skipped before any lease is taken).
 *
 * READING A FAILURE HERE. A red row is a claim about the composition, so the
 * useful first question is never "which assertion broke" but "which seam stopped
 * agreeing with its neighbour". The row titles are written to make that
 * answerable: each names the injected fault and the observable §5.4 requires.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import {
  VerificationScheduler,
  ResourceLeasePool,
  VERIFY_NO_RUNBOOK_REASON,
  type VerificationSchedulerDeps,
} from '../verificationScheduler';
import {
  VerificationAgentRunner,
  ATTESTATION_MISSING_MESSAGE,
  ATTESTATION_UNCAPPED_MESSAGE,
  type AttestationRecord,
  type VerificationAgentRunnerDeps,
  type ResolvedVerifyAgent,
} from '../verificationAgentRunner';
import { VerifyCapabilityStore, CAPABILITY_BREAKER_THRESHOLD } from '../capabilityStore';
import { VerifyRunbookStore, type VerifyRunbookStoreDeps } from '../runbookStore';
import { VerifyDepPreparer, type DepExec } from '../depPreparer';
import { captureSnapshotSha, provisionSnapshot, type SnapshotProvision } from '../snapshotProvisioner';
import { prepareVerificationEnqueue } from '../enqueueFromTask';
import { decideMergeGate, isMergeGateBlocking } from '../mergeGateLaneAdvance';
import { Mutex } from '../../../utils/mutex';
import { setSeamErrorSink } from '../../telemetrySink';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { withTempDir } from '../../../__test_fixtures__/tmp';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';
import type {
  ResolvedVisualVerifyConfig,
  VerificationModality,
  VerificationReportV1,
  VerificationTaskV1,
  VerificationType,
  VerdictV1,
  VlmJudge,
} from '../../../../../shared/types/visualVerification';

// ---------------------------------------------------------------------------
// The DB: real migrations, not a hand-rolled schema
// ---------------------------------------------------------------------------

/** The project/run worktree every row probes unless it needs a real git tree. */
const LIVE_WORKTREE = '/live/worktree';

const MIG_DIR = path.join(__dirname, '..', '..', '..', 'database', 'migrations');

/**
 * The minimal REAL migration chain that stands up everything a matrix row
 * touches, in order: the core run/workflow tables (006–016), `workflow_runs
 * .batch_id` (022 — the merge-gate's lane attribution reads it), the
 * verification queue + per-project budget (055/056), the run's agent-provider
 * stamp (062), the agent-engine request columns `task_json`/`report_json`/
 * `delivery_state`/`snapshot_sha`/`enqueue_key` (078), the phase-0 failure-class
 * + modality + `setup_proof` columns (088), and the phase-2 runbook record +
 * request PIN (089).
 *
 * Hand-rolling this schema (as the older scheduler suites do) is fine for a
 * module test and WRONG here: half of what this file asserts is that a column
 * added by a migration is actually read by the code that claims to read it, and
 * a hand-rolled table is a place where that can silently be true in the test and
 * false in production. The chain is also the cheapest available proof that 088
 * and 089 apply cleanly on top of the real 078 shape.
 */
const MIGRATION_CHAIN = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '022_sprint_batches.sql',
  '055_visual_verification.sql',
  '056_visual_verify_budget.sql',
  '062_workflow_run_agent_provider.sql',
  '078_verification_agent_requests.sql',
  '088_verify_failure_classes.sql',
  '089_verify_runbook_local.sql',
] as const;

/**
 * `projects` is created by hand because it predates the file-based migrations
 * (the same reason capabilityStore.test.ts / runbookStore.test.ts do it) —
 * WITHOUT `visual_verify_budget_calls`, which migration 056 in the chain adds
 * itself. Pre-creating that column would make 056 fail on a duplicate name and
 * silently abandon the REST of that file, which is where `judge_calls_used`
 * lives — i.e. the budget assertions would pass against a table that never got
 * the column they are about.
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      path       TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  for (const file of MIGRATION_CHAIN) db.exec(readFileSync(path.join(MIG_DIR, file), 'utf-8'));
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Matrix', LIVE_WORKTREE);
  return db;
}

/**
 * Seed the `workflows` parent row (a real FK, unlike the hand-rolled schemas)
 * plus one AGENT-STAMPED run. `verify_chain = ['agent']` is what routes the
 * request to the runner rather than the capture-backend waterfall, and
 * `verify_enabled = 1` is what the enqueue seam reads.
 */
function seedRun(dbX: Database.Database, runId: string, worktreePath: string = LIVE_WORKTREE): void {
  dbX
    .prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json, permission_mode)
       VALUES ('wf-matrix', 1, 'sprint', '{}', 'default')`,
    )
    .run();
  dbX
    .prepare(
      `INSERT INTO workflow_runs
         (id, workflow_id, project_id, status, worktree_path, verify_enabled, verify_type, verify_chain, agent_provider)
       VALUES (?, 'wf-matrix', 1, 'running', ?, 1, 'interactive-web-behavior', ?, 'claude')`,
    )
    .run(runId, worktreePath, JSON.stringify(['agent']));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'interactive-web-behavior',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  devServerPorts: [29260, 29262],
  simulatorDevices: [],
  queuedAgeCeilingMs: 15 * 60 * 1000,
  agentSlots: 2,
};

/** The leased pair every row's request gets: the pool's first slot and its driver sidecar. */
const LEASED_PORT = 29260;
const DRIVER_PORT = LEASED_PORT + 1;

/** How long a row waits on `awaitTerminal` before calling the scheduler wedged. */
const TERMINAL_DEADLINE_MS = 20_000;
const TERMINAL_POLL_MS = 5;

const fakeJudge: VlmJudge = {
  judge: async (): Promise<VerdictV1> => {
    throw new Error('the agent engine never calls the VLM judge — a call here is a routing bug');
  },
};

/**
 * The portable runbook the matrix's project "committed". Declares the two
 * modalities the roster supports on this host plus their §7.1 attestation
 * channels — `attestation` is REQUIRED per modality by the portable contract,
 * which is what makes "no attestation ⇒ no passed" enforceable at all.
 */
function baseRunbook(): VerifyRunbookV1 {
  return {
    version: 1,
    modalities: {
      web: {
        build: ['pnpm run build:web'],
        serve: { cmd: 'pnpm run preview -- --port ${PORT}', readyWhen: { urlPath: '/' } },
        attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
      },
      'cdp-app': {
        serve: { cmd: 'electron . --remote-debugging-port=${PORT}', attach: 'cdp' },
        attestation: { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1' },
      },
      'native-screen': {
        serve: { cmd: 'electron .' },
        attestation: { kind: 'window-identity', titlePattern: 'Cyboflow' },
      },
    },
  };
}

/**
 * What task-verify actually composes for a lane: behaviors PLUS its own guessed
 * `build`/`serve`. The guess is deliberately present rather than left blank —
 * §1's diagnosis is that the composer guesses build/serve and has been wrong
 * every time, and §5.2's merge exists to REPLACE that guess with the proven
 * runbook's commands. A fixture with no guess would quietly change what the
 * degrade gate sees when an injection is declined (a task with neither build nor
 * serve derives no environment and is exempt), which would make the drift rows
 * assert nothing.
 */
function composedTask(overrides: Partial<VerificationTaskV1> = {}): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'the settings panel shows the new toggle',
    taskRef: 'TASK-1',
    build: ['pnpm run build'],
    serve: { cmd: 'pnpm dev --port ${PORT}' },
    behaviors: [{ id: 'b1', description: 'the toggle renders', expected: 'visible, default off' }],
    ...overrides,
  };
}

/**
 * The DEGENERATE pre-live shape: a bare target, nothing to build, nothing to
 * serve. Built as its own factory rather than as an override of
 * {@link composedTask} because the point is the ABSENCE of `build`/`serve`, and
 * an object spread cannot remove keys — a "degenerate" task that still carried
 * them would be routed through the degrade gate it is supposed to be exempt from.
 */
function degenerateTask(
  target: { url?: string; htmlPath?: string },
  overrides: Partial<VerificationTaskV1> = {},
): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'the prerendered page renders',
    taskRef: 'TASK-1',
    target,
    behaviors: [{ id: 'b1', description: 'the toggle renders', expected: 'visible, default off' }],
    ...overrides,
  };
}

function passReport(overrides: Partial<VerificationReportV1> = {}): VerificationReportV1 {
  return {
    version: 1,
    behaviors: [{ id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'ok' } }],
    screenshots: [{ fileName: 's.png', caption: 'the toggle' }],
    outcome: 'pass',
    confidence: 0.92,
    feedback: 'the toggle renders, default off',
    issues: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The runbook store, with mutable fake IO
// ---------------------------------------------------------------------------

/**
 * The three environment facts `VerifyRunbookStore.status()` re-checks on every
 * read, made mutable so a row can inject exactly one drift at a time. That
 * granularity is the point: §5.3 says "ANY component changing demotes", and a
 * matrix row that changed two at once could not tell which one the store
 * actually noticed.
 */
interface RunbookIo {
  /** dirPath → portable runbook text. An absent key is the "this tree lacks the file" case (never a demotion). */
  files: Map<string, string>;
  inputHash: string | null;
  fingerprint: string;
}

function makeRunbookIo(probePath: string = LIVE_WORKTREE): RunbookIo {
  return {
    files: new Map([[probePath, JSON.stringify(baseRunbook())]]),
    inputHash: 'inputs-v1',
    fingerprint: 'host-v1',
  };
}

function makeRunbookStore(dbX: Database.Database, io: RunbookIo): VerifyRunbookStore {
  const deps: VerifyRunbookStoreDeps = {
    readPortableFile: async (dirPath) => io.files.get(dirPath) ?? null,
    computeInputHash: async () => io.inputHash,
    hostFingerprint: async () => io.fingerprint,
  };
  return new VerifyRunbookStore(dbAdapter(dbX), deps);
}

/**
 * Drive one modality to `'proven'` the short way (register the derived draft,
 * then flip it). The ENGINE-enforced flip — a `setup_proof` request that
 * actually passed — is covered by verificationSchedulerAgent.test.ts's §5.3
 * suite; here proving is a PRECONDITION of the row under test, not its subject,
 * and going through a full proof run for every row would make each one assert
 * two things at once.
 */
async function proveModality(
  store: VerifyRunbookStore,
  modality: VerificationModality,
  probePath: string = LIVE_WORKTREE,
): Promise<{ hash: string; version: number }> {
  const registered = await store.registerDraft(1, probePath, modality);
  if ('error' in registered) throw new Error(`registerDraft failed: ${registered.error}`);
  const proven = store.markProven(1, modality, registered.hash, registered.version, '{"fixture":true}');
  expect(proven).toEqual({ ok: true });
  return registered;
}

// ---------------------------------------------------------------------------
// The runner, with every outside-world seam injected
// ---------------------------------------------------------------------------

/**
 * The injected environment ONE scenario runs against. Mutable (rather than
 * passed per call) so a row can change the world between requests — which is
 * precisely what the breaker row and the drift rows are about.
 */
interface RunnerWorld {
  /** `resolveChromium`: a path, or `null` for the "chromium removed" env fault. */
  chromium: string | null;
  /** Ports a FOREIGN process holds. `portFreeProbe` answers false for these. */
  occupiedPorts: Set<number>;
  /** What the (faked) SDK session returns as its structured report. */
  report: VerificationReportV1;
  /** The DRIVER-written attestation record; `null` = the attest step never produced one. */
  attest: AttestationRecord | null;
  /** `nativeCaptureProbe` for the runner's preflight; `null` = not wired (check omitted). */
  nativeCapture: (() => Promise<boolean>) | null;
  /** Provisioning seam; `null` = the fake in-memory snapshot below. */
  provision: VerificationAgentRunnerDeps['provision'] | null;
  /** §5.2 seam-3 pin resolution; `null` = unwired (the runner's pin check does not run). */
  resolveRunbookByHash: VerificationAgentRunnerDeps['resolveRunbookByHash'] | null;
  /**
   * One entry per SDK session actually deployed, holding that session's composed
   * user prompt. Length is what the budget / "never deployed" assertions read —
   * `judge_calls_used` alone cannot distinguish "no session" from "a session the
   * scheduler declined to charge", and §3.6 is a claim about both.
   */
  deploys: string[];
}

function makeWorld(overrides: Partial<RunnerWorld> = {}): RunnerWorld {
  return {
    chromium: '/opt/chromium',
    occupiedPorts: new Set<number>(),
    report: passReport(),
    attest: { ok: true, kind: 'http-endpoint', detail: 'endpoint echoed this request nonce' },
    nativeCapture: null,
    provision: null,
    resolveRunbookByHash: null,
    deploys: [],
    ...overrides,
  };
}

function makeAgent(): EffectiveAgent {
  return {
    agentKey: 'visual-verify',
    name: 'cyboflow-visual-verify',
    role: 'verify',
    description: 'drives and judges the deliverable',
    systemPrompt: 'SYSTEM PROMPT BODY',
    tools: [],
    model: null,
    enabledMcps: [],
    source: 'builtin',
  };
}

/**
 * The REAL runner, with only the outside world faked. Everything the matrix is
 * actually about — preflight ordering, the pin check, the attestation floor, the
 * drive-unsupported coercion, the outcome→status mapping — is the module's own
 * code running unmodified.
 *
 * The fake `provision` is an in-memory stand-in for `git worktree add`: it still
 * reports `mode: 'snapshot'` (which the §3.1 classifier's `'deliverable'` gate
 * requires) without costing a real repo. The two DEPENDENCY rows override it
 * with the real provisioner, because for them the worktree IS the subject.
 */
function makeRunner(world: RunnerWorld): VerificationAgentRunner {
  const resolvedAgent: ResolvedVerifyAgent = {
    agent: makeAgent(),
    runProvider: 'claude',
    runModel: 'claude-sonnet-5',
  };
  const fakeProvision = async (): Promise<SnapshotProvision> => ({
    worktreePath: '/snap',
    sha: 'sha-matrix',
    dispose: async () => {},
  });
  const deps: VerificationAgentRunnerDeps = {
    query: async (args) => {
      world.deploys.push(args.prompt);
      return { structured: world.report, transcript: null };
    },
    resolveVerifyAgent: () => resolvedAgent,
    resolveClaudeAlias: (alias) => `claude-${alias}-resolved`,
    claudeDefaultModel: 'claude-opus-4-8',
    resolveNode: async () => '/usr/bin/node',
    driverCliPath: '/app/driverCli.js',
    provision: world.provision ?? fakeProvision,
    checkSnapshotMutated: async () => false,
    fileExists: async () => true,
    resolveChromium: async () => world.chromium,
    portFreeProbe: async (port) => !world.occupiedPorts.has(port),
    readAttestFile: async () => world.attest,
    writeDriverScript: async () => '/artifacts/.driver/verify-driver.sh',
    stopDriver: async () => {},
    reapBrowser: () => {},
    writeTranscript: async () => {},
    ...(world.nativeCapture ? { nativeCaptureProbe: world.nativeCapture } : {}),
    ...(world.resolveRunbookByHash ? { resolveRunbookByHash: world.resolveRunbookByHash } : {}),
  };
  return new VerificationAgentRunner(deps);
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

/**
 * The REAL scheduler singleton, wired the way index.ts wires it: the runbook
 * store answers BOTH the §3.2 degrade gate and the enqueue-side pin resolution,
 * and the capability ledger takes the classified outcome of every terminal.
 *
 * The scheduler's OWN `portFreeProbe` is deliberately left at its always-free
 * default even in the two squatter rows. That probe answers a different
 * question — "did this deployment leak the port at teardown", which decides
 * release-vs-QUARANTINE — and a quarantined slot would silently change how many
 * ports later requests in the same scenario can lease. The squatter is injected
 * where the row's claim lives: the RUNNER's pre-deploy preflight.
 */
function initScheduler(
  dbX: Database.Database,
  opts: {
    world: RunnerWorld;
    runbookStore?: VerifyRunbookStore;
    capabilityStore?: VerifyCapabilityStore;
    capabilityFinding?: VerificationSchedulerDeps['capabilityFinding'];
    nativeCaptureProbe?: () => Promise<boolean>;
    probePath?: string;
  },
): VerificationScheduler {
  const runbookStore = opts.runbookStore;
  const probePath = opts.probePath ?? LIVE_WORKTREE;
  return VerificationScheduler.initialize({
    db: dbAdapter(dbX),
    backends: {},
    judge: fakeJudge,
    artifactsDirResolver: () => '/artifacts',
    config: CONFIG,
    leasePool: new ResourceLeasePool(new Mutex()),
    agentRunner: makeRunner(opts.world),
    capabilityStore: opts.capabilityStore ?? new VerifyCapabilityStore(dbAdapter(dbX)),
    ...(runbookStore
      ? {
          runbookStore,
          runbookStatus: async (projectId, modality) => runbookStore.status(projectId, probePath, modality),
        }
      : {}),
    ...(opts.capabilityFinding ? { capabilityFinding: opts.capabilityFinding } : {}),
    ...(opts.nativeCaptureProbe ? { nativeCaptureProbe: opts.nativeCaptureProbe } : {}),
  });
}

/**
 * Enqueue through the SHARED enqueue seam (`prepareVerificationEnqueue`) rather
 * than calling `scheduler.enqueue` directly, so every row exercises the §7.2
 * dependency guard and the §5.2 seam-3 proven-runbook injection + pin stamping
 * that a production enqueue would. A row that wants the UNPINNED, un-merged path
 * simply runs against a project with no proven runbook — which is the same thing
 * production does.
 */
async function enqueueThroughSeam(
  scheduler: VerificationScheduler,
  args: {
    runId: string;
    type?: VerificationType;
    task: VerificationTaskV1;
    snapshotSha?: string | null;
    setupProof?: boolean;
    probePath?: string;
  },
): Promise<string> {
  const type: VerificationType = args.type ?? 'interactive-web-behavior';
  const prepared = await prepareVerificationEnqueue({
    projectId: 1,
    runId: args.runId,
    type,
    task: args.task,
    ...(args.probePath !== undefined ? { probePath: args.probePath } : {}),
  });
  if (!prepared.ok) throw new Error(`enqueue preparation rejected the task: ${prepared.error}`);
  const task = prepared.task ?? args.task;
  return scheduler.enqueue({
    runId: args.runId,
    projectId: 1,
    type,
    input: { intent: task.summary, taskRef: task.taskRef ?? 'TASK-1' },
    chain: [],
    task,
    snapshotSha: args.snapshotSha ?? 'sha-matrix',
    ...(args.setupProof === true ? { setupProof: true } : {}),
    ...(prepared.pin
      ? { runbookHash: prepared.pin.hash, runbookLocalVersion: prepared.pin.localVersion }
      : {}),
  });
}

/** The persisted row shape every row's assertions read. */
interface TerminalRow {
  status: string;
  error_message: string | null;
  failure_class: string | null;
  failure_evidence_json: string | null;
  preflight_json: string | null;
  modality: string | null;
  judge_calls_used: number;
  runbook_hash: string | null;
}

function readRow(dbX: Database.Database, requestId: string): TerminalRow {
  return dbX
    .prepare(
      `SELECT status, error_message, failure_class, failure_evidence_json, preflight_json,
              modality, judge_calls_used, runbook_hash
         FROM verification_requests WHERE id = ?`,
    )
    .get(requestId) as TerminalRow;
}

function evidenceOf(row: TerminalRow): Array<{ source: string; check: string; detail: string }> {
  return JSON.parse(row.failure_evidence_json ?? '[]') as Array<{
    source: string;
    check: string;
    detail: string;
  }>;
}

function preflightOf(row: TerminalRow): { ok: boolean; checks: Array<{ id: string; ok: boolean }> } | null {
  return row.preflight_json === null
    ? null
    : (JSON.parse(row.preflight_json) as { ok: boolean; checks: Array<{ id: string; ok: boolean }> });
}

/** Runbook record state, read straight from migration 089's table. */
function runbookRecord(dbX: Database.Database, modality = 'web'): { status: string; version: number } | undefined {
  return dbX
    .prepare('SELECT status, version FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
    .get(modality) as { status: string; version: number } | undefined;
}

// ---------------------------------------------------------------------------
// Real-git fixture (the two dependency rows only)
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A throwaway repo with one commit, a lockfile + manifest (the preparer's key inputs), and a node_modules. */
async function initDepFixtureRepo(dir: string): Promise<void> {
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@cyboflow.dev']);
  git(dir, ['config', 'user.name', 'Cyboflow Test']);
  await fsPromises.writeFile(path.join(dir, 'README.md'), 'v1\n');
  await fsPromises.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await fsPromises.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'matrix-fixture' }));
  await fsPromises.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fsPromises.writeFile(path.join(dir, 'node_modules', 'marker.txt'), 'live-tree\n');
  git(dir, ['add', 'README.md', 'pnpm-lock.yaml', 'package.json']);
  git(dir, ['commit', '-q', '-m', 'init']);
}

/**
 * A `DepExec` that performs the copy for real (so the preparer's own existence
 * checks run against real directories, and the published mirror is a real tree
 * the symlink can point at) and records every invocation. The Electron ABI
 * rebuild is a recorded no-op — §7.2 puts it here on purpose, and the two rows
 * below assert WHERE it happens, never that it works.
 */
function recordingDepExec(calls: Array<{ cmd: string; args: string[] }>): DepExec {
  return async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    if (cmd === 'cp') {
      await fsPromises.cp(args[1], args[2], { recursive: true });
      return { code: 0, out: '' };
    }
    return { code: 0, out: '' };
  };
}

// ---------------------------------------------------------------------------

let db: Database.Database;

beforeEach(() => {
  setSeamErrorSink(() => {});
  // HERMETICITY: with no explicit preparer, `provisionSnapshot` resolves the
  // DEFAULT one, whose cache lives under `CYBOFLOW_DIR|~/.cyboflow`. No test may
  // build a prepared set in the user's real data dir; the two rows that DO
  // exercise the preparer inject their own (an explicit preparer bypasses this
  // switch). Same posture as snapshotProvisioner.test.ts.
  process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER = '1';
  db = buildDb();
  VerificationScheduler._resetForTesting();
});

afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
  delete process.env.CYBOFLOW_DISABLE_VERIFY_DEP_PREPARER;
});

// ===========================================================================
// Rows 1 + 2 — cold deps / warm deps
//
// §5.4: "cold deps (fresh prepared-set build) → green within deadline" and
// "warm deps → green". The observable that matters is not merely 'passed': it
// is WHERE the snapshot's node_modules points. §7.2's hazard is that the link
// resolves to the LIVE worktree, so anything the verification writes lands in
// the tree every sibling lane builds against. A green run whose link still
// pointed at the live tree would satisfy a naive assertion and prove nothing.
// ===========================================================================

describe('§5.4 matrix — dependency preparation', () => {
  /**
   * Runs one full verification against a REAL git repo + a REAL prepared-set
   * cache, with only `cp`/the ABI rebuild faked. Returns the terminal status,
   * the symlink target the snapshot got, and every exec the preparer performed.
   */
  async function runAgainstRealRepo(ctx: {
    repo: string;
    cacheDir: string;
    execCalls: Array<{ cmd: string; args: string[] }>;
    runId: string;
  }): Promise<{ status: string; linkTargets: string[] }> {
    const io = makeRunbookIo(ctx.repo);
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web', ctx.repo);

    const preparer = new VerifyDepPreparer({
      baseDir: ctx.cacheDir,
      exec: recordingDepExec(ctx.execCalls),
    });
    const linkTargets: string[] = [];
    const world = makeWorld({
      // The REAL provisioner: a real detached worktree, real dependency-dir
      // discovery, real symlink creation — wrapped only to read the link back
      // BEFORE `dispose()` removes the tree in the runner's finally block.
      provision: async (opts) => {
        const provision = await provisionSnapshot({ ...opts, depPreparer: preparer });
        linkTargets.push(await fsPromises.readlink(path.join(provision.worktreePath, 'node_modules')));
        return provision;
      },
      resolveRunbookByHash: (projectId, modality, hash) => store.getByHash(projectId, modality, hash),
    });

    seedRun(db, ctx.runId, ctx.repo);
    const scheduler = initScheduler(db, { world, runbookStore: store, probePath: ctx.repo });
    const sha = await captureSnapshotSha(ctx.repo);
    const requestId = await enqueueThroughSeam(scheduler, {
      runId: ctx.runId,
      task: composedTask(),
      snapshotSha: sha,
      probePath: ctx.repo,
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    return { status: outcome.status, linkTargets };
  }

  it('COLD: the preparer builds a fresh mirror, the snapshot links THAT (not the live tree), and the run is green', async () => {
    await withTempDir('matrix-cold-deps-', async (root) => {
      const repo = path.join(root, 'repo');
      await fsPromises.mkdir(repo, { recursive: true });
      await initDepFixtureRepo(repo);
      const cacheDir = path.join(root, 'verify-deps');
      const execCalls: Array<{ cmd: string; args: string[] }> = [];

      const { status, linkTargets } = await runAgainstRealRepo({
        repo,
        cacheDir,
        execCalls,
        runId: 'run-cold',
      });

      expect(status).toBe('passed');

      // A mirror was BUILT (cold): the clone ran at least once.
      expect(execCalls.filter((c) => c.cmd === 'cp').length).toBeGreaterThan(0);

      // …and the snapshot's node_modules resolves INTO the cache, not into the
      // live worktree. This is the §7.2 write-through hazard, closed.
      expect(linkTargets).toHaveLength(1);
      expect(linkTargets[0].startsWith(path.resolve(cacheDir) + path.sep)).toBe(true);
      expect(linkTargets[0].endsWith(path.join('node_modules'))).toBe(true);
      expect(linkTargets[0]).not.toBe(path.join(repo, 'node_modules'));

      // The mirror really is a materialized tree (not a dangling link).
      expect(await fsPromises.readFile(path.join(linkTargets[0], 'marker.txt'), 'utf8')).toBe('live-tree\n');
    });
  }, 60_000);

  it('WARM: a second verification reuses the published set — no re-clone, same mirror, still green', async () => {
    await withTempDir('matrix-warm-deps-', async (root) => {
      const repo = path.join(root, 'repo');
      await fsPromises.mkdir(repo, { recursive: true });
      await initDepFixtureRepo(repo);
      const cacheDir = path.join(root, 'verify-deps');
      const execCalls: Array<{ cmd: string; args: string[] }> = [];

      const first = await runAgainstRealRepo({ repo, cacheDir, execCalls, runId: 'run-warm-1' });
      expect(first.status).toBe('passed');
      const clonesAfterCold = execCalls.filter((c) => c.cmd === 'cp').length;
      expect(clonesAfterCold).toBeGreaterThan(0);

      // A fresh scheduler singleton for the second request — the cache is on
      // DISK, so reuse must not depend on any in-process memo surviving.
      VerificationScheduler._resetForTesting();
      const second = await runAgainstRealRepo({ repo, cacheDir, execCalls, runId: 'run-warm-2' });

      expect(second.status).toBe('passed');
      // The whole point: the published set was ADOPTED, not rebuilt.
      expect(execCalls.filter((c) => c.cmd === 'cp').length).toBe(clonesAfterCold);
      expect(second.linkTargets).toEqual(first.linkTargets);
    });
  }, 60_000);
});

// ===========================================================================
// Rows 3 + 4 — a foreign process holds the port the harness leased
// ===========================================================================

describe('§5.4 matrix — leased port pre-occupied by a foreign process', () => {
  it("ROW 3: env-skip via preflight, failure_class 'env', budget uncharged, and the merge gate ADVANCES with zero attempt increment", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The §1(e) false-ready incident, reproduced: the pool handed out a logical
    // slot while a stale server from an unrelated worktree still owned the OS
    // socket. The connect probe is the only thing that can see that.
    const world = makeWorld({ occupiedPorts: new Set([LEASED_PORT]) });
    seedRun(db, 'run-squatted');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, { runId: 'run-squatted', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('skipped');
    const row = readRow(db, requestId);
    expect(row.failure_class).toBe('env');

    // HARNESS-derived provenance, never model prose — the conservative rule
    // that makes an advancing skip safe at all (§3.1).
    const evidence = evidenceOf(row);
    expect(evidence).toContainEqual(
      expect.objectContaining({ source: 'port-probe', check: 'port-free' }),
    );
    expect(evidence[0].detail).toContain('squatter');

    // Nothing was deployed and nothing was charged (§3.6): a misconfigured host
    // must not spend a project's lifetime budget discovering it is misconfigured.
    expect(world.deploys).toHaveLength(0);
    expect(row.judge_calls_used).toBe(0);
    expect(preflightOf(row)?.ok).toBe(false);

    // §5.4's actual requirement — "ZERO lane-attempt increment". The merge gate
    // ADVANCES a skip (R4), and an advance carries no attempt at all; a
    // `loopback-implement` here would be the bug this row exists to catch.
    const action = decideMergeGate({ status: 'skipped', currentAttempts: 1 });
    expect(action).toEqual({ kind: 'advance-integrated' });
    expect(isMergeGateBlocking(action)).toBe(false);
  });

  it("ROW 4: the user's OWN app already holds the CDP endpoint — attach-mode env-skip on the driver port, chromium never probed", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'cdp-app');

    // Attach mode drives the app's own CDP endpoint on the DRIVER port, so that
    // is the port a running instance of the user's app squats.
    const world = makeWorld({ occupiedPorts: new Set([DRIVER_PORT]) });
    seedRun(db, 'run-own-instance');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    // The COMPOSER declares the attach shape (that is the modality-aware
    // task-verify contract) — which is what makes the enqueue seam resolve the
    // `cdp-app` runbook at all — and the proven entry then replaces its guessed
    // command with the one the proof actually validated.
    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-own-instance',
      task: composedTask({
        summary: 'the app window renders the new panel',
        serve: { cmd: 'electron .', attach: 'cdp' },
      }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(row.modality).toBe('cdp-app'); // the runbook merge really did produce an attach task
    expect(outcome.status).toBe('skipped');
    expect(row.failure_class).toBe('env');
    expect(evidenceOf(row)).toContainEqual(
      expect.objectContaining({ source: 'port-probe', check: 'driver-port-free' }),
    );
    expect(world.deploys).toHaveLength(0);
    expect(row.judge_calls_used).toBe(0);

    // Attach mode never launches a browser, so the chromium probe is INAPPLICABLE
    // — recorded as absent, not as a passing check (preflight.ts's applicability
    // rule). A chromium entry here would mean the modality axis was ignored.
    const checkIds = preflightOf(row)?.checks.map((c) => c.id) ?? [];
    expect(checkIds).not.toContain('chromium');
    expect(checkIds).not.toContain('port-free'); // attach mode binds nothing itself
    expect(checkIds).toContain('driver-port-free');
  });
});

// ===========================================================================
// Row 5 — app restart mid-queue
// ===========================================================================

describe('§5.4 matrix — app restart mid-queue', () => {
  it('every in-flight row terminalizes or re-drains through recovery; none is left wedged', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    seedRun(db, 'run-restart');

    /** Seed a row in a state a crash could leave behind (no in-process worker owns it). */
    function seedRequest(id: string, status: 'queued' | 'leased' | 'running'): void {
      db.prepare(
        `INSERT INTO verification_requests
           (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt,
            task_json, snapshot_sha, modality, setup_proof, enqueued_at)
         VALUES (?, 'run-restart', 1, ?, 'static-render-snapshot', ?, '[]', 0, ?, 'sha-matrix', 'web', 0, CURRENT_TIMESTAMP)`,
      ).run(
        id,
        status,
        JSON.stringify({ intent: 'verify the widget', taskRef: 'TASK-1' }),
        // A DEGENERATE pre-live task: it derives no environment, so the §3.2
        // gate exempts it and the queued row can actually drain to a verdict
        // rather than skipping for an unrelated reason.
        JSON.stringify(degenerateTask({ htmlPath: '/out/index.html' })),
      );
    }

    seedRequest('vr_restart_queued', 'queued');
    seedRequest('vr_restart_leased', 'leased');
    seedRequest('vr_restart_running', 'running');

    const world = makeWorld();
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const recovered = await scheduler.runRecovery();
    // The two ORPHANS (leased/running) are force-terminalized; the fresh queued
    // row is not stale, so recovery leaves it queued and NUDGES the drain.
    expect(recovered).toBe(2);

    const outcomes = await Promise.all(
      ['vr_restart_queued', 'vr_restart_leased', 'vr_restart_running'].map((id) =>
        scheduler.awaitTerminal(id, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS),
      ),
    );

    // NOTHING is wedged: every seeded row reached a terminal status.
    const statuses = db
      .prepare('SELECT id, status FROM verification_requests ORDER BY id')
      .all() as Array<{ id: string; status: string }>;
    expect(statuses.every((r) => !['queued', 'leased', 'running'].includes(r.status))).toBe(true);

    // The orphans are honest about WHY they died…
    const leased = readRow(db, 'vr_restart_leased');
    expect(leased.status).toBe('timeout');
    expect(leased.error_message).toBe('orphaned by process restart');
    expect(readRow(db, 'vr_restart_running').status).toBe('timeout');

    // …and the survivor actually RAN post-restart rather than being swept.
    expect(outcomes[0].status).toBe('passed');
    expect(world.deploys).toHaveLength(1);

    // Every terminal drives a parked lane OFF awaiting-verify (R4) — a wedged
    // sprint is exactly what recovery exists to prevent.
    for (const outcome of outcomes) {
      expect(decideMergeGate({ status: outcome.status, currentAttempts: 1 }).kind).toBe(
        'advance-integrated',
      );
    }
  });
});

// ===========================================================================
// Row 6 — injected deliverable regression
// ===========================================================================

describe('§5.4 matrix — injected deliverable regression', () => {
  it("a JUDGED snapshot-mode fail stays FAILED, is attributed 'deliverable', and loops the lane back", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The broken-renderer commit: the environment is fine (preflight all green,
    // real snapshot mode) and the agent DROVE the behavior and judged it failed.
    const world = makeWorld({
      report: passReport({
        behaviors: [
          { id: 'b1', result: 'fail', evidence: { screenshots: ['s.png'], notes: 'the toggle never rendered' } },
        ],
        outcome: 'fail',
        feedback: 'the toggle never rendered',
      }),
    });
    const capability = new VerifyCapabilityStore(dbAdapter(db));
    const healthy = vi.spyOn(capability, 'recordHealthyOutcome');
    seedRun(db, 'run-regression');
    const scheduler = initScheduler(db, { world, runbookStore: store, capabilityStore: capability });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-regression',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(outcome.status).toBe('failed'); // NOT converted to a skip — the deliverable is what broke
    expect(row.failure_class).toBe('deliverable');
    expect(evidenceOf(row)).toContainEqual(
      expect.objectContaining({ source: 'report', check: 'report-outcome' }),
    );

    // The environment demonstrably worked (it built, served, drove and judged),
    // so this RESETS the breaker rather than counting toward it (§3.4).
    expect(healthy).toHaveBeenCalledWith(1, 'web');

    // §5.4: "lane loops back" — and it is BLOCKING, unlike every env skip above.
    const action = decideMergeGate({ status: 'failed', currentAttempts: 1 });
    expect(action).toEqual({ kind: 'loopback-implement', nextAttempt: 2 });
    expect(isMergeGateBlocking(action)).toBe(true);
  });
});

// ===========================================================================
// Row 7 — injected env fault (chromium removed)
// ===========================================================================

describe('§5.4 matrix — injected env fault (chromium removed)', () => {
  it('K consecutive preflight skips trip the breaker ONCE; the K+1th short-circuits on the suppression, and nothing is ever charged', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    const world = makeWorld({ chromium: null }); // the injected fault: no chromium on this host
    const capability = new VerifyCapabilityStore(dbAdapter(db));
    const capabilityFinding = vi.fn();
    seedRun(db, 'run-no-chromium');
    const scheduler = initScheduler(db, {
      world,
      runbookStore: store,
      capabilityStore: capability,
      capabilityFinding,
    });

    const requestIds: string[] = [];
    for (let i = 0; i < CAPABILITY_BREAKER_THRESHOLD; i++) {
      const id = await enqueueThroughSeam(scheduler, { runId: 'run-no-chromium', task: composedTask() });
      requestIds.push(id);
      await scheduler.awaitTerminal(id, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    }

    // Each one is an honest, evidence-backed env skip taken BEFORE any deploy.
    for (const id of requestIds) {
      const row = readRow(db, id);
      expect(row.status).toBe('skipped');
      expect(row.failure_class).toBe('env');
      expect(row.error_message).toContain('chromium not resolved');
      expect(evidenceOf(row)).toContainEqual(
        expect.objectContaining({ source: 'preflight', check: 'chromium' }),
      );
      expect(row.judge_calls_used).toBe(0);
    }
    expect(world.deploys).toHaveLength(0);

    // The breaker tripped exactly once — a modality going quiet is worth ONE
    // notice, not one per request.
    expect(capabilityFinding).toHaveBeenCalledTimes(1);
    expect(capabilityFinding).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 1, modality: 'web' }),
    );

    // The K+1th never reaches preflight at all: the ledger gates it pre-lease.
    const suppressedId = await enqueueThroughSeam(scheduler, {
      runId: 'run-no-chromium',
      task: composedTask(),
    });
    await scheduler.awaitTerminal(suppressedId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    const suppressed = readRow(db, suppressedId);
    expect(suppressed.status).toBe('skipped');
    expect(suppressed.error_message).toContain('verification suppressed for web');
    expect(suppressed.preflight_json).toBeNull(); // it did not even get that far
    expect(suppressed.judge_calls_used).toBe(0);
    expect(capabilityFinding).toHaveBeenCalledTimes(1); // still one
    expect(world.deploys).toHaveLength(0);
  });
});

// ===========================================================================
// Rows 8 + 9 — runbook drift
// ===========================================================================

describe('§5.4 matrix — runbook drift demotes a proven record', () => {
  it("ROW 8: an edited dev script (project input-hash drift) demotes to 'unproven-draft' and the request skips with the setup CTA", async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');
    expect(runbookRecord(db)?.status).toBe('proven');

    // The drift: the project's dev/build scripts (or lockfile, or electron
    // version) moved under a proof that was taken against the old ones.
    io.inputHash = 'inputs-v2';

    const world = makeWorld();
    seedRun(db, 'run-input-drift');
    const scheduler = initScheduler(db, { world, runbookStore: store });
    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-input-drift',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    // The demotion is a WRITE-THROUGH on read: whoever asked next corrected the
    // record, rather than leaving a green badge lying for a human to find.
    expect(runbookRecord(db)?.status).toBe('unproven-draft');

    const row = readRow(db, requestId);
    expect(outcome.status).toBe('skipped');
    expect(row.error_message).toBe(VERIFY_NO_RUNBOOK_REASON); // the setup CTA
    expect(row.failure_class).toBe('env');
    // Unpinned, because the enqueue-side resolver asked the same demoted store.
    expect(row.runbook_hash).toBeNull();
    expect(world.deploys).toHaveLength(0);
  });

  it('ROW 9: host-fingerprint drift demotes; a fresh derive + proof restores it and the build/serve task deploys again', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    const firstProof = await proveModality(store, 'web');

    // The drift: a different chromium, a flipped TCC grant, a node major bump —
    // anything the proof's host fingerprint covered.
    io.fingerprint = 'host-v2';

    const world = makeWorld();
    seedRun(db, 'run-host-drift');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const demotedId = await enqueueThroughSeam(scheduler, {
      runId: 'run-host-drift',
      task: composedTask(),
    });
    await scheduler.awaitTerminal(demotedId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    expect(readRow(db, demotedId).error_message).toBe(VERIFY_NO_RUNBOOK_REASON);
    expect(runbookRecord(db)?.status).toBe('unproven-draft');
    expect(world.deploys).toHaveLength(0);

    // RE-PROOF on the new host: a fresh draft (bumping the CAS version so any
    // in-flight pin against the old revision fails) plus a fresh proof.
    const reProof = await proveModality(store, 'web');
    expect(reProof.version).toBeGreaterThan(firstProof.version);
    expect(runbookRecord(db)?.status).toBe('proven');

    // …and the SAME task now deploys, pinned to the new revision.
    const recoveredId = await enqueueThroughSeam(scheduler, {
      runId: 'run-host-drift',
      task: composedTask(),
    });
    const outcome = await scheduler.awaitTerminal(recoveredId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);
    expect(outcome.status).toBe('passed');
    expect(world.deploys).toHaveLength(1);
    expect(readRow(db, recoveredId).runbook_hash).toBe(reProof.hash);
  });
});

// ===========================================================================
// Row 10 — attestation channel absent
// ===========================================================================

describe('§5.4 matrix — attestation channel absent (§7.1: no attestation ⇒ no passed)', () => {
  it('a DECLARED channel whose driver record never appeared downgrades the pass to a BLOCKING failure', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'web');

    // The agent reports a clean pass; the driver wrote no attest record, so the
    // harness cannot prove the surface it drove was this deliverable.
    const world = makeWorld({ attest: null });
    seedRun(db, 'run-no-attest');
    const scheduler = initScheduler(db, { world, runbookStore: store });

    const requestId = await enqueueThroughSeam(scheduler, { runId: 'run-no-attest', task: composedTask() });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(world.deploys).toHaveLength(1); // it really did run — this is not a skip
    expect(outcome.status).toBe('failed');
    expect(readRow(db, requestId).error_message).toContain(ATTESTATION_MISSING_MESSAGE);

    // §7.1's posture: without foreign-occupancy evidence a missing attestation
    // is AMBIGUOUS, and ambiguous BLOCKS. Calling it 'env' would advance the
    // lane on a verification that proved nothing.
    expect(readRow(db, requestId).failure_class).toBe('ambiguous');
    expect(isMergeGateBlocking(decideMergeGate({ status: 'failed', currentAttempts: 1 }))).toBe(true);
  });

  it('a task that never DECLARED a channel is capped at low_confidence — advisory, never passed', async () => {
    // No proven runbook in this DB, so nothing injects an attestation: the bare
    // pre-live `target.url` shape, which is exactly the case §7.1 softens rather
    // than breaking (it never had an identity check to fail).
    const world = makeWorld();
    seedRun(db, 'run-uncapped');
    const scheduler = initScheduler(db, { world });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-uncapped',
      task: degenerateTask({ url: 'https://example.test/page' }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    expect(outcome.status).toBe('low_confidence');
    expect(readRow(db, requestId).error_message).toContain(ATTESTATION_UNCAPPED_MESSAGE);
    // Advisory: it advances the lane without asserting an identity it cannot prove.
    expect(decideMergeGate({ status: 'low_confidence', currentAttempts: 1 })).toEqual({
      kind: 'advance-integrated',
    });
  });

  it('the DEGENERATE htmlPath target passes on implicit file-identity (the runner owns the path it opened)', async () => {
    const world = makeWorld();
    seedRun(db, 'run-file-identity');
    const scheduler = initScheduler(db, { world });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-file-identity',
      type: 'static-render-snapshot',
      task: degenerateTask({ htmlPath: '/artifacts/prototype/index.html' }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    // No live process, no port, nothing for a stale server or the user's own app
    // to race — so identity holds by construction and `passed` is available.
    expect(outcome.status).toBe('passed');
    expect(readRow(db, requestId).error_message).toBeNull();
  });
});

// ===========================================================================
// Row 11 — native-screen
//
// §5.4's row is "native-screen (IF DRIVE LANDS) — explicit-consent gate honored;
// abort-on-input verified". Drive has NOT landed (§4 fn.²: no executable native
// drive path exists; the modality is declared observe-only). Asserting the
// consent gate here would be asserting a behavior nothing implements. What IS
// assertable — and what the consent gate will eventually sit on top of — is the
// observe-only contract, so that is what these rows pin.
// ===========================================================================

describe('§5.4 matrix — native-screen (observe-only contract)', () => {
  it('a drive-required behavior the agent claimed to PASS is coerced to not_testable and capped at low_confidence', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'native-screen');

    // The agent claims it clicked through a behavior the driver would have
    // refused. A screenshot cannot show a refusal, so the harness must not take
    // the model's word for it.
    const world = makeWorld({
      nativeCapture: async () => true,
      attest: { ok: true, kind: 'window-identity', detail: 'window title matched "Cyboflow"' },
      report: passReport({
        behaviors: [
          { id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'clicked the menu' } },
        ],
      }),
    });
    seedRun(db, 'run-native');
    const scheduler = initScheduler(db, {
      world,
      runbookStore: store,
      nativeCaptureProbe: async () => true,
    });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-native',
      type: 'native-desktop',
      task: composedTask({
        summary: 'the tray menu opens',
        behaviors: [
          { id: 'b1', description: 'the tray menu opens on click', expected: 'menu visible', requiresDrive: true },
        ],
      }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(row.modality).toBe('native-screen');
    expect(world.deploys).toHaveLength(1);

    // The claim was REMOVED (never silently dropped, never upgraded): the report
    // records not_testable, and an all-not_testable pass is the honest ceiling.
    const report = db
      .prepare('SELECT report_json AS r FROM verification_requests WHERE id = ?')
      .get(requestId) as { r: string | null };
    const behaviors = (JSON.parse(report.r ?? '{}') as VerificationReportV1).behaviors;
    expect(behaviors[0].result).toBe('not_testable');
    expect(behaviors[0].evidence.notes).toContain('drive-unsupported');
    expect(outcome.status).toBe('low_confidence');
  });

  it('a host that cannot capture the screen is skipped BEFORE any lease, with the actionable grant detail', async () => {
    const io = makeRunbookIo();
    const store = makeRunbookStore(db, io);
    await proveModality(store, 'native-screen');

    const world = makeWorld();
    seedRun(db, 'run-native-ungranted');
    const scheduler = initScheduler(db, {
      world,
      runbookStore: store,
      // The retired peekaboo both-grants probe, answering honestly.
      nativeCaptureProbe: async () => false,
    });

    const requestId = await enqueueThroughSeam(scheduler, {
      runId: 'run-native-ungranted',
      type: 'native-desktop',
      task: composedTask({ summary: 'the tray menu opens' }),
    });
    const outcome = await scheduler.awaitTerminal(requestId, TERMINAL_DEADLINE_MS, TERMINAL_POLL_MS);

    const row = readRow(db, requestId);
    expect(outcome.status).toBe('skipped');
    expect(row.failure_class).toBe('env');
    expect(row.error_message).toContain("unsupported modality 'native-screen'");
    expect(row.error_message).toContain('cannot capture the screen');
    expect(row.preflight_json).toBeNull(); // pre-lease: no deploy, no snapshot, no screen lease
    expect(world.deploys).toHaveLength(0);
  });

  /**
   * §5.4 marks this row "(if drive lands)" and explicitly exempts it from
   * "runnable unattended". It is blocked on TWO decisions that are open in the
   * proposal, not on test effort:
   *
   *  - §4 fn.² — native DRIVING has no executable path at all today
   *    (`DriverCommand` is CDP-selector-only; the verify agent runs Bash-only
   *    with an empty MCP map). There is nothing to gate.
   *  - §4 "Screen exclusivity is a product policy" — v1's decision is EXPLICIT
   *    PER-RUN GO-AHEAD (idle-queueing deferred, §8). A per-run human go-ahead
   *    is by definition not scriptable unattended, and "abort on any user input
   *    or focus change" is a claim about the real display that a fake probe
   *    cannot make.
   *
   * When drive lands, this becomes: hold the screen lease, assert no input is
   * emitted before the go-ahead resolves, then inject a focus change mid-action
   * and assert the run aborts rather than typing into the user's window.
   */
  it.todo(
    'explicit per-run consent gate is honored and any user input aborts the drive (§4 — blocked: native drive is a designed prerequisite, not yet implemented)',
  );
});
