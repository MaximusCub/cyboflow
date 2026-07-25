/**
 * Unit tests for DesignPrototypeServerManager — the token-gated single-resource
 * loopback prototype server. Drives the REAL node server over loopback fetch,
 * with the HTML loader, origin registry, and watchdog control injected as fakes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DesignPrototypeServerManager } from '../designPrototypeServer';
import type { FrameWatchdogControl } from '../designFrameWatchdog';
import { ARTIFACT_INTERACTIVE_CSP } from '../../../../shared/types/artifacts';

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
