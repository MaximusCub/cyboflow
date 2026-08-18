/**
 * ompModelCatalog — the model picker's data source for OMP.
 *
 * OMP advertises its catalogue over RPC (`get_available_models`) rather than as
 * a static list, so discovery means spawning a short-lived `omp --mode rpc`
 * child, handshaking, asking, and stopping it — structurally the Codex
 * `model/list` probe (`codexSdkManager.fetchCodexModelCatalog`), including its
 * 5-minute TTL and its single-flight de-duplication.
 *
 * TWO THINGS ARE OMP-SPECIFIC:
 *
 *  1. THE ID IS COMPOSED, NOT COPIED. A wire row keeps the halves apart —
 *     `{ id: 'claude-3-5-sonnet-20240620', provider: 'anthropic', … }` — so the
 *     bare `id` is indistinguishable from a first-party Claude id. The canonical
 *     form cyboflow persists and spawns with is `<provider>/<id>`, which is what
 *     OMP's own `--model` / `set_model` accept and what `isOmpModelFamily` keys
 *     on. See `OmpModelOption` in shared/types/agentModels.ts.
 *  2. THE PROBE IS LOCKED DOWN LIKE A REAL SPAWN. `--no-extensions --no-skills`
 *     stop the project's own `.omp/` discovery from executing repo TypeScript at
 *     startup (proposal §8.2) — a probe runs against whatever directory the app
 *     happens to be in, so this is not optional. `--no-session` keeps the probe
 *     out of the user's session list, and `--approval-mode always-ask` means a
 *     probe that somehow reached a tool would fail closed rather than run it.
 *     No gate extension is passed: a probe issues no prompt and runs no turn.
 */
import type { Logger } from '../../../utils/logger';
import type { OmpModelCatalog } from '../../../../../shared/types/agentModels';
import { perfBump } from '../../perfTracer';
import { detectOmpAvailability } from './ompAvailability';
import { OmpRpcClient, type OmpModel, type OmpRpcClientOptions } from './rpc';

/** How long a fetched catalogue is served from memory (Codex parity). */
export const OMP_MODEL_CATALOG_CACHE_TTL_MS = 5 * 60_000;

/** Wall-clock budget for the probe's handshake and its one request. */
const OMP_PROBE_TIMEOUT_MS = 20_000;

/**
 * argv the catalogue probe adds after `--mode rpc`. Kept exported so the
 * lockdown is assertable rather than merely reviewed.
 */
export const OMP_MODEL_CATALOG_PROBE_ARGS: readonly string[] = [
  '--approval-mode',
  'always-ask',
  '--no-extensions',
  '--no-skills',
  '--no-session',
  '--no-title',
];

/** The subset of `OmpRpcClient` the probe drives. */
export interface OmpModelCatalogProbeClient {
  start(): void;
  handshake(): Promise<unknown>;
  getAvailableModels(): Promise<readonly OmpModel[]>;
  stop(signal?: NodeJS.Signals): Promise<void>;
}

export type OmpModelCatalogProbeClientFactory = (
  options: OmpRpcClientOptions,
) => OmpModelCatalogProbeClient;

export interface OmpModelCatalogProbeDeps {
  createClient?: OmpModelCatalogProbeClientFactory;
  /** Resolves the `omp` binary; defaults to the shared availability probe. */
  resolveExecutablePath?: () => Promise<string>;
  logger?: Logger;
  now?: () => number;
}

