/**
 * orchSocketEndpoint unit tests.
 *
 * The pipe name is the whole Windows contract of this module, and two
 * properties of it are load-bearing:
 *
 * 1. PER-KIND separation — the app intentionally runs per-kind instances in
 *    parallel (stable / `pnpm dev` / dev DMG), each with its own data dir and
 *    therefore its own `sockets/orch.sock` posixPath. The pipe name must fold
 *    a hash of that path in, or the second kind's MCP subprocesses connect to
 *    the first kind's orch server (wrong database).
 * 2. POSIX passthrough — on non-win32 the injected socket path IS the
 *    endpoint; the Unix-domain socket's 0700/0600 modes are the access
 *    control, so the path must be returned untouched.
 *
 * `platform` is an injected seam (mirroring TerminalSessionManagerOptions
 * .platform) so the win32 branch is exercised from any host. No electron /
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
      // The slug regex in the shape assertion above already proves only
      // sanctioned chars survive; this pins that the sanitize step exists by
      // asserting the slug is composed exactly of the expected transform.
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
