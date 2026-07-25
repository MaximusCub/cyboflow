/**
 * DesignPrototypeServerManager (Design Mode v1 — design-mode.md "Process
 * isolation" + "Server lifecycle — bound to design-mode entry/exit (v1)") — the
 * token-gated loopback server that serves the run's interactive prototype
 * document to a genuinely cross-origin (→ own OOPIF renderer) canvas frame.
 *
 * SURFACE-SCOPED LIFECYCLE, not ambient. The design surface calls `ensure` on
 * entry (and on respawn) and `stop` on exit. There is exactly ONE server per
 * runId; `ensure` is idempotent (returns the SAME baseUrl/token while live).
 * Rationale (design-mode.md, from live testing): a long-lived ambient server the
 * UI merely hopes is still there gets reaped unpredictably and breaks any canvas
 * that counts on it — a surface-scoped lifecycle makes availability deterministic
 * and re-entry simply respawns from the on-disk blessed bytes.
 *
 * SINGLE-RESOURCE server — a deliberate simplification over StaticServerManager's
 * static-root pipeline (path-traversal denylist, realpath containment, MIME map):
 * the interactive prototype contract is ONE self-contained `prototype/index.html`
 * with no sibling assets (subresources are inline data: only, enforced by the
 * injected CSP), so this server answers EXACTLY one path —
 * `/<token>/prototype/index.html` — and 404s everything else, leaking no signal
 * about whether a bad token was "close". The served bytes are loaded FRESH PER
 * REQUEST (not cached at spawn) so an agent re-report of the prototype is picked
 * up on the next reload without a server restart, and the interactive CSP is
 * injected at position 0 (see injectPrototypeCsp) so it governs the whole doc.
 *
 * AUTHORIZATION: binding loopback is NOT access control — anything on 127.0.0.1
 * could hit the port. The first path segment is an unguessable per-spawn token
 * (`randomBytes(16)`), the sole authorization boundary, exactly as
 * StaticServerManager does.
 *
 * The loader fn, origin-registry hooks, watchdog control, and server-stopped
 * notifier are all constructor seams, so this manager unit-tests with plain
 * fakes and no Electron import; index.ts wires the concrete instances.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import type { LoggerLike } from '../orchestrator/types';
import {
  ARTIFACT_INTERACTIVE_CSP,
  PROTOTYPE_HTML_RELPATH,
} from '../../../shared/types/artifacts';
import { injectPrototypeCsp } from '../ipc/artifactHtml';
import {
  registerScriptedFrameOrigin,
  unregisterScriptedFrameOrigin,
} from '../ipc/artifactFrameGuard';
import type { FrameWatchdogControl, WatchdogTarget } from './designFrameWatchdog';

/** The one path this server serves — the canonical interactive prototype document. */
const SERVED_PATH = `/${PROTOTYPE_HTML_RELPATH}`;

export interface DesignPrototypeServerManagerOptions {
  /**
   * Load the RAW canonical prototype bytes for a run (no CSP injection) — wraps
   * `loadCanonicalPrototypeHtml(services, runId, 'interactive-prototype')`.
   * A null result (absent / invalid / oversized) is served as a 404.
   */
  loadHtml: (runId: string) => Promise<string | null>;
  /** Watchdog to start on the first live server and stop when the last one goes. */
  watchdog?: FrameWatchdogControl;
  /**
   * Notify the renderer that a server went away OUTSIDE an explicit `stop` call
   * (i.e. via `stopAll` at quit / window close). Fail-soft — a dead window is a
   * no-op. Not called from `stop` (the canvas asked for that teardown itself).
   */
  onServerStopped?: (runId: string) => void;
  /** Register a live server's origin as a scripted artifact-frame identity. */
  registerOrigin?: (origin: string) => void;
  /** Unregister a server's origin on stop. */
  unregisterOrigin?: (origin: string) => void;
  logger?: LoggerLike;
}

/** One live server's tracked state. */
interface ServerEntry {
  server: Server;
  origin: string;
  baseUrl: string;
  /** Open connections, force-destroyed on release so `close()` never hangs. */
  sockets: Set<Socket>;
}

export class DesignPrototypeServerManager {
  private readonly loadHtml: (runId: string) => Promise<string | null>;
  private readonly watchdog?: FrameWatchdogControl;
  private readonly onServerStopped?: (runId: string) => void;
  private readonly registerOrigin: (origin: string) => void;
  private readonly unregisterOrigin: (origin: string) => void;
  private readonly logger?: LoggerLike;

  private readonly servers = new Map<string, ServerEntry>();
  /** In-flight spawns, so concurrent `ensure`s for one runId share a single server. */
  private readonly pending = new Map<string, Promise<string>>();

  constructor(opts: DesignPrototypeServerManagerOptions) {
    this.loadHtml = opts.loadHtml;
    this.watchdog = opts.watchdog;
    this.onServerStopped = opts.onServerStopped;
    this.registerOrigin = opts.registerOrigin ?? registerScriptedFrameOrigin;
    this.unregisterOrigin = opts.unregisterOrigin ?? unregisterScriptedFrameOrigin;
    this.logger = opts.logger;
  }

