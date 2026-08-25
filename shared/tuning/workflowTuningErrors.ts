/**
 * Typed errors for the PER-RUN tuning-level override (plan D4).
 *
 * The override is an explicit "run this flow at THIS level, once" choice made at
 * the launch wizard and threaded `runs.start` -> `RunLauncher.launch` ->
 * `WorkflowRegistry.createRun`, which is the chokepoint that validates it. Every
 * rejection below is a USER-REACHABLE input error, not a crash: the wizard
 * disables the offending combination client-side, and these are the server half
 * of the same rules for a stale payload, an MCP caller, or a scripted launch.
 *
 * Message-prefix convention mirrors `../types/executionModelErrors`: a plain
 * `Error` thrown out of a tRPC procedure is rewrapped into a fresh `TRPCError`
 * whose `code` is INTERNAL_SERVER_ERROR — the constructor/name/`.code` do NOT
 * survive that rewrap, only the MESSAGE does. So the machine code is embedded in
 * the message text and {@link isTuningOverrideError} matches on it, while the
 * class + `.reason` stay available to same-process callers (and to a future
 * router-side catch that wants a real 400).
 */
import type { TuningLevel } from './workflowTuning';

/** Machine-readable prefix embedded in every {@link TuningOverrideError} message. */
export const TUNING_OVERRIDE_CODE = 'TUNING_OVERRIDE_REJECTED';

/**
 * Why an override was refused.
 *
 *   `variant_conflict`   — the launch ALSO pins an A/B variant. A variant carries
 *                          its own frozen graph, so the two are competing spec
 *                          choices; the wizard makes them mutually exclusive and
 *                          this is the server-side half of that rule.
 *   `not_built_in`       — a "save as new" flow has no built-in baseline for a
 *                          preset to transform, so it is outside the level system
 *                          entirely (its runs stamp NULL).
 *   `empty_custom_slot`  — overriding to `'custom'` needs a definition in the
 *                          flow's slot; without one the run would materialize an
 *                          unresolvable spec.
 *   `invalid_level`      — the value is not a `TuningLevel` at all.
 */
export type TuningOverrideRejection =
  | 'variant_conflict'
  | 'not_built_in'
  | 'empty_custom_slot'
  | 'invalid_level';

export class TuningOverrideError extends Error {
  readonly code = TUNING_OVERRIDE_CODE;

  constructor(
    readonly reason: TuningOverrideRejection,
    detail: string,
  ) {
    super(`[${TUNING_OVERRIDE_CODE}:${reason}] ${detail}`);
    this.name = 'TuningOverrideError';
  }
}

/** Matches an error that crossed the tRPC boundary as a {@link TuningOverrideError}. */
export function isTuningOverrideError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(TUNING_OVERRIDE_CODE);
}

/** The four rejections, spelled as the messages the chokepoint throws. */
export function tuningOverrideRejection(
  reason: TuningOverrideRejection,
  level: TuningLevel | string,
  workflowName: string,
): TuningOverrideError {
  switch (reason) {
    case 'variant_conflict':
      return new TuningOverrideError(
        reason,
        `a per-run tuning level ('${String(level)}') cannot be combined with an explicit A/B variant pin — ` +
          'a variant runs its own frozen definition, so pick one or the other',
      );
    case 'not_built_in':
      return new TuningOverrideError(
        reason,
        `workflow '${workflowName}' is not a built-in flow, so it has no tuning baseline to override`,
      );
    case 'empty_custom_slot':
      return new TuningOverrideError(
        reason,
        `workflow '${workflowName}' has an empty custom slot; save a definition from the advanced editor before running it at 'custom'`,
      );
    case 'invalid_level':
      return new TuningOverrideError(reason, `invalid tuning level '${String(level)}'`);
  }
}
