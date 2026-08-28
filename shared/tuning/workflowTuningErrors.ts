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
import type { RuntimeMix } from './runtimeMix';

/** Machine-readable prefix embedded in every {@link TuningOverrideError} message. */
export const TUNING_OVERRIDE_CODE = 'TUNING_OVERRIDE_REJECTED';

/**
 * Why an override was refused.
 *
 *   `variant_conflict`   — the launch ALSO pins an A/B variant belonging to a
 *                          DIFFERENT tuning level. Migration 126 scoped variants
 *                          to a level, so an override plus a variant of the
 *                          SAME level is coherent (the level picks the pool, the
 *                          pin picks inside it) and is allowed; only a foreign-level
 *                          pin is refused, because the variant's frozen graph would
 *                          win and silently run a configuration the requested level
 *                          does not describe. A bare `variantSpecJson` with no
 *                          variant id carries no level to compare and is refused
 *                          on the same grounds.
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
        `a per-run tuning level ('${String(level)}') cannot be combined with an A/B variant pinned to a different level — ` +
          "a variant runs its own frozen definition, so pin one of that level's variants or drop the level override",
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

// ─── The runtime-mix sibling (migration 128 / runtime-mix plan D3) ───────────

/**
 * Machine-readable prefix embedded in every {@link RuntimeMixOverrideError}
 * message — see the module doc above for why the code lives in the MESSAGE.
 */
export const RUNTIME_MIX_OVERRIDE_CODE = 'RUNTIME_MIX_OVERRIDE_REJECTED';

/**
 * Why a per-run runtime-mix override was refused.
 *
 *   `variant_conflict` — the launch ALSO pins an A/B variant. A variant carries
 *                        its own frozen graph and its runs stamp a NULL mix
 *                        (plan D5), so a mix asked for alongside one could not
 *                        be honoured OR recorded. Unlike the tuning level there
 *                        is no containment model to fall back on: variants are
 *                        scoped to a LEVEL (migration 126), never to a mix.
 *   `not_built_in`     — a "save as new" flow has no role-class table, so there
 *                        is nothing to split into execution vs. verification;
 *                        it is outside the mix system entirely (runs stamp NULL).
 *   `invalid_mix`      — the value is not a `RuntimeMix` at all.
 */
export type RuntimeMixOverrideRejection = 'variant_conflict' | 'not_built_in' | 'invalid_mix';

export class RuntimeMixOverrideError extends Error {
  readonly code = RUNTIME_MIX_OVERRIDE_CODE;

  constructor(
    readonly reason: RuntimeMixOverrideRejection,
    detail: string,
  ) {
    super(`[${RUNTIME_MIX_OVERRIDE_CODE}:${reason}] ${detail}`);
    this.name = 'RuntimeMixOverrideError';
  }
}

/** Matches an error that crossed the tRPC boundary as a {@link RuntimeMixOverrideError}. */
export function isRuntimeMixOverrideError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(RUNTIME_MIX_OVERRIDE_CODE);
}

/** The three rejections, spelled as the messages the chokepoint throws. */
export function runtimeMixOverrideRejection(
  reason: RuntimeMixOverrideRejection,
  mix: RuntimeMix | string,
  workflowName: string,
): RuntimeMixOverrideError {
  switch (reason) {
    case 'variant_conflict':
      return new RuntimeMixOverrideError(
        reason,
        `a per-run runtime mix ('${String(mix)}') cannot be combined with an A/B variant — ` +
          'a variant runs its own frozen definition and its runs are mix-unattributed, ' +
          'so drop one of the two',
      );
    case 'not_built_in':
      return new RuntimeMixOverrideError(
        reason,
        `workflow '${workflowName}' is not a built-in flow, so it has no execution/verification split to route`,
      );
    case 'invalid_mix':
      return new RuntimeMixOverrideError(reason, `invalid runtime mix '${String(mix)}'`);
  }
}
