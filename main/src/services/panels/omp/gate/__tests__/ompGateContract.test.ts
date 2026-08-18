/**
 * Contract test — pins the OMP (oh-my-pi) extension-API shape the gate relies
 * on, so an OMP bump that changes it fails a committed expectation here instead
 * of failing silently in production.
 *
 * OMP's release cadence is extreme (docs/proposals/omp-provider-integration.md
 * §2.8: 683 releases in ~9 months, weekly majors, frequent breaking changes), so
 * every upstream fact this module depends on is asserted rather than assumed.
 * Each assertion below names its evidence; the full citations live in
 * `ompGateTypes.ts`. When a bump breaks one of these, re-read the cited file and
 * update BOTH the citation and the assertion — never just the assertion.
 *
 * What this test can and cannot do: OMP is not vendored into this repo, so
 * nothing here reads OMP's source. It pins OUR side of the contract — the
 * export shape we present, the event names we bind, the result keys we emit —
 * which is what a `-e` load actually exercises. The upstream half is covered by
 * the live-load smoke described in the proposal's manual checklist.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import cyboflowOmpGate, {
  ENV_GATE_CONFIG,
  ENV_GATE_SENTINEL,
  ENV_ORCH_SOCKET,
  ENV_RUN_ID,
  MOST_RESTRICTIVE_GATE_CONFIG,
  createToolCallHandler,
  type OmpGateLogger,
} from '../ompGateExtension';
import type {
  OmpExtensionApi,
  OmpExtensionFactory,
  OmpGateSentinel,
  OmpLifecycleHandler,
  OmpToolCallEvent,
  OmpToolCallEventResult,
  OmpToolCallHandler,
} from '../ompGateTypes';

const silentLogger: OmpGateLogger = {
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * A stand-in for OMP's `ExtensionAPI`, recording what the factory binds.
 * Structurally this is what `ExtensionRunner` hands a factory during load.
 */
function makeStubPi(): {
  pi: OmpExtensionApi;
  toolCallHandlers: OmpToolCallHandler[];
  lifecycleHandlers: Map<string, OmpLifecycleHandler[]>;
  labels: string[];
} {
  const toolCallHandlers: OmpToolCallHandler[] = [];
  const lifecycleHandlers = new Map<string, OmpLifecycleHandler[]>();
  const labels: string[] = [];

  const pi: OmpExtensionApi = {
    on: (event: string, handler: OmpToolCallHandler | OmpLifecycleHandler): void => {
      if (event === 'tool_call') {
        toolCallHandlers.push(handler as OmpToolCallHandler);
        return;
      }
      const list = lifecycleHandlers.get(event) ?? [];
      list.push(handler as OmpLifecycleHandler);
      lifecycleHandlers.set(event, list);
    },
    setLabel: (label: string) => void labels.push(label),
  } as OmpExtensionApi;

  return { pi, toolCallHandlers, lifecycleHandlers, labels };
}

// ---------------------------------------------------------------------------
// (a) The module export shape OMP's loader accepts
// ---------------------------------------------------------------------------

