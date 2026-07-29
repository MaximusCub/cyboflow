/**
 * InteractivePrototypeEmbed — the v1 `interactive-prototype` canvas (design-
 * mode.md "Process isolation" + "Server lifecycle — bound to design-mode
 * entry/exit (v1)" + "Isolation spike results (rev 7)").
 *
 * Renders the run's blessed prototype document via the surface-owned,
 * token-gated loopback server (`window.electronAPI.designPrototypeServer`) in
 * a cross-origin `<iframe sandbox="allow-scripts">` — deliberately WITHOUT
 * `allow-same-origin`: the loopback origin (a different port than the shell)
 * is what gives the frame its own OOPIF renderer process (spike-confirmed),
 * so granting same-origin back would defeat the isolation this component
 * exists for. This component only ENSURES/watches the server; it never STOPS
 * it — the design surface owns the server's lifecycle (entry/exit-scoped),
 * because this canvas can unmount on ordinary stage-state flips (e.g. a
 * clarify gate popping up) while the server should stay warm.
 *
 * State machine (`status`):
 *   - `loading` — an `ensure` call is in flight (mount, runId change, or a
 *     manual Retry/Restart).
 *   - `ready`   — the iframe is live at the resolved `baseUrl`. A
 *     `frame-terminated` watchdog event overlays a respawn affordance ON TOP
 *     of the (dead) iframe rather than replacing it — the spike verified a
 *     bare `src` reassignment (with a `?r=N` cache-buster; a `#r=N` fragment
 *     does NOT respawn the process) spawns a fresh OOPIF process.
 *   - `error`   — `ensure` failed (bridge absent, IPC error, or
 *     `success: false`). Fail-soft: never a wedged/blank frame.
 *   - `stopped` — the server went away out-of-band (`server-stopped` event).
 *     Same fail-soft shape as `error`, different copy/affordance ("Restart"
 *     re-ensures and swaps in the fresh `baseUrl`).
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { PrototypeFrameTerminationReason } from '../../../../../shared/types/designPrototypeServer';

interface InteractivePrototypeEmbedProps {
  runId: string;
}

type EmbedStatus = 'loading' | 'ready' | 'error' | 'stopped';

/**
 * The capture request/reply `type` values posted across the postMessage
 * boundary with the prototype frame's capture serializer
 * (main/src/services/designPrototypeServer.ts `CAPTURE_SERIALIZER_TAG`).
 * Duplicated as literals rather than imported: frontend/ never imports from
 * main/src (separate bundles), so this is a small cross-process protocol
 * string, mirrored intentionally — not a shared-module miss.
 */
const CAPTURE_REQUEST_TYPE = 'cyboflow-design-capture';
const CAPTURE_RESULT_TYPE = 'cyboflow-design-capture-result';

/** How long `requestCapture` waits for a matching reply before rejecting. */
const CAPTURE_TIMEOUT_MS = 3000;

/**
 * Imperative handle exposed by {@link InteractivePrototypeEmbed} for comment
 * mode (design-mode.md "Comment mode", invariant 1 — faithful freeze).
 */
export interface InteractivePrototypeCaptureHandle {
  /**
   * Request a serialization of the LIVE rendered DOM from the prototype
   * frame. Mints a fresh `captureId`, posts `{ type: 'cyboflow-design-
   * capture', captureId }` to the frame, and resolves with the `html` from
   * the matching `{ type: 'cyboflow-design-capture-result', captureId, html
   * }` reply.
   *
   * Validated by SOURCE IDENTITY (`event.source === iframe.contentWindow`) +
   * message shape — NEVER by `event.origin`: the frame's sandbox carries no
   * `allow-same-origin`, so its origin is the opaque string `'null'` and is
   * useless for authentication. A reply from a different source, a stale/
   * mismatched captureId, or a malformed shape is silently ignored (a later
   * matching reply can still resolve the same pending call).
   *
   * Rejects when no frame is live (status !== 'ready') or after a 3s
   * timeout with no matching reply.
   */
  requestCapture(): Promise<string>;
}

/**
 * Append a cache-busting query param so a re-set `src` is a genuinely
 * different URL string (React/Chromium won't re-navigate an unchanged `src`
 * assignment) — spike-verified: a `src` reassignment spawns a fresh OOPIF
 * process; `n === 0` (no reload yet) returns the token URL unchanged.
 */
