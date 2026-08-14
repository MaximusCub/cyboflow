/**
 * Tests for ompGatePath — where the spawner finds the gating extension.
 *
 * Two behaviours are worth locking down, both of them measured against the real
 * `omp` binary rather than reasoned about (see ompGatePath.ts's header):
 *
 *  1. The asset is the TypeScript SOURCE. OMP rejected tsc's CommonJS output
 *     ("Extension does not export a valid factory function") and accepted the
 *     .ts file. A future "let's ship the compiled artifact like everything
 *     else" cleanup would break the gate silently, so the extension is asserted.
 *  2. The packaged branch THROWS. OMP starts a session even when an extension
 *     fails to load (loader.ts:437-443), so a path that does not exist would
 *     produce an UNGATED session instead of an error.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  OMP_GATE_EXTENSION_FILENAME,
  resolveOmpGateExtensionPath,
  toSourceDir,
} from '../ompGatePath';

describe('toSourceDir', () => {
  it('maps a compiled dev directory back to the source tree', () => {
    expect(toSourceDir('/repo/main/dist/main/src/services/panels/omp/gate')).toBe(
      '/repo/main/src/services/panels/omp/gate',
    );
  });

  it('leaves a path that is already source alone (the vitest case)', () => {
    expect(toSourceDir('/repo/main/src/services/panels/omp/gate')).toBe(
      '/repo/main/src/services/panels/omp/gate',
    );
  });

  it('rewrites the LAST occurrence, so a repo path containing main/dist is safe', () => {
    expect(toSourceDir('/main/dist/main/src/x/main/dist/main/src/services/panels/omp/gate')).toBe(
      '/main/dist/main/src/x/main/src/services/panels/omp/gate',
    );
  });
});

describe('resolveOmpGateExtensionPath', () => {
  it('resolves the source file from a compiled dev directory', () => {
    const resolved = resolveOmpGateExtensionPath({
      isPackaged: false,
      dirname: '/repo/main/dist/main/src/services/panels/omp/gate',
    });

    expect(resolved).toBe('/repo/main/src/services/panels/omp/gate/ompGateExtension.ts');
  });

  it('resolves next to this module when it is already running from source', () => {
    const resolved = resolveOmpGateExtensionPath({
      isPackaged: false,
      dirname: '/repo/main/src/services/panels/omp/gate',
    });

    expect(resolved).toBe('/repo/main/src/services/panels/omp/gate/ompGateExtension.ts');
  });

  it('defaults the directory to this module’s own location', () => {
    const resolved = resolveOmpGateExtensionPath({ isPackaged: false });

    expect(path.basename(resolved)).toBe(OMP_GATE_EXTENSION_FILENAME);
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('ships the TypeScript source — the compiled .js is NOT loadable by OMP', () => {
    expect(OMP_GATE_EXTENSION_FILENAME).toBe('ompGateExtension.ts');
  });

  it('points at a file that actually exists in this checkout', async () => {
    // The dev path is the one `pnpm dev` uses; a rename that broke it would
    // otherwise only surface when someone started an OMP session.
    const fs = await import('node:fs');
    expect(fs.existsSync(resolveOmpGateExtensionPath({ isPackaged: false }))).toBe(true);
  });

  it('throws in packaged mode, naming the electron-builder change needed', () => {
    expect(() =>
      resolveOmpGateExtensionPath({ isPackaged: true, resourcesPath: '/Applications/x/Resources' }),
    ).toThrow(/extraResources/);
  });

  it('refuses to spawn rather than degrade when packaged', () => {
    expect(() => resolveOmpGateExtensionPath({ isPackaged: true })).toThrow(
      /Refusing to spawn OMP without/i,
    );
  });
});
