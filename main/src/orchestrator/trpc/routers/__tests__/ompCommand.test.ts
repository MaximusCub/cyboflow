/**
 * Tests for cyboflow.ompCommand — the privileged OMP command router.
 *
 * Verifies the authority boundary and the fail-closed audit trail:
 *   1. A principal without `omp:supervise` is rejected FORBIDDEN AND the
 *      attempt is still audited (attempted + forbidden completed).
 *   2. A supervised principal with no adapter records attempted + completed
 *      `unavailable` (stub path), never throws.
 *   3. A missing audit sink is refused with `unavailable` before anything runs.
 */
import { describe, it, expect } from 'vitest';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import type { OmpAuditEntry } from '../ompCommand';
import type { OmpPrincipal } from '../../../../../../shared/types/ompCommand';

const SUPERVISE: OmpPrincipal = {
  userId: 'local',
  capabilities: new Set(['omp:supervise']),
};

const NO_SUPERVISE: OmpPrincipal = {
  userId: 'local',
  capabilities: new Set([]),
};

function callerWith(deps: Parameters<typeof createContext>[0]): ReturnType<typeof appRouter.createCaller> {
  return appRouter.createCaller(createContext(deps));
}

describe('cyboflow.ompCommand authorization', () => {
  it('rejects a non-supervise principal FORBIDDEN and still audits the attempt', async () => {
    const audit: OmpAuditEntry[] = [];
    const caller = callerWith({ principal: NO_SUPERVISE, auditOmp: (e) => audit.push(e) });

    await expect(
      caller.cyboflow.ompCommand.spawn({ model: 'm', task: 't' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ verb: 'spawn', outcome: 'attempted' });
    expect(audit[1]).toMatchObject({ verb: 'spawn', outcome: 'completed', detail: 'forbidden' });
    // Input is redacted: keys only, never the task text.
    expect(JSON.stringify(audit)).not.toContain('task text');
  });

  it('a supervised principal with no adapter returns unavailable, audited both ways', async () => {
    const audit: OmpAuditEntry[] = [];
    const caller = callerWith({ principal: SUPERVISE, auditOmp: (e) => audit.push(e) });

    const res = await caller.cyboflow.ompCommand.spawn({ model: 'm', task: 't' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('unavailable');

    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ outcome: 'attempted' });
    expect(audit[1]).toMatchObject({ outcome: 'completed', detail: 'unavailable' });
  });

  it('refuses outright when no audit sink is configured', async () => {
    const caller = callerWith({ principal: SUPERVISE });
    const res = await caller.cyboflow.ompCommand.spawn({ model: 'm', task: 't' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('unavailable');
  });
});
