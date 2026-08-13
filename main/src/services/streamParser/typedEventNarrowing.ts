/**
 * TypedEventNarrowing — Stage 3 of the streamParser pipeline.
 *
 * Validates each parsed JSON object against the Zod schema and narrows it to
 * the appropriate ClaudeStreamEvent variant. Unknown discriminants fall through
 * to the { kind: '__unknown__', raw } catch-all — never throws, never drops.
 */

import { claudeStreamEventSchemaByType } from './schemas';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { ILogger } from './types';

/** The `type` values that have a schema branch. */
type KnownEventType = keyof typeof claudeStreamEventSchemaByType;

export class TypedEventNarrowing {
  private readonly logger: Pick<ILogger, 'verbose'> | undefined;

  constructor(logger?: Pick<ILogger, 'verbose'>) {
    this.logger = logger;
  }

  /**
   * Narrow a parsed JSON value to a typed ClaudeStreamEvent.
   *
   * Dispatches on the top-level `type` discriminant via
   * `claudeStreamEventSchemaByType` and `safeParse`s that ONE branch. On
   * success, returns the validated, narrowed event. On failure (unknown
   * variant, missing field, bad type), returns `{ kind: '__unknown__', raw }`.
   *
   * Equivalent to parsing the full `claudeStreamEventSchema` union, because
   * every branch pins a distinct `type` literal — but without constructing a
   * ZodError for each non-matching branch, which profiling showed dominated
   * main-process CPU while runs were streaming (see the map's header comment).
   *
   * Contract: NEVER throws. NEVER drops (unknown events become the catch-all
   * variant, not null).
   */
  narrow(parsed: unknown): ClaudeStreamEvent {
    const rawObj =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const rawType = rawObj['type'];
    const wireType = typeof rawType === 'string' ? rawType : undefined;

    if (wireType !== undefined && wireType in claudeStreamEventSchemaByType) {
      const branch = claudeStreamEventSchemaByType[wireType as KnownEventType];
      const result = branch.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
    }

    // Log at debug/verbose level — informative but not noisy.
    this.logger?.verbose?.(
      `[streamParser] unknown ClaudeStreamEvent variant type=${wireType ?? '<missing>'}`,
    );

    return { kind: '__unknown__', raw: rawObj };
  }
}
