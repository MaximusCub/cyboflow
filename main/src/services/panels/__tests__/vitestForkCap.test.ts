import { describe, it, expect } from 'vitest';
import { availableParallelism } from 'node:os';

import { countRunningGates, forkPoolOptions } from '../../../../../vitestForkCap';

/** A `ps -Ao command=` style dump. */
const psDump = (...lines: string[]) => () => lines.join('\n') + '\n';

describe('countRunningGates', () => {
  it('counts vitest roots and ignores their pool workers', () => {
    const list = psDump(
      'node (vitest)',
      'node (vitest 1)',
      'node (vitest 2)',
      'node (vitest)',
      'node (vitest 9)',
      '/usr/bin/node /some/other/thing',
    );
    expect(countRunningGates(list)).toBe(2);
  });

  it('tolerates the trailing whitespace ps emits', () => {
    expect(countRunningGates(psDump('node (vitest)  ', '  node (vitest)'))).toBe(2);
  });

  it('returns at least 1 when no root has titled itself yet', () => {
    expect(countRunningGates(psDump('launchd', 'node (vitest 3)'))).toBe(1);
  });

  it('fails soft to 1 when ps is unavailable', () => {
    expect(
      countRunningGates(() => {
        throw new Error('ps: command not found');
      }),
    ).toBe(1);
  });
});

describe('forkPoolOptions', () => {
  it('is empty for an unmanaged run, leaving vitest pool defaults untouched', () => {
    expect(forkPoolOptions({}, psDump('node (vitest)'))).toEqual({});
  });

  it('pins the fork pool when an explicit cap is set', () => {
    expect(forkPoolOptions({ CYBOFLOW_TEST_MAX_FORKS: '4' }, psDump('node (vitest)'))).toEqual({
      pool: 'forks',
      poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    });
  });

  it('divides the box across concurrent gates when managed', () => {
    const cores = availableParallelism();
    const result = forkPoolOptions(
      { CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' },
      psDump(...Array.from({ length: 5 }, () => 'node (vitest)')),
    );
    expect(result).toMatchObject({ pool: 'forks' });
    const { maxForks } = (result as { poolOptions: { forks: { maxForks: number } } }).poolOptions.forks;
    expect(maxForks).toBe(Math.max(2, Math.min(cores - 1, Math.floor(cores / 5))));
    // The whole point: five concurrent gates must not each take the full box.
    expect(maxForks).toBeLessThanOrEqual(Math.max(2, cores - 1));
  });

  it('gives a lone managed gate the same width as an unmanaged one', () => {
    const cores = availableParallelism();
    const result = forkPoolOptions(
      { CYBOFLOW_MANAGED_TEST_CONCURRENCY: '1' },
      psDump('node (vitest)'),
    );
    const { maxForks } = (result as { poolOptions: { forks: { maxForks: number } } }).poolOptions.forks;
    expect(maxForks).toBe(Math.max(2, cores - 1));
  });
});
