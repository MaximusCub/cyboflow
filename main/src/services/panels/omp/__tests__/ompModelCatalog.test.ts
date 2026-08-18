/**
 * Unit tests for OmpModelCatalogProbe.
 *
 * Two things matter beyond "it returns rows": the canonical `<provider>/<id>`
 * composition (the wire id alone is bare and would be mistaken for a first-party
 * Claude id by `isOmpModelFamily`), and the probe's lockdown flags — a probe runs
 * against whatever directory the app is in, so `--no-extensions`/`--no-skills`
 * are what stop a project's `.omp/` discovery executing repo TypeScript.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OmpRpcClientOptions } from '../rpc';
import {
  OMP_MODEL_CATALOG_CACHE_TTL_MS,
  OMP_MODEL_CATALOG_PROBE_ARGS,
  OmpModelCatalogProbe,
  type OmpModelCatalogProbeClient,
} from '../ompModelCatalog';

const ROWS = [
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'openai' },
  // Same bare id under a second vendor — only the composed id is unique.
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (Bedrock)', provider: 'bedrock' },
];

class FakeProbeClient implements OmpModelCatalogProbeClient {
  readonly start = vi.fn(() => undefined);
  readonly handshake = vi.fn(async () => ({}));
  readonly stop = vi.fn(async () => undefined);
  readonly getAvailableModels: () => Promise<readonly { id: string; name?: string; provider: string }[]>;

  constructor(
    readonly options: OmpRpcClientOptions,
    rows: readonly { id: string; name?: string; provider: string }[] = ROWS,
  ) {
    this.getAvailableModels = vi.fn(async () => rows);
  }
}

function makeProbe(
  rows: readonly { id: string; name?: string; provider: string }[] = ROWS,
  now: () => number = () => 0,
): { probe: OmpModelCatalogProbe; clients: FakeProbeClient[] } {
  const clients: FakeProbeClient[] = [];
  const probe = new OmpModelCatalogProbe({
    createClient: (options) => {
      const client = new FakeProbeClient(options, rows);
      clients.push(client);
      return client;
    },
    resolveExecutablePath: async () => '/usr/local/bin/omp',
    now,
  });
  return { probe, clients };
}

describe('OmpModelCatalogProbe', () => {
  it('composes canonical ids, de-duplicates on them, and stops the probe', async () => {
    const { probe, clients } = makeProbe();

    await expect(probe.getCatalog()).resolves.toEqual({
      models: [
        { id: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', ompProvider: 'anthropic' },
        { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol', ompProvider: 'openai' },
        {
          id: 'bedrock/claude-haiku-4-5',
          label: 'Claude Haiku 4.5 (Bedrock)',
          ompProvider: 'bedrock',
        },
      ],
    });
    expect(clients).toHaveLength(1);
    expect(clients[0].start).toHaveBeenCalledOnce();
    expect(clients[0].stop).toHaveBeenCalledOnce();
  });

  it('falls back to the bare id as the label when a row names nothing', async () => {
    const { probe } = makeProbe([{ id: 'mystery-1', provider: 'local' }]);
    await expect(probe.getCatalog()).resolves.toEqual({
      models: [{ id: 'local/mystery-1', label: 'mystery-1', ompProvider: 'local' }],
    });
  });

  it('spawns the probe locked down', async () => {
    const { probe, clients } = makeProbe();
    await probe.getCatalog();

    const args = clients[0].options.args ?? [];
    expect(args).toEqual(OMP_MODEL_CATALOG_PROBE_ARGS);
    // Discovery lockdown (proposal §8.2) plus an approval mode that fails closed.
    expect(args).toContain('--no-extensions');
    expect(args).toContain('--no-skills');
    expect(args).toContain('--no-session');
    expect(args).toContain('--approval-mode');
    expect(clients[0].options.command).toBe('/usr/local/bin/omp');
  });

  it('serves the cache inside the TTL and re-probes after it', async () => {
    let clock = 0;
    const { probe, clients } = makeProbe(ROWS, () => clock);

    await probe.getCatalog();
    clock = OMP_MODEL_CATALOG_CACHE_TTL_MS - 1;
    await probe.getCatalog();
    expect(clients).toHaveLength(1);

    clock = OMP_MODEL_CATALOG_CACHE_TTL_MS + 1;
    await probe.getCatalog();
    expect(clients).toHaveLength(2);
  });

  it('de-duplicates concurrent callers onto one probe', async () => {
    const { probe, clients } = makeProbe();

    const [first, second] = await Promise.all([probe.getCatalog(), probe.getCatalog()]);

    expect(clients).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('hands back a copy, so a caller cannot mutate the cache', async () => {
    const { probe } = makeProbe();
    const first = await probe.getCatalog();
    first.models[0].label = 'tampered';

    expect((await probe.getCatalog()).models[0].label).toBe('Claude Haiku 4.5');
  });

  it('rejects (and still stops the child) when OMP lists no models', async () => {
    const { probe, clients } = makeProbe([]);

    await expect(probe.getCatalog()).rejects.toThrow(/no models/);
    expect(clients[0].stop).toHaveBeenCalledOnce();
  });

  it('reaps a mid-flight probe at shutdown', async () => {
    const clients: FakeProbeClient[] = [];
    let release: () => void = () => undefined;
    const probe = new OmpModelCatalogProbe({
      createClient: (options) => {
        const client = new FakeProbeClient(options);
        client.handshake.mockImplementation(
          () =>
            new Promise((resolve) => {
              release = () => resolve({});
            }),
        );
        clients.push(client);
        return client;
      },
      resolveExecutablePath: async () => '/usr/local/bin/omp',
    });

    const pending = probe.getCatalog();
    await vi.waitFor(() => expect(clients).toHaveLength(1));

    await probe.shutdown();
    expect(clients[0].stop).toHaveBeenCalled();

    release();
    await pending;
  });
});
