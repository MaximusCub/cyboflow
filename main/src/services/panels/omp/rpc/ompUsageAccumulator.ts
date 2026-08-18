/**
 * ompUsageAccumulator — the per-TURN usage/cost delta for an OMP session.
 *
 * WHY A DELTA AND NOT A ROLLUP. `get_session_stats` reports CUMULATIVE session
 * totals. Stamping that on every turn's result event would be re-summed
 * downstream (`insightsQueries.ts` adds each result's `total_cost_usd`),
 * recording A + (A+B) + (A+B+C) across one warm session — the double-billing
 * hazard the proposal's adversarial review called out (§5.1). So the turn's
 * numbers come only from the per-assistant-message `usage` blocks that arrived
 * WITHIN that turn, and the accumulator is reset at each turn boundary.
 *
 * WHY `message_end` ONLY. The identical `usage` object rides message_start,
 * every message_update delta, message_end, turn_end AND agent_end — the probe
 * capture shows the same block seven times for a single assistant message.
 * Accumulating on each sighting would multiply the turn's cost by that count, so
 * `message_end` is the single accrual point, with `responseId` de-duplication as
 * a second guard for any path that repeats one.
 *
 * TOKEN MAPPING. OMP's `input`/`output`/`cacheRead`/`cacheWrite` are DISJOINT
 * (probe: 3 + 4 + 0 + 23316 === totalTokens 23323), so unlike the Codex
 * accumulator — whose `inputTokens` is inclusive of its cached count and must be
 * subtracted — these map straight onto `AgentUsage`.
 */
import type { AgentUsage } from '../../../../../../shared/types/agentStream';
import type { OmpAssistantMessage, OmpUsage } from './ompContract';

export class OmpTurnUsageAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private costUsdTotal = 0;
  private messageCount = 0;
  private readonly seenResponseIds = new Set<string>();

  /**
   * Accrue one assistant message's usage. `responseId`, when present, makes the
   * call idempotent so a repeated `message_end` cannot double-count.
   */
  addMessageUsage(usage: OmpUsage | undefined, responseId?: string): void {
    if (!usage) return;
    if (responseId !== undefined && responseId.length > 0) {
      if (this.seenResponseIds.has(responseId)) return;
      this.seenResponseIds.add(responseId);
    }
    this.inputTokens += usage.input;
    this.outputTokens += usage.output;
    this.cacheReadTokens += usage.cacheRead;
    this.cacheWriteTokens += usage.cacheWrite;
    this.costUsdTotal += usage.cost?.total ?? 0;
    this.messageCount += 1;
  }

  /** Convenience for the projector: accrue straight from an assistant message. */
  addAssistantMessage(message: OmpAssistantMessage): void {
    this.addMessageUsage(message.usage, message.responseId);
  }

  /** The turn's token delta, or `undefined` when no usage was ever reported. */
  snapshot(): AgentUsage | undefined {
    if (this.messageCount === 0) return undefined;
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cache_read_input_tokens: this.cacheReadTokens,
      cache_creation_input_tokens: this.cacheWriteTokens,
    };
  }

  /**
   * The turn's cost delta in USD — the sum of each message's `usage.cost.total`,
   * stored verbatim per the run-cost source-of-truth rule. `undefined` when no
   * message carried a cost breakdown, so a missing cost is never recorded as $0.
   */
  costUsd(): number | undefined {
    return this.messageCount === 0 ? undefined : this.costUsdTotal;
  }

  /** Assistant messages accrued so far this turn. */
  get accruedMessages(): number {
    return this.messageCount;
  }

  /** Clear at a turn boundary. The accumulator is per-turn, never per-session. */
  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.costUsdTotal = 0;
    this.messageCount = 0;
    this.seenResponseIds.clear();
  }
}
