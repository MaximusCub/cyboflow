/**
 * Stub implementation of `OmpCommandAdapter` — Phase 2 of the OMP plan.
 *
 * Every method fails closed with `unavailable` and a synthetic operationId, so
 * the command ROUTER and its authorization/audit path can ship and be tested
 * before any real command exists. Real implementations are a separate ADR
 * (Phase 3) with its own go/no-go.
 */
import { randomUUID } from 'node:crypto';
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

  private unavailable(verb: string): OmpCommandResult {
    return {
      ok: false,
      operationId: randomUUID(),
      error: 'unavailable',
      detail: `omp:${verb} not implemented (Phase 3 ADR)`,
    };
  }

  spawn(_req: OmpSpawnRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('spawn'));
  }

  kill(_req: OmpKillRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('kill'));
  }

  apply(_req: OmpApplyRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('apply'));
  }

  discard(_req: OmpDiscardRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('discard'));
  }

  verifyRun(_req: OmpVerifyRequest): Promise<OmpCommandResult> {
    return Promise.resolve(this.unavailable('verifyRun'));
  }
}
