/**
 * Typed error for the mixed-provider / orchestrated guard (Phase 2 slice D1).
 *
 * A workflow agent config can pin a single agent onto Codex
 * (`WorkflowAgentConfig.runtime === 'codex-sdk'` in `./workflows.ts`), but that
 * per-agent override is only honored by the PROGRAMMATIC step runner, which
 * spawns each step as its own CLI process. An ORCHESTRATED run is a single
 * agent process for the whole DAG, so a per-step Codex override would be
 * SILENTLY IGNORED there. `WorkflowRegistry.createRun` throws this error
 * before any `workflow_runs` row is inserted whenever it detects that shape,
 * so a later slice's UI can catch it and prompt "switch to programmatic?"
 * instead of launching a run that quietly ignores part of its own config.
 *
 * Not thrown for a whole-run Codex request (the run's base `agentProvider`
 * resolves to `'codex'`) — every step already targets the same provider there,
 * so there is nothing "mixed" about it.
 *
 * tRPC boundary note: as of this slice, `trpc/routers/runs.ts` does not catch
 * and remap `createRun` errors the way `trpc/routers/agents.ts`'s
 * `rethrowAsTRPCError` does for `AgentOverrideError` (see
 * `agents/agentValidation.ts`). A plain `Error` thrown out of a tRPC
 * procedure is rewrapped by tRPC's default `getTRPCErrorFromUnknown` into a
 * fresh `TRPCError` with `code: 'INTERNAL_SERVER_ERROR'` — the original
 * error's constructor/name/`.code` field does NOT survive that rewrap (it
 * only remains reachable server-side as `TRPCError.cause`), but the
 * `TRPCError` constructor defaults `message` to `cause.message`, so the
 * MESSAGE text is preserved verbatim to the renderer. That makes a message
 * substring the only mechanism reliable across the tRPC boundary today, which
 * is why {@link MIXED_PROVIDER_ORCHESTRATED_CODE} is embedded directly in the
 * default message below rather than relied on only as `.code`. A later slice
 * that wants a real `TRPCError.code` (so the renderer can branch on
 * `error.data.code` instead of a substring) should add a router-side catch
 * mirroring `rethrowAsTRPCError`.
 */
export const MIXED_PROVIDER_ORCHESTRATED_CODE = 'MIXED_PROVIDER_REQUIRES_PROGRAMMATIC';

export class MixedProviderOrchestratedError extends Error {
  readonly code = MIXED_PROVIDER_ORCHESTRATED_CODE;

  constructor(message?: string) {
    super(
      message ??
        `[${MIXED_PROVIDER_ORCHESTRATED_CODE}] This workflow runs one or more steps on Codex, which requires programmatic execution. Orchestrated runs cannot mix providers.`,
    );
    this.name = 'MixedProviderOrchestratedError';
  }
}

/**
 * Matches an error that crossed the tRPC boundary as a
 * {@link MixedProviderOrchestratedError} — see the doc comment above for why a
 * message substring (rather than `instanceof` or `.code`) is the only
 * mechanism reliable across the rewrap. A caller (e.g. the launch wizard) uses
 * this to detect the specific "needs programmatic" failure and offer to retry
 * the same launch with `executionModel: 'programmatic'`, instead of surfacing
 * a raw error.
 */
export function isMixedProviderOrchestratedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(MIXED_PROVIDER_ORCHESTRATED_CODE);
}

/**
 * The sibling guard for a WHOLE-RUN provider that has no orchestrated contract
 * at all.
 *
 * {@link MixedProviderOrchestratedError} above is about a MIX: the run's base
 * provider is Claude and a per-agent pin points somewhere else. A whole-run
 * non-Claude request is deliberately exempt from it — every step targets the
 * same provider, so nothing is mixed. That exemption is right for Codex, which
 * has the orchestrated pieces (prompt envelope, question bridge), and wrong for
 * a provider that only ever shipped the programmatic lane: the run would launch
 * a main orchestrator outside the contract that exists for it.
 *
 * Which providers those are is a capability question, not a name — see
 * `main/src/orchestrator/providerExecutionSupport.ts`.
 *
 * DISTINCT from the mixed-provider code on purpose. The launch wizard's
 * mixed-provider prompt renders HARDCODED copy ("This flow runs one or more
 * steps on Codex…"), which would be actively misleading here, so this error is
 * left to surface through the ordinary `setLaunchError` path where its own
 * message is shown verbatim. It carries the same machine prefix convention so a
 * later surface can branch on it — see the tRPC boundary note above for why the
 * code lives in the MESSAGE rather than only on `.code`.
 */
export const PROVIDER_ORCHESTRATED_UNSUPPORTED_CODE = 'PROVIDER_REQUIRES_PROGRAMMATIC';

export class ProviderOrchestratedUnsupportedError extends Error {
  readonly code = PROVIDER_ORCHESTRATED_UNSUPPORTED_CODE;

  constructor(
    /** The provider label as a user reads it (e.g. 'OMP'). */
    readonly providerLabel: string,
  ) {
    super(
      `[${PROVIDER_ORCHESTRATED_UNSUPPORTED_CODE}] ${providerLabel} workflow runs are ` +
        'programmatic-only in this build — switch the run/variant to programmatic execution.',
    );
    this.name = 'ProviderOrchestratedUnsupportedError';
  }
}

/** {@link isMixedProviderOrchestratedError} for the whole-run guard. */
export function isProviderOrchestratedUnsupportedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(PROVIDER_ORCHESTRATED_UNSUPPORTED_CODE);
}
