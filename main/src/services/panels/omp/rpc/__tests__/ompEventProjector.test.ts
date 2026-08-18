import { describe, expect, it } from 'vitest';
import {
  lastAssistantTextIn,
  OMP_EVENT_SOURCE,
  OmpTurnProjector,
  projectOmpEvent,
  type OmpEventProjectionContext,
} from '../ompEventProjector';
import { normalizeOmpEvent, type OmpRpcEvent } from '../ompContract';

const CONTEXT: OmpEventProjectionContext = { model: 'claude-haiku-4-5', durationMs: 1_200 };

function project(event: OmpRpcEvent, context: Partial<OmpEventProjectionContext> = {}) {
  return projectOmpEvent(event, { ...CONTEXT, ...context });
}

describe('ompEventProjector — source stamping', () => {
  it('stamps provider and runtime on every emitted event', () => {
    expect(OMP_EVENT_SOURCE).toEqual({ provider: 'omp', runtime: 'omp-sdk' });
    const events = project({ type: 'agent_end', messages: [], isTerminal: true });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider: 'omp', runtime: 'omp-sdk' });
  });
});

describe('ompEventProjector — messages', () => {
  it('projects a user message_end', () => {
    expect(project({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: 'hi there' }] },
    })).toEqual([{
      type: 'agent_message',
      ...OMP_EVENT_SOURCE,
      role: 'user',
      content: [{ type: 'text', text: 'hi there' }],
    }]);
  });

  it('suppresses the user echo when hideUserMessage is set', () => {
    expect(project(
      { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'internal' }] } },
      { hideUserMessage: true },
    )).toEqual([]);
  });

  it('drops an empty user message', () => {
    expect(project({
      type: 'message_end',
      message: { role: 'user', content: [{ type: 'text', text: '   ' }] },
    })).toEqual([]);
  });

  it('maps assistant text, thinking and tool calls onto cyboflow block names', () => {
    const events = project({
      type: 'message_end',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        responseId: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'pondering' },
          { type: 'text', text: 'here you go' },
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/x' } },
        ],
      },
    });

    expect(events).toEqual([{
      type: 'agent_message',
      ...OMP_EVENT_SOURCE,
      role: 'assistant',
      id: 'msg_1',
      model: 'claude-sonnet-4-5',
      content: [
        // OMP's `thinking` key becomes cyboflow's `text`...
        { type: 'thinking', text: 'pondering' },
        { type: 'text', text: 'here you go' },
        // ...and OMP's `arguments` becomes cyboflow's `input`.
        { type: 'tool_call', id: 'call_1', name: 'read', input: { path: '/tmp/x' } },
      ],
    }]);
  });

  it('falls back to the context model and a timestamp-derived id', () => {
    const events = project({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 42 },
    });
    expect(events[0]).toMatchObject({ model: 'claude-haiku-4-5', id: 'omp-assistant-42' });
  });

  it('drops opaque redacted-thinking and skips a message left with no content', () => {
    expect(project({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'redactedThinking', data: 'AAAA' }] },
    })).toEqual([]);
  });

  it('projects a toolResult message into a tool_result block', () => {
    expect(project({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read',
        isError: false,
        content: [{ type: 'text', text: 'file contents' }],
      },
    })).toEqual([{
      type: 'agent_message',
      ...OMP_EVENT_SOURCE,
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_call_id: 'call_1',
        content: 'file contents',
        is_error: false,
      }],
    }]);
  });

  it('carries the error flag on a failed tool result', () => {
    const events = project({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call_2',
        toolName: 'bash',
        isError: true,
        content: [{ type: 'text', text: 'command not found' }],
      },
    });
    expect(events[0]).toMatchObject({ content: [{ is_error: true }] });
  });

  it('surfaces an unmodeled content block as agent_unknown rather than dropping it', () => {
    const events = project(normalizeOmpEvent({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }, { type: 'someFutureBlock', payload: 7 }],
      },
    }));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'agent_unknown',
      raw: { omp: 'assistant_content_block', block: { type: 'someFutureBlock', payload: 7 } },
    });
  });
});

