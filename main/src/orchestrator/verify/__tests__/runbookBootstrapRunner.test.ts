/**
 * Unit tests for the bootstrap sequence itself
 * (docs/proposals/lane-runbook-bootstrap.md §12).
 *
 * The sequence is claim → draft → validate → apply rung-1 → commit → register →
 * PROVE → re-enqueue, and the property that matters most is not that the happy
 * path works. It is that **no exit leaves a promoted record this run did not
 * prove**, and that every refusal costs exactly what §10 says it costs and no
 * more. So the tests are organized around exits rather than around steps.
 *
 * The three that would be silent in production if they regressed:
 *
 *  - a PROOF FAILURE must never return `proven` — the runner learns about
 *    promotion, it never performs it (the engine's terminal path owns
 *    `markProven`), and a `proven` outcome here is what makes the caller stop
 *    treating the lane as unverified.
 *  - a NOT-POSSIBLE draft must write the §10 suppression, and a VALIDATION
 *    rejection must NOT. One is a claim about the project, the other is a claim
 *    about this draft, and conflating them either burns budget forever or
 *    silences a project on one bad draft.
 *  - a resumed owner mid-proof must AWAIT the request it already fired rather
 *    than firing a second one, which would dedup to the first and deploy nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeBootstrapProofTask,
  MAX_BOOTSTRAP_ROUNDS,
  runRunbookBootstrap,
  type BootstrapProofOutcome,
  type RunbookBootstrapDeps,
} from '../runbookBootstrapRunner';
import { RunbookBootstrapStampStore } from '../bootstrapStampStore';
import { BootstrapSuppressionStore } from '../bootstrapSuppressionStore';
import type { DatabaseLike } from '../../types';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

const MANIFEST = JSON.stringify({ scripts: { build: 'vite build', preview: 'vite preview' } }, null, 2);

const RUNBOOK: VerifyRunbookV1 = {
  version: 1,
  modalities: {
    web: {
      build: ['pnpm run build'],
      serve: { cmd: 'pnpm run preview --port ${PORT}' },
      attestation: { kind: 'dom-marker', selector: '[data-verify-build]' },
    },
  },
};

const ARGS = {
  projectId: 1,
  runId: 'run-1',
  laneTaskRef: 'TASK-7',
  modality: 'web' as const,
  worktreePath: '/wt',
  adopt: false,
};

const PASS: BootstrapProofOutcome = { status: 'passed', errorMessage: null, failureClass: null, feedback: null };
const FAIL: BootstrapProofOutcome = {
  status: 'failed',
  errorMessage: 'the serve command exited immediately',
  failureClass: 'deliverable',
  feedback: null,
};

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(MIG_DIR, '106_runbook_bootstrap_stamp.sql'), 'utf-8'));
  db.exec(readFileSync(join(MIG_DIR, '107_runbook_bootstrap_suppression.sql'), 'utf-8'));
  return db;
}

interface Harness {
  deps: RunbookBootstrapDeps;
  db: Database.Database;
  stamps: RunbookBootstrapStampStore;
  suppression: BootstrapSuppressionStore;
  written: Array<{ path: string; content: string }>;
  commits: Array<{ paths: readonly string[]; message: string }>;
  proofs: Array<{ round: number; runbookHash: string }>;
  drafts: number;
}

function harness(over: Partial<RunbookBootstrapDeps> & { draftResults?: unknown[]; proofs?: BootstrapProofOutcome[] } = {}): Harness {
  const db = buildDb();
  const stamps = new RunbookBootstrapStampStore(db as unknown as DatabaseLike);
  const suppression = new BootstrapSuppressionStore(db as unknown as DatabaseLike);
  const written: Array<{ path: string; content: string }> = [];
  const commits: Array<{ paths: readonly string[]; message: string }> = [];
  const proofs: Array<{ round: number; runbookHash: string }> = [];
  const state = { drafts: 0, awaits: 0 };
  const draftResults = over.draftResults ?? [{ decision: 'runbook', modality: 'web', runbook: RUNBOOK }];
  const proofOutcomes = over.proofs ?? [PASS];

  const base: RunbookBootstrapDeps = {
    stamps,
    suppression,
    draft: async () => {
      const result = draftResults[Math.min(state.drafts, draftResults.length - 1)];
      state.drafts += 1;
      return result;
    },
    readFile: async (_wt, relativePath) => {
      if (relativePath === 'package.json') return MANIFEST;
      const found = written.find((w) => w.path === relativePath);
      return found?.content ?? null;
    },
    writeFile: async (_wt, relativePath, content) => {
      written.push({ path: relativePath, content });
    },
    commitPaths: async (_wt, paths, message) => {
      commits.push({ paths, message });
      return `sha-${commits.length}`;
    },
    registerDraft: async () => ({ hash: 'hash-1', version: 3 }),
    setOrigin: vi.fn(),
    enqueueProof: async ({ round, runbookHash }) => {
      proofs.push({ round, runbookHash });
      return { requestId: `req-${round}` };
    },
    // Counted independently of `proofs`: the RESUME path awaits a request it
    // never enqueued in this call, so keying the outcome off the enqueue count
    // would read past the end of the array.
    awaitProof: async () => {
      const outcome = proofOutcomes[Math.min(state.awaits, proofOutcomes.length - 1)];
      state.awaits += 1;
      return outcome;
    },
    computeInputHash: async () => 'input-a',
    hostFingerprint: async () => 'host-a',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  const { draftResults: _d, proofs: _p, ...depsOver } = over;
  const deps: RunbookBootstrapDeps = { ...base, ...depsOver };
  return {
    deps,
    db,
    stamps,
    suppression,
    written,
    commits,
    proofs,
    get drafts() {
      return state.drafts;
    },
  };
}

describe('runRunbookBootstrap — the happy path', () => {
  it('drafts, commits, registers, proves, and reports the pin', async () => {
    const h = harness();
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toEqual({
      kind: 'proven',
      runbookHash: 'hash-1',
      runbookVersion: 3,
      commitSha: 'sha-1',
      rung1: null,
    });
    h.db.close();
  });

  it('writes the runbook and commits it BY PATHSPEC — one path, not a bare commit', async () => {
    const h = harness();
    await runRunbookBootstrap(ARGS, h.deps);
    // Compared by VALUE, not against the literal above: the controller writes
    // the output of `parseVerifyRunbookV1`, i.e. the runbook as the strict parser
    // reconstructs it — which is the point, since that is exactly what the store
    // will parse back when it registers and pins the revision.
    expect(h.written).toHaveLength(1);
    expect(h.written[0].path).toBe('.cyboflow/verify-runbook.json');
    expect(JSON.parse(h.written[0].content)).toEqual(RUNBOOK);
    expect(h.written[0].content.endsWith('\n')).toBe(true);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0].paths).toEqual(['.cyboflow/verify-runbook.json']);
    h.db.close();
  });

  it('stamps the record as lane-derived, so a human can tell it from a reviewed one', async () => {
    // Migration 105 provenance. Both origins are proven by the same
    // engine-enforced run; they did not earn the same amount of trust, and
    // collapsing them erases the only durable record of which happened.
    const h = harness();
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.deps.setOrigin).toHaveBeenCalledWith(1, 'web', 'lane-bootstrap');
    h.db.close();
  });

  it('leaves the stamp PROVEN with the pin, so a sibling lane takes the ordinary path', async () => {
    const h = harness();
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.stamps.read('run-1', 1, 'web')).toMatchObject({
      state: 'proven',
      runbookHash: 'hash-1',
      runbookVersion: 3,
      commitSha: 'sha-1',
    });
    h.db.close();
  });

  it('clears a stale suppression the success has just falsified', async () => {
    const h = harness();
    h.suppression.suppress({
      projectId: 1,
      modality: 'web',
      inputHash: 'input-a',
      hostFingerprint: 'host-a',
      reason: 'old',
    });
    // Suppression is checked BEFORE the claim, so seed it as non-matching and
    // let the success clear whatever is there.
    h.suppression.suppress({
      projectId: 1,
      modality: 'web',
      inputHash: 'other',
      hostFingerprint: 'other',
      reason: 'old',
    });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.suppression.read(1, 'web')).toBeNull();
    h.db.close();
  });
});

describe('runRunbookBootstrap — the refusals', () => {
  it('declines a modality a portable runbook cannot even express', async () => {
    // 'mobile' is deferred by §4 and has no representation; deriving anyway would
    // register a record no execution path could satisfy.
    const h = harness();
    const outcome = await runRunbookBootstrap({ ...ARGS, modality: 'mobile' }, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'undeclarable-modality' });
    expect(h.drafts).toBe(0);
    h.db.close();
  });

  it('declines a suppressed project WITHOUT taking the claim or spending a draft', async () => {
    const h = harness();
    h.suppression.suppress({
      projectId: 1,
      modality: 'web',
      inputHash: 'input-a',
      hostFingerprint: 'host-a',
      reason: 'no script serves the renderer',
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'suppressed' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('no script serves the renderer');
    expect(h.drafts).toBe(0);
    expect(h.stamps.read('run-1', 1, 'web')).toBeNull();
    h.db.close();
  });

  it('declines when a DIFFERENT lane holds the single-flight', async () => {
    // Five lanes reach visual-verify at unpredictable moments; exactly one may
    // derive, because registerDraft UPSERTs a singleton row.
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-2' });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'in-flight' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('TASK-2');
    expect(h.drafts).toBe(0);
    h.db.close();
  });

  it('reports PROVEN (not a decline) to a lane arriving after the bootstrap finished', async () => {
    // The sibling-lane case: the stamp already settled proven, so this lane must
    // take the ordinary path rather than re-deriving anything.
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-2' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-2',
      state: 'proven',
      runbookHash: 'hash-x',
      runbookVersion: 9,
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'proven', runbookHash: 'hash-x', runbookVersion: 9 });
    expect(h.drafts).toBe(0);
    h.db.close();
  });

  it('declines when this run already failed — the run has decided', async () => {
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-2' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-2',
      state: 'failed',
      detail: 'the project cannot be served',
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'already-settled' });
    expect(h.drafts).toBe(0);
    h.db.close();
  });
});

describe('runRunbookBootstrap — NOT-POSSIBLE vs a rejected draft', () => {
  it('NOT-POSSIBLE writes the §10 suppression, so the next sprint does not pay again', async () => {
    const h = harness({
      draftResults: [{ decision: 'not-possible', reason: 'no script serves the renderer' }],
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'not-possible' });
    expect(h.suppression.read(1, 'web')).toMatchObject({
      inputHash: 'input-a',
      hostFingerprint: 'host-a',
      reason: 'no script serves the renderer',
    });
    expect(h.written).toEqual([]);
    expect(h.commits).toEqual([]);
    h.db.close();
  });

  it('an UNDECLARED command does NOT suppress — that is about the draft, not the project', async () => {
    // Suppressing here would let one bad draft silence a project whose next
    // draft would have been fine. The run-scoped stamp already stops the retry
    // loop within this run.
    const h = harness({
      draftResults: [
        {
          decision: 'runbook',
          modality: 'web',
          runbook: {
            ...RUNBOOK,
            modalities: { web: { ...RUNBOOK.modalities.web, serve: { cmd: 'vite --port 5173' } } },
          },
        },
      ],
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('vite --port 5173');
    expect(h.suppression.read(1, 'web')).toBeNull();
    expect(h.written).toEqual([]);
    h.db.close();
  });

  it('a malformed draft is refused without writing anything', async () => {
    const h = harness({ draftResults: [{ decision: 'runbook', modality: 'web', runbook: { version: 2 } }] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    expect(h.written).toEqual([]);
    expect(h.commits).toEqual([]);
    h.db.close();
  });

  it('a null draft (the agent timed out) is refused, not treated as empty', async () => {
    const h = harness({ draftResults: [null] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    h.db.close();
  });
});

describe('runRunbookBootstrap — the rung-1 operation', () => {
  const withOperation = {
    decision: 'runbook',
    modality: 'web',
    runbook: {
      ...RUNBOOK,
      modalities: {
        web: { ...RUNBOOK.modalities.web, serve: { cmd: 'pnpm run verify:serve --port ${PORT}' } },
      },
    },
    operation: { kind: 'add-script', scriptName: 'verify:serve', command: 'vite preview' },
  };

  it('applies the edit and commits it SEPARATELY from the runbook', async () => {
    // §8.1's review surface: one self-contained, revertible commit in the branch
    // diff, not a config change buried alongside a JSON blob.
    const h = harness({ draftResults: [withOperation] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('proven');
    expect(h.commits).toHaveLength(2);
    expect(h.commits[0].paths).toEqual(['package.json']);
    expect(h.commits[1].paths).toEqual(['.cyboflow/verify-runbook.json']);
    h.db.close();
  });

  it('validates the commands against the POST-EDIT manifest', async () => {
    // An agent that proposes both "add a verify:serve script" and "serve with
    // pnpm run verify:serve" is self-consistent. Validating against the pre-edit
    // manifest would reject the one shape this feature exists to enable.
    const h = harness({ draftResults: [withOperation] });
    await expect(runRunbookBootstrap(ARGS, h.deps)).resolves.toMatchObject({ kind: 'proven' });
    const manifest = h.written.find((w) => w.path === 'package.json');
    expect(manifest).toBeDefined();
    expect(JSON.parse(manifest?.content ?? '{}').scripts['verify:serve']).toBe('vite preview');
    h.db.close();
  });

  it('records the edited PATH and its own sha on the stamp', async () => {
    // Both are consumed downstream: the path by the eval-diff excision and the
    // address-review denylist, the sha by the commit-integrity probe.
    const h = harness({ draftResults: [withOperation] });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.stamps.read('run-1', 1, 'web')).toMatchObject({
      rung1Path: 'package.json',
      rung1CommitSha: 'sha-1',
    });
    expect(h.stamps.commitShasForRun('run-1').sort()).toEqual(['sha-1', 'sha-2']);
    h.db.close();
  });

  it('surfaces the edit on the outcome, so the caller can file a finding naming it', async () => {
    const h = harness({ draftResults: [withOperation] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    if (outcome.kind !== 'proven') throw new Error('unreachable');
    expect(outcome.rung1?.path).toBe('package.json');
    expect(outcome.rung1?.description).toContain('verify:serve');
    h.db.close();
  });

  it('refuses a denylisted target and writes NOTHING — not even the runbook', async () => {
    // The refusal has to happen before any write, because the runbook's commands
    // depend on the edit: committing one without the other leaves a runbook that
    // cannot work.
    const h = harness({
      draftResults: [
        {
          ...withOperation,
          operation: { kind: 'relax-strict-port', file: '.github/workflows/ci.yml', setting: 'strictPort' },
        },
      ],
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    expect(h.written).toEqual([]);
    expect(h.commits).toEqual([]);
    h.db.close();
  });

  it('refuses when the named target does not exist in this worktree', async () => {
    const h = harness({
      draftResults: [
        { ...withOperation, operation: { kind: 'relax-strict-port', file: 'vite.config.ts', setting: 'strictPort' } },
      ],
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'rejected' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('vite.config.ts');
    h.db.close();
  });
});

describe('runRunbookBootstrap — the proof', () => {
  it('fires an ATTESTATION-ONLY task carrying the runbook\'s own commands', async () => {
    // §7: the proof asks exactly one question — does this project stand up and
    // identify itself? The lane's own task is NOT the proof vehicle, so no
    // failure is ever attributed to the wrong thing.
    const task = composeBootstrapProofTask(RUNBOOK, 'web');
    expect(task).toMatchObject({
      version: 1,
      behaviors: [],
      modality: 'web',
      attestation: { kind: 'dom-marker', selector: '[data-verify-build]' },
      build: ['pnpm run build'],
      serve: { cmd: 'pnpm run preview --port ${PORT}' },
    });
  });

  it('pins the proof to the revision it just registered', async () => {
    const h = harness();
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.proofs).toEqual([{ round: 1, runbookHash: 'hash-1' }]);
    h.db.close();
  });

  it('a FAILED proof never returns proven — it returns an honest unproven draft', async () => {
    // The load-bearing exit. This runner learns about promotion; it never
    // performs it. A `proven` here is what makes the caller stop treating the
    // lane as unverified, so a failing proof reaching it would be the one bug
    // this whole design exists to make impossible.
    const h = harness({ proofs: [FAIL, FAIL] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('unproven');
    if (outcome.kind !== 'unproven') throw new Error('unreachable');
    expect(outcome.detail).toContain('the serve command exited immediately');
    expect(outcome.commitSha).not.toBeNull();
    h.db.close();
  });

  it('re-drafts ONCE on a failure, and hands the second round the failure verbatim', async () => {
    // A re-draft with no feedback is the same guess again, which is the only
    // thing that would make a second round worth its cost.
    const feedbacks: Array<string | null> = [];
    const h = harness({
      proofs: [FAIL, PASS],
      draft: async (request) => {
        feedbacks.push(request.feedback);
        return { decision: 'runbook', modality: 'web', runbook: RUNBOOK };
      },
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('proven');
    expect(feedbacks).toHaveLength(2);
    expect(feedbacks[0]).toBeNull();
    expect(feedbacks[1]).toContain('the serve command exited immediately');
    h.db.close();
  });

  it('stops at the round cap rather than guessing a third time', async () => {
    const h = harness({ proofs: [FAIL, FAIL, FAIL] });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('unproven');
    expect(h.proofs).toHaveLength(MAX_BOOTSTRAP_ROUNDS);
    expect(h.stamps.read('run-1', 1, 'web')?.state).toBe('failed');
    h.db.close();
  });

  it('gives each round its own enqueue round number, which is what makes the key unique', async () => {
    // Without a fresh key, findLiveRequestByEnqueueKey returns round 1's
    // terminal row and round 2 deploys NOTHING while every caller reads it as
    // enqueued — v1's defect 3, silent and total.
    const h = harness({ proofs: [FAIL, FAIL] });
    await runRunbookBootstrap(ARGS, h.deps);
    expect(h.proofs.map((p) => p.round)).toEqual([1, 2]);
    h.db.close();
  });

  it('a proof that could not be ENQUEUED is infrastructure, not a project verdict', async () => {
    const h = harness({ enqueueProof: async () => ({ error: 'scheduler-unavailable' }) });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'infrastructure' });
    expect(h.suppression.read(1, 'web')).toBeNull();
    h.db.close();
  });
});

describe('runRunbookBootstrap — restart and resume', () => {
  it('a restarted owner mid-proof AWAITS its own request rather than firing a second', async () => {
    // The controller restarts lanes at inner step zero. Re-firing would enqueue
    // under the same round key, dedup to the first, and deploy nothing.
    const h = harness();
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-7' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-7',
      state: 'proving',
      round: 1,
      requestId: 'req-earlier',
      commitSha: 'sha-earlier',
      runbookHash: 'hash-earlier',
      runbookVersion: 2,
    });

    const awaited: string[] = [];
    const deps: RunbookBootstrapDeps = {
      ...h.deps,
      awaitProof: async (requestId) => {
        awaited.push(requestId);
        return PASS;
      },
    };
    const outcome = await runRunbookBootstrap(ARGS, deps);
    expect(awaited).toEqual(['req-earlier']);
    expect(h.proofs).toEqual([]);
    expect(h.drafts).toBe(0);
    expect(outcome).toMatchObject({ kind: 'proven', runbookHash: 'hash-earlier', runbookVersion: 2 });
    h.db.close();
  });

  it('a restarted owner whose in-flight proof FAILED continues at the next round', async () => {
    const h = harness({ proofs: [FAIL, PASS] });
    h.stamps.claim({ runId: 'run-1', projectId: 1, modality: 'web', ownerTaskRef: 'TASK-7' });
    h.stamps.advance({
      runId: 'run-1',
      projectId: 1,
      modality: 'web',
      ownerTaskRef: 'TASK-7',
      state: 'proving',
      round: 1,
      requestId: 'req-earlier',
      runbookHash: 'h',
      runbookVersion: 1,
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome.kind).toBe('proven');
    // Round 2 only — round 1 was the one already in flight.
    expect(h.proofs.map((p) => p.round)).toEqual([2]);
    h.db.close();
  });
});

describe('runRunbookBootstrap — never throws', () => {
  it('turns a throwing collaborator into a decline', async () => {
    // The one caller is enqueueTaskVerification, whose contract is that it
    // cannot crash a lane.
    const h = harness({
      commitPaths: async () => {
        throw new Error('git exploded');
      },
    });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined' });
    h.db.close();
  });

  it('degrades when the stamp store itself cannot answer', async () => {
    const db = new Database(':memory:'); // no migrations at all
    const h = harness();
    const deps: RunbookBootstrapDeps = {
      ...h.deps,
      stamps: new RunbookBootstrapStampStore(db as unknown as DatabaseLike),
      suppression: new BootstrapSuppressionStore(db as unknown as DatabaseLike),
    };
    const outcome = await runRunbookBootstrap(ARGS, deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'unavailable' });
    db.close();
    h.db.close();
  });

  it('a registration failure is infrastructure and writes no suppression', async () => {
    const h = harness({ registerDraft: async () => ({ error: 'cas-conflict' }) });
    const outcome = await runRunbookBootstrap(ARGS, h.deps);
    expect(outcome).toMatchObject({ kind: 'declined', reason: 'infrastructure' });
    if (outcome.kind !== 'declined') throw new Error('unreachable');
    expect(outcome.detail).toContain('cas-conflict');
    expect(h.suppression.read(1, 'web')).toBeNull();
    h.db.close();
  });
});
