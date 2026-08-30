/**
 * orchSocketEndpoint — the platform-aware address of the orch IPC endpoint.
 *
 * On POSIX this is the Unix-domain socket path the caller computed. On
 * Windows, binding an AF_UNIX socket at that path fails with EACCES under a
 * normal (non-elevated) process, so the endpoint becomes a NAMED PIPE —
 * Node's `net` module treats a `\\.\pipe\…` path transparently on Windows,
 * which keeps OrchSocketServer and every client source-unchanged. The pipe
 * namespace is machine-global, so the name folds in TWO discriminators:
 *
 *   1. the username — without it, two Windows accounts running the app would
 *      collide on one pipe;
 *   2. a short hash of the injected `posixPath` — the app intentionally runs
 *      per-kind instances in PARALLEL (stable / `pnpm dev` / dev DMG; index.ts
 *      enforces single-instance PER KIND, each with its own data dir), and the
 *      per-kind socket path already differs per kind. Without the hash both
 *      kinds computed the SAME pipe name, so the second kind's MCP
 *      subprocesses connected to the FIRST kind's orch server — writing
 *      through the wrong database.
 *
 * Security note: the POSIX path relied on 0700/0600 modes. Named pipes carry
 * no such modes — the per-user, per-data-dir name plus the run-scoped bearer
 * tokens (orchAuthToken.ts) are the Windows access control, and tightenMode
 * degrades to a warn-only no-op there, by design.
 *
 * Standalone-typecheck invariant (mirrors orchSocketServer.ts): this module
 * must NOT import from 'electron', 'better-sqlite3', or main/src/services/*.
 */
import { createHash } from 'node:crypto';
import * as os from 'os';

export function orchSocketEndpoint(
  posixPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== 'win32') {
    return posixPath;
  }
  const rawUser = os.userInfo().username || 'default';
  const user = rawUser.replace(/[^A-Za-z0-9_-]+/g, '-');
  // First 8 hex of a digest over the per-kind socket path — enough to keep the
  // handful of app kinds apart without approaching the pipe-name length
  // budget. Not a secret; it only has to be stable per path and differ across
  // paths.
  const kind = createHash('sha256').update(posixPath).digest('hex').slice(0, 8);
  return `\\\\.\\pipe\\cyboflow-${user}-${kind}-orch`;
}
