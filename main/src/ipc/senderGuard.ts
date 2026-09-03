/**
 * senderGuard — one sender check in front of EVERY `ipcMain.handle` channel.
 *
 * `ipcMain.handle` dispatches on channel name alone: any frame in any
 * WebContents that can reach `ipcRenderer.invoke` gets the handler, and cyboflow
 * registers ~194 of them (git execution, project-scoped file writes, session
 * control). The renderer's own preload allowlist (main/src/preload.ts →
 * GENERIC_INVOKE_CHANNELS) narrows what the MAIN window may ask for, but it is
 * renderer-side and says nothing about WHO asked. This module is the
 * main-process half: only the app's own top-level renderer frame is served.
 *
 * Rejected by construction:
 *   - `about:srcdoc` static-mockup artifact frames,
 *   - `http://127.0.0.1:<port>` design-prototype loopback frames (Design Mode),
 *   - any sub-frame, even one whose URL would otherwise pass,
 *   - `data:`/`blob:`/custom-scheme documents and stray file:// documents.
 * None of those frames are given a preload (see `createWindow` in
 * main/src/index.ts and DesignPrototypeServerManager), so none has a legitimate
 * IPC surface today; the guard makes that a main-process invariant rather than
 * a property of how the frames happen to be configured.
 *
 * INSTALLATION is a deliberate monkeypatch of the `ipcMain` singleton rather
 * than a wrapped `IpcMain` passed to each `register*` module: several modules
 * (`uiState`, `logs`, `artifactHtml`, `artifactImages`, `designPrototypeServer`)
 * import `ipcMain` directly instead of taking it as a parameter, and two
 * handlers are registered inline in `main/src/index.ts`. Patching the singleton
 * covers every one of them from a single call site.
 *
 * The tRPC surface is guarded too: `trpc-electron` rides
 * `ipcMain.on(ELECTRON_TRPC_CHANNEL)`, not `handle`, so `ipcMain.on` is ALSO
 * patched — for that one channel only — with the same frame-identity check. As
 * the IPC→tRPC migration moves channels off `ipcMain.handle`, this is what
 * keeps them on the guarded surface. An `.on` listener has no return path for a
 * rejection envelope, so an untrusted frame's tRPC message is DROPPED (logged,
 * never answered) — its request simply never resolves, which is fine for a
 * frame that has no preload and therefore no legitimate way to have sent one.
 */
import { ipcMain, app } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

/**
 * trpc-electron's wire channel — the literal behind its ELECTRON_TRPC_CHANNEL
 * export. Declared locally rather than imported because importing
 * 'trpc-electron/main' here would drag the real package (and its own `electron`
 * named imports) into every unit test that transitively loads this module.
 * senderGuard.test.ts pins this literal against the package's OWN declaration,
 * so a channel rename in an upgrade fails a test instead of silently
 * registering the tRPC listener unwrapped.
 */
export const TRPC_ELECTRON_CHANNEL = 'trpc-electron';

/** Where the packaged/e2e renderer's document lives inside the app bundle. */
const RENDERER_DOCUMENT_SUFFIX = '/frontend/dist/index.html';

/**
 * Escape hatch for a field-diagnosable "the app can't talk to itself" boot
 * failure. Logged loudly on every rejected call it lets through so a run with
 * it set is never mistaken for a healthy one.
 */
const GUARD_DISABLED = process.env.CYBOFLOW_DISABLE_IPC_SENDER_GUARD === '1';

export interface SenderGuardConfig {
  /** `NODE_ENV !== 'production' && !app.isPackaged` — matches main/src/index.ts. */
  isDevelopment: boolean;
  /** Vite dev-server port the main window loads from (`CYBOFLOW_VITE_PORT` ?? 4521). */
  devRendererPort: string;
}

/**
 * Whether `frameUrl` identifies the app's own renderer document. PURE, so the
 * accept/reject matrix unit-tests without an Electron runtime.
 *
 * Development: the Vite dev server, and ONLY on `localhost` — `127.0.0.1` is
 * deliberately excluded because that is the design-prototype loopback host, and
 * treating the two spellings as interchangeable would hand a scripted prototype
 * frame the whole IPC surface on any port collision.
 *
 * Production: a `file:` document at the renderer's own bundle path. The suffix
 * match (rather than containment in `app.getAppPath()`) is what survives all
 * three real load paths — packaged inside `app.asar`, the unpackaged e2e launch
 * from the repo root, and `createWindow`'s relative fallback — while still
 * rejecting every other `file:` URL.
 */