describe('ompEventProjector — results', () => {
  it('projects a terminal agent_end into a result carrying the turn delta', () => {
    const usage = { input_tokens: 3, output_tokens: 4 };
    expect(project(
      { type: 'agent_end', messages: [], isTerminal: true },
      { usage, costUsd: 0.5, externalSessionId: 'sess-1' },
    )).toEqual([{
      type: 'agent_result',
      ...OMP_EVENT_SOURCE,
      subtype: 'success',
      is_error: false,
      duration_ms: 1_200,
      num_turns: 1,
      // Both keys, same value: cost_usd for existing consumers, total_cost_usd
      // because that is the only key insightsQueries' run-cost rollup scans —
      // this event persists into raw_events verbatim.
      cost_usd: 0.5,
      total_cost_usd: 0.5,
      usage,
      external_session_id: 'sess-1',
    }]);
  });

  it('emits NOTHING for a non-terminal agent_end', () => {
    // The session will resume, so a result here would close the turn early and
    // bill a partial delta.
    expect(project({ type: 'agent_end', messages: [], isTerminal: false })).toEqual([]);
  });

  it('marks the result as an error when the last assistant message failed', () => {
    const events = project({
      type: 'agent_end',
      isTerminal: true,
      messages: [{
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'upstream 529',
      }],
    });
    expect(events[0]).toMatchObject({
      subtype: 'error_during_execution',
      is_error: true,
      result: 'upstream 529',
    });
  });

  it('treats an aborted turn as an error result', () => {
    const events = project({
      type: 'agent_end',
      isTerminal: true,
      messages: [{ role: 'assistant', content: [], stopReason: 'aborted' }],
    });
    expect(events[0]).toMatchObject({ is_error: true });
  });

  it('omits cost_usd and total_cost_usd entirely when no cost was reported', () => {
    const [event] = project({ type: 'agent_end', messages: [], isTerminal: true });
    expect(Object.hasOwn(event, 'cost_usd')).toBe(false);
    expect(Object.hasOwn(event, 'total_cost_usd')).toBe(false);
  });
});

