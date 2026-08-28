import { describe, it, expect } from 'vitest';
import {
  SESSION_ALLOWED_TRANSITIONS,
  SESSION_STATUSES,
  isSessionStatus,
  isSessionTransitionAllowed,
  IllegalSessionTransitionError,
  type SessionStatus,
} from '../sessionStateMachine';

const ALL: readonly SessionStatus[] = ['pending', 'running', 'stopped', 'completed', 'failed'];

describe('SESSION_ALLOWED_TRANSITIONS shape', () => {
  it('covers exactly the five DB statuses', () => {
    expect(Object.keys(SESSION_ALLOWED_TRANSITIONS).sort()).toEqual([...ALL].sort());
    expect([...SESSION_STATUSES].sort()).toEqual([...ALL].sort());
  });

  it('is TOTAL — every ordered pair is legal, self-edges included', () => {
    // Deliberate, and evidenced: see the module doc comment. A session has no
    // terminal state; every resting status is woken to `running` by a follow-up
    // turn, re-initialized to `pending` by continue-conversation, and restorable
    // from `running` by the two spawn-failure revert paths. If this ever
    // narrows it must be because a caller was removed, not because the graph
    // looked too permissive.
    for (const from of ALL) {
      for (const to of ALL) {
        expect(isSessionTransitionAllowed(from, to), `${from} -> ${to}`).toBe(true);
      }
    }
  });

  it('names the three caller families that make it total', () => {
    // The wake edge every `{ status: 'running' }` writer performs.
    for (const from of ['pending', 'stopped', 'completed', 'failed'] as const) {
      expect(isSessionTransitionAllowed(from, 'running')).toBe(true);
    }
    // The re-init edge (`'initializing'` -> `pending`) from any resting status.
    for (const from of ['running', 'stopped', 'completed', 'failed'] as const) {
      expect(isSessionTransitionAllowed(from, 'pending')).toBe(true);
    }
    // The revert edge: whatever a session was, `running` restores to it.
    for (const to of ALL) {
      expect(isSessionTransitionAllowed('running', to)).toBe(true);
    }
  });
});

describe('vocabulary enforcement (what this table is actually for)', () => {
  it('rejects a status outside the union at EITHER end', () => {
    // `sessions.status` has no CHECK constraint and at least one seam types the
    // field as a bare string, so this is the only thing standing between a typo
    // and a session that vanishes from every status-filtered query.
    expect(isSessionTransitionAllowed('running', 'in_progress')).toBe(false);
    expect(isSessionTransitionAllowed('waiting', 'running')).toBe(false);
    expect(isSessionTransitionAllowed('running', '')).toBe(false);
  });

  it('rejects the RICHER app-level statuses that never reach the funnel un-mapped', () => {
    // SessionManager.mapSessionStatusToDbStatus collapses these first; seeing one
    // here means the mapping was bypassed.
    for (const appOnly of ['initializing', 'ready', 'waiting', 'completed_unviewed', 'error']) {
      expect(isSessionStatus(appOnly), appOnly).toBe(false);
    }
  });

  it('rejects non-string values without throwing', () => {
    for (const bad of [undefined, null, 0, {}, ['running']]) {
      expect(isSessionStatus(bad)).toBe(false);
      expect(isSessionTransitionAllowed(bad, 'running')).toBe(false);
    }
  });

  it('accepts every member of the union', () => {
    for (const status of ALL) expect(isSessionStatus(status)).toBe(true);
  });
});

describe('IllegalSessionTransitionError', () => {
  it('carries from/to/sessionId and names them in the message', () => {
    const err = new IllegalSessionTransitionError('running', 'in_progress', 'sess-1');
    expect(err.name).toBe('IllegalSessionTransitionError');
    expect(err.from).toBe('running');
    expect(err.to).toBe('in_progress');
    expect(err.sessionId).toBe('sess-1');
    expect(err.message).toContain('running -> in_progress');
    expect(err.message).toContain('sess-1');
  });

  it('omits the sessionId suffix when none is supplied', () => {
    expect(new IllegalSessionTransitionError('running', 'nope').message).not.toContain('sessionId');
  });
});
