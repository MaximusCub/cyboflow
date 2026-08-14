/**
 * Stub implementation of `OmpCommandAdapter` — Phase 2 of the OMP plan.
 *
 * Every method fails closed with `unavailable`, echoing the request's
 * `operationId` verbatim so the audit trail and the returned result correlate
 * on one token. Real implementations are a separate ADR (Phase 3).
 */
import type {
  OmpApplyRequest,
  OmpCommandAdapter,
  OmpCommandResult,
  OmpDiscardRequest,
  OmpKillRequest,
  OmpSpawnRequest,
  OmpVerifyRequest,
} from '../../../../shared/types/ompCommand';

export class OmpCommandStub implements OmpCommandAdapter {
  readonly authority = 'supervise' as const;

  private unavailable(verb: string, operationId: string): OmpCommandResult {
    return {
      ok: false,
      operationId,
      error: 'unavailable',
      detail: `omp:${verb} not implemented (Phase 3 ADR)`,
    };
  }

  spawn(req: OmpSpawnRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('spawn', req.operationId));
  }

  kill(req: OmpKillRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('kill', req.operationId));
  }

  apply(req: OmpApplyRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('apply', req.operationId));
  }

  discard(req: OmpDiscardRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('discard', req.operationId));
  }

  verifyRun(req: OmpVerifyRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('verifyRun', req.operationId));
  }
}
