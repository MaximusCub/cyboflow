/**
 * Pure-function coverage for the provider-access helpers in
 * shared/types/agentRuntime.ts — the single source both the renderer's pickers
 * and the main-side launch seams read through.
 *
 * The invariants worth locking:
 *   - ABSENT ⇒ enabled (so an install that never touched the toggles behaves
 *     exactly as it did before the feature existed).
 *   - The all-off map degrades to both-on rather than bricking every seam.
 *   - The IPC validator accepts only `{claude?: boolean, codex?: boolean}` —
 *     an unknown provider key or a non-boolean member is rejected outright.
 */
import { describe, it, expect } from 'vitest';
import {
  enabledAgentProviders,
  firstEnabledRuntime,
  isAgentProviderAccess,
  isAgentProviderEnabled,
  isRuntimeProviderEnabled,
  providerForRuntime,
  resolveAgentProviderAccess,
} from '../../../../shared/types/agentRuntime';

describe('isAgentProviderEnabled', () => {
  it('floors an absent map and an absent member to enabled', () => {
    expect(isAgentProviderEnabled(undefined, 'claude')).toBe(true);
    expect(isAgentProviderEnabled({}, 'codex')).toBe(true);
    expect(isAgentProviderEnabled({ claude: false }, 'codex')).toBe(true);
  });

  it('honours an explicit false', () => {
    expect(isAgentProviderEnabled({ claude: false }, 'claude')).toBe(false);
  });
});

describe('providerForRuntime / isRuntimeProviderEnabled', () => {
  it('maps every runtime to its owning provider', () => {
    expect(providerForRuntime('claude-sdk')).toBe('claude');
    expect(providerForRuntime('claude-interactive')).toBe('claude');
    expect(providerForRuntime('codex-sdk')).toBe('codex');
    expect(providerForRuntime('codex-pty')).toBe('codex');
    expect(providerForRuntime('codex-exec')).toBe('codex');
  });

  it('gates a runtime on its provider', () => {
    const access = { claude: true, codex: false };
    expect(isRuntimeProviderEnabled(access, 'claude-interactive')).toBe(true);
    expect(isRuntimeProviderEnabled(access, 'codex-pty')).toBe(false);
  });
});

describe('enabledAgentProviders', () => {
  it('lists both by default and drops the switched-off one', () => {
    expect(enabledAgentProviders(undefined)).toEqual(['claude', 'codex']);
    expect(enabledAgentProviders({ claude: false, codex: true })).toEqual(['codex']);
  });
});

describe('resolveAgentProviderAccess', () => {
  it('materializes both members from an absent or partial map', () => {
    expect(resolveAgentProviderAccess(undefined)).toEqual({ claude: true, codex: true });
    expect(resolveAgentProviderAccess({ codex: false })).toEqual({ claude: true, codex: false });
  });

  it('degrades an all-off map to both-on', () => {
    expect(resolveAgentProviderAccess({ claude: false, codex: false })).toEqual({
      claude: true,
      codex: true,
    });
  });
});

describe('isAgentProviderAccess (IPC validator)', () => {
  it('accepts an empty, partial, or full boolean map', () => {
    expect(isAgentProviderAccess({})).toBe(true);
    expect(isAgentProviderAccess({ codex: false })).toBe(true);
    expect(isAgentProviderAccess({ claude: true, codex: false })).toBe(true);
  });

  it('rejects non-objects, arrays, unknown providers, and non-boolean members', () => {
    expect(isAgentProviderAccess(null)).toBe(false);
    expect(isAgentProviderAccess('claude')).toBe(false);
    expect(isAgentProviderAccess(['claude'])).toBe(false);
    expect(isAgentProviderAccess({ gemini: true })).toBe(false);
    expect(isAgentProviderAccess({ claude: 'yes' })).toBe(false);
  });
});

describe('firstEnabledRuntime', () => {
  it('returns the first candidate on an enabled provider', () => {
    expect(
      firstEnabledRuntime({ claude: false, codex: true }, ['claude-sdk', 'codex-sdk'] as const),
    ).toBe('codex-sdk');
  });

  it('returns null when no candidate is available', () => {
    expect(firstEnabledRuntime({ claude: false, codex: true }, ['claude-sdk'] as const)).toBeNull();
  });
});
