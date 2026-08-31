import { describe, it, expect } from 'vitest';
import { deriveQueuePageState, type QueuePageStateInput } from '../reviewQueuePageState';

function baseInput(overrides: Partial<QueuePageStateInput> = {}): QueuePageStateInput {
  return {
    loadError: false,
    providersConnected: true,
    projectsCount: 1,
    sessionsCount: 1,
    waitingCount: 1,
    blockedCount: 1,
    workingCount: 0,
    ...overrides,
  };
}

describe('deriveQueuePageState', () => {
  it('returns error when loadError is set, regardless of every other flag', () => {
    expect(
      deriveQueuePageState(
        baseInput({
          loadError: true,
          providersConnected: false,
          projectsCount: 0,
          sessionsCount: 0,
          waitingCount: 0,
          blockedCount: 0,
          workingCount: 0,
        }),
      ),
    ).toBe('error');
  });

  it('returns no-accounts when no provider account is connected', () => {
    expect(deriveQueuePageState(baseInput({ providersConnected: false }))).toBe('no-accounts');
  });

  it('no-accounts takes priority over zero projects/sessions', () => {
    expect(
      deriveQueuePageState(
        baseInput({ providersConnected: false, projectsCount: 0, sessionsCount: 0 }),
      ),
    ).toBe('no-accounts');
  });

  it('returns no-projects when accounts are connected but there are zero projects', () => {
    expect(deriveQueuePageState(baseInput({ projectsCount: 0 }))).toBe('no-projects');
  });

  it('no-projects takes priority over zero sessions', () => {
    expect(deriveQueuePageState(baseInput({ projectsCount: 0, sessionsCount: 0 }))).toBe('no-projects');
  });

  it('returns no-sessions when projects exist but there are zero sessions of any kind', () => {
    expect(deriveQueuePageState(baseInput({ sessionsCount: 0 }))).toBe('no-sessions');
  });

  it('no-sessions takes priority over waitingCount being zero', () => {
    expect(deriveQueuePageState(baseInput({ sessionsCount: 0, waitingCount: 0 }))).toBe('no-sessions');
  });

  it('returns caught-up when sessions exist and nothing is waiting, even while agents are working', () => {
    expect(
      deriveQueuePageState(baseInput({ waitingCount: 0, blockedCount: 0, workingCount: 3 })),
    ).toBe('caught-up');
  });

  it('returns all-idle when something is waiting but nothing is blocked or working', () => {
    expect(
      deriveQueuePageState(baseInput({ waitingCount: 2, blockedCount: 0, workingCount: 0 })),
    ).toBe('all-idle');
  });

  it('returns normal when something is waiting and something is blocked', () => {
    expect(
      deriveQueuePageState(baseInput({ waitingCount: 2, blockedCount: 1, workingCount: 0 })),
    ).toBe('normal');
  });

  it('returns normal when something is waiting and something is working', () => {
    expect(
      deriveQueuePageState(baseInput({ waitingCount: 2, blockedCount: 0, workingCount: 1 })),
    ).toBe('normal');
  });

  it('returns normal when something is waiting and both blocked and working are non-zero', () => {
    expect(
      deriveQueuePageState(baseInput({ waitingCount: 3, blockedCount: 1, workingCount: 1 })),
    ).toBe('normal');
  });
});
