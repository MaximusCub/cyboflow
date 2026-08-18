import { beforeEach, describe, expect, it, vi } from 'vitest';

const findExecutableInPath = vi.fn<(executable: string) => string | null>();
const probeCliVersion =
  vi.fn<(executablePath: string, env: NodeJS.ProcessEnv) => Promise<{ version: string; usedNodeFallback: boolean }>>();

vi.mock('../../../../utils/shellPath', () => ({
  getShellPath: () => '/usr/bin:/bin',
  findExecutableInPath: (executable: string) => findExecutableInPath(executable),
}));

vi.mock('../../cli/cliVersionProbe', () => ({
  probeCliVersion: (executablePath: string, env: NodeJS.ProcessEnv) => probeCliVersion(executablePath, env),
}));

import { detectOmpAvailability } from '../ompAvailability';
import { OMP_TESTED_VERSION } from '../ompVersions';

beforeEach(() => {
  findExecutableInPath.mockReset();
  probeCliVersion.mockReset();
});

describe('detectOmpAvailability', () => {
  it('reports unavailable with no evidence when omp is not on PATH', async () => {
    findExecutableInPath.mockReturnValue(null);

    await expect(detectOmpAvailability()).resolves.toEqual({
      state: 'unavailable',
      binaryPath: null,
      version: null,
    });
    expect(probeCliVersion).not.toHaveBeenCalled();
  });

  it('reports detected for a binary at/above the version floor', async () => {
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    probeCliVersion.mockResolvedValue({ version: 'omp/17.3.2', usedNodeFallback: false });

    await expect(detectOmpAvailability()).resolves.toEqual({
      state: 'detected',
      binaryPath: '/Users/dev/.local/bin/omp',
      version: 'omp/17.3.2',
    });
  });

  it('reports unavailable for a too-old binary, but still surfaces its version', async () => {
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    probeCliVersion.mockResolvedValue({ version: 'omp/17.2.0', usedNodeFallback: false });

    await expect(detectOmpAvailability()).resolves.toEqual({
      state: 'unavailable',
      binaryPath: '/Users/dev/.local/bin/omp',
      version: 'omp/17.2.0',
    });
  });

  it('reports unavailable (binary path known, no version) when --version fails', async () => {
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    probeCliVersion.mockRejectedValue(new Error('spawn EACCES'));

    await expect(detectOmpAvailability()).resolves.toEqual({
      state: 'unavailable',
      binaryPath: '/Users/dev/.local/bin/omp',
      version: null,
    });
  });

  it('accepts (never refuses) a version newer than the tested ceiling, and warns once', async () => {
    findExecutableInPath.mockReturnValue('/Users/dev/.local/bin/omp');
    probeCliVersion.mockResolvedValue({ version: 'omp/99.0.0', usedNodeFallback: false });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(detectOmpAvailability()).resolves.toEqual({
      state: 'detected',
      binaryPath: '/Users/dev/.local/bin/omp',
      version: 'omp/99.0.0',
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(OMP_TESTED_VERSION));

    warnSpy.mockRestore();
  });

  it('honors an explicit custom path over PATH discovery', async () => {
    probeCliVersion.mockResolvedValue({ version: 'omp/17.3.2', usedNodeFallback: false });

    await detectOmpAvailability('/custom/omp');

    expect(findExecutableInPath).not.toHaveBeenCalled();
    expect(probeCliVersion).toHaveBeenCalledWith('/custom/omp', expect.any(Object));
  });
});
