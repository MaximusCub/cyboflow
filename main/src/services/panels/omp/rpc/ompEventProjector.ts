/**
 * ompEventProjector — OMP RPC events → cyboflow's provider-neutral
 * `AgentStreamEvent[]`, stamped `{provider:'omp', runtime:'omp-sdk'}`.
 *
 * The Codex projector is the shape blueprint: a total `switch` over the event
 * union, `[]` for anything transport-level, and an explicit `agent_unknown` for
 * shapes we do not model — never a silent drop of something anomalous.
 *
 * PROJECT FROM MESSAGES, NOT FROM TOOL LIFECYCLE. OMP reports a tool result
 * BOTH as a `tool_execution_end` event and as a `message_start`/`message_end`
 * pair carrying a `role:"toolResult"` message (`packages/agent/src/agent.ts`
 * :1640-1641, :1663-1664, :1743-1745). Projecting both would render every tool
 * result twice, so `message_end` is the single source: it is the canonical
 * transcript entry, it carries the assistant's `toolCall` blocks alongside, and
 * `tool_execution_*` is then just the streaming mirror — dropped like
 * `message_update` deltas.
 *
 * DELTAS ARE DROPPED in v1 (codex-parity refetch model, proposal §5.1);
 * `message_start` is dropped too, since `message_end` re-delivers the same
 * message complete.
 */
import type {
  AgentAssistantContentBlock,
  AgentAssistantMessageEvent,
  AgentResultEvent,
  AgentStreamEvent,
  AgentUnknownEvent,
  AgentUsage,
  AgentUserContentBlock,
  AgentUserMessageEvent,
} from '../../../../../../shared/types/agentStream';
import {
  OMP_UNKNOWN,
  isTerminalAgentEnd,
  type OmpAgentEndEvent,
  type OmpAssistantMessage,
  type OmpContentBlock,
  type OmpMessage,
  type OmpRpcEvent,
  type OmpToolResultMessage,
  type OmpUserMessage,
} from './ompContract';
import { OmpTurnUsageAccumulator } from './ompUsageAccumulator';

/** Mirrors CODEX_EVENT_SOURCE — every projected event carries its origin. */
export const OMP_EVENT_SOURCE = {
  provider: 'omp' as const,
  runtime: 'omp-sdk' as const,
};

export interface OmpEventProjectionContext {
  /** Model id for assistant events when the message itself does not name one. */
  readonly model: string;
  readonly durationMs: number;
  /** The TURN's usage delta (never a session rollup) — see ompUsageAccumulator. */
  readonly usage?: AgentUsage;
  /** The TURN's cost delta in USD, stored verbatim. */
  readonly costUsd?: number;
  readonly externalSessionId?: string;
  /** Suppress OMP's echo of an internal workflow prompt from the chat surface. */
  readonly hideUserMessage?: boolean;
}

function buildUnknownEvent(raw: Record<string, unknown>): AgentUnknownEvent {
  return { type: 'agent_unknown', ...OMP_EVENT_SOURCE, raw };
}

function withSession<T extends { external_session_id?: string }>(
  event: T,
  context: OmpEventProjectionContext,
): T {
  if (context.externalSessionId === undefined) return event;
  return { ...event, external_session_id: context.externalSessionId };
}

/** Flatten a content array to display text; images become a readable stand-in. */
function contentText(content: readonly OmpContentBlock[]): string {
  return content.flatMap((block) => {
    switch (block.type) {
      case 'text':
        return [block.text];
      case 'image':
        return [`[image: ${block.mimeType}]`];
      default:
        return [];
    }
  }).join('\n');
}

function unknownBlocks(content: readonly OmpContentBlock[]): Record<string, unknown>[] {
  return content.flatMap((block) => (block.type === OMP_UNKNOWN ? [block.block] : []));
}

/**
 * Map OMP's assistant blocks onto cyboflow's. The names differ deliberately:
 * OMP carries thinking text under `thinking` and tool arguments under
 * `arguments`, where cyboflow uses `text` and `input`.
 */
function assistantContent(content: readonly OmpContentBlock[]): AgentAssistantContentBlock[] {
  return content.flatMap((block): AgentAssistantContentBlock[] => {
    switch (block.type) {
      case 'text':
        return block.text.length > 0 ? [{ type: 'text', text: block.text }] : [];
      case 'thinking':
        return block.thinking.length > 0 ? [{ type: 'thinking', text: block.thinking }] : [];
      case 'toolCall':
        return [{ type: 'tool_call', id: block.id, name: block.name, input: block.arguments }];
      // `redactedThinking` is opaque provider ciphertext with no renderable
      // text, and images are not an assistant content kind here.
      case 'redactedThinking':
      case 'image':
      case OMP_UNKNOWN:
        return [];
    }
  });
}