  /**
   * Ensure a live server for `runId` and return its tokenized entry URL. Idempotent:
   * a second call while a server is live (or its spawn is in flight) returns the
   * SAME baseUrl.
   */
  async ensure(runId: string): Promise<string> {
    const existing = this.servers.get(runId);
    if (existing) return existing.baseUrl;
    const inFlight = this.pending.get(runId);
    if (inFlight) return inFlight;

    const spawnPromise = this.spawn(runId).finally(() => this.pending.delete(runId));
    this.pending.set(runId, spawnPromise);
    return spawnPromise;
  }

  /**
   * Tear down the run's server (design-mode exit). Idempotent — returns false when
   * no server was running. Does NOT emit `server-stopped` (the caller asked for it).
   */
  async stop(runId: string): Promise<boolean> {
    const entry = this.servers.get(runId);
    if (!entry) return false;
    this.servers.delete(runId);
    await this.releaseEntry(entry);
    this.maybeStopWatchdog();
    this.logger?.debug('[DesignPrototypeServer] stopped', { runId });
    return true;
  }

  /**
   * Tear down EVERY live server (app quit / main-window close). Each server's
   * renderer notification fires via {@link onServerStopped} (fail-soft) because
   * this teardown is out-of-band from the canvas's own `stop`.
   */
  async stopAll(): Promise<void> {
    const entries = [...this.servers.entries()];
    this.servers.clear();
    for (const [runId, entry] of entries) {
      await this.releaseEntry(entry);
      try {
        this.onServerStopped?.(runId);
      } catch (err) {
        this.logger?.debug('[DesignPrototypeServer] server-stopped notify failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.maybeStopWatchdog();
  }

  /** The live (origin, runId) pairs the frame watchdog judges frames against. */
  getTargets(): WatchdogTarget[] {
    return [...this.servers.entries()].map(([runId, entry]) => ({ origin: entry.origin, runId }));
  }

  /** Bind a fresh token-gated loopback server for `runId` and register its origin. */
  private async spawn(runId: string): Promise<string> {
    const token = randomBytes(16).toString('hex');
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      void this.handleRequest(req, res, token, runId);
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    const port = await new Promise<number>((resolve, reject) => {
      let settled = false;
      server.on('error', (err) => {
        if (settled) {
          this.logger?.error('[DesignPrototypeServer] server error after listening', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      server.listen(0, '127.0.0.1', () => {
        if (settled) return;
        const address = server.address();
        if (address === null || typeof address === 'string') {
          settled = true;
          server.close();
          reject(new Error('design prototype server failed to bind a port'));
          return;
        }
        settled = true;
        resolve(address.port);
      });
    });

    const origin = `http://127.0.0.1:${port}`;
    const baseUrl = `${origin}/${token}/${PROTOTYPE_HTML_RELPATH}`;
    this.servers.set(runId, { server, origin, baseUrl, sockets });
    this.registerOrigin(origin);
    this.watchdog?.start();
    this.logger?.info('[DesignPrototypeServer] listening', { runId, baseUrl });
    return baseUrl;
  }

  /**
   * Serve the single blessed document for a token-matching GET/HEAD; everything
   * else is a bare 404 (or 405 for a disallowed method). Never throws — an
   * unexpected failure answers 500 (or destroys the socket if headers are out).
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    runId: string,
  ): Promise<void> {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.sendStatus(res, 405, 'Method Not Allowed');
        return;
      }
      const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
      // Single resource: the path must be EXACTLY `/<token>/prototype/index.html`.
      // No path decoding/normalization is needed — there is nothing else to serve,
      // so anything but the exact string is an indistinguishable 404.
      if (rawPath !== `/${token}${SERVED_PATH}`) {
        this.sendStatus(res, 404, 'Not Found');
        return;
      }

      const raw = await this.loadHtml(runId);
      if (raw === null) {
        // Fail-soft: the canonical bytes are absent/invalid — a 404, so the canvas
        // shows its empty state rather than a wedged frame.
        this.sendStatus(res, 404, 'Not Found');
        return;
      }
      const html = injectPrototypeCsp(raw, ARTIFACT_INTERACTIVE_CSP);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      res.end(html);
    } catch (err) {
      this.logger?.error('[DesignPrototypeServer] request handling failed', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        this.sendStatus(res, 500, 'Internal Server Error');
      } else {
        res.destroy();
      }
    }
  }

  /** Unregister the origin, then close the server and force-destroy open sockets. */
  private async releaseEntry(entry: ServerEntry): Promise<void> {
    this.unregisterOrigin(entry.origin);
    await new Promise<void>((resolve) => {
      entry.server.close(() => resolve());
      // close() only stops accepting NEW connections; destroy in-flight ones so
      // its callback isn't left waiting on a lingering keep-alive socket.
      for (const socket of entry.sockets) socket.destroy();
    });
  }

  /** Stop the watchdog once no server remains (nothing left to poll). */
  private maybeStopWatchdog(): void {
    if (this.servers.size === 0) this.watchdog?.stop();
  }

  /** Minimal plain-text status response carrying the same safety headers. */
  private sendStatus(res: ServerResponse, code: number, message: string): void {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(message);
  }
}