describe('ompEventProjector — dropped and tolerated frames', () => {
  const dropped: OmpRpcEvent[] = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'turn_end' },
    { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta' } },
    { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read' },
    { type: 'tool_execution_update', toolCallId: 'c1', toolName: 'read' },
    { type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read' },
    { type: 'available_commands_update', commands: [] },
    { type: 'extension_ui_request', id: 'ui_1', method: 'setWidget' },
    { type: 'prompt_result', id: 'p1', agentInvoked: true },
  ];

  it.each(dropped)('drops $type', (event) => {
    expect(project(event)).toEqual([]);
  });

  it('does not double-render a tool result already projected from message_end', () => {
    // The pair OMP emits for one tool call: only the message side projects.
    const fromMessage = project({
      type: 'message_end',
      message: {
        role: 'toolResult', toolCallId: 'c1', toolName: 'read', isError: false,
        content: [{ type: 'text', text: 'out' }],
      },
    });
    const fromLifecycle = project({
      type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: 'out',
    });
    expect(fromMessage).toHaveLength(1);
    expect(fromLifecycle).toHaveLength(0);
  });

  it('surfaces an extension error as agent_unknown', () => {
    expect(project({ type: 'extension_error', extensionPath: '/x.ts', error: 'boom' })).toEqual([{
      type: 'agent_unknown',
      ...OMP_EVENT_SOURCE,
      raw: { omp: 'extension_error', extensionPath: '/x.ts', error: 'boom' },
    }]);
  });

  it('surfaces an unrecognized frame as agent_unknown', () => {
    expect(project(normalizeOmpEvent({ type: 'ttsr_triggered', detail: 1 }))).toEqual([{
      type: 'agent_unknown',
      ...OMP_EVENT_SOURCE,
      raw: { type: 'ttsr_triggered', detail: 1 },
    }]);
  });
});

describe('OmpTurnProjector', () => {
  function assistantEnd(responseId: string, total: number): OmpRpcEvent {
    return {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        responseId,
        usage: {
          input: 1,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 3,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
        },
      },
    };
  }

  it('accrues usage before the result event so the delta is complete', () => {
    const projector = new OmpTurnProjector({ model: 'm' }, () => 0);
    projector.project(assistantEnd('msg_1', 0.25));
    const [result] = projector.project({ type: 'agent_end', messages: [], isTerminal: true });
    expect(result).toMatchObject({
      type: 'agent_result',
      cost_usd: 0.25,
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
  });

  it('reports a per-turn delta across three turns, not a rollup', () => {
    const projector = new OmpTurnProjector({ model: 'm' }, () => 0);
    const costs: Array<number | undefined> = [];
    for (const [index, total] of [0.25, 0.5, 1].entries()) {
      projector.beginTurn();
      projector.project(assistantEnd(`msg_${index}`, total));
      projector.project({ type: 'agent_end', messages: [], isTerminal: true });
      costs.push(projector.turnCostUsd());
    }
    expect(costs).toEqual([0.25, 0.5, 1]);
  });

  it('keeps accruing across a non-terminal agent_end', () => {
    // A maintenance resume splits one logical turn in two; both halves belong to
    // the same delta.
    const projector = new OmpTurnProjector({ model: 'm' }, () => 0);
    projector.project(assistantEnd('msg_1', 0.25));
    expect(projector.project({ type: 'agent_end', messages: [], isTerminal: false })).toEqual([]);
    projector.project(assistantEnd('msg_2', 0.75));
    const [result] = projector.project({ type: 'agent_end', messages: [], isTerminal: true });
    expect(result).toMatchObject({ cost_usd: 1, total_cost_usd: 1 });
  });

  it('measures duration from the turn start', () => {
    let now = 1_000;
    const projector = new OmpTurnProjector({ model: 'm' }, () => now);
    projector.beginTurn();
    now = 3_500;
    const [result] = projector.project({ type: 'agent_end', messages: [], isTerminal: true });
    expect(result).toMatchObject({ duration_ms: 2_500 });
  });
});

/**
 * `lastAssistantTextIn` is the source of `CliSpawnOutcome.resultText` for an
 * omp-sdk step turn — the string the workflow controller parses a code-review
 * verdict, a task-verify PASS/FAIL, and the visual-verification fence out of. It
 * has to return the agent's ANSWER and nothing else: fold in a thinking block or
 * a tool-call argument and the controller's parsers see text the agent never
 * addressed to them.
 */
describe('ompEventProjector — lastAssistantTextIn', () => {
  it('returns the final assistant message`s text', () => {
    expect(lastAssistantTextIn({
      type: 'agent_end',
      isTerminal: true,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'thinking out loud' }] },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: 'file contents' }],
        },
        { role: 'assistant', content: [{ type: 'text', text: '## Verdict\nPASS' }] },
      ],
    })).toBe('## Verdict\nPASS');
  });

  it('joins several text blocks of that one message', () => {
    expect(lastAssistantTextIn({
      type: 'agent_end',
      isTerminal: true,
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
      }],
    })).toBe('line one\nline two');
  });

  it('ignores thinking and tool-call blocks — only the answer counts', () => {
    expect(lastAssistantTextIn({
      type: 'agent_end',
      isTerminal: true,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'the user probably wants…' },
          { type: 'text', text: 'FAIL' },
          { type: 'toolCall', id: 'c9', name: 'bash', arguments: { command: 'ls' } },
        ],
      }],
    })).toBe('FAIL');
  });

  it('returns null for a final message with no text at all', () => {
    // The tool-calls-only shape: the manager falls back to the RPC call here
    // rather than reporting an empty verdict.
    expect(lastAssistantTextIn({
      type: 'agent_end',
      isTerminal: true,
      messages: [{
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
      }],
    })).toBeNull();
  });

  it('stops at the LAST assistant message rather than concatenating earlier ones', () => {
    // Earlier assistant messages are intermediate reasoning around tool calls;
    // the verdict parsers look for a fence in the FINAL answer, and gluing the
    // whole turn together would let an earlier draft's fence win.
    expect(lastAssistantTextIn({
      type: 'agent_end',
      isTerminal: true,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'VERDICT: FAIL (draft)' }] },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }] },
      ],
    })).toBeNull();
  });

  it('returns null for an empty or absent message list', () => {
    expect(lastAssistantTextIn({ type: 'agent_end', isTerminal: true, messages: [] })).toBeNull();
    expect(lastAssistantTextIn({ type: 'agent_end', isTerminal: true })).toBeNull();
  });
});
