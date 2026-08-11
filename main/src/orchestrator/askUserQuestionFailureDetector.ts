/**
 * AskUserQuestionFailureDetector — watches a single flow-run's typed
 * ClaudeStreamEvent stream for a HUMAN GATE that FAILED at the SDK
 * control-channel layer, so the orchestrator can synthesize a durable review
 * gate instead of letting the run silently false-complete.
 *
 * WHY THIS EXISTS
 * ---------------
 * On the SDK substrate the AskUserQuestion gate is serviced by a `can_use_tool`
 * control round-trip over the query's stdin. That channel intermittently drops
 * under load ("Stream closed"): the CLI reports the tool call back as an error
 * tool_result (`Tool permission request failed: Error: Stream closed`) WITHOUT
 * ever invoking our PreToolUse hook. The agent, seeing the error, degrades to a
 * free-text question and ends its turn. The run then drains to `awaiting_review`
 * and renders as "Workflow complete" — the human decision is stranded and every
 * nudge re-hits the same drop. See streamingPromptInput.ts for the (partial)
 * stdin-keepalive fix; this detector is the durable safety net for when it fails
 * mid-run anyway. Diagnosed 2026-07-07 from a real ship run.
 *
 * WHICH GATES (2026-08-11)
 * ------------------------
 * Both gate tools count, because both are serviced over the same channel: the
 * native `AskUserQuestion` and the first-party MCP `cyboflow_request_user_input`
 * (the form workflowPromptRenderer tells every flow agent to use, and the ONLY
 * form a Codex-runtime agent has). A launch run lost its human checkpoint when
 * the MCP form came back CANCELLED — the CLI cancels a tool at entry when the
 * turn's abort signal is already set, framing it with its standard
 * user-declined text — and the agent, told the user had declined, walked past
 * the gate. Neither the tool name nor that wording was matched here, so the
 * durable net never fired. See shouldHoldFlowTurnOpen for the root-cause fix;
 * this stays the safety net for every other way the round trip can die.
 *
 * DETECTION
 * ---------
 *   (a) `assistant` events: a `tool_use` block for either gate tool records
 *       its block id as pending, keyed to its `questions` input payload.
 *   (b) `user` events: a `tool_result` whose tool_use_id is pending, whose
 *       `is_error` is true, and whose flattened text matches the gate-failure
 *       signature yields `onFailure(questions)` — exactly once per tool call.
 *
 * A pending id that comes back as a SUCCESSFUL tool_result is cleared silently
 * (the gate worked; nothing to recover). Everything is fail-soft: handleEvent
 * never throws (a malformed event logs a WARN and is dropped).
 */
import type {
  AssistantEvent,
  ClaudeStreamEvent,
  ToolResultBlock,
  UserEvent,
} from '../../../shared/types/claudeStream';
import type { QuestionPayload } from '../../../shared/types/questions';
import type { LoggerLike } from './types';

/**
 * Matches the CLI's error tool_result text when the `can_use_tool` control
 * round-trip for a gate fails. Three observed shapes:
 *   - `Tool permission request failed: Error: Stream closed` — the control
 *     channel dropped (matched by either half, so a minor wording change on
 *     either side still trips the recovery path);
 *   - `The user doesn't want to take this action right now. …` — the CLI's
 *     standard user-declined framing, which it ALSO uses for a tool cancelled
 *     at entry on an already-aborted turn (2026-08-11). Matched on the stable
 *     middle of the sentence so the apostrophe form does not matter.
 *
 * A gate the human genuinely denies at the permission prompt would match the
 * last one too. That is deliberate: a denied gate is still an unanswered human
 * decision, and re-offering it as a review item is far cheaper than losing it.
 */
const GATE_FAILURE_SIGNATURE =
  /stream closed|tool permission request failed|want to take this action/i;

/**
 * The MCP gate tool, minus its `mcp__<server>__` prefix. Matched by suffix so a
 * rename of the MCP server registration cannot silently unhook the detector.
 */
const MCP_GATE_TOOL_SUFFIX = 'cyboflow_request_user_input';

/** True for either human-gate tool (native AskUserQuestion or the MCP form). */
function isGateToolName(name: string): boolean {
  return name === 'AskUserQuestion' || name.endsWith(MCP_GATE_TOOL_SUFFIX);
}

export interface AskUserQuestionFailureDetectorOptions {
  /**
   * Fired once when a pending AskUserQuestion tool call comes back as a
   * gate-failure error tool_result. `questions` is the exact payload the agent
   * asked (captured from the tool_use input) so the caller can re-offer it.
   */
  onFailure: (questions: QuestionPayload[]) => void;
  logger?: Pick<LoggerLike, 'warn'>;
}

