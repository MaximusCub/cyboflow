/**
 * ompRpcContract — the anti-drift KEYSTONE for the OMP RPC transport.
 *
 * Modeled on `main/src/test/fakes/__tests__/sdkContract.test.ts`. The fixtures in
 * `../__fixtures__` are wire captures from the real `omp` v17.3.2 binary; this
 * file pins every discriminant the client, projector and accumulator actually
 * read, so an OMP protocol change becomes a named, readable failure instead of a
 * silently reshaped chat stream (or, worse, a silently wrong cost).
 *
 * Three layers, mirroring the SDK contract test:
 *   1. WIRE PINS — the literal keys and discriminants we depend on exist, with
 *      the shapes we expect.
 *   2. DISCRIMINANT SNAPSHOT — the set of frame `type`s in the captured turn is
 *      committed, so a new or dropped event kind is visible on regeneration.
 *   3. END-TO-END — the captured turn is replayed through the REAL client into
 *      the REAL projector + accumulator, asserting the projected event sequence
 *      and the turn's usage/cost delta.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentStreamEvent } from '../../../../../../../shared/types/agentStream';
import {
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_FRAME_BYTES,
  OMP_RPC_PROTOCOL_VERSION,
  isOmpReadyFrame,
  isOmpRpcResponse,
  isTerminalAgentEnd,
  normalizeOmpEvent,
} from '../ompContract';
import { OmpTurnProjector } from '../ompEventProjector';
import { OmpRpcClient, type OmpRpcProcess, type SpawnOmpRpcProcess } from '../ompRpcClient';

const FIXTURES = join(__dirname, '..', '__fixtures__');

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

function readTurnFrames(): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, 'ompTurnFrames.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * The frame `type`s the captured turn contains, sorted. A regenerated capture
 * that gains or loses a kind changes this set — the assertion turns that into a
 * reviewable diff rather than an unnoticed projection gap.
 */
const EXPECTED_TURN_FRAME_TYPES: readonly string[] = [
  'agent_end',
  'agent_start',
  'available_commands_update',
  'extension_ui_request',
  'message_end',
  'message_start',
  'message_update',
  'ready',
  'response',
  'turn_end',
  'turn_start',
];

/** The turn's ground-truth usage — the exact numbers a cost regression would move. */
const EXPECTED_TURN_USAGE = {
  input_tokens: 3,
  output_tokens: 4,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 23316,
} as const;

const EXPECTED_TURN_COST_USD = 0.029168;

class FakeOmpProcess extends EventEmitter implements OmpRpcProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// 1. Wire pins.
// ---------------------------------------------------------------------------

