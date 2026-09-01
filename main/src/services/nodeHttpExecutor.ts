import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'http';
import type { RequestOptions } from 'http';
import { request as httpsRequest } from 'https';
import {
  HttpExecutor,
  configureRequestOptions,
  configureRequestUrl,
  type DownloadOptions,
} from 'builder-util-runtime';

/**
 * An electron-updater HTTP executor backed by Node's own http/https stack
 * instead of Chromium's.
 *
 * electron-updater ships `ElectronHttpExecutor`, which routes every update
 * request through `electron.net` on a cached "electron-updater" session. That
 * inherits Chromium's network service — and when that utility process dies
 * mid-run, the session stays bound to the dead network context and every
 * request fails with a bare net::ERR_FAILED until the app is relaunched
 * (see AppUpdater.watchNetworkService).
 *
 * Node's stack lives in the main process and is untouched by that crash, so
 * running the updater over it makes checks and downloads survive it. The cost
 * is that Node does not read the OS proxy configuration or the macOS keychain,
 * which a managed corporate machine may depend on — AppUpdater keeps the
 * Electron executor as a fallback for exactly that case.
 *
 * `builder-util-runtime`'s `HttpExecutor` base was written against Node's API,
 * so only `createRequest` is genuinely abstract. `download` is reimplemented
 * here solely because it lives on `ElectronHttpExecutor` rather than the base;
 * it is a thin wrapper over the inherited (Node-shaped) `doDownload`.
 * Redirect handling is deliberately NOT overridden: `ElectronHttpExecutor`
 * only overrides it because `electron.net` signals redirects through a
 * 'redirect' event, whereas the base class already implements the Node form.
 */
export class NodeHttpExecutor extends HttpExecutor<ClientRequest> {
  createRequest(
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest {
    return (options.protocol === 'http:' ? httpRequest : httpsRequest)(options, callback);
  }

  async download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    return await options.cancellationToken.createPromise<string>((resolve, reject, onCancel) => {
      const requestOptions: RequestOptions = { headers: options.headers ?? undefined };
      configureRequestUrl(url, requestOptions);
      configureRequestOptions(requestOptions);
      this.doDownload(
        requestOptions,
        {
          destination,
          options,
          onCancel,
          callback: (error: Error | null) => {
            if (error == null) resolve(destination);
            else reject(error);
          },
          responseHandler: null,
        },
        0,
      );
    });
  }
}

/**
 * Transport-level failures where retrying the same request through Chromium's
 * network stack can genuinely succeed: Node cannot see the OS proxy settings,
 * and validates TLS against its own bundled CA list rather than the macOS
 * keychain. Both are the signature of a managed/corporate network.
 *
 * Deliberately excludes anything that carries an HTTP status: a 404 or a 500
 * means the request reached the server, so the transport is not the problem
 * and a second attempt over a different one only doubles the latency.
 */
const FALLBACK_ERROR_CODES: ReadonlySet<string> = new Set([
  // TLS — an inspecting proxy's root certificate is in the keychain, which
  // Chromium reads and Node does not.
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
  // Connection — a network that only egresses through a proxy Node never saw.
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** True when `error` is a Node transport failure worth retrying over electron.net. */
export function isProxyOrCertTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (typeof (error as { statusCode?: unknown }).statusCode === 'number') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && FALLBACK_ERROR_CODES.has(code);
}