function projectAssistantMessage(
  message: OmpAssistantMessage,
  context: OmpEventProjectionContext,
): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const content = assistantContent(message.content);
  if (content.length > 0) {
    const event: AgentAssistantMessageEvent = {
      type: 'agent_message',
      ...OMP_EVENT_SOURCE,
      role: 'assistant',
      // `responseId` is the provider's own message id; fall back to the message
      // timestamp so a provider that omits it still yields a stable key.
      id: message.responseId ?? `omp-assistant-${message.timestamp ?? 0}`,
      model: message.model ?? context.model,
      content,
    };
    events.push(withSession(event, context));
  }
  // Surface an unmodeled content block rather than dropping it silently — that
  // silence is exactly how a provider-shape change goes unnoticed.
  for (const block of unknownBlocks(message.content)) {
    events.push(buildUnknownEvent({ omp: 'assistant_content_block', block }));
  }
  return events;
}

function projectUserMessage(
  message: OmpUserMessage,
  context: OmpEventProjectionContext,
): AgentStreamEvent[] {
  if (context.hideUserMessage === true) return [];
  const text = contentText(message.content);
  if (text.trim().length === 0) return [];
  const event: AgentUserMessageEvent = {
    type: 'agent_message',
    ...OMP_EVENT_SOURCE,
    role: 'user',
    content: [{ type: 'text', text }],
  };
  return [withSession(event, context)];
}

function projectToolResultMessage(
  message: OmpToolResultMessage,
  context: OmpEventProjectionContext,
): AgentStreamEvent[] {
  const content: AgentUserContentBlock[] = [{
    type: 'tool_result',
    tool_call_id: message.toolCallId,
    content: contentText(message.content),
    is_error: message.isError,
  }];
  const event: AgentUserMessageEvent = {
    type: 'agent_message',
    ...OMP_EVENT_SOURCE,
    role: 'user',
    content,
  };
  return [withSession(event, context)];
}

function projectMessage(
  message: OmpMessage,
  context: OmpEventProjectionContext,
): AgentStreamEvent[] {
  switch (message.role) {
    case 'assistant':
      return projectAssistantMessage(message, context);
    case 'user':
      return projectUserMessage(message, context);
    case 'toolResult':
      return projectToolResultMessage(message, context);
    case OMP_UNKNOWN:
      return [buildUnknownEvent({ omp: 'message', message: message.message })];
  }
}

/**
 * Did the run end badly? `agent_end` carries the transcript, so the last
 * assistant message's stop reason is the available signal. `aborted` counts as
 * an error result the same way an interrupted Codex turn does.
 */
function agentEndIsError(event: OmpAgentEndEvent): boolean {
  const messages = event.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    return message.errorMessage !== undefined
      || message.stopReason === 'error'
      || message.stopReason === 'aborted';
  }
  return false;
}

/**
 * The final assistant message's TEXT in a terminal `agent_end`, or null when the
 * turn produced none.
 *
 * This is the typed step-output channel for an `omp-sdk` programmatic step
 * (`CliSpawnOutcome.resultText`): the workflow controller parses a code-review
 * verdict, a task-verify PASS/FAIL, and the visual-verification fence out of it,
 * and every one of those paths is dead for a substrate that returns null. The
 * transcript is already IN the terminal `agent_end` — OMP hands the whole
 * message list over — so the value is read from the frame the turn resolved on
 * rather than round-tripped through another RPC call.
 *
 * Only `text` blocks count. `thinking` is not the agent's answer, `toolCall`
 * blocks carry arguments, and a `redactedThinking` block is opaque ciphertext —
 * folding any of them in would hand the controller's parsers text the agent
 * never addressed to them.
 *
 * The LAST assistant message wins, and the search stops there rather than
 * concatenating every assistant turn: a multi-step turn's earlier messages are
 * intermediate reasoning around tool calls, and the verdict parsers look for a
 * fence in the FINAL answer.
 */
export function lastAssistantTextIn(event: OmpAgentEndEvent): string | null {
  const messages = event.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    return text.length > 0 ? text : null;
  }
  return null;
}

