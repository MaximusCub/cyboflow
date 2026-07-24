/**
 * VerificationAgentRunner unit tests (redesign §5.4/§5.7).
 *
 * The module under test imports NO SDK: the structured query is an injected fake
 * (JudgeClient-style seam), and provisioning / git / fs / driver-teardown are all
 * injected fakes. Coverage: Claude-namespace model resolution, report validation +
 * screenshot-existence enforcement, the §5.7 outcome→status mapping (incl. the
 * snapshot-vs-fallback build-failure split, not_testable, and the mutation-check
 * demotion), and that teardown (snapshot dispose + driver stop) runs on every path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  VerificationAgentRunner,
  VerificationAgentQueryError,
  resolveVerifyModel,
  resolveVerifyProvider,
  resolveVerifyCodexModel,
  mapReportToResult,
  type VerificationAgentRunnerDeps,
  type VerificationAgentRequest,
  type ResolvedVerifyAgent,
  type VerificationAgentQueryOutcome,
} from '../verificationAgentRunner';
import { SnapshotProvisionError, type SnapshotProvision } from '../snapshotProvisioner';
import { setSeamErrorSink } from '../../telemetrySink';
import type { EffectiveAgent } from '../../agents/effectiveAgents';
import type {
  VerificationTaskV1,
  VerificationReportV1,
} from '../../../../../shared/types/visualVerification';

const CLAUDE_DEFAULT = 'claude-opus-4-8';

function makeAgent(overrides: Partial<EffectiveAgent> = {}): EffectiveAgent {
  return {
    agentKey: 'visual-verify',
    name: 'cyboflow-visual-verify',
    role: 'verify',
    description: 'd',
    systemPrompt: 'SYSTEM PROMPT BODY',
    tools: [],
    model: null,
    enabledMcps: [],
    source: 'builtin',
    ...overrides,
  };
}

function makeTask(overrides: Partial<VerificationTaskV1> = {}): VerificationTaskV1 {
  return {
    version: 1,
    summary: 'verify the widget',
    behaviors: [{ id: 'b1', description: 'renders', expected: 'the widget is visible' }],
    ...overrides,
  };
}

function validReport(overrides: Partial<VerificationReportV1> = {}): VerificationReportV1 {
  return {
    version: 1,
    behaviors: [{ id: 'b1', result: 'pass', evidence: { screenshots: ['s.png'], notes: 'ok' } }],
    screenshots: [{ fileName: 's.png', caption: 'the widget' }],
    outcome: 'pass',
    confidence: 0.9,
    feedback: 'looks right',
    issues: [],
    ...overrides,
  };
}

/** Wrap a report in the query outcome shape (structured + transcript), defaulting transcript to null. */
function makeOutcome(
  report: VerificationReportV1,
  transcript: string | null = null,
): VerificationAgentQueryOutcome {
  return { structured: report, transcript };
}