describe('ompRpcContract — wire pins', () => {
  it('the ready frame advertises protocol v1 and the transport limits we assume', () => {
    const ready = readJson('ompReadyFrame.json');
    expect(isOmpReadyFrame(ready)).toBe(true);
    if (!isOmpReadyFrame(ready)) return;

    expect(Object.keys(ready).sort()).toEqual([
      'maxFrameBytes',
      'maxReassembledFrameBytes',
      'protocolVersion',
      'supportedProtocolVersions',
      'type',
    ]);
    // The handshake REFUSES a server whose supported set excludes 1.
    expect(ready.supportedProtocolVersions).toContain(OMP_RPC_PROTOCOL_VERSION);
    expect(ready.protocolVersion).toBe(OMP_RPC_PROTOCOL_VERSION);
    // Our constants must match what the server actually advertises.
    expect(ready.maxFrameBytes).toBe(OMP_MAX_FRAME_BYTES);
    expect(ready.maxReassembledFrameBytes).toBe(OMP_MAX_REASSEMBLED_FRAME_BYTES);
  });

  it('a success response envelope is {id,type,command,success,data}', () => {
    const response = readJson('ompSessionStatsResponse.json');
    expect(isOmpRpcResponse(response)).toBe(true);
    expect(response.type).toBe('response');
    expect(response.command).toBe('get_session_stats');
    expect(response.success).toBe(true);
    expect(typeof response.id).toBe('string');
    expect(response.data).toBeTypeOf('object');
  });

  it('an unknown command fails with NO id — the correlation hazard the client works around', () => {
    const response = readJson('ompUnknownCommandResponse.json');
    expect(isOmpRpcResponse(response)).toBe(true);
    expect(response.success).toBe(false);
    expect(typeof response.error).toBe('string');
    // The whole reason `takePendingFor` falls back to matching by command name:
    // correlating on id alone would strand this request forever.
    expect(Object.hasOwn(response, 'id')).toBe(false);
    expect(response.command).toBe('definitely_not_a_command');
  });

  it('negotiate_protocol reports the version actually in force', () => {
    const response = readJson('ompNegotiateProtocolResponse.json');
    expect(response.success).toBe(true);
    expect(response.data).toEqual({ protocolVersion: 2 });
  });

  it('model rows carry a BARE id plus a separate provider', () => {
    const response = readJson('ompAvailableModelsResponse.json');
    const data = response.data as { models: Record<string, unknown>[] };
    expect(data.models.length).toBeGreaterThan(0);
    for (const model of data.models) {
      expect(typeof model.id).toBe('string');
      expect(typeof model.provider).toBe('string');
      // Cyboflow's canonical persisted form is `<provider>/<id>`, composed at
      // the catalog projection — the wire id must NOT already be qualified.
      expect(model.id as string).not.toContain('/');
    }
  });

  it('get_session_stats is a CUMULATIVE rollup with a FLAT cost — never a turn source', () => {
    const response = readJson('ompSessionStatsResponse.json');
    const data = response.data as Record<string, unknown>;
    expect(typeof data.cost).toBe('number');
    expect(Object.keys(data.tokens as object).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'input',
      'output',
      'reasoning',
      'total',
    ]);
    // Session-level counters are what make this cumulative; using it per turn
    // would re-sum A + (A+B) + (A+B+C) downstream.
    expect(typeof data.totalMessages).toBe('number');
    expect(typeof data.assistantMessages).toBe('number');
  });

  it('get_last_assistant_text OMITS text on an empty session (not null)', () => {
    const response = readJson('ompLastAssistantTextResponse.json');
    expect(response.success).toBe(true);
    expect(response.data).toEqual({});
  });

  it('get_state returns a full model row and omits session paths under --no-session', () => {
    const response = readJson('ompGetStateResponse.json');
    const data = response.data as Record<string, unknown>;
    const model = data.model as Record<string, unknown>;
    expect(typeof model.id).toBe('string');
    expect(typeof model.provider).toBe('string');
    expect(Object.hasOwn(data, 'sessionFile')).toBe(false);
    expect(typeof data.sessionId).toBe('string');
  });

  it('the assistant usage block carries the disjoint token fields the accumulator maps', () => {
    const assistantEnd = readTurnFrames().find((frame) => {
      const message = frame.message as { role?: string } | undefined;
      return frame.type === 'message_end' && message?.role === 'assistant';
    });
    const message = assistantEnd?.message as Record<string, unknown>;
    const usage = message.usage as Record<string, unknown>;

    expect(Object.keys(usage).sort()).toEqual([
      'cacheRead',
      'cacheWrite',
      'cost',
      'cttl',
      'input',
      'output',
      'totalTokens',
    ]);
    // Disjoint, unlike Codex's inclusive inputTokens — hence no subtraction in
    // OmpTurnUsageAccumulator.
    const { input, output, cacheRead, cacheWrite, totalTokens } = usage as Record<string, number>;
    expect(input + output + cacheRead + cacheWrite).toBe(totalTokens);

    const cost = usage.cost as Record<string, number>;
    expect(typeof cost.total).toBe('number');
    expect(cost.total).toBe(EXPECTED_TURN_COST_USD);

    // The assistant message names a BARE model and a separate provider.
    expect(message.model).toBe('claude-haiku-4-5');
    expect(message.provider).toBe('anthropic');
    expect(message.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('agent_end stamps isTerminal explicitly, and absence still reads as terminal', () => {
    const agentEnd = readTurnFrames().find((frame) => frame.type === 'agent_end');
    expect(agentEnd?.isTerminal).toBe(true);

    const normalized = normalizeOmpEvent(agentEnd as Record<string, unknown>);
    expect(normalized.type).toBe('agent_end');
    if (normalized.type !== 'agent_end') return;
    expect(isTerminalAgentEnd(normalized)).toBe(true);
    // Older runtimes omit the field; only an explicit `false` is non-terminal.
    expect(isTerminalAgentEnd({ type: 'agent_end' })).toBe(true);
    expect(isTerminalAgentEnd({ type: 'agent_end', isTerminal: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Discriminant snapshot.
// ---------------------------------------------------------------------------

describe('ompRpcContract — discriminant snapshot', () => {
  it('the captured turn covers the committed set of frame types', () => {
    const types = [...new Set(readTurnFrames().map((frame) => String(frame.type)))].sort();
    expect(types).toEqual([...EXPECTED_TURN_FRAME_TYPES]);
  });

  it('every captured event frame normalizes to a MODELED variant, never __unknown__', () => {
    // `response` and `ready` are transport frames, not events.
    const eventFrames = readTurnFrames()
      .filter((frame) => frame.type !== 'response' && frame.type !== 'ready');
    expect(eventFrames.length).toBeGreaterThan(0);
    for (const frame of eventFrames) {
      const normalized = normalizeOmpEvent(frame);
      expect(normalized.type, `frame ${String(frame.type)} fell through to the unknown variant`)
        .toBe(frame.type);
    }
  });

  it('an unmodeled frame is carried through as __unknown__ instead of throwing', () => {
    const normalized = normalizeOmpEvent({ type: 'some_future_event', payload: 1 });
    expect(normalized.type).toBe('__unknown__');
    if (normalized.type !== '__unknown__') return;
    expect(normalized.frame).toEqual({ type: 'some_future_event', payload: 1 });
  });
});

// ---------------------------------------------------------------------------
// 3. End-to-end: fixture → client → projector → accumulator.
// ---------------------------------------------------------------------------

describe('ompRpcContract — captured turn end to end', () => {
  it('projects the real turn into user + assistant + result, with the turn cost delta', async () => {
    const child = new FakeOmpProcess();
    const spawn: SpawnOmpRpcProcess = () => child;
    const transportErrors: string[] = [];

    const projector = new OmpTurnProjector(
      { model: 'fallback-model', externalSessionId: 'session-1' },
      () => 0, // freeze the clock so duration_ms is deterministic
    );
    const projected: AgentStreamEvent[] = [];

    const client = new OmpRpcClient({
      spawn,
      // The capture was taken WITHOUT v2 negotiation, so replaying it must not
      // wait on a negotiate_protocol response that never arrives.
      negotiateProtocolV2: false,
      onEvent: (event) => projected.push(...projector.project(event)),
      onError: (error) => transportErrors.push(error.message),
    });
    client.start();

    // Replay the capture byte-for-byte, as one write per line.
    for (const frame of readTurnFrames()) {
      child.stdout.write(`${JSON.stringify(frame)}\n`);
    }
    await new Promise((resolve) => setImmediate(resolve));

    const handshake = await client.handshake();
    expect(handshake.protocolVersion).toBe(1);
    expect(handshake.ready.supportedProtocolVersions).toEqual([1, 2]);

    expect(projected).toEqual([
      {
        type: 'agent_message',
        provider: 'omp',
        runtime: 'omp-sdk',
        role: 'user',
        content: [{ type: 'text', text: 'Reply with exactly: ok' }],
        external_session_id: 'session-1',
      },
      {
        type: 'agent_message',
        provider: 'omp',
        runtime: 'omp-sdk',
        role: 'assistant',
        id: 'msg_01FIXTUREASSISTANT00000',
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'ok' }],
        external_session_id: 'session-1',
      },
      {
        type: 'agent_result',
        provider: 'omp',
        runtime: 'omp-sdk',
        subtype: 'success',
        is_error: false,
        duration_ms: 0,
        num_turns: 1,
        cost_usd: EXPECTED_TURN_COST_USD,
        usage: { ...EXPECTED_TURN_USAGE },
        external_session_id: 'session-1',
      },
    ]);

    // The accumulator's own view must agree with what the result event carried.
    expect(projector.turnUsage()).toEqual({ ...EXPECTED_TURN_USAGE });
    expect(projector.turnCostUsd()).toBe(EXPECTED_TURN_COST_USD);

    // The two capture responses (`prompt` ack id "turn-1", `get_session_stats`
    // id "stats-1") belong to the probe, not to this client, so they are
    // tolerated and reported rather than treated as transport faults.
    expect(transportErrors).toHaveLength(2);
    for (const message of transportErrors) {
      expect(message).toContain('no matching request');
    }
    expect(client.state).toBe('running');
  });

  it('the usage delta is NOT multiplied by the repeated usage blocks in the capture', () => {
    // The identical usage object rides message_start, three message_updates,
    // message_end, turn_end and agent_end. Accruing on each would bill 7x.
    const frames = readTurnFrames();
    const carriers = frames.filter((frame) => {
      const message = frame.message as { usage?: unknown } | undefined;
      return message?.usage !== undefined;
    });
    expect(carriers.length).toBeGreaterThan(1);

    const projector = new OmpTurnProjector({ model: 'm' }, () => 0);
    for (const frame of frames) {
      if (frame.type === 'response' || frame.type === 'ready') continue;
      projector.project(normalizeOmpEvent(frame));
    }
    expect(projector.turnCostUsd()).toBe(EXPECTED_TURN_COST_USD);
    expect(projector.turnUsage()).toEqual({ ...EXPECTED_TURN_USAGE });
  });
});