async function defaultResolveExecutablePath(): Promise<string> {
  const availability = await detectOmpAvailability();
  if (availability.state !== 'detected' || !availability.binaryPath) {
    throw new Error('OMP is not available on this machine (no usable `omp` binary found)');
  }
  return availability.binaryPath;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, description: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${description} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Project one wire row. A row missing either half of the canonical id is dropped
 * rather than surfaced half-formed — the transport already guarantees both are
 * strings, so this is belt-and-braces against a future widening there.
 */
function projectRow(row: OmpModel): OmpModelCatalog['models'][number] {
  return {
    id: `${row.provider}/${row.id}`,
    label: row.name ?? row.id,
    ompProvider: row.provider,
  };
}

function cloneCatalog(catalog: OmpModelCatalog): OmpModelCatalog {
  return { models: catalog.models.map((model) => ({ ...model })) };
}

export class OmpModelCatalogProbe {
  private readonly createClient: OmpModelCatalogProbeClientFactory;
  private readonly resolveExecutablePath: () => Promise<string>;
  private readonly logger?: Logger;
  private readonly now: () => number;

  private catalog: OmpModelCatalog | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<OmpModelCatalog> | null = null;
  /** Live probe clients, so an app shutdown reaps one that is mid-flight. */
  private readonly clients = new Set<OmpModelCatalogProbeClient>();

  constructor(deps: OmpModelCatalogProbeDeps = {}) {
    this.createClient = deps.createClient ?? ((options) => new OmpRpcClient(options));
    this.resolveExecutablePath = deps.resolveExecutablePath ?? defaultResolveExecutablePath;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => Date.now());
  }

  async getCatalog(): Promise<OmpModelCatalog> {
    if (this.catalog && this.now() - this.fetchedAt < OMP_MODEL_CATALOG_CACHE_TTL_MS) {
      return cloneCatalog(this.catalog);
    }
    this.inFlight ??= this.fetchCatalog();
    try {
      const catalog = await this.inFlight;
      this.catalog = catalog;
      this.fetchedAt = this.now();
      return cloneCatalog(catalog);
    } finally {
      this.inFlight = null;
    }
  }

  /** Stop any probe still running (app shutdown). */
  async shutdown(): Promise<void> {
    const clients = [...this.clients];
    this.clients.clear();
    await Promise.all(
      clients.map((client) =>
        client.stop().catch((error: unknown) => {
          this.logger?.warn(
            `[OmpModelCatalogProbe] teardown failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }),
      ),
    );
  }

  private async fetchCatalog(): Promise<OmpModelCatalog> {
    const command = await this.resolveExecutablePath();
    perfBump('omp.probe.spawn');
    const client = this.createClient({
      command,
      args: OMP_MODEL_CATALOG_PROBE_ARGS,
      onStderr: (chunk) => this.logger?.warn(`[omp model discovery stderr] ${chunk.trimEnd()}`),
    });
    this.clients.add(client);

    try {
      client.start();
      await withTimeout(client.handshake(), OMP_PROBE_TIMEOUT_MS, 'omp model discovery handshake');
      const rows = await withTimeout(
        client.getAvailableModels(),
        OMP_PROBE_TIMEOUT_MS,
        'omp model discovery',
      );
      // De-duplicate on the COMPOSED id: two rows can share a bare id across
      // providers (an `anthropic/…` and a `bedrock/…` of the same model), and it
      // is the composed form that must be unique for the picker.
      const models = new Map<string, OmpModelCatalog['models'][number]>();
      for (const row of rows) {
        const option = projectRow(row);
        if (!models.has(option.id)) models.set(option.id, option);
      }
      if (models.size === 0) {
        throw new Error('omp get_available_models returned no models');
      }
      return { models: [...models.values()] };
    } finally {
      this.clients.delete(client);
      await client.stop().catch((error: unknown) => {
        this.logger?.warn(
          `[OmpModelCatalogProbe] model discovery teardown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }
}

let sharedProbe: OmpModelCatalogProbe | null = null;

/**
 * The process-wide probe behind `models:get-catalog`.
 *
 * A singleton rather than a field on `AppServices` because the catalogue is a
 * property of the machine's `omp` install, not of any session or manager — and
 * because it must answer the IPC channel before the OMP manager is constructed
 * (a user opening the picker in Settings has started no OMP session). The
 * manager holds the same instance so `killAllProcesses` reaps a mid-flight probe.
 */
export function getSharedOmpModelCatalogProbe(): OmpModelCatalogProbe {
  sharedProbe ??= new OmpModelCatalogProbe();
  return sharedProbe;
}
