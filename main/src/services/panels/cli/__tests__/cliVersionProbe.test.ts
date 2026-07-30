import { describe, expect, it, vi } from 'vitest';
import { describeMissingInterpreter, probeCliVersion } from '../cliVersionProbe';

const MISSING_NODE = 'Command failed: /Users/dev/.local/bin/codex --version\nenv: node: No such file or directory\n';

describe('describeMissingInterpreter', () => {
  it('extracts the interpreter from a shebang failure', () => {
    expect(describeMissingInterpreter(MISSING_NODE)).toBe('node');
    expect(describeMissingInterpreter('env: python3: No such file or directory')).toBe('python3');
  });

  it('returns null for unrelated failures', () => {
    expect(describeMissingInterpreter(undefined)).toBeNull();
    expect(describeMissingInterpreter('spawn ENOENT')).toBeNull();
    expect(describeMissingInterpreter('Command failed: codex --version\nnot logged in')).toBeNull();
  });
});

describe('probeCliVersion', () => {
  it('returns the direct version without a Node fallback', async () => {
    const runCommand = vi.fn().mockReturnValue('codex-cli 0.144.3\n');

    const result = await probeCliVersion('/opt/codex/bin/codex', { PATH: '/opt/codex/bin' }, {
      runCommand,
      resolveNodeScript: () => null,
      resolveNodeExecutable: () => Promise.resolve('/usr/bin/node'),
    });

    expect(result).toEqual({ version: 'codex-cli 0.144.3', usedNodeFallback: false });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith('/opt/codex/bin/codex', ['--version'], {
      PATH: '/opt/codex/bin',
    });
  });

  it('retries an npm shim through Node when its shebang interpreter is missing', async () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(MISSING_NODE);
      })
      .mockReturnValue('0.144.3\n');

    const result = await probeCliVersion('/Users/dev/.local/bin/codex', { PATH: '/usr/bin' }, {
      runCommand,
      resolveNodeScript: () => '/Users/dev/.local/lib/codex/index.js',
      resolveNodeExecutable: () => Promise.resolve('/Users/dev/.nvm/versions/node/v22.3.0/bin/node'),
    });

    expect(result).toEqual({ version: '0.144.3', usedNodeFallback: true });
    expect(runCommand).toHaveBeenLastCalledWith(
      '/Users/dev/.nvm/versions/node/v22.3.0/bin/node',
      ['--no-warnings', '--enable-source-maps', '/Users/dev/.local/lib/codex/index.js', '--version'],
      { PATH: '/usr/bin' },
    );
  });

  it('runs the Electron binary as plain Node when that is the only interpreter', async () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(MISSING_NODE);
      })
      .mockReturnValue('1.0.0');

    const result = await probeCliVersion('/Users/dev/.local/bin/claude', { PATH: '/usr/bin' }, {
      runCommand,
      resolveNodeScript: () => null,
      resolveNodeExecutable: () => Promise.resolve('/Applications/Cyboflow.app/Contents/MacOS/Cyboflow'),
      execPath: '/Applications/Cyboflow.app/Contents/MacOS/Cyboflow',
    });

    expect(result.usedNodeFallback).toBe(true);
    expect(runCommand).toHaveBeenLastCalledWith(
      '/Applications/Cyboflow.app/Contents/MacOS/Cyboflow',
      ['/Users/dev/.local/bin/claude', '--version'],
      { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' },
    );
  });

  it('rethrows failures that are not a missing interpreter without retrying', async () => {
    const runCommand = vi.fn().mockImplementation(() => {
      throw new Error('Command failed: codex --version\nnot logged in');
    });

    await expect(
      probeCliVersion('/opt/codex/bin/codex', {}, {
        runCommand,
        resolveNodeScript: () => null,
        resolveNodeExecutable: () => Promise.resolve('/usr/bin/node'),
      }),
    ).rejects.toThrow('not logged in');
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it('reports both failures when the Node fallback also fails', async () => {
    const runCommand = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error(MISSING_NODE);
      })
      .mockImplementationOnce(() => {
        throw new Error('spawn EACCES');
      });

    await expect(
      probeCliVersion('/Users/dev/.local/bin/codex', {}, {
        runCommand,
        resolveNodeScript: () => null,
        resolveNodeExecutable: () => Promise.resolve('/usr/bin/node'),
      }),
    ).rejects.toThrow(/env: node: No such file or directory[\s\S]*Node fallback via \/usr\/bin\/node also failed: spawn EACCES/);
  });
});