function makeReq(overrides: Partial<VerificationAgentRequest> = {}): VerificationAgentRequest {
  return {
    runId: 'run-1',
    requestId: 'vr-1',
    projectId: 1,
    task: makeTask(),
    runWorktreePath: '/live/worktree',
    snapshotSha: 'abc123',
    artifactsDir: '/artifacts',
    verifyPort: 29260,
    verifyDriverPort: 29261,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Build a runner with fake deps; returns the runner + the spies tests assert on. */
function makeRunner(overrides: Partial<VerificationAgentRunnerDeps> = {}): {
  runner: VerificationAgentRunner;
  dispose: ReturnType<typeof vi.fn>;
  stopDriver: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  codexQuery: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  writeTranscript: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn(async () => {});
  const stopDriver = vi.fn(async () => {});
  const query = vi.fn(async () => makeOutcome(validReport()));
  const codexQuery = vi.fn(async () => makeOutcome(validReport()));
  const warn = vi.fn();
  const writeTranscript = vi.fn(async () => {});
  const provision = vi.fn(
    async (): Promise<SnapshotProvision> => ({ worktreePath: '/snap', sha: 'abc123', dispose }),
  );
  const resolvedAgent: ResolvedVerifyAgent = {
    agent: makeAgent(),
    runProvider: 'claude',
    runModel: 'claude-sonnet-5',
  };
  const deps: VerificationAgentRunnerDeps = {
    query,
    codexQuery,
    resolveVerifyAgent: () => resolvedAgent,
    resolveClaudeAlias: (alias) => `claude-${alias}-resolved`,
    claudeDefaultModel: CLAUDE_DEFAULT,
    resolveNode: async () => '/usr/bin/node',
    driverCliPath: '/app/driverCli.js',
    logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    provision,
    checkSnapshotMutated: async () => false,
    fileExists: async () => true,
    writeDriverScript: async () => '/artifacts/.driver/verify-driver.sh',
    stopDriver,
    reapBrowser: vi.fn(),
    writeTranscript,
    ...overrides,
  };
  return { runner: new VerificationAgentRunner(deps), dispose, stopDriver, query, codexQuery, warn, writeTranscript };
}

beforeEach(() => {
  setSeamErrorSink(() => {});
});

// ---------------------------------------------------------------------------
// resolveVerifyModel — Claude-namespace-only
// ---------------------------------------------------------------------------

describe('resolveVerifyModel', () => {
  const alias = (a: string): string | null => `concrete-${a}`;

  it('resolves a pinned Claude alias through the alias→concrete mechanism', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ model: 'opus' }),
      runProvider: 'claude',
      runModel: 'claude-run',
    };
    expect(resolveVerifyModel(r, alias, CLAUDE_DEFAULT)).toBe('concrete-opus');
  });

  it('inherits the run model on a Claude-provider run when unpinned', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ model: null }),
      runProvider: 'claude',
      runModel: 'claude-run-model',
    };
    expect(resolveVerifyModel(r, alias, CLAUDE_DEFAULT)).toBe('claude-run-model');
  });

  it('falls back to the Claude default on a Codex run (never the gpt run model)', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ model: null }),
      runProvider: 'codex',
      runModel: 'gpt-5.4',
    };
    const model = resolveVerifyModel(r, alias, CLAUDE_DEFAULT);
    expect(model).toBe(CLAUDE_DEFAULT);
    expect(model.startsWith('gpt')).toBe(false);
  });

  it('falls back to the Claude default when the alias does not resolve', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ model: 'opus' }),
      runProvider: 'claude',
      runModel: 'claude-run',
    };
    expect(resolveVerifyModel(r, () => null, CLAUDE_DEFAULT)).toBe(CLAUDE_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// resolveVerifyProvider — runtime pin wins, else inherit the run provider
// ---------------------------------------------------------------------------

describe('resolveVerifyProvider', () => {
  it('maps a codex-sdk runtime pin to codex', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ runtime: 'codex-sdk' }),
      runProvider: 'claude',
      runModel: 'claude-run',
    };
    expect(resolveVerifyProvider(r)).toBe('codex');
  });

  it('maps a claude-sdk runtime pin to claude even on a codex run', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ runtime: 'claude-sdk' }),
      runProvider: 'codex',
      runModel: 'gpt-5.4',
    };
    expect(resolveVerifyProvider(r)).toBe('claude');
  });

  it('inherits the run provider when the agent is unpinned', () => {
    expect(
      resolveVerifyProvider({ agent: makeAgent({ runtime: undefined }), runProvider: 'codex', runModel: 'gpt-5.4' }),
    ).toBe('codex');
    expect(
      resolveVerifyProvider({ agent: makeAgent({ runtime: undefined }), runProvider: 'claude', runModel: 'claude-run' }),
    ).toBe('claude');
  });
});

// ---------------------------------------------------------------------------
// resolveVerifyCodexModel — codexModel pin wins, else the codex run model, else undefined
// ---------------------------------------------------------------------------

