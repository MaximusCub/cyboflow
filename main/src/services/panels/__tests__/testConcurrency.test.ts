import { describe, it, expect } from 'vitest';

import {
  MANAGED_TEST_CONCURRENCY_ENV,
  MIN_MANAGED_FORKS,
  isManagedTestConcurrency,
  managedForkCap,
  managedTestConcurrencyEnv,
  parseExplicitForkCap,
  resolveForkCap,
} from '../../../../../shared/types/testConcurrency';
import { buildCodexAppServerEnvironment } from '../codex/appServer/runConfig';

const runtimeConfig = {
  orchSocketPath: '/tmp/orch.sock',
  bridgeScriptPath: '/tmp/bridge.js',
  nodeExecutablePath: '/usr/bin/node',
};

describe('parseExplicitForkCap', () => {
  it('accepts a positive integer', () => {
    expect(parseExplicitForkCap('4')).toBe(4);
  });

  it.each([undefined, '', '  ', '0', '-2', '2.5', 'four'])('rejects %o', (raw) => {
    expect(parseExplicitForkCap(raw)).toBeUndefined();
  });
});

describe('managedForkCap', () => {
  it('leaves a lone gate with vitest-default parallelism', () => {
    // 10 cores, nothing else running -> cores - 1, i.e. unchanged behaviour.
    expect(managedForkCap(10, 1)).toBe(9);
  });

  it('divides the cores across concurrent gates', () => {
    expect(managedForkCap(10, 2)).toBe(5);
    expect(managedForkCap(10, 3)).toBe(3);
  });

  it('floors at MIN_MANAGED_FORKS no matter how oversubscribed', () => {
    // The measured pathological case: 5 sprint lanes x 2 A/B arms.
    expect(managedForkCap(10, 10)).toBe(MIN_MANAGED_FORKS);
    expect(managedForkCap(10, 500)).toBe(MIN_MANAGED_FORKS);
  });

  it('never exceeds cores - 1', () => {
    expect(managedForkCap(4, 1)).toBe(3);
  });

  it('tolerates a nonsense gate count', () => {
    expect(managedForkCap(10, 0)).toBe(9);
    expect(managedForkCap(10, -3)).toBe(9);
  });

  it('stays at the floor on a single-core box rather than returning 0', () => {
    expect(managedForkCap(1, 1)).toBe(MIN_MANAGED_FORKS);
  });
});

describe('resolveForkCap', () => {
  it('returns undefined for an unmanaged run so vitest keeps its own default', () => {
    expect(
      resolveForkCap({ explicit: undefined, managed: undefined, cores: 10, concurrentGates: 8 }),
    ).toBeUndefined();
  });

  it('honours an explicit cap even when unmanaged', () => {
    expect(
      resolveForkCap({ explicit: '3', managed: undefined, cores: 10, concurrentGates: 1 }),
    ).toBe(3);
  });

  it('lets an explicit cap override the managed computation', () => {
    expect(resolveForkCap({ explicit: '7', managed: '1', cores: 10, concurrentGates: 10 })).toBe(7);
  });

  it('computes the managed cap when marked and not explicitly pinned', () => {
    expect(
      resolveForkCap({ explicit: undefined, managed: '1', cores: 10, concurrentGates: 5 }),
    ).toBe(2);
  });

  it('ignores a managed flag that is not exactly "1"', () => {
    expect(
      resolveForkCap({ explicit: undefined, managed: 'true', cores: 10, concurrentGates: 5 }),
    ).toBeUndefined();
    expect(isManagedTestConcurrency('true')).toBe(false);
    expect(isManagedTestConcurrency('1')).toBe(true);
  });
});

describe('agent env injection', () => {
  it('managedTestConcurrencyEnv marks the tree', () => {
    expect(managedTestConcurrencyEnv()).toEqual({ [MANAGED_TEST_CONCURRENCY_ENV]: '1' });
  });

  it('the codex app-server env carries the marker', () => {
    const env = buildCodexAppServerEnvironment('run-1', runtimeConfig, { PATH: '/usr/bin' }, () => '/usr/bin');
    expect(env[MANAGED_TEST_CONCURRENCY_ENV]).toBe('1');
  });

  it('the codex app-server env still carries its existing run identity', () => {
    const env = buildCodexAppServerEnvironment('run-1', runtimeConfig, { PATH: '/usr/bin' }, () => '/usr/bin');
    expect(env.CYBOFLOW_RUN_ID).toBe('run-1');
    expect(env.CYBOFLOW_ORCH_SOCKET).toBe('/tmp/orch.sock');
  });
});
