/**
 * orchSocketEndpoint — the platform-aware address of the orch IPC endpoint.
 *
 * On POSIX this is the Unix-domain socket path the caller computed
 * (`~/.cyboflow/sockets/orch.sock`). On Windows, binding an AF_UNIX socket at
 * that path fails with EACCES under a normal (non-elevated) process, so the
 * endpoint becomes a per-user NAMED PIPE — Node's `net` module treats a
 * `\\.\pipe\…` path transparently on Windows, which keeps OrchSocketServer
 * (listen/probe/close) and every client (`net.createConnection`) source-
 * unchanged. The pipe namespace is machine-global, so the name embeds the
 * username; without that, two Windows accounts running the app would collide
 * on one pipe.
 *
 * Security note: the POSIX path relied on 0700/0600 modes (OrchSocketServer's
 * tightenMode). Named pipes carry no such modes — the per-user name plus the
 * run-scoped bearer tokens (orchAuthToken.ts) are the Windows access control.
 * tightenMode degrades to a warn-only no-op there, which is by design.
 *
 * Standalone-typecheck invariant (mirrors orchSocketServer.ts): this module
 * must NOT import from 'electron', 'better-sqlite3', or any concrete service
 * in main/src/services/*.
 */
import * as os from 'os';

export function orchSocketEndpoint(posixPath: string): string {
  if (process.platform !== 'win32') {
    return posixPath;
  }
  const rawUser = os.userInfo().username || 'default';
  const user = rawUser.replace(/[^A-Za-z0-9_-]+/g, '-');
  return `\\\\.\\pipe\\cyboflow-${user}-orch`;
}