describe('resolveVerifyCodexModel', () => {
  it('returns a pinned codexModel', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ codexModel: 'gpt-5.4-pinned' }),
      runProvider: 'claude',
      runModel: 'claude-run',
    };
    expect(resolveVerifyCodexModel(r)).toBe('gpt-5.4-pinned');
  });

  it('inherits the run model on a Codex-provider run when the codexModel is unset', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ codexModel: undefined }),
      runProvider: 'codex',
      runModel: 'gpt-5.4-run',
    };
    expect(resolveVerifyCodexModel(r)).toBe('gpt-5.4-run');
  });

  it('returns undefined when unpinned and the run is not Codex (account default resolves later)', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ codexModel: undefined }),
      runProvider: 'claude',
      runModel: 'claude-run',
    };
    expect(resolveVerifyCodexModel(r)).toBeUndefined();
  });

  it('returns undefined when the run model is a blank string', () => {
    const r: ResolvedVerifyAgent = {
      agent: makeAgent({ codexModel: undefined }),
      runProvider: 'codex',
      runModel: '   ',
    };
    expect(resolveVerifyCodexModel(r)).toBeUndefined();
  });

  it("treats the picker's 'auto' sentinel as unset (any case), falling through to the run model", () => {
    const onCodexRun: ResolvedVerifyAgent = {
      agent: makeAgent({ codexModel: 'auto' }),
      runProvider: 'codex',
      runModel: 'gpt-5.4-run',
    };
    expect(resolveVerifyCodexModel(onCodexRun)).toBe('gpt-5.4-run');
    const onClaudeRun: ResolvedVerifyAgent = {
      agent: makeAgent({ codexModel: 'AUTO' }),
      runProvider: 'claude',
      runModel: 'claude-run',
    };
    expect(resolveVerifyCodexModel(onClaudeRun)).toBeUndefined();
  });

  it("treats 'default' and a cross-family Claude id as unset (spawn-seam parity)", () => {
    expect(
      resolveVerifyCodexModel({
        agent: makeAgent({ codexModel: 'default' }),
        runProvider: 'claude',
        runModel: null,
      }),
    ).toBeUndefined();
    expect(
      resolveVerifyCodexModel({
        agent: makeAgent({ codexModel: 'claude-opus-4-8' }),
        runProvider: 'claude',
        runModel: null,
      }),
    ).toBeUndefined();
  });

  it("an inherited run model of 'auto' on a Codex run resolves to the account default (undefined)", () => {
    expect(
      resolveVerifyCodexModel({
        agent: makeAgent({ codexModel: undefined }),
        runProvider: 'codex',
        runModel: 'auto',
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapReportToResult — §5.7 posture table
// ---------------------------------------------------------------------------

describe('mapReportToResult', () => {
  const M = 'claude-x';

  it('pass → passed with a pass verdict + judged screenshot files', () => {
    const r = mapReportToResult(validReport(), 'snapshot', false, M);
    expect(r.status).toBe('passed');
    expect(r.verdict?.status).toBe('pass');
    expect(r.verdict?.judgedFileNames).toEqual(['s.png']);
    expect(r.fileNames).toEqual(['s.png']);
  });

  it('fail → failed with a fail verdict', () => {
    const report = validReport({
      outcome: 'fail',
      behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: [], notes: 'missing' } }],
    });
    const r = mapReportToResult(report, 'snapshot', false, M);
    expect(r.status).toBe('failed');
    expect(r.verdict?.status).toBe('fail');
  });

  it('build_failed IN A SNAPSHOT → failed (verdict-less, error = build log excerpt)', () => {
    const report = validReport({ outcome: 'build_failed', buildLogExcerpt: 'tsc error TS1005' });
    const r = mapReportToResult(report, 'snapshot', false, M);
    expect(r.status).toBe('failed');
    expect(r.verdict).toBeUndefined();
    expect(r.errorMessage).toBe('tsc error TS1005');
  });

  it('build_failed IN THE DIRTY FALLBACK → skipped (unattributable)', () => {
    const report = validReport({ outcome: 'launch_failed', buildLogExcerpt: 'EADDRINUSE' });
    const r = mapReportToResult(report, 'fallback', false, M);
    expect(r.status).toBe('skipped');
    expect(r.errorMessage).toContain('unattributable');
    expect(r.errorMessage).toContain('EADDRINUSE');
  });

  it('pass with a not_testable behavior (none failed) → low_confidence', () => {
    const report = validReport({
      behaviors: [{ id: 'b1', result: 'not_testable', evidence: { screenshots: [], notes: 'n/a' } }],
    });
    const r = mapReportToResult(report, 'snapshot', false, M);
    expect(r.status).toBe('low_confidence');
    expect(r.verdict?.status).toBe('low_confidence');
  });

  it('post-run mutation trips low_confidence on an otherwise-pass report', () => {
    const r = mapReportToResult(validReport(), 'snapshot', true, M);
    expect(r.status).toBe('low_confidence');
    expect(r.errorMessage).toContain('modified tracked sources');
  });
});

// ---------------------------------------------------------------------------
// run() — end to end with fakes
// ---------------------------------------------------------------------------

describe('VerificationAgentRunner.run', () => {
  it('deploys the agent and maps a pass report to passed; teardown runs', async () => {
    const { runner, dispose, stopDriver, query } = makeRunner();
    const result = await runner.run(makeReq());
    expect(result.status).toBe('passed');
    expect(result.report?.outcome).toBe('pass');
    // The composed prompt + harness contract + resolved model reached the query.
    const args = query.mock.calls[0][0];
    expect(args.systemPrompt).toContain('SYSTEM PROMPT BODY');
    expect(args.systemPrompt).toContain('VERIFICATION HARNESS CONTRACT');
    expect(args.allowedTools).toEqual(['Bash', 'Read', 'Grep', 'Glob']);
    expect(args.env.VERIFY_PORT).toBe('29260');
    expect(args.env.VERIFY_DRIVER_PORT).toBe('29261');
    // model is the Claude-run inherit (never a gpt id).
    expect(args.model).toBe('claude-sonnet-5');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stopDriver).toHaveBeenCalledTimes(1);
  });

  it('routes a codex-sdk runtime pin to the Codex query with the codexModel + the Codex harness contract', async () => {
    const { runner, query, codexQuery } = makeRunner({
      resolveVerifyAgent: () => ({
        agent: makeAgent({ runtime: 'codex-sdk', codexModel: 'gpt-5.4' }),
        runProvider: 'claude',
        runModel: 'claude-run',
      }),
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('passed');
    expect(codexQuery).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    const args = codexQuery.mock.calls[0][0];
    expect(args.model).toBe('gpt-5.4');
    // The Codex harness contract is swapped in (shell + view_image, not the Bash ceiling).
    expect(args.systemPrompt).toContain('view_image');
    expect(args.systemPrompt).not.toContain('Use ONLY Bash');
  });

  it('a codex-routed request with NO codexQuery dep fails open to skipped', async () => {
    const { runner, query } = makeRunner({
      codexQuery: undefined,
      resolveVerifyAgent: () => ({
        agent: makeAgent({ runtime: 'codex-sdk' }),
        runProvider: 'claude',
        runModel: 'claude-run',
      }),
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('skipped');
    expect(result.errorMessage).toBe('codex verify runtime not wired');
    expect(query).not.toHaveBeenCalled();
  });

  it('an unpinned agent inherits a Codex-provider run — codexQuery with the run model', async () => {
    const { runner, query, codexQuery } = makeRunner({
      resolveVerifyAgent: () => ({
        agent: makeAgent({ runtime: undefined, codexModel: undefined }),
        runProvider: 'codex',
        runModel: 'gpt-5.4',
      }),
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('passed');
    expect(codexQuery).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(codexQuery.mock.calls[0][0].model).toBe('gpt-5.4');
  });

  it('an unpinned agent on a Claude-provider run stays on the Claude query (regression guard)', async () => {
    const { runner, query, codexQuery } = makeRunner();
    const result = await runner.run(makeReq());
    expect(result.status).toBe('passed');
    expect(query).toHaveBeenCalledTimes(1);
    expect(codexQuery).not.toHaveBeenCalled();
  });

  it('a claude-sdk pin on a Codex-provider run routes to the Claude query', async () => {
    const { runner, query, codexQuery } = makeRunner({
      resolveVerifyAgent: () => ({
        agent: makeAgent({ runtime: 'claude-sdk' }),
        runProvider: 'codex',
        runModel: 'gpt-5.4',
      }),
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('passed');
    expect(query).toHaveBeenCalledTimes(1);
    expect(codexQuery).not.toHaveBeenCalled();
  });

  it('skips (fail-open) when the visual-verify agent is unresolvable', async () => {
    const { runner } = makeRunner({ resolveVerifyAgent: () => undefined });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('skipped');
    expect(result.errorMessage).toContain('not resolvable');
  });

  it('skips when the report fails validation (unknown behavior id)', async () => {
    const { runner, dispose } = makeRunner({
      query: async () =>
        makeOutcome(
          validReport({
            behaviors: [{ id: 'nope', result: 'pass', evidence: { screenshots: [], notes: '' } }],
          }),
        ),
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('skipped');
    expect(result.errorMessage).toContain('invalid report');
    expect(dispose).toHaveBeenCalledTimes(1); // teardown still runs
  });

  it('skips when a reported screenshot does not exist in the artifacts dir', async () => {
    const { runner } = makeRunner({ fileExists: async () => false });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('skipped');
    expect(result.errorMessage).toContain('not found');
  });

  it('skips when a reported screenshot is not a bare filename', async () => {
    const { runner } = makeRunner({
      query: async () =>
        makeOutcome(validReport({ screenshots: [{ fileName: '../escape.png', caption: 'x' }] })),
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('skipped');
    expect(result.errorMessage).toContain('bare filename');
  });

  it('routes a snapshot build failure to failed; a live-fallback build failure to skipped', async () => {
    const buildFail = async (): Promise<VerificationAgentQueryOutcome> =>
      makeOutcome(
        validReport({ outcome: 'build_failed', buildLogExcerpt: 'boom', screenshots: [], behaviors: [] }),
      );

    const snap = makeRunner({ query: buildFail });
    expect((await snap.runner.run(makeReq())).status).toBe('failed');

    // No sha (capture failed at enqueue) ⇒ fallback ⇒ the same build failure is
    // unattributable in the shared worktree ⇒ skipped.
    const fb = makeRunner({ query: buildFail });
    const r = await fb.runner.run(makeReq({ snapshotSha: null }));
    expect(r.status).toBe('skipped');
  });

  it('a recorded sha ALWAYS snapshots — sibling-lane dirt cannot force the live-worktree fallback', async () => {
    // Regression (adversarial-review fix 2026-07-23): the old whole-tree dirty
    // check routed to the live worktree whenever ANY lane had uncommitted edits.
    // The runner no longer consults worktree state at all: sha present ⇒ provision
    // is called with that sha and the agent runs in the snapshot path.
    const provision = vi.fn(
      async (_opts: unknown): Promise<SnapshotProvision> => ({ worktreePath: '/snap', sha: 'abc123', dispose: vi.fn(async () => {}) }),
    );
    const { runner, query } = makeRunner({ provision });
    const result = await runner.run(makeReq({ snapshotSha: 'abc123' }));
    expect(result.status).toBe('passed');
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision.mock.calls[0][0]).toMatchObject({ snapshotSha: 'abc123' });
    expect(query.mock.calls[0][0].cwd).toBe('/snap');
  });

  it('sha null skips provisioning entirely and runs in the live worktree', async () => {
    const provision = vi.fn(
      async (): Promise<SnapshotProvision> => ({ worktreePath: '/snap', sha: 'abc123', dispose: vi.fn(async () => {}) }),
    );
    const { runner, query } = makeRunner({ provision });
    const result = await runner.run(makeReq({ snapshotSha: null }));
    expect(result.status).toBe('passed');
    expect(provision).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0].cwd).toBe('/live/worktree');
  });

  it('demotes to low_confidence when the post-run mutation check trips (snapshot mode)', async () => {
    const { runner } = makeRunner({ checkSnapshotMutated: async () => true });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('low_confidence');
    expect(result.errorMessage).toContain('modified tracked sources');
  });

  it('does NOT run the mutation check in the live-worktree fallback', async () => {
    const checkSnapshotMutated = vi.fn(async () => true);
    const { runner } = makeRunner({ checkSnapshotMutated });
    const result = await runner.run(makeReq({ snapshotSha: null }));
    // Fallback mode ⇒ a pass stays passed (the check is skipped, so no demotion).
    expect(result.status).toBe('passed');
    expect(checkSnapshotMutated).not.toHaveBeenCalled();
  });

  it('routes a snapshot provisioning failure to skipped (fail-open infra)', async () => {
    const { runner } = makeRunner({
      provision: async () => {
        throw new SnapshotProvisionError('bad', 'bad_sha');
      },
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('skipped');
    expect(result.errorMessage).toContain('bad_sha');
  });

  it('returns timeout and still tears down when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner, dispose, stopDriver } = makeRunner();
    const result = await runner.run(makeReq({ signal: controller.signal }));
    expect(result.status).toBe('timeout');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(stopDriver).toHaveBeenCalledTimes(1);
  });

  it('does not set VERIFY_PORT when the task implies no server (verifyPort null)', async () => {
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ verifyPort: null }));
    const env = query.mock.calls[0][0].env;
    expect(env.VERIFY_PORT).toBeUndefined();
    expect(env.VERIFY_DRIVER_PORT).toBe('29261');
  });

  it('sets VERIFY_DRIVER_ATTACH_ONLY=1 exactly when the task serves in CDP-attach mode', async () => {
    const attach = makeRunner();
    await attach.runner.run(
      makeReq({ task: makeTask({ serve: { cmd: 'electron . --remote-debugging-port="$VERIFY_DRIVER_PORT"', attach: 'cdp' } }) }),
    );
    expect(attach.query.mock.calls[0][0].env.VERIFY_DRIVER_ATTACH_ONLY).toBe('1');

    const plain = makeRunner();
    await plain.runner.run(makeReq({ task: makeTask({ serve: { cmd: 'npm run dev -- --port ${PORT}' } }) }));
    expect(plain.query.mock.calls[0][0].env.VERIFY_DRIVER_ATTACH_ONLY).toBeUndefined();

    const noServe = makeRunner();
    await noServe.runner.run(makeReq());
    expect(noServe.query.mock.calls[0][0].env.VERIFY_DRIVER_ATTACH_ONLY).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // verifier-transcript capture — writeTranscript seam
  // -------------------------------------------------------------------------

  it('writes the transcript once with the deterministic filename when the query outcome carries one', async () => {
    const { runner, writeTranscript } = makeRunner({
      query: async () => makeOutcome(validReport(), '# transcript body'),
    });
    const req = makeReq({ requestId: 'vr-transcript-1', artifactsDir: '/artifacts' });
    const result = await runner.run(req);
    expect(result.status).toBe('passed');
    expect(writeTranscript).toHaveBeenCalledTimes(1);
    expect(writeTranscript).toHaveBeenCalledWith('/artifacts', 'transcript-vr-transcript-1.md', '# transcript body');
  });

  it('does not write a transcript when the query outcome carries none (null)', async () => {
    const { runner, writeTranscript } = makeRunner({
      query: async () => makeOutcome(validReport(), null),
    });
    await runner.run(makeReq());
    expect(writeTranscript).not.toHaveBeenCalled();
  });

  it('writes the partial transcript from a thrown VerificationAgentQueryError, and still maps to the usual skipped/timeout result', async () => {
    const { runner, writeTranscript } = makeRunner({
      query: async () => {
        throw new VerificationAgentQueryError('agent boom', 'partial transcript up to the failure');
      },
    });
    const req = makeReq({ requestId: 'vr-transcript-2', artifactsDir: '/artifacts' });
    const result = await runner.run(req);
    expect(result.status).toBe('skipped');
    expect(result.errorMessage).toContain('agent boom');
    expect(writeTranscript).toHaveBeenCalledTimes(1);
    expect(writeTranscript).toHaveBeenCalledWith(
      '/artifacts',
      'transcript-vr-transcript-2.md',
      'partial transcript up to the failure',
    );
  });

  it('a query error flagged timedOut maps to the terminal timeout status (not skipped), transcript still written', async () => {
    const { runner, writeTranscript } = makeRunner({
      query: async () => {
        throw new VerificationAgentQueryError(
          'verification agent query timed out after 900000ms',
          'partial transcript up to the deadline',
          true,
        );
      },
    });
    const req = makeReq({ requestId: 'vr-timeout-1', artifactsDir: '/artifacts' });
    const result = await runner.run(req);
    expect(result.status).toBe('timeout');
    expect(result.errorMessage).toContain('timed out after 900000ms');
    expect(writeTranscript).toHaveBeenCalledWith(
      '/artifacts',
      'transcript-vr-timeout-1.md',
      'partial transcript up to the deadline',
    );
  });

  it("threads the request's timeoutMs into the query args (and omits it when absent)", async () => {
    const { runner, query } = makeRunner();
    await runner.run(makeReq({ timeoutMs: 900_000 }));
    expect(query.mock.calls[0][0].timeoutMs).toBe(900_000);
    query.mockClear();
    await runner.run(makeReq());
    expect('timeoutMs' in query.mock.calls[0][0]).toBe(false);
  });

  it('a rejecting writeTranscript is fail-soft — the verdict path is unchanged', async () => {
    const writeTranscript = vi.fn(async () => {
      throw new Error('disk full');
    });
    const { runner } = makeRunner({
      query: async () => makeOutcome(validReport(), 'some transcript'),
      writeTranscript,
    });
    const result = await runner.run(makeReq());
    expect(result.status).toBe('passed'); // unaffected by the write failure
    expect(writeTranscript).toHaveBeenCalledTimes(1);
  });
});
