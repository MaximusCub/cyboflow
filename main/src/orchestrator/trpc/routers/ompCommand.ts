/**
 * cyboflow.ompCommand sub-router — the privileged OMP command surface.
 *
 * Every mutation is gated on `hasSupervise(ctx.principal)` (an immutable
 * capability, NOT merely `ctx.userId === 'local'`) and is audited twice —
 * ATTEMPTED before delegation, COMPLETED after — with input/result redacted.
 *
 * Audit is FAIL-CLOSED: an authorized OR unauthorized attempt with an audit
 * sink present always records a terminal outcome, including `forbidden` and
 * thrown adapter failures. A missing audit sink is refused (a privileged
 * mutation without an audit trail is never allowed).
 *
 * In Phase 2 the injected `OmpCommandAdapter` is a stub that fails closed with
 * `unavailable`, so no real command can run even though the router, its
 * authorization, and its audit trail are all live and tested.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*.
 */
import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { hasSupervise, OMP_SUPERVISE_CAPABILITY } from '../../../../../shared/types/ompCommand';
import type {
  OmpApplyRequest,
  OmpCommandAdapter,
  OmpCommandResult,
  OmpDiscardRequest,
  OmpKillRequest,
  OmpPrincipal,
  OmpSpawnRequest,
  OmpVerifyRequest,
} from '../../../../../shared/types/ompCommand';

/** Audit entry shape — narrow and string-only, trivially redactable and serializable. */
export interface OmpAuditEntry {
  verb: string;
  principal: string;
  outcome: 'attempted' | 'completed';
  operationId: string;
  /** Redacted detail: never raw task text, scope paths, or proof blobs. */
  detail: string;
}

type OmpAuditSink = (entry: OmpAuditEntry) => void;

/** Redact command input to a stable, non-sensitive summary. */
function redactInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'object') {
    return Object.keys(input as Record<string, unknown>).join(',');
  }
  return String(input);
}

interface OmpCommandCtx {
  principal?: OmpPrincipal;
  ompCommand?: OmpCommandAdapter;
  auditOmp?: OmpAuditSink;
}

/**
 * Authorize, audit, and dispatch one command. Every attempt — authorized or
 * not, adapter present or not — records a redacted terminal outcome when an
 * audit sink is configured; otherwise the command is refused outright.
 */
async function runGuarded<TReq>(
  ctx: OmpCommandCtx,
  verb: string,
  input: TReq,
  invoke: (adapter: OmpCommandAdapter, req: TReq) => Promise<OmpCommandResult>,
): Promise<OmpCommandResult> {
  // A privileged mutation without an audit trail is refused, not allowed.
  if (!ctx.auditOmp) {
    return {
      ok: false,
      operationId: 'n/a',
      error: 'unavailable',
      detail: 'OMP audit sink not configured',
    };
  }

  const operationId = randomUUID();
  const principal = ctx.principal?.userId ?? 'unknown';
  ctx.auditOmp({ verb, principal, outcome: 'attempted', operationId, detail: redactInput(input) });

  if (!hasSupervise(ctx.principal)) {
    // Unauthorized attempts are the most security-relevant: record them before
    // failing closed, never silently.
    ctx.auditOmp({ verb, principal, outcome: 'completed', operationId, detail: 'forbidden' });
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `missing capability ${OMP_SUPERVISE_CAPABILITY}`,
    });
  }

  let result: OmpCommandResult;
  if (!ctx.ompCommand) {
    result = {
      ok: false,
      operationId,
      error: 'unavailable',
      detail: 'OMP command adapter not configured',
    };
  } else {
    try {
      result = await invoke(ctx.ompCommand, input);
    } catch (error) {
      result = {
        ok: false,
        operationId,
        error: 'unavailable',
        detail: error instanceof Error ? error.message : 'OMP command failed',
      };
    }
  }

  // Terminal outcome always recorded, redacted: never raw result.detail (a
  // future real adapter may echo task text or proof bytes).
  ctx.auditOmp({
    verb,
    principal,
    outcome: 'completed',
    operationId,
    detail: result.ok ? 'ok' : result.error,
  });
  return result;
}

export const ompCommandRouter = router({
  spawn: protectedProcedure
    .input(z.object({ model: z.string(), task: z.string(), label: z.string().optional(), cwd: z.string().optional(), timeoutMs: z.number().optional() }))
    .mutation(({ ctx, input }) => runGuarded<OmpSpawnRequest>(ctx, 'spawn', input, (a, req) => a.spawn(req))),
  kill: protectedProcedure
    .input(z.object({ workerId: z.string(), timeoutMs: z.number().optional() }))
    .mutation(({ ctx, input }) => runGuarded<OmpKillRequest>(ctx, 'kill', input, (a, req) => a.kill(req))),
  applyProposal: protectedProcedure
    .input(z.object({ proposalId: z.string(), reason: z.string() }))
    .mutation(({ ctx, input }) => runGuarded<OmpApplyRequest>(ctx, 'apply', input, (a, req) => a.apply(req))),
  discard: protectedProcedure
    .input(z.object({ proposalId: z.string(), reason: z.string() }))
    .mutation(({ ctx, input }) => runGuarded<OmpDiscardRequest>(ctx, 'discard', input, (a, req) => a.discard(req))),
  verifyRun: protectedProcedure
    .input(z.object({ proposalId: z.string() }))
    .mutation(({ ctx, input }) => runGuarded<OmpVerifyRequest>(ctx, 'verifyRun', input, (a, req) => a.verifyRun(req))),
});
