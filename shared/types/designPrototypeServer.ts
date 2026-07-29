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
export const DESIGN_PROTO_SERVER_HOST_COMMENT_CHANNEL = 'design:proto-server:host-comment';
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
 * Ceiling on a hosted comment document (design-mode.md "Comment mode": the
 * parent "caps payload size"). A freeze of a live rendered DOM is markup + inline
 * CSS + `data:` images, so 2 MiB is generous for a prototype while keeping a
 * runaway/adversarial serialization from parking unbounded bytes in the main
 * process. Measured over the UTF-8 encoding of the sanitized document.
 */
export const MAX_COMMENT_DOCUMENT_BYTES = 2 * 1024 * 1024;

/**
 * Host the PARENT-SANITIZED freeze of the live prototype DOM as the run's
 * current comment document (design-mode.md "Comment mode — live-DOM freeze +
 * sanitizer + nonce-CSP").
 *
 * The bytes are served back from the SAME token-gated loopback server as the
 * prototype (so the comment frame is likewise cross-origin → its own renderer
 * process) under a nonce-only `script-src` delivered as a RESPONSE HEADER, with
 * the app-owned inspector — the frame's sole possible writer — injected
 * server-side carrying that nonce.
 *
 * Requires a LIVE server for the runId (the design surface `ensure`d one on
 * entry); hosting against a stopped/absent server is an error, not a silent
 * spawn. Only the CURRENT capture is retained: a second call evicts the previous
 * one, whose URL then 404s.
 */
export interface HostCommentDocumentRequest {
  runId: string;
  /**
   * The sanitized document string. Sanitization is a PARENT-side (renderer)
   * responsibility — see frontend/src/utils/sanitizeFrozenDom.ts. The nonce CSP
   * is the enforcement regardless, so the main process treats these bytes as
   * untrusted content and only bounds their size.
   */
  sanitizedHtml: string;
}

export interface HostCommentDocumentResult {
  /**
   * The full tokenized URL of the freshly-hosted comment document
   * (`http://127.0.0.1:<port>/<token>/comment/<captureId>.html`) — the comment
   * frame's `src`, verbatim. A new captureId per call, so the URL always
   * differs from the previous capture's (which is now evicted).
   */
  url: string;
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
