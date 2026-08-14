/**
 * Contract pins for the provider-aware reasoning-effort vocabulary (IDEA-029).
 *
 * The two providers expose DIFFERENT effort scales, and a stale cross-provider
 * value must be dropped rather than forwarded to a spawn that would reject it —
 * the same silent-corruption class as `normalizeAgentModelSelection`. Pin the
 * scales and the normalize behaviour so a regression fails the build.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_EFFORT_LEVELS,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  OMP_EFFORT_LEVELS,
  effortLevelsForProvider,
  isValidEffortForProvider,
  normalizeEffortSelection,
} from '../../../shared/types/reasoningEffort';
import { AGENT_PROVIDERS } from '../../../shared/types/agentRuntime';

describe('reasoningEffort vocabulary', () => {
  it('exposes the documented per-provider scales', () => {
    expect([...CLAUDE_EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect([...CODEX_EFFORT_LEVELS]).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    expect([...OMP_EFFORT_LEVELS]).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('keys the picker option list to the provider', () => {
    expect(effortLevelsForProvider('claude')).toBe(CLAUDE_EFFORT_LEVELS);
    expect(effortLevelsForProvider('codex')).toBe(CODEX_EFFORT_LEVELS);
    expect(effortLevelsForProvider('omp')).toBe(OMP_EFFORT_LEVELS);
  });

  // The wire schema (`z.enum(ALL_EFFORT_LEVELS)`) is provider-agnostic, so it has
  // to accept the union — a value it rejected could never reach the
  // provider-specific normalization that is supposed to arbitrate it.
  it('covers every provider scale in the wire-schema union, with no stale member', () => {
    const fromProviders = new Set(AGENT_PROVIDERS.flatMap((p) => [...effortLevelsForProvider(p)]));
    expect([...ALL_EFFORT_LEVELS].sort()).toEqual([...fromProviders].sort());
  });

  it('validates against the owning provider only', () => {
    // `max` is Claude-only among the first two; `none` is Codex-only; `off` is
    // OMP-only. OMP is the one scale spanning both ends.
    expect(isValidEffortForProvider('claude', 'max')).toBe(true);
    expect(isValidEffortForProvider('codex', 'max')).toBe(false);
    expect(isValidEffortForProvider('codex', 'minimal')).toBe(true);
    expect(isValidEffortForProvider('claude', 'minimal')).toBe(false);
    expect(isValidEffortForProvider('omp', 'off')).toBe(true);
    expect(isValidEffortForProvider('omp', 'max')).toBe(true);
    expect(isValidEffortForProvider('omp', 'none')).toBe(false);
    expect(isValidEffortForProvider('claude', 'off')).toBe(false);
    expect(isValidEffortForProvider('codex', 'off')).toBe(false);
    // shared middle
    expect(isValidEffortForProvider('claude', 'high')).toBe(true);
    expect(isValidEffortForProvider('codex', 'high')).toBe(true);
    expect(isValidEffortForProvider('omp', 'high')).toBe(true);
  });
});

describe('normalizeEffortSelection', () => {
  it('treats empty / default as no explicit selection', () => {
    expect(normalizeEffortSelection('claude', undefined)).toBeUndefined();
    expect(normalizeEffortSelection('claude', null)).toBeUndefined();
    expect(normalizeEffortSelection('claude', '')).toBeUndefined();
    expect(normalizeEffortSelection('codex', 'default')).toBeUndefined();
  });

  it('preserves a valid value for the provider (case/space-insensitive)', () => {
    expect(normalizeEffortSelection('claude', 'xhigh')).toBe('xhigh');
    expect(normalizeEffortSelection('claude', ' High ')).toBe('high');
    expect(normalizeEffortSelection('codex', 'minimal')).toBe('minimal');
  });

  it('drops a value outside the provider scale (stale cross-provider carry-over)', () => {
    // Codex agent left with Claude's `max`, or Claude agent left with `minimal`.
    expect(normalizeEffortSelection('codex', 'max')).toBeUndefined();
    expect(normalizeEffortSelection('claude', 'minimal')).toBeUndefined();
    expect(normalizeEffortSelection('claude', 'garbage')).toBeUndefined();
    // An OMP agent left with Codex's `none`, and either of the other two left
    // with OMP's `off` — the two ends the scales do not share.
    expect(normalizeEffortSelection('omp', 'none')).toBeUndefined();
    expect(normalizeEffortSelection('claude', 'off')).toBeUndefined();
    expect(normalizeEffortSelection('codex', 'off')).toBeUndefined();
    expect(normalizeEffortSelection('omp', 'off')).toBe('off');
    expect(normalizeEffortSelection('omp', 'max')).toBe('max');
  });

  // OMP's `--thinking` accepts `auto`, which this module deliberately does not
  // model: "let OMP decide" is what NO selection already means, and admitting
  // both spellings would make `undefined` and `'auto'` indistinguishable in
  // persisted state. Pinned so the omission reads as a decision, not an oversight.
  it("drops OMP's `auto`, which is spelled as the absence of a selection", () => {
    expect(normalizeEffortSelection('omp', 'auto')).toBeUndefined();
    expect(isValidEffortForProvider('omp', 'auto')).toBe(false);
    expect(OMP_EFFORT_LEVELS).not.toContain('auto');
  });
});
