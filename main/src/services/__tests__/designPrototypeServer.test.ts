/**
 * Unit tests for DesignPrototypeServerManager — the token-gated single-resource
 * loopback prototype server. Drives the REAL node server over loopback fetch,
 * with the HTML loader, origin registry, and watchdog control injected as fakes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DesignPrototypeServerManager } from '../designPrototypeServer';
import type { FrameWatchdogControl } from '../designFrameWatchdog';
import { ARTIFACT_INTERACTIVE_CSP } from '../../../../shared/types/artifacts';
import {
  DESIGN_INSPECTOR_NONCE_PLACEHOLDER,
  DESIGN_INSPECTOR_SCRIPT_TEMPLATE,
} from '../designInspectorScript';

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_INTERACTIVE_CSP}">`;

function makeManager(loadHtml: (runId: string) => Promise<string | null>) {
  const registerOrigin = vi.fn();
  const unregisterOrigin = vi.fn();
  const onServerStopped = vi.fn();
  const watchdog: FrameWatchdogControl = { start: vi.fn(), stop: vi.fn() };
  const manager = new DesignPrototypeServerManager({
    loadHtml,
    watchdog,
    onServerStopped,
    registerOrigin,
    unregisterOrigin,
  });
  return { manager, registerOrigin, unregisterOrigin, onServerStopped, watchdog };
}

/** Parse `http://127.0.0.1:<port>` origin out of a full tokenized baseUrl. */
function originOf(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.host}`;
}

let managers: DesignPrototypeServerManager[] = [];
function track(m: DesignPrototypeServerManager): DesignPrototypeServerManager {
  managers.push(m);
  return m;
}
afterEach(async () => {
  for (const m of managers) await m.stopAll();
  managers = [];
});

describe('DesignPrototypeServerManager serving', () => {
  it('serves the CSP-injected canonical bytes at the tokenized path (meta at position 0)', async () => {
    const { manager } = makeManager(async () => '<html><body>hello</body></html>');
    track(manager);
    const baseUrl = await manager.ensure('run-1');

    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body.startsWith(CSP_META)).toBe(true);
    expect(body).toContain('hello');
  });

  it('injects the capture serializer after the CSP meta and ahead of prototype markup', async () => {
    const { manager } = makeManager(async () => '<html><body>hello</body></html>');
    track(manager);
    const body = await (await fetch(await manager.ensure('run-1'))).text();

    // The comment-mode capture request the serializer answers, and the reply it posts.
    expect(body).toContain("data.type !== 'cyboflow-design-capture'");
    expect(body).toContain("type: 'cyboflow-design-capture-result'");
    expect(body).toContain("'<!doctype html>' + document.documentElement.outerHTML");
    // Ordering: CSP first (position 0), then the serializer, then untrusted markup.
    expect(body.indexOf(CSP_META)).toBe(0);
    expect(body.indexOf('cyboflow-design-capture')).toBeLessThan(body.indexOf('hello'));
  });

  it('404s a wrong-token path, a stray path, and 405s a disallowed method', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    const baseUrl = await manager.ensure('run-1');
    const origin = originOf(baseUrl);

    const wrongToken = await fetch(`${origin}/deadbeef/prototype/index.html`);
    expect(wrongToken.status).toBe(404);
    const stray = await fetch(`${origin}/`);
    expect(stray.status).toBe(404);
    const post = await fetch(baseUrl, { method: 'POST' });
    expect(post.status).toBe(405);
  });

  it('reloads FRESH per request — a changed loader output is served without a restart', async () => {
    let version = 'v1';
    const { manager } = makeManager(async () => `<html>${version}</html>`);
    track(manager);
    const baseUrl = await manager.ensure('run-1');

    expect(await (await fetch(baseUrl)).text()).toContain('v1');
    version = 'v2';
    expect(await (await fetch(baseUrl)).text()).toContain('v2');
  });

  it('404s when the canonical bytes are absent (null load) — fail-soft', async () => {
    const { manager } = makeManager(async () => null);
    track(manager);
    const baseUrl = await manager.ensure('run-1');
    const res = await fetch(baseUrl);
    expect(res.status).toBe(404);
  });
});

describe('DesignPrototypeServerManager lifecycle', () => {
  it('ensure is idempotent — same baseUrl, one origin registration, one watchdog start', async () => {
    const { manager, registerOrigin, watchdog } = makeManager(async () => '<html>ok</html>');
    track(manager);
    const a = await manager.ensure('run-1');
    const b = await manager.ensure('run-1');
    expect(a).toBe(b);
    expect(registerOrigin).toHaveBeenCalledTimes(1);
    expect(registerOrigin).toHaveBeenCalledWith(originOf(a));
    expect(watchdog.start).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent ensures for one runId into a single server', async () => {
    const { manager, registerOrigin } = makeManager(async () => '<html>ok</html>');
    track(manager);
    const [a, b] = await Promise.all([manager.ensure('run-1'), manager.ensure('run-1')]);
    expect(a).toBe(b);
    expect(registerOrigin).toHaveBeenCalledTimes(1);
  });

  it('stop releases the port, unregisters the origin, and stops the watchdog', async () => {
    const { manager, unregisterOrigin, watchdog } = makeManager(async () => '<html>ok</html>');
    track(manager);
    const baseUrl = await manager.ensure('run-1');
    const origin = originOf(baseUrl);

    const stopped = await manager.stop('run-1');
    expect(stopped).toBe(true);
    expect(unregisterOrigin).toHaveBeenCalledWith(origin);
    expect(watchdog.stop).toHaveBeenCalledTimes(1);
    // The port is released — a fetch to the old URL now fails to connect.
    await expect(fetch(baseUrl)).rejects.toBeTruthy();
  });

  it('stop returns false when no server is running for the runId', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    expect(await manager.stop('never-started')).toBe(false);
  });

  it('does NOT fire onServerStopped on an explicit stop (the caller asked for it)', async () => {
    const { manager, onServerStopped } = makeManager(async () => '<html>ok</html>');
    track(manager);
    await manager.ensure('run-1');
    await manager.stop('run-1');
    expect(onServerStopped).not.toHaveBeenCalled();
  });

  it('stopAll tears down every server, unregisters each origin, and notifies out-of-band', async () => {
    const { manager, unregisterOrigin, onServerStopped, watchdog } = makeManager(async () => '<html>ok</html>');
    track(manager);
    const a = await manager.ensure('run-1');
    const b = await manager.ensure('run-2');

    await manager.stopAll();
    expect(unregisterOrigin).toHaveBeenCalledWith(originOf(a));
    expect(unregisterOrigin).toHaveBeenCalledWith(originOf(b));
    expect(onServerStopped).toHaveBeenCalledWith('run-1');
    expect(onServerStopped).toHaveBeenCalledWith('run-2');
    expect(watchdog.stop).toHaveBeenCalled();
    await expect(fetch(a)).rejects.toBeTruthy();
  });

  it('exposes live (origin, runId) targets for the watchdog', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    const a = await manager.ensure('run-1');
    expect(manager.getTargets()).toEqual([{ origin: originOf(a), runId: 'run-1' }]);
    await manager.stop('run-1');
    expect(manager.getTargets()).toEqual([]);
  });
});

// Design Mode v1 comment mode (design-mode.md "Comment mode — live-DOM freeze +
// sanitizer + nonce-CSP"): the sanitized freeze is hosted back off the run's own
// prototype server under a nonce-only CSP, with the app-owned inspector as the
// only thing in the document carrying that nonce.
const FROZEN = '<html><body><p>frozen</p></body></html>';

/** The nonce out of a `script-src 'nonce-…'` CSP header, or null. */
function nonceFromCsp(header: string | null): string | null {
  return /script-src 'nonce-([^']+)'/.exec(header ?? '')?.[1] ?? null;
}

describe('DesignPrototypeServerManager comment documents', () => {
  it('serves the hosted capture under a nonce CSP header whose nonce matches the injected inspector', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    await manager.ensure('run-1');
    const { url } = await manager.hostCommentDocument('run-1', FROZEN);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');

    const csp = res.headers.get('content-security-policy');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain('img-src data:');
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");

    const nonce = nonceFromCsp(csp);
    expect(nonce).toBeTruthy();
    const body = await res.text();
    // The header nonce IS the injected script's nonce — a mismatch would leave
    // the inspector inert and the comment frame unusable.
    expect(body).toContain(`<script nonce="${nonce as string}">`);
    // The placeholder is fully substituted, never shipped literally.
    expect(body).not.toContain(DESIGN_INSPECTOR_NONCE_PLACEHOLDER);
    // The inspector precedes the captured markup, which survives verbatim.
    expect(body.indexOf('cyboflow-design-inspect')).toBeLessThan(body.indexOf('frozen'));
    expect(body).toContain('<p>frozen</p>');
  });

  it('mints a FRESH nonce and captureId per host call', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    await manager.ensure('run-1');

    const first = await manager.hostCommentDocument('run-1', FROZEN);
    const firstNonce = nonceFromCsp((await fetch(first.url)).headers.get('content-security-policy'));
    const second = await manager.hostCommentDocument('run-1', FROZEN);
    const secondNonce = nonceFromCsp((await fetch(second.url)).headers.get('content-security-policy'));

    expect(first.url).not.toBe(second.url);
    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
  });

  it('retains only the CURRENT capture — a new host evicts the previous URL (404)', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    await manager.ensure('run-1');

    const first = await manager.hostCommentDocument('run-1', '<html><body>old</body></html>');
    expect((await fetch(first.url)).status).toBe(200);
    const second = await manager.hostCommentDocument('run-1', '<html><body>new</body></html>');

    expect((await fetch(first.url)).status).toBe(404);
    expect(await (await fetch(second.url)).text()).toContain('new');
  });

  it('404s an unknown captureId and 405s a non-GET/HEAD on the comment path', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    const baseUrl = await manager.ensure('run-1');
    const { url } = await manager.hostCommentDocument('run-1', FROZEN);
    const origin = originOf(baseUrl);
    const token = new URL(baseUrl).pathname.split('/')[1] as string;

    expect((await fetch(`${origin}/${token}/comment/deadbeef.html`)).status).toBe(404);
    // Right captureId, wrong token — still an indistinguishable 404.
    expect((await fetch(`${origin}/badtoken/comment/x.html`)).status).toBe(404);
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(200);
  });

  it('rejects hosting against a stopped or never-started server', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    await expect(manager.hostCommentDocument('never-started', FROZEN)).rejects.toThrow(
      /No prototype server is running/,
    );

    await manager.ensure('run-1');
    await manager.stop('run-1');
    await expect(manager.hostCommentDocument('run-1', FROZEN)).rejects.toThrow(
      /No prototype server is running/,
    );
  });

  it('drops hosted captures when the server stops (the URL stops resolving)', async () => {
    const { manager } = makeManager(async () => '<html>ok</html>');
    track(manager);
    await manager.ensure('run-1');
    const { url } = await manager.hostCommentDocument('run-1', FROZEN);
    expect((await fetch(url)).status).toBe(200);

    await manager.stop('run-1');
    await expect(fetch(url)).rejects.toBeTruthy();
  });

  it('keeps the prototype document reachable alongside a hosted capture', async () => {
    const { manager } = makeManager(async () => '<html><body>proto</body></html>');
    track(manager);
    const baseUrl = await manager.ensure('run-1');
    await manager.hostCommentDocument('run-1', FROZEN);

    const res = await fetch(baseUrl);
    expect(res.status).toBe(200);
    // The prototype keeps its meta CSP; only the comment doc gets a header policy.
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(await res.text()).toContain('proto');
  });
});

describe('design inspector script', () => {
  it('uses no dynamic-code primitive (eval / new Function / script injection)', () => {
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).not.toMatch(/\beval\b/);
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).not.toMatch(/new\s+Function/);
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).not.toMatch(/createElement\(\s*['"]script/i);
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
  });

  it('carries the nonce placeholder and posts hover/pick stacks to the parent', () => {
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).toContain(
      `<script nonce="${DESIGN_INSPECTOR_NONCE_PLACEHOLDER}">`,
    );
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).toContain("post('hover'");
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).toContain("post('pick'");
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).toContain("getAttribute('data-design-id')");
    // Belt to the navigation guard's suspenders.
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).toContain("addEventListener('submit'");
    expect(DESIGN_INSPECTOR_SCRIPT_TEMPLATE).toContain("addEventListener('keydown'");
  });
});
