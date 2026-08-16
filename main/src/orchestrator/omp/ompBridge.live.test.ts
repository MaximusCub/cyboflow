/**
 * LIVE smoke — runs Cyboflow's real config resolver, adapter, and HTTP client
 * against the real bridge. Requires OMP_BRIDGE_* env; run explicitly:
 *   OMP_BRIDGE_TOKEN_FILE=... OMP_BRIDGE_SESSION_ID=... npx vitest run <this>
 * Uses a nonexistent worker id so fleet_kill traverses the full path (auth →
 * session scope → tool gate → tool host → fleet controller) without side effects.
 */
import { describe, expect, it } from 'vitest';
import { resolveOmpBridgeCommandConfig } from './ompBridgeConfig';
import { OmpBridgeCommandAdapter } from './ompBridgeCommandAdapter';
import { OmpBridgeHttpClient } from './ompBridgeClient';

const config = resolveOmpBridgeCommandConfig();

describe.skipIf(config === undefined)('live bridge smoke', () => {
  it('resolves real config', () => {
    expect(config).toBeDefined();
  });

  it('fleet_kill on a nonexistent worker traverses the full path', async () => {
    const adapter = new OmpBridgeCommandAdapter(
      new OmpBridgeHttpClient(config!.url, config!.token, config!.sessionId),
    );
    const result = await adapter.kill({ operationId: 'op-live-smoke-1', workerId: 'cyboflow-smoke-nonexistent' });
    // The command must correlate and return a structured result — not throw.
    expect(result.operationId).toBe('op-live-smoke-1');
    expect(typeof result.ok).toBe('boolean');
    if (!result.ok) expect(typeof result.detail).toBe('string');
  });
});
