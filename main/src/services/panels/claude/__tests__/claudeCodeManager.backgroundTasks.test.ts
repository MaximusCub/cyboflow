/**
 * Background-subagent task tracking + the flow-turn hold-open boundary.
 *
 * SDK ≥0.3.201 runs Agent-tool subagents in the BACKGROUND by default: the
 * parent turn can produce a `result` while its subagents are still running, and
 * the CLI auto-continues the same conversation when they finish. Treating that
 * intermediate result as the turn boundary resolved spawnCliProcess, so
 * RunExecutor fired 'drained' (awaiting_review rest + run-level step-'done')
 * mid-flow — the false "Workflow complete". This suite pins:
 *
 *   (1) trackBackgroundTasks — the task_started / task_updated /
 *       task_notification lifecycle over the live set;
 *   (2) shouldHoldFlowTurnOpen — the boundary predicate's scope guards
 *       (flow-only, warm-only, never on terminal error / abort / kill switch);
 *   (3) the real streaming loop holds ONE logical turn across intermediate
 *       results while tasks are live: a flow spawn over a scripted
 *       auto-continuing stream emits exactly ONE 'exit', and spawnCliProcess
 *       resolves only after the final (task-free) result;
 *   (4) the kill switch (single-shot path) does NOT hold — the first result
 *       still ends the turn exactly as before.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { ApprovalRouter } from '../../../../orchestrator/approvalRouter';
import { QuestionRouter } from '../../../../orchestrator/questionRouter';
import { dbAdapter } from '../../../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../../../orchestrator/__test_fixtures__/orchestratorTestDb';
import {
  createModuleFakeSdk,
  scenario,
  sdkSystemInit,
  sdkSystemTaskStarted,
  sdkSystemTaskUpdated,
  sdkSystemTaskNotification,
  type FakeQueryParams,
} from '../../../../test/fakes/fakeSdk';
import {
  ClaudeCodeManager,
  createBackgroundTaskState,
  trackBackgroundTasks,
  shouldHoldFlowTurnOpen,
  type BackgroundTaskState,
} from '../claudeCodeManager';
import { ModelAvailabilityService } from '../../../modelAvailabilityService';
import type { SessionManager } from '../../../sessionManager';

const SESSION_UUID = 'sess-bg-uuid';

const fakeSdk = createModuleFakeSdk();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: FakeQueryParams) => fakeSdk.query(params),
}));

vi.mock('../../../orchestrator/mcpServer/scriptPath', () => ({
  resolveMcpServerScriptPath: vi.fn(() => '/mock/mcp-server.js'),
}));
vi.mock('../../../utils/nodeFinder', () => ({
  findNodeExecutable: vi.fn(async () => 'node'),
}));
vi.mock('../../../utils/sessionValidation', () => ({
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

/** getDbSession → undefined = the FLOW-step identity path (runId === panelId). */
function createMockSessionManager(): SessionManager {
  return {
    getDbSession: vi.fn(() => undefined),
    getPanelClaudeSessionId: vi.fn(() => SESSION_UUID),
    getProjectById: vi.fn(() => undefined),
    updateSession: vi.fn(),
  } as unknown as SessionManager;
}

function getSdkRuns(mgr: ClaudeCodeManager): Map<string, { turnInFlight: boolean; warm: unknown }> {
  return (mgr as unknown as { sdkRuns: Map<string, { turnInFlight: boolean; warm: unknown }> }).sdkRuns;
}