function withCacheBust(url: string, n: number): string {
  if (n <= 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}r=${n}`;
}

export const InteractivePrototypeEmbed = forwardRef<InteractivePrototypeCaptureHandle, InteractivePrototypeEmbedProps>(
  function InteractivePrototypeEmbed({ runId }, ref): ReactElement {
  const [status, setStatus] = useState<EmbedStatus>('loading');
  const [baseUrl, setBaseUrl] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [terminated, setTerminated] = useState<{ reason: PrototypeFrameTerminationReason } | null>(null);
  const isMountedRef = useRef(true);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Ensure (or return the already-running) server for this runId. Re-created
  // per runId so the mount effect below re-fires on a runId change, and
  // reused as the Retry/Restart click handler.
  const runEnsure = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setTerminated(null);
    const bridge = window.electronAPI?.designPrototypeServer;
    if (!bridge) {
      if (isMountedRef.current) setStatus('error');
      return;
    }
    try {
      const result = await bridge.ensure({ runId });
      if (!isMountedRef.current) return;
      if (result.success && result.data) {
        setBaseUrl(result.data.baseUrl);
        setReloadNonce(0);
        setStatus('ready');
      } else {
        setStatus('error');
      }
    } catch {
      if (isMountedRef.current) setStatus('error');
    }
  }, [runId]);

  useEffect(() => {
    void runEnsure();
  }, [runEnsure]);

  // Watchdog + server-lifecycle events, filtered to THIS embed's runId — the
  // channel is process-wide (one design-mode surface, potentially multiple
  // prototype servers across a session's runs).
  useEffect(() => {
    const bridge = window.electronAPI?.designPrototypeServer;
    if (!bridge) return;
    const unsubscribe = bridge.onEvent((event) => {
      if (event.runId !== runId) return;
      if (event.kind === 'frame-terminated') {
        setTerminated({ reason: event.reason ?? 'cpu' });
      } else if (event.kind === 'server-stopped') {
        setStatus('stopped');
        setTerminated(null);
      }
    });
    return () => unsubscribe();
  }, [runId]);

  const handleReload = useCallback(() => {
    setReloadNonce((n) => n + 1);
    setTerminated(null);
  }, []);

  const requestCapture = useCallback((): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const frameWindow = iframeRef.current?.contentWindow ?? null;
      if (status !== 'ready' || frameWindow === null) {
        reject(new Error('Prototype frame is not ready'));
        return;
      }
      const captureId = crypto.randomUUID();
      let settled = false;

      const cleanup = (): void => {
        window.clearTimeout(timeoutId);
        window.removeEventListener('message', onMessage);
      };

      const onMessage = (event: MessageEvent): void => {
        if (settled) return;
        // Source identity, not origin — see the handle's doc comment: an
        // `allow-scripts`-only sandboxed frame has an opaque 'null' origin.
        if (event.source !== frameWindow) return;
        const data: unknown = event.data;
        if (
          typeof data !== 'object' ||
          data === null ||
          (data as { type?: unknown }).type !== CAPTURE_RESULT_TYPE ||
          (data as { captureId?: unknown }).captureId !== captureId ||
          typeof (data as { html?: unknown }).html !== 'string'
        ) {
          return;
        }
        settled = true;
        cleanup();
        resolve((data as { html: string }).html);
      };

      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('Capture request timed out'));
      }, CAPTURE_TIMEOUT_MS);

      window.addEventListener('message', onMessage);
      frameWindow.postMessage({ type: CAPTURE_REQUEST_TYPE, captureId }, '*');
    });
  }, [status]);

  useImperativeHandle(ref, () => ({ requestCapture }), [requestCapture]);

  if (status === 'loading') {
    return (
      <div data-testid="interactive-embed" className="relative flex-1 flex flex-col min-h-0">
        <div className="h-full w-full flex items-center justify-center">
          <span data-testid="interactive-embed-loading" className="text-xs text-text-muted">
            Starting prototype server…
          </span>
        </div>
      </div>
    );
  }

  if (status === 'error' || status === 'stopped') {
    const title = status === 'error' ? 'Prototype server unavailable' : 'Prototype server stopped';
    const buttonLabel = status === 'error' ? 'Retry' : 'Restart';
    return (
      <div data-testid="interactive-embed" className="relative flex-1 flex flex-col min-h-0">
        <div
          data-testid="interactive-embed-error"
          className="h-full w-full flex flex-col items-center justify-center gap-3"
        >
          <span className="text-xs text-text-muted">{title}</span>
          <button
            type="button"
            onClick={() => void runEnsure()}
            className="text-xs font-bold text-text-primary bg-bg-primary border border-border-primary rounded px-3 py-1"
          >
            {buttonLabel}
          </button>
        </div>
      </div>
    );
  }

  // status === 'ready'
  const iframeSrc = baseUrl !== null ? withCacheBust(baseUrl, reloadNonce) : undefined;

  return (
    <div data-testid="interactive-embed" className="relative flex-1 flex flex-col min-h-0">
      <iframe
        ref={iframeRef}
        data-testid="interactive-embed-iframe"
        src={iframeSrc}
        title="Interactive prototype"
        // SECURITY-CRITICAL: allow-scripts ONLY — no allow-same-origin. See the
        // header comment: the cross-origin loopback origin is what gives the
        // frame its own OOPIF process; allow-same-origin would defeat that.
        sandbox="allow-scripts"
        className="flex-1 w-full border-0 bg-surface-primary min-h-0"
      />
      {terminated && (
        <div
          data-testid="interactive-embed-terminated"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 backdrop-blur-[2px]"
          style={{ backgroundColor: 'color-mix(in srgb, var(--color-bg-primary) 65%, transparent)' }}
        >
          <span className="text-xs text-text-primary font-medium">
            {terminated.reason === 'memory'
              ? 'Prototype terminated — it exhausted memory'
              : 'Prototype terminated — it pegged the CPU'}
          </span>
          <button
            type="button"
            data-testid="interactive-embed-reload"
            onClick={handleReload}
            className="text-xs font-bold text-text-primary bg-bg-primary border border-border-primary rounded px-3 py-1"
          >
            Reload prototype
          </button>
        </div>
      )}
    </div>
  );
  },
);