describe('OMP contract (a): default-exported factory', () => {
  it('default-exports a single-argument function', () => {
    // loader.ts:55-59 — `typeof module === "function" ? module : module.default`,
    // then `typeof candidate === "function"`. Anything else is a load error.
    expect(typeof cyboflowOmpGate).toBe('function');
    expect(cyboflowOmpGate.length).toBe(1);
  });

  it('is assignable to the pinned OmpExtensionFactory type', () => {
    const factory: OmpExtensionFactory = cyboflowOmpGate;
    expect(factory).toBe(cyboflowOmpGate);
  });

  it('registers only during load — it performs no runtime action calls', () => {
    // docs/extensions.md:62-66 — calling an action method during load throws
    // ExtensionRuntimeNotInitializedError. Our stub `pi` exposes ONLY `on` and
    // `setLabel`; a factory that reached for anything else would throw here.
    const { pi } = makeStubPi();
    expect(() => cyboflowOmpGate(pi)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// (b) + (e) The events we bind
// ---------------------------------------------------------------------------

describe('OMP contract (b, e): bound events', () => {
  it('binds exactly one `tool_call` handler and a `session_shutdown` handler', () => {
    const { pi, toolCallHandlers, lifecycleHandlers } = makeStubPi();
    cyboflowOmpGate(pi);

    expect(toolCallHandlers).toHaveLength(1);
    expect(lifecycleHandlers.get('session_shutdown')).toHaveLength(1);
    // Anything else would be an unpinned dependency on an upstream event name.
    expect([...lifecycleHandlers.keys()]).toEqual(['session_shutdown']);
  });

  it('emits a block result with exactly the {block, reason} keys OMP reads', async () => {
    // shared-events.ts:310-321 — ToolCallEventResult is {block?, reason?, input?}.
    // We never return `input`: cyboflow decides, it does not rewrite arguments.
    const handler = createToolCallHandler({
      config: { ...MOST_RESTRICTIVE_GATE_CONFIG, disallowedTools: ['bash'] },
      runId: 'r',
      socketPath: undefined,
      logger: silentLogger,
      inFlight: new Set(),
    });

    const event: OmpToolCallEvent = {
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'c1',
      input: {},
    };
    const result = (await handler(event)) as OmpToolCallEventResult;

    expect(Object.keys(result).sort()).toEqual(['block', 'reason']);
    expect(result.block).toBe(true);
    expect(typeof result.reason).toBe('string');
  });

  it('returns undefined — not {block:false} — when it has no objection', async () => {
    // runner.ts:1260-1264 treats any truthy result as the running `result`.
    // `undefined` is the unambiguous "no opinion" that lets OMP proceed.
    const handler = createToolCallHandler({
      config: { ...MOST_RESTRICTIVE_GATE_CONFIG, permissionMode: 'dontAsk' },
      runId: 'r',
      socketPath: undefined,
      logger: silentLogger,
      inFlight: new Set(),
    });

    await expect(
      handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: {} }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (c) Fail-closed on throw
// ---------------------------------------------------------------------------

describe('OMP contract (c): a handler throw blocks the call', () => {
  it('throws rather than resolving when it cannot reach a decision', async () => {
    // runner.ts:1235-1270 converts a thrown handler into
    // {block:true, reason:'Extension <path> failed: <message>'} (runner.ts:1109),
    // and wrapper.ts:229-234 rethrows on the non-loop path. Either way the tool
    // is blocked — so throwing IS our deny of last resort.
    const handler = createToolCallHandler({
      config: { ...MOST_RESTRICTIVE_GATE_CONFIG },
      runId: 'r',
      socketPath: undefined,
      logger: silentLogger,
      inFlight: new Set(),
    });

    await expect(
      handler({ type: 'tool_call', toolName: 'bash', toolCallId: 'c1', input: {} }),
    ).rejects.toThrow(/failing closed/i);
  });
});

// ---------------------------------------------------------------------------
// The env contract the SDK manager is built against
// ---------------------------------------------------------------------------

describe('env contract', () => {
  it('pins the four env var names the manager sets', () => {
    expect(ENV_RUN_ID).toBe('CYBOFLOW_RUN_ID');
    expect(ENV_ORCH_SOCKET).toBe('CYBOFLOW_ORCH_SOCKET');
    expect(ENV_GATE_CONFIG).toBe('CYBOFLOW_OMP_GATE_CONFIG');
    expect(ENV_GATE_SENTINEL).toBe('CYBOFLOW_OMP_GATE_SENTINEL');
  });

  it('writes the load sentinel from the factory body, at load time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompgate-'));
    const sentinelPath = path.join(dir, 'sentinel.json');
    try {
      vi.stubEnv(ENV_RUN_ID, 'run-load');
      vi.stubEnv(ENV_GATE_SENTINEL, sentinelPath);

      const { pi } = makeStubPi();
      cyboflowOmpGate(pi);

      const sentinel = JSON.parse(fs.readFileSync(sentinelPath, 'utf8')) as OmpGateSentinel;
      expect(sentinel.runId).toBe('run-load');
      expect(sentinel.pid).toBe(process.pid);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still installs the gate when the sentinel cannot be written', () => {
    // The sentinel's ABSENCE is the manager's refuse-the-session signal; a
    // failed write must never also cost us the handler registration.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompgate-'));
    try {
      vi.stubEnv(ENV_GATE_SENTINEL, path.join(dir, 'missing-dir', 'sentinel.json'));

      const { pi, toolCallHandlers } = makeStubPi();
      expect(() => cyboflowOmpGate(pi)).not.toThrow();
      expect(toolCallHandlers).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gates everything when the config env var is absent', async () => {
    vi.stubEnv(ENV_GATE_CONFIG, '');
    vi.stubEnv(ENV_ORCH_SOCKET, '');
    vi.stubEnv(ENV_GATE_SENTINEL, '');
    try {
      const { pi, toolCallHandlers } = makeStubPi();
      cyboflowOmpGate(pi);

      // No config and no socket ⇒ the most restrictive policy ⇒ every call is
      // undecidable ⇒ throw (which OMP renders as a block).
      await expect(
        toolCallHandlers[0]!({ type: 'tool_call', toolName: 'read', toolCallId: 'c', input: {} }, {}),
      ).rejects.toThrow(/failing closed/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