const flush = () => new Promise<void>((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// (1) trackBackgroundTasks — lifecycle over the live set.
// ---------------------------------------------------------------------------

describe('trackBackgroundTasks', () => {
  /** State seeded with the given live task ids and no owed continuation. */
  function stateWith(...ids: string[]): BackgroundTaskState {
    const state = createBackgroundTaskState();
    for (const id of ids) state.live.add(id);
    return state;
  }

  it('registers on task_started and retires on task_notification', () => {
    const state = createBackgroundTaskState();
    trackBackgroundTasks(sdkSystemTaskStarted('t1'), state);
    trackBackgroundTasks(sdkSystemTaskStarted('t2'), state);
    expect([...state.live].sort()).toEqual(['t1', 't2']);
    trackBackgroundTasks(sdkSystemTaskNotification('t1'), state);
    expect([...state.live]).toEqual(['t2']);
  });

  it('retires on a settled task_updated patch but keeps live statuses', () => {
    const state = stateWith('t1', 't2', 't3');
    trackBackgroundTasks(sdkSystemTaskUpdated('t1', { status: 'completed' }), state);
    trackBackgroundTasks(sdkSystemTaskUpdated('t2', { status: 'running' }), state);
    // A patch with no status (e.g. a description update) never settles.
    trackBackgroundTasks(sdkSystemTaskUpdated('t3', { description: 'still going' }), state);
    expect([...state.live].sort()).toEqual(['t2', 't3']);
    // Unknown status vocabulary defaults to SETTLED (fail toward closing turns).
    trackBackgroundTasks(sdkSystemTaskUpdated('t2', { status: 'exploded' }), state);
    expect([...state.live]).toEqual(['t3']);
  });

  it('ignores non-system events, missing task ids, and non-object events', () => {
    const state = stateWith('t1');
    trackBackgroundTasks({ type: 'assistant', task_id: 't1', subtype: 'task_notification' }, state);
    trackBackgroundTasks({ type: 'system', subtype: 'task_notification' }, state);
    trackBackgroundTasks(null, state);
    trackBackgroundTasks('result', state);
    expect([...state.live]).toEqual(['t1']);
    expect(state.continuationPending).toBe(false);
  });

  it('is idempotent for repeated notifications of an already-settled task', () => {
    const state = createBackgroundTaskState();
    trackBackgroundTasks(sdkSystemTaskNotification('never-seen'), state);
    expect(state.live.size).toBe(0);
  });

  // The continuation window (2026-08-11): the notification is the CLI's trigger
  // to open one more turn, and its system/init is the proof that it did.
  it('arms continuationPending on a task_notification and disarms it on the next init', () => {
    const state = createBackgroundTaskState();
    trackBackgroundTasks(sdkSystemTaskStarted('t1'), state);
    expect(state.continuationPending).toBe(false);
    trackBackgroundTasks(sdkSystemTaskNotification('t1'), state);
    expect(state.continuationPending).toBe(true);
    trackBackgroundTasks(sdkSystemInit({ sessionId: SESSION_UUID }), state);
    expect(state.continuationPending).toBe(false);
  });

  it('does NOT arm continuationPending on a settled task_updated (only the notification continues)', () => {
    const state = stateWith('t1');
    trackBackgroundTasks(sdkSystemTaskUpdated('t1', { status: 'completed' }), state);
    expect(state.live.size).toBe(0);
    expect(state.continuationPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (2) shouldHoldFlowTurnOpen — scope guards.
// ---------------------------------------------------------------------------

describe('shouldHoldFlowTurnOpen', () => {
  const holdable = {
    spawnKey: 'run-1',
    runId: 'run-1',
    liveBackgroundTaskCount: 1,
    continuationPending: false,
    hasWarmInput: true,
    warmDisabled: false,
    terminalError: null,
    aborted: false,
  };

  it('holds a warm flow turn with live tasks', () => {
    expect(shouldHoldFlowTurnOpen(holdable)).toBe(true);
  });

  // The 2026-08-11 gate loss: no task is live at the result, but the CLI still
  // owes the continuation the notification opened.
  it('holds a warm flow turn with no live task when a continuation is owed', () => {
    expect(
      shouldHoldFlowTurnOpen({ ...holdable, liveBackgroundTaskCount: 0, continuationPending: true }),
    ).toBe(true);
  });

  it.each([
    ['no live tasks and no owed continuation', { liveBackgroundTaskCount: 0 }],
    ['quick chat turn (spawnKey ≠ runId)', { runId: '__quick__sentinel' }],
    ['fan-out lane (composite spawnKey)', { spawnKey: 'run-1:item-2' }],
    ['single-shot process (no warm input)', { hasWarmInput: false }],
    ['warm kill switch', { warmDisabled: true }],
    ['terminal error', { terminalError: 'usage limit' }],
    ['aborted', { aborted: true }],
  ] as const)('never holds: %s', (_label, override) => {
    expect(shouldHoldFlowTurnOpen({ ...holdable, ...override })).toBe(false);
  });

  // An owed continuation does not buy past the scope guards either.
  it.each([
    ['quick chat turn', { runId: '__quick__sentinel' }],
    ['fan-out lane', { spawnKey: 'run-1:item-2' }],
    ['single-shot process', { hasWarmInput: false }],
    ['warm kill switch', { warmDisabled: true }],
    ['terminal error', { terminalError: 'usage limit' }],
    ['aborted', { aborted: true }],
  ] as const)('an owed continuation never overrides the scope guard: %s', (_label, override) => {
    expect(
      shouldHoldFlowTurnOpen({
        ...holdable,
        liveBackgroundTaskCount: 0,
        continuationPending: true,
        ...override,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (3)+(4) The real streaming loop over the fake SDK.
// ---------------------------------------------------------------------------

describe('ClaudeCodeManager — flow turn held open while background tasks run', () => {
  let db: Database.Database;
  let mgr: ClaudeCodeManager;

  beforeEach(() => {
    fakeSdk.reset();
    delete process.env.CYBOFLOW_DISABLE_WARM_SDK;
    ModelAvailabilityService._resetForTesting();
    ModelAvailabilityService.initialize();
    db = createTestDb();
    const adapter = dbAdapter(db);
    ApprovalRouter.initialize(adapter);
    QuestionRouter.initialize(adapter);
    mgr = new ClaudeCodeManager(createMockSessionManager(), undefined, undefined, db);
  });

  afterEach(async () => {
    for (const key of Array.from(getSdkRuns(mgr).keys())) {
      await mgr.killProcess(key).catch(() => {});
    }
    ApprovalRouter._resetForTesting();
    QuestionRouter._resetForTesting();
    ModelAvailabilityService._resetForTesting();
    db.close();
    vi.clearAllMocks();
  });

  /**
   * The observed production stream shape: two subagents spawn, the parent's turn
   * produces intermediate results while they run, and the CLI auto-continues
   * past each — opening every continuation with its own `system/init`.
   *
   * The third result is the 2026-08-11 shape: `task-b`'s notification landed
   * BEFORE it (the subagent settled while the parent was still writing), so no
   * task is live, yet the CLI still owes the continuation it just opened. Only
   * the fourth result — inside that continuation, with nothing owed — is the
   * real boundary.
   */
  function autoContinuingScenario() {
    return scenario()
      .systemInit({ sessionId: SESSION_UUID })
      .taskStarted('task-a')
      .taskStarted('task-b')
      .assistantText('spawned both context agents')
      .resultSuccess({ result: 'waiting for agents' })
      .autoContinue()
      .systemInit({ sessionId: SESSION_UUID })
      .taskNotification('task-a')
      .assistantText('one done, one to go')
      .resultSuccess({ result: 'still waiting' })
      .autoContinue()
      .systemInit({ sessionId: SESSION_UUID })
      .taskNotification('task-b')
      .assistantText('both done — wrapping up')
      .resultSuccess({ result: 'wrap-up' })
      .autoContinue()
      .systemInit({ sessionId: SESSION_UUID })
      .assistantText('continuing the flow')
      .resultSuccess({ result: 'walk finished' })
      // Trailing step: the generator PARKS at the final result awaiting a push
      // (the multi-turn warm shape), so the process stays warm-idle for the
      // park assertions instead of draining to process death.
      .assistantText('next turn — never reached');
  }

  /**
   * A notification whose continuation NEVER arrives — the pathological case the
   * grace bound exists for. The stream simply stops after the held result.
   */
  function silentAfterNotificationScenario() {
    return scenario()
      .systemInit({ sessionId: SESSION_UUID })
      .taskStarted('task-a')
      .assistantText('spawned the context agent')
      .resultSuccess({ result: 'waiting for the agent' })
      .autoContinue()
      .systemInit({ sessionId: SESSION_UUID })
      .taskNotification('task-a')
      .assistantText('agent done')
      .resultSuccess({ result: 'held awaiting a continuation that never comes' })
      .assistantText('next turn — never reached');
  }

  it('a flow spawn spans intermediate results: ONE exit, resolution after the final result', async () => {
    const panelId = 'p-bg-flow';
    fakeSdk.setScenario(autoContinuingScenario());

    // Ordered log of boundary-relevant emissions: result outputs + exits.
    const log: string[] = [];
    mgr.on('output', (evt: { data?: { type?: string; result?: string } }) => {
      if (evt.data?.type === 'result') log.push(`result:${evt.data.result}`);
    });
    mgr.on('exit', () => log.push('exit'));

    // Flow identity: panelId === sessionId (mock getDbSession → undefined ⇒ runId === panelId).
    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'plan the ideas',
      permissionMode: 'ignore',
    });
    await flush();

    // ONE logical turn: the three intermediate results ended nothing — including
    // 'wrap-up', which has NO live task and would have ended the turn (killing
    // the gate the continuation went on to open) before the continuation hold.
    expect(log).toEqual([
      'result:waiting for agents',
      'result:still waiting',
      'result:wrap-up',
      'result:walk finished',
      'exit',
    ]);
    // The process parks warm-idle after the real boundary, ready for the next turn.
    expect(getSdkRuns(mgr).get(panelId)?.turnInFlight).toBe(false);
    expect(getSdkRuns(mgr).get(panelId)?.warm).not.toBeNull();
  });

  it('releases a continuation-only hold when the CLI goes silent, settling the turn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const panelId = 'p-bg-silent';
      fakeSdk.setScenario(silentAfterNotificationScenario());

      const log: string[] = [];
      mgr.on('output', (evt: { data?: { type?: string; result?: string } }) => {
        if (evt.data?.type === 'result') log.push(`result:${evt.data.result}`);
      });
      mgr.on('exit', () => log.push('exit'));

      const spawned = mgr.spawnCliProcess({
        panelId,
        sessionId: panelId,
        worktreePath: '/tmp/wt',
        prompt: 'plan the ideas',
        permissionMode: 'ignore',
      });
      await flush();

      // Held: the notification owes a continuation, so the turn has NOT ended.
      expect(log).toEqual([
        'result:waiting for the agent',
        'result:held awaiting a continuation that never comes',
      ]);

      // The bound fires: the warm input closes, the loop drains, and the
      // process-death boundary settles the held turn.
      await vi.advanceTimersByTimeAsync(5_000);
      await spawned;
      await flush();

      expect(log.filter((entry) => entry === 'exit')).toHaveLength(1);
      expect(getSdkRuns(mgr).has(panelId)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill switch (single-shot path): the first result still ends the turn', async () => {
    process.env.CYBOFLOW_DISABLE_WARM_SDK = '1';
    const panelId = 'p-bg-coldpath';
    fakeSdk.setScenario(autoContinuingScenario());

    const log: string[] = [];
    mgr.on('output', (evt: { data?: { type?: string; result?: string } }) => {
      if (evt.data?.type === 'result') log.push(`result:${evt.data.result}`);
    });
    mgr.on('exit', () => log.push('exit'));

    await mgr.spawnCliProcess({
      panelId,
      sessionId: panelId,
      worktreePath: '/tmp/wt',
      prompt: 'plan the ideas',
      permissionMode: 'ignore',
    });
    await flush();

    // Pre-fix behavior preserved: the FIRST result is the boundary ('exit' right
    // after it), regardless of live tasks — the single-shot process is closing.
    expect(log[0]).toBe('result:waiting for agents');
    expect(log[1]).toBe('exit');
  });
});