export class AskUserQuestionFailureDetector {
  /**
   * tool_use block id → the questions payload it asked, for AskUserQuestion
   * calls awaiting their tool_result.
   */
  private readonly pending = new Map<string, QuestionPayload[]>();

  /**
   * Fire onFailure AT MOST ONCE per detector (i.e. per spawn/turn). An agent
   * facing a dropped gate retries AskUserQuestion several times in the SAME turn
   * (6× in the diagnosed run); one recovery gate per turn is enough — it blocks
   * the run, so the next turn (if any) gets a fresh detector.
   */
  private fired = false;

  constructor(private readonly opts: AskUserQuestionFailureDetectorOptions) {}

  /** Feed one typed stream event through the detector. Never throws. */
  handleEvent(event: ClaudeStreamEvent): void {
    try {
      // The catch-all UnknownStreamEvent discriminates on `kind`, not `type`
      // (see claudeStream.ts) — it carries no tool_use/tool_result blocks, so
      // skip it before the type switch.
      if ('kind' in event) return;
      if (event.type === 'assistant') {
        this.handleAssistant(event);
      } else if (event.type === 'user') {
        this.handleUser(event);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.opts.logger?.warn(`[askUserQuestionFailureDetector] event handling failed: ${message}`);
    }
  }

  /** (a) Remember every gate tool_use block id + its questions. */
  private handleAssistant(event: AssistantEvent): void {
    for (const block of event.message.content) {
      if (block.type !== 'tool_use' || !isGateToolName(block.name)) continue;
      const questions = extractQuestions(block.input);
      // Even with no parseable questions we track the id so a failure can still
      // synthesize an (option-less) recovery gate rather than false-completing.
      this.pending.set(block.id, questions);
    }
  }

  /** (b) On the matching tool_result: fire onFailure for a gate-failure error. */
  private handleUser(event: UserEvent): void {
    for (const block of event.message.content) {
      if (block.type !== 'tool_result') continue;
      if (!this.pending.has(block.tool_use_id)) continue;

      const questions = this.pending.get(block.tool_use_id) ?? [];
      // A tool_use gets exactly one tool_result — clear on receipt so a
      // success (or a non-matching error) cannot leak a pending entry or
      // double-fire.
      this.pending.delete(block.tool_use_id);

      if (block.is_error !== true) continue; // gate succeeded — nothing to recover.
      const text = flattenToolResultContent(block.content);
      if (!GATE_FAILURE_SIGNATURE.test(text)) continue; // some other tool error.
      if (this.fired) continue; // one recovery gate per turn (see `fired`).

      this.fired = true;
      this.opts.onFailure(questions);
    }
  }
}

/**
 * Narrow a gate tool_use input to QuestionPayload[]. Both wire shapes are
 * `{ questions: [...] }` and differ only in the multi-select key: the native
 * AskUserQuestion tool carries camelCase `multiSelect`, the MCP
 * `cyboflow_request_user_input` tool carries snake_case `multi_select` (see
 * cyboflowMcpServer's input schema). Anything malformed yields `[]` (the
 * recovery gate then carries no options — still better than a lost gate).
 */
function extractQuestions(input: Record<string, unknown>): QuestionPayload[] {
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: QuestionPayload[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const q = entry as Record<string, unknown>;
    if (typeof q['question'] !== 'string') continue;
    out.push({
      question: q['question'],
      header: typeof q['header'] === 'string' ? q['header'] : '',
      multiSelect: q['multiSelect'] === true || q['multi_select'] === true,
      options: extractOptions(q['options']),
    });
  }
  return out;
}

/** Narrow a question's `options` array; a malformed entry is dropped. */
function extractOptions(raw: unknown): QuestionPayload['options'] {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ label: string; description?: string; preview?: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const o = entry as Record<string, unknown>;
    if (typeof o['label'] !== 'string') continue;
    out.push({
      label: o['label'],
      ...(typeof o['description'] === 'string' ? { description: o['description'] } : {}),
      ...(typeof o['preview'] === 'string' ? { preview: o['preview'] } : {}),
    });
  }
  return out;
}

/**
 * Flatten a ToolResultBlock's content to plain text — sometimes a plain string,
 * sometimes an array of `{ type, text }` objects (claudeStream.ts). Mirrors the
 * helper in dynamicWorkflowDetector.ts.
 */
function flattenToolResultContent(content: ToolResultBlock['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}
