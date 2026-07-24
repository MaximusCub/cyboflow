/**
 * Design-mode v1 interactive prototype server — the IPC contract between the
 * design surface (renderer) and the main-process loopback server + frame
 * watchdog (docs/ideas/design-mode.md → "Process isolation" + "Server
 * lifecycle — bound to design-mode entry/exit").
 *
 * Lifecycle contract: the server is SURFACE-SCOPED — the design-mode surface
 * calls `ensure` on entry (and on respawn) and `stop` on exit. It is never an
 * ambient long-lived server the UI merely hopes is still there (user
 * requirement from live testing: ambient prototype servers got reaped
 * unpredictably and broke any UI that counted on them). Re-entry respawns from
 * the on-disk blessed bytes; the canvas must treat "server gone" fail-soft
 * (respawn affordance, never a wedged frame).
 *
 * SHARED so the main handler, the preload bridge, and the renderer
 * `electron.d.ts` declaration reference ONE definition (see CODE-PATTERNS.md →
 * IPC type-parity rules).
 */

/** IPC channel names — single source so main/preload can't drift. */
export const DESIGN_PROTO_SERVER_ENSURE_CHANNEL = 'design:proto-server:ensure';
export const DESIGN_PROTO_SERVER_STOP_CHANNEL = 'design:proto-server:stop';
export const DESIGN_PROTO_SERVER_EVENT_CHANNEL = 'design:proto-server:event';

/**
 * Spin up (or return the already-running) token-gated loopback server for the
 * run's canonical prototype document, and register its origin with the frame
 * watchdog + navigation guard. Idempotent per runId: a second ensure while a
 * server is live returns the SAME baseUrl (same token) — the canvas may call
 * it freely on mount/respawn.
 */
export interface EnsurePrototypeServerRequest {
  runId: string;
}

export interface EnsurePrototypeServerResult {
  /**
   * The full tokenized entry URL for the prototype document
   * (`http://127.0.0.1:<port>/<token>/prototype/index.html`) — the iframe's
   * `src`, verbatim. The token is the sole authorization boundary (loopback
   * binding alone is not access control), minted fresh per server spawn.
   */
  baseUrl: string;
}

/** Tear down the run's prototype server (design-mode exit). Idempotent. */
export interface StopPrototypeServerRequest {
  runId: string;
}

export interface StopPrototypeServerResult {
  /** False when no server was running for the runId (already stopped). */
  stopped: boolean;
}

/**
 * Why the watchdog killed the prototype frame's renderer process:
 * sustained ~one-core CPU (busy loop) or working-set runaway (memory bomb).
 */
export type PrototypeFrameTerminationReason = 'cpu' | 'memory';

/**
 * Pushed main→renderer on DESIGN_PROTO_SERVER_EVENT_CHANNEL.
 *
 * - `frame-terminated`: the watchdog SIGKILLed the prototype frame's OOPIF
 *   renderer process (`reason` says why). The server itself is still up — the
 *   canvas shows the terminated state and respawn is one iframe-src
 *   reassignment (spike-verified: a re-set src spawns a fresh process).
 * - `server-stopped`: the server went away outside the canvas's own `stop`
 *   call (e.g. spawn-failure teardown). The canvas shows the fail-soft
 *   respawn affordance and `ensure`s again on demand.
 */
export interface PrototypeServerEvent {
  runId: string;
  kind: 'frame-terminated' | 'server-stopped';
  reason?: PrototypeFrameTerminationReason;
}
