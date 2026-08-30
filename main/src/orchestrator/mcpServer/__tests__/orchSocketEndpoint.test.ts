/**
 * orchSocketEndpoint unit tests — the pipe name is the whole Windows contract
 * of this module (see the module header for the two load-bearing properties:
 * per-kind separation and POSIX passthrough). `platform` is an injected seam
 * so the win32 branch is exercised from any host. No electron /
 * better-sqlite3 imports here — the standalone-typecheck invariant holds.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as os from 'os';
import { orchSocketEndpoint } from '../orchSocketEndpoint';

/** The username slug the module derives, computed the same way. */
function expectedUserSlug(): string {
  const rawUser = os.userInfo().username || 'default';
  return rawUser.replace(/[^A-Za-z0-9_-]+/g, '-');
}

function expectedHash(posixPath: string): string {
  return createHash('sha256').update(posixPath).digest('hex').slice(0, 8);
}

describe('orchSocketEndpoint', () => {
  describe('win32', () => {
    it('returns a named pipe embedding the user slug and an 8-hex kind hash', () => {
      const pipe = orchSocketEndpoint('C:/Users/dev/.cyboflow/sockets/orch.sock', 'win32');
      expect(pipe).toMatch(/^\\\\\.\\pipe\\cyboflow-[A-Za-z0-9_-]+-[0-9a-f]{8}-orch$/);
      expect(pipe).toContain(expectedUserSlug());
      expect(pipe).toContain(expectedHash('C:/Users/dev/.cyboflow/sockets/orch.sock'));
    });

    it('is stable for the same posixPath', () => {
      const path = 'C:/Users/dev/.cyboflow-dev/sockets/orch.sock';
      expect(orchSocketEndpoint(path, 'win32')).toBe(orchSocketEndpoint(path, 'win32'));
    });

    it('differs for two different posixPaths — per-kind instances must not share a pipe', () => {
      const stable = orchSocketEndpoint('C:/Users/dev/.cyboflow/sockets/orch.sock', 'win32');
      const dev = orchSocketEndpoint('C:/Users/dev/.cyboflow-dev/sockets/orch.sock', 'win32');
      expect(stable).not.toBe(dev);
    });

    it('sanitizes username characters outside [A-Za-z0-9_-]', () => {
      // Pins that the sanitize step exists: the slug must equal the expected
      // transform exactly, not merely match the sanctioned-char shape.
      const pipe = orchSocketEndpoint('/sockets/orch.sock', 'win32');
      expect(pipe).toContain(`cyboflow-${expectedUserSlug()}-`);
    });
  });

  describe('posix', () => {
    it.each(['linux', 'darwin'] as const)(
      'returns the injected path unchanged on %s',
      (platform) => {
        const socketPath = '/Users/dev/.cyboflow/sockets/orch.sock';
        expect(orchSocketEndpoint(socketPath, platform)).toBe(socketPath);
      }
    );
  });
});
