/**
 * Functional tests for NodeHttpExecutor against a real loopback HTTP server.
 *
 * The AppUpdater tests mock electron-updater wholesale, so they prove the
 * transport is *selected* but nothing about whether it *works*. This suite
 * exercises the real thing end to end — request, redirect following, download
 * to disk, progress reporting and checksum verification — because the whole
 * point of the swap is that Node's stack carries the update feed unaided.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { createHash, randomBytes } from 'crypto';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CancellationToken } from 'builder-util-runtime';
import { NodeHttpExecutor } from '../nodeHttpExecutor';

const PAYLOAD = randomBytes(64 * 1024);
const PAYLOAD_SHA512 = createHash('sha512').update(PAYLOAD).digest('base64');

let server: Server | null = null;
const scratch: string[] = [];

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address == null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function scratchFile(): string {
  const path = join(tmpdir(), `node-http-executor-${randomBytes(8).toString('hex')}.bin`);
  scratch.push(path);
  return path;
}

afterEach(async () => {
  if (server != null) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await Promise.all(scratch.splice(0).map((p) => rm(p, { force: true })));
});

describe('NodeHttpExecutor', () => {
  it('fetches a feed body over plain HTTP', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/yaml' });
      res.end('version: 0.2.11\n');
    });

    const body = await new NodeHttpExecutor().request({
      ...urlOptions(base, '/latest-mac.yml'),
    });

    expect(body).toBe('version: 0.2.11\n');
  });

  it('surfaces an HTTP status as an error carrying statusCode', async () => {
    // AppUpdater's fallback classifier keys off statusCode to decide that the
    // transport was fine and a retry elsewhere is pointless.
    const base = await listen((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });

    const error = await new NodeHttpExecutor()
      .request({ ...urlOptions(base, '/missing.yml') })
      .catch((e: unknown) => e);

    expect((error as { statusCode?: number }).statusCode).toBe(404);
  });

  it('follows redirects', async () => {
    // The Electron executor overrides addRedirectHandlers for electron.net's
    // 'redirect' event; the Node path must work on the base implementation.
    const base = await listen((req, res) => {
      if (req.url === '/latest-mac.yml') {
        res.writeHead(302, { Location: '/real/latest-mac.yml' });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end('version: 0.2.12\n');
    });

    const body = await new NodeHttpExecutor().request({
      ...urlOptions(base, '/latest-mac.yml'),
    });

    expect(body).toBe('version: 0.2.12\n');
  });

  it('downloads to disk, verifies sha512 and reports progress', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': String(PAYLOAD.length),
      });
      res.end(PAYLOAD);
    });
    const destination = scratchFile();
    const progress: number[] = [];

    const result = await new NodeHttpExecutor().download(
      new URL(`${base}/Cyboflow-0.2.11-mac.zip`),
      destination,
      {
        cancellationToken: new CancellationToken(),
        sha512: PAYLOAD_SHA512,
        onProgress: (p) => progress.push(p.transferred),
      },
    );

    expect(result).toBe(destination);
    expect(await readFile(destination)).toEqual(PAYLOAD);
    expect(progress.at(-1)).toBe(PAYLOAD.length);
  });

  it('rejects a download whose checksum does not match', async () => {
    const base = await listen((_req, res) => {
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
    });

    await expect(
      new NodeHttpExecutor().download(new URL(`${base}/tampered.zip`), scratchFile(), {
        cancellationToken: new CancellationToken(),
        sha512: createHash('sha512').update('something else').digest('base64'),
      }),
    ).rejects.toThrow(/checksum mismatch/i);
  });

  it('reports a refused connection as ECONNREFUSED', async () => {
    // This is the code AppUpdater's fallback keys off; pin the real shape
    // rather than trusting a hand-built fake.
    const base = await listen((_req, res) => res.end());
    const port = (server!.address() as { port: number }).port;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    void base;

    const error = await new NodeHttpExecutor()
      .request({ protocol: 'http:', hostname: '127.0.0.1', port, path: '/', method: 'GET' })
      .catch((e: unknown) => e);

    expect((error as { code?: string }).code).toBe('ECONNREFUSED');
  });
});

function urlOptions(base: string, path: string) {
  const url = new URL(`${base}${path}`);
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: Number(url.port),
    path: url.pathname,
    method: 'GET' as const,
  };
}