export function isTrustedRendererFrameUrl(frameUrl: string, config: SenderGuardConfig): boolean {
  if (!frameUrl) return false;

  let parsed: URL;
  try {
    parsed = new URL(frameUrl);
  } catch {
    return false;
  }

  if (config.isDevelopment) {
    return parsed.protocol === 'http:' && parsed.host === `localhost:${config.devRendererPort}`;
  }

  if (parsed.protocol !== 'file:') return false;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  return pathname.endsWith(RENDERER_DOCUMENT_SUFFIX);
}

/**
 * The IPCResponse shape every cyboflow handler already returns, so a rejected
 * call reaches the renderer as an ordinary failed call rather than an opaque
 * "Error invoking remote method" thrown across the bridge.
 */
export interface SenderRejection {
  success: false;
  error: string;
}

export function senderRejection(channel: string): SenderRejection {
  return {
    success: false,
    error: `IPC channel "${channel}" is not available to this frame.`,
  };
}

/**
 * Decide whether an invoke (or a trpc-electron `.on` message — both event
 * shapes carry `senderFrame`) may proceed. Exported for direct unit testing of
 * the frame-identity rules (top-frame-ness plus URL) without patching the
 * singleton.
 */
export function isTrustedSender(
  event: IpcMainInvokeEvent | IpcMainEvent,
  config: SenderGuardConfig,
): boolean {
  const frame = event.senderFrame;
  // A destroyed or absent frame cannot be attributed to the main window; there
  // is no safe way to serve it.
  if (!frame) return false;
  // Top-level only. Every artifact/prototype surface is a SUB-frame of the main
  // window, so this alone excludes them regardless of what URL they hold.
  if (frame.parent !== null) return false;
  return isTrustedRendererFrameUrl(frame.url, config);
}

let installed = false;

/**
 * Patch `ipcMain.handle` (every channel) and `ipcMain.on` (the trpc-electron
 * channel only) so everything registered from this point on is
 * sender-validated. Idempotent — a second call is a no-op, so a re-entered boot
 * path cannot stack wrappers.
 *
 * Must run BEFORE any `ipcMain.handle` call AND before trpc-electron's
 * `createIPCHandler` registers its global `.on` listener: listeners registered
 * earlier keep their unwrapped form. `registerIpcHandlers` is the first
 * registration in the boot sequence (inside `initializeServices`, which
 * completes before `createWindow` calls `attachOrchestratorTrpcToWindow`),
 * which is why the install lives at the top of it.
 *
 * The `.on` wrapper breaks `removeListener`-by-reference for the wrapped
 * channel; acceptable because trpc-electron registers its listener once for the
 * process lifetime and never removes it.
 */
export function installIpcSenderGuard(config: SenderGuardConfig): void {
  if (installed) return;
  installed = true;

  if (GUARD_DISABLED) {
    console.warn(
      '[IPC] CYBOFLOW_DISABLE_IPC_SENDER_GUARD=1 — IPC sender validation is OFF. ' +
        'Every frame that can reach ipcRenderer.invoke is served. Do not run this way outside diagnosis.',
    );
    return;
  }

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    originalHandle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event, config)) {
        console.warn(
          `[IPC] Rejected "${channel}" from untrusted frame: ${event.senderFrame?.url ?? '<no frame>'}` +
            `${event.senderFrame && event.senderFrame.parent !== null ? ' (sub-frame)' : ''}`,
        );
        return senderRejection(channel);
      }
      return listener(event, ...args);
    });
  };

  // The tRPC bridge: wrap ONLY the trpc-electron channel — every other
  // `ipcMain.on` channel (terminal PTY bridge, panel events, …) keeps its
  // untouched listener and semantics. A rejected message is dropped, not
  // answered — see the module header.
  const originalOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = ((
    channel: string,
    listener: (event: IpcMainEvent, ...args: unknown[]) => void,
  ) => {
    if (channel !== TRPC_ELECTRON_CHANNEL) {
      return originalOn(channel, listener);
    }
    return originalOn(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event, config)) {
        console.warn(
          `[IPC] Dropped "${channel}" message from untrusted frame: ${event.senderFrame?.url ?? '<no frame>'}` +
            `${event.senderFrame && event.senderFrame.parent !== null ? ' (sub-frame)' : ''}`,
        );
        return;
      }
      listener(event, ...args);
    });
  }) as typeof ipcMain.on;
}

/** Config from the same sources `main/src/index.ts` uses for its own window load. */
export function resolveSenderGuardConfig(): SenderGuardConfig {
  return {
    isDevelopment: process.env.NODE_ENV !== 'production' && !app.isPackaged,
    devRendererPort: process.env.CYBOFLOW_VITE_PORT ?? '4521',
  };
}