function agentEndResultText(event: OmpAgentEndEvent): string | undefined {
  const messages = event.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'assistant' && message.errorMessage !== undefined) {
      return message.errorMessage;
    }
  }
  return undefined;
}

function projectAgentEnd(
  event: OmpAgentEndEvent,
  context: OmpEventProjectionContext,
): AgentStreamEvent[] {
  // A non-terminal `agent_end` means maintenance scheduled more work and the
  // session will resume — it is NOT the end of the turn, so no result is
  // emitted (and the usage accumulator keeps accruing).
  if (!isTerminalAgentEnd(event)) return [];
  const isError = agentEndIsError(event);
  const result = agentEndResultText(event);
  const event_: AgentResultEvent = {
    type: 'agent_result',
    ...OMP_EVENT_SOURCE,
    subtype: isError ? 'error_during_execution' : 'success',
    is_error: isError,
    duration_ms: context.durationMs,
    num_turns: 1,
    ...(result !== undefined ? { result } : {}),
    // cost_usd for existing consumers; total_cost_usd is the SDK-raw key
    // insightsQueries' run-cost rollup scans — this event persists into
    // raw_events verbatim (see ompSdkManager's RawEventsSink<AgentStreamEvent>).
    ...(context.costUsd !== undefined
      ? { cost_usd: context.costUsd, total_cost_usd: context.costUsd }
      : {}),
    ...(context.usage !== undefined ? { usage: context.usage } : {}),
  };
  return [withSession(event_, context)];
}

/**
 * Project one OMP event. Returns `[]` for transport-level frames the chat
 * surface has no use for.
 */
export function projectOmpEvent(
  event: OmpRpcEvent,
  context: OmpEventProjectionContext,
): AgentStreamEvent[] {
  switch (event.type) {
    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
      // Lifecycle bookkeeping with no chat representation.
      return [];
    case 'message_start':
    case 'message_update':
      // `message_start` is redundant with `message_end`, which re-delivers the
      // same message complete; deltas are dropped in v1.
      return [];
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end':
      // The streaming mirror of results already projected from `message_end`.
      return [];
    case 'available_commands_update':
    case 'extension_ui_request':
    case 'prompt_result':
      // Transport-level: the command catalogue and the extension-UI bridge are
      // handled by the client and the gate extension, not the chat stream.
      return [];
    case 'message_end':
      return projectMessage(event.message, context);
    case 'agent_end':
      return projectAgentEnd(event, context);
    // A failing extension is a genuine anomaly, not routine chatter.
    case 'extension_error':
      return [buildUnknownEvent({
        omp: 'extension_error',
        extensionPath: event.extensionPath,
        error: event.error,
      })];
    case OMP_UNKNOWN:
      return [buildUnknownEvent(event.frame)];
  }
}

/**
 * Stateful per-turn composition of the accumulator and the projector — what the
 * `OmpSdkManager` drives, and the seam the fixture-driven contract test
 * exercises end to end.
 *
 * The ordering that matters: an assistant `message_end` accrues usage BEFORE the
 * terminal `agent_end` is projected, so the result event carries the complete
 * turn delta. `reset()` at each turn boundary is what keeps the delta a delta.
 */
export class OmpTurnProjector {
  private readonly usage = new OmpTurnUsageAccumulator();
  private startedAtMs: number;

  constructor(
    private readonly context: Omit<OmpEventProjectionContext, 'durationMs' | 'usage' | 'costUsd'>,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAtMs = this.now();
  }

  /** Begin a new turn: clear the delta and restart the duration clock. */
  beginTurn(): void {
    this.usage.reset();
    this.startedAtMs = this.now();
  }

  project(event: OmpRpcEvent): AgentStreamEvent[] {
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      this.usage.addAssistantMessage(event.message);
    }
    const snapshot = this.usage.snapshot();
    const costUsd = this.usage.costUsd();
    return projectOmpEvent(event, {
      ...this.context,
      durationMs: Math.max(0, this.now() - this.startedAtMs),
      ...(snapshot !== undefined ? { usage: snapshot } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    });
  }

  /** The turn's accrued token delta, for callers that record it separately. */
  turnUsage(): AgentUsage | undefined {
    return this.usage.snapshot();
  }

  /** The turn's accrued cost delta in USD. */
  turnCostUsd(): number | undefined {
    return this.usage.costUsd();
  }
}
