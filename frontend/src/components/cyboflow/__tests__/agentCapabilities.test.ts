/**
 * The per-runtime capability table + the launch-picker projection built on it.
 *
 * Two things are pinned here. First, EXHAUSTIVENESS: the table must describe
 * every runtime in the union, because a runtime that slipped through would read
 * as `undefined` at a capability lookup and silently disable a control. The
 * compiler enforces this on the Record type; the assertion below also catches a
 * STALE key left behind by a rename, which the type cannot.
 *
 * Second, each flag's value is asserted against the behavior it was derived
 * from, with the evidence named — these values are a transcription of what the
 * UI did before the flags existed, and the transcription is the thing that can
 * be wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_AGENT_RUNTIMES,
  type AgentRuntime,
} from '../../../../../shared/types/agentRuntime';
import {
  RUNTIME_CAPABILITIES,
  isRuntimeSelectableInPickers,
  runtimeSupportsEffort,
  runtimeSupportsFastMode,
  runtimesWithCapability,
} from '../../../../../shared/types/agentCapabilities';
import { launchRuntimeForPickers } from '../agentRuntimeUi';

describe('RUNTIME_CAPABILITIES', () => {
  it('describes exactly the runtimes in the union — no missing, no stale key', () => {
    expect(Object.keys(RUNTIME_CAPABILITIES).sort()).toEqual([...ALL_AGENT_RUNTIMES].sort());
  });

  it('never leaves a flag undefined for a declared runtime', () => {
    for (const runtime of ALL_AGENT_RUNTIMES) {
      const capabilities = RUNTIME_CAPABILITIES[runtime];
      for (const [flag, value] of Object.entries(capabilities)) {
        expect(typeof value, `${runtime}.${flag}`).toBe('boolean');
      }
    }
  });
});

describe('supportsEffort', () => {
  // Evidence: codexPtyManager accepts `reasoningEffort` but never turns it into
  // a CLI flag — there is no turn-options object on the PTY path. Every other
  // launchable runtime carries it (Claude SDK `Options.effort`, interactive
  // `--effort`, codex-sdk via buildCodexAppServerTurnOptions).
  it('is false only for codex-pty among the launchable runtimes', () => {
    expect(runtimeSupportsEffort('claude-sdk')).toBe(true);
    expect(runtimeSupportsEffort('claude-interactive')).toBe(true);
    expect(runtimeSupportsEffort('codex-sdk')).toBe(true);
    expect(runtimeSupportsEffort('codex-pty')).toBe(false);
  });
});

describe('supportsFastMode', () => {
  // Evidence: fast mode is the Opus-only premium opt-in and has no Codex
  // analogue — useQuickSession sends `claudeConfig.fastMode` on the Claude path
  // only, and the wizard gated its toggle on the effective PROVIDER being
  // 'claude', which covers BOTH Claude runtimes (the interactive eager spawn
  // receives it on claudeConfig just as the SDK panel persists it).
  it('is true for both Claude runtimes and false for every Codex runtime', () => {
    expect(runtimesWithCapability('supportsFastMode')).toEqual([
      'claude-sdk',
      'claude-interactive',
    ]);
    expect(runtimeSupportsFastMode('codex-sdk')).toBe(false);
    expect(runtimeSupportsFastMode('codex-pty')).toBe(false);
  });
});

/** The runtimes no picker may offer, and WHY each one is on the list. */
const UNSELECTABLE_RUNTIMES: readonly AgentRuntime[] = ['codex-exec', 'omp-sdk', 'omp-pty'];

describe('selectableInPickers', () => {
  // Two different reasons land a runtime here. codex-exec has no manager and is
  // in neither SESSION_AGENT_RUNTIMES nor WORKFLOW_LAUNCHABLE_RUNTIMES, yet is
  // reachable as a persisted `config.defaultAgentRuntime` — which is why four
  // seeding seams each carried their own `!== 'codex-exec'` test. The two omp-*
  // runtimes ARE session runtimes, declared ahead of their managers; this flag
  // is the single switch that keeps them out of every picker until they ship.
  it('is false for exactly the runtimes that may not be offered', () => {
    expect(runtimesWithCapability('selectableInPickers')).toEqual(
      ALL_AGENT_RUNTIMES.filter((runtime) => !UNSELECTABLE_RUNTIMES.includes(runtime)),
    );
  });

  it('treats an absent runtime as unselectable, like the `!== undefined` pairs it replaced', () => {
    expect(isRuntimeSelectableInPickers(undefined)).toBe(false);
  });
});

describe('effort + fast mode for the OMP runtimes', () => {
  // Evidence: OMP's RPC turn options carry a thinking level, so an effort
  // selection genuinely reaches the structured lane — but the TUI is driven by
  // keystrokes and has no turn-options object, exactly as codex-pty does not.
  // Fast mode is the Opus-only Claude opt-in with no OMP analogue.
  it('gives the structured lane effort and the terminal lane neither', () => {
    expect(runtimeSupportsEffort('omp-sdk')).toBe(true);
    expect(runtimeSupportsEffort('omp-pty')).toBe(false);
    expect(runtimeSupportsFastMode('omp-sdk')).toBe(false);
    expect(runtimeSupportsFastMode('omp-pty')).toBe(false);
  });
});

describe('launchRuntimeForPickers', () => {
  it('passes every offerable runtime through unchanged', () => {
    for (const runtime of ALL_AGENT_RUNTIMES) {
      if (UNSELECTABLE_RUNTIMES.includes(runtime)) continue;
      expect(launchRuntimeForPickers(runtime)).toBe(runtime);
    }
  });

  it('drops an unselectable or absent runtime so the surface falls back to its own default', () => {
    for (const runtime of UNSELECTABLE_RUNTIMES) {
      expect(launchRuntimeForPickers(runtime)).toBeUndefined();
    }
    expect(launchRuntimeForPickers(undefined)).toBeUndefined();
  });

  it('drops a runtime string that is not in the union at all', () => {
    // A hand-edited config.json can hold anything; the seeding seams must not
    // seed a picker with it.
    expect(launchRuntimeForPickers('acme-sdk' as AgentRuntime)).toBeUndefined();
  });
});
