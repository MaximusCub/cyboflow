/**
 * The lane resolver is the contract every chat dispatch seam switches on, so the
 * whole (provider × substrate) matrix is pinned here — including the two cells
 * that were previously unreachable because the seams tested `agent_runtime`
 * alone: an interactive override in a codex-SDK session (used to fall to the
 * CLAUDE PTY) and an sdk override in a codex-PTY session (used to be ignored).
 */
import { describe, expect, it } from 'vitest';
import { isPtyLane, providerForSession, resolvePanelLane, substrateForPanel } from '../panelLane';

describe('resolvePanelLane — inherited panels (no per-panel override)', () => {
  it.each([
    { runtime: 'claude-sdk', substrate: 'sdk', lane: 'claude-sdk' },
    { runtime: 'claude-sdk', substrate: 'interactive', lane: 'claude-interactive' },
    { runtime: 'codex-sdk', substrate: 'sdk', lane: 'codex-sdk' },
    { runtime: 'codex-pty', substrate: 'interactive', lane: 'codex-pty' },
  ] as const)('$runtime + $substrate → $lane', ({ runtime, substrate, lane }) => {
    expect(resolvePanelLane({ agent_runtime: runtime, substrate }, {})).toBe(lane);
  });

  it('keeps a codex-pty session on its terminal even when substrate was never stamped', () => {
    // The resolver floors an absent substrate to 'sdk'; without the codex-pty
    // special case an older row would lose its terminal to the SDK lane.
    expect(resolvePanelLane({ agent_runtime: 'codex-pty' }, {})).toBe('codex-pty');
  });

  it('floors an unknown/absent runtime to the Claude SDK lane', () => {
    expect(resolvePanelLane(undefined, undefined)).toBe('claude-sdk');
    expect(resolvePanelLane({}, {})).toBe('claude-sdk');
  });
});

describe('resolvePanelLane — per-panel overrides stay inside the session provider', () => {
  it('routes an interactive override in a codex-SDK session to the CODEX terminal', () => {
    expect(resolvePanelLane({ agent_runtime: 'codex-sdk', substrate: 'sdk' }, { substrate: 'interactive' })).toBe(
      'codex-pty',
    );
  });

  it('routes an sdk override in a codex-PTY session to the CODEX SDK', () => {
    expect(
      resolvePanelLane({ agent_runtime: 'codex-pty', substrate: 'interactive' }, { substrate: 'sdk' }),
    ).toBe('codex-sdk');
  });

  it('routes overrides on a Claude session to the Claude managers', () => {
    expect(resolvePanelLane({ agent_runtime: 'claude-sdk', substrate: 'sdk' }, { substrate: 'interactive' })).toBe(
      'claude-interactive',
    );
    expect(
      resolvePanelLane({ agent_runtime: 'claude-interactive', substrate: 'interactive' }, { substrate: 'sdk' }),
    ).toBe('claude-sdk');
  });

  it('never lets a panel change the PROVIDER — that axis is session-wide', () => {
    // There is no panel field that could flip this; the assertion documents the
    // invariant the four-lane switch depends on.
    for (const substrate of ['sdk', 'interactive'] as const) {
      expect(resolvePanelLane({ agent_runtime: 'codex-sdk' }, { substrate })).toMatch(/^codex-/);
      expect(resolvePanelLane({ agent_runtime: 'claude-sdk' }, { substrate })).toMatch(/^claude-/);
    }
  });
});

describe('lane helpers', () => {
  it('reads the provider off the runtime prefix', () => {
    expect(providerForSession({ agent_runtime: 'codex-sdk' })).toBe('codex');
    expect(providerForSession({ agent_runtime: 'codex-pty' })).toBe('codex');
    expect(providerForSession({ agent_runtime: 'claude-sdk' })).toBe('claude');
    expect(providerForSession(undefined)).toBe('claude');
  });

  it('ignores the process environment when resolving a panel substrate', () => {
    const previous = process.env.CYBOFLOW_SUBSTRATE;
    process.env.CYBOFLOW_SUBSTRATE = 'interactive';
    try {
      expect(substrateForPanel({ agent_runtime: 'claude-sdk', substrate: 'sdk' }, {})).toBe('sdk');
    } finally {
      if (previous === undefined) delete process.env.CYBOFLOW_SUBSTRATE;
      else process.env.CYBOFLOW_SUBSTRATE = previous;
    }
  });

  it('classifies the two PTY lanes', () => {
    expect(isPtyLane('claude-interactive')).toBe(true);
    expect(isPtyLane('codex-pty')).toBe(true);
    expect(isPtyLane('claude-sdk')).toBe(false);
    expect(isPtyLane('codex-sdk')).toBe(false);
  });
});
