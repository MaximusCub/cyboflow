/**
 * Tests for `resolveOmpBridgeCommandConfig` — the fail-closed bridge config.
 *
 * The command path must never silently authorize: any missing or unusable
 * field resolves to `undefined` (no adapter → stub → `unavailable`).
 */
import { describe, expect, it } from 'vitest';
import { resolveOmpBridgeCommandConfig } from './ompBridgeConfig';

const URL = 'http://127.0.0.1:53138';
const ENV_KEYS = ['OMP_BRIDGE_URL', 'OMP_BRIDGE_TOKEN_FILE', 'OMP_BRIDGE_SESSION_ID'] as const;

function withEnv(overrides: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) {
      const original = saved.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  };
}

describe('resolveOmpBridgeCommandConfig', () => {
  it('resolves a full config from env', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: URL,
      OMP_BRIDGE_TOKEN_FILE: __filename, // any existing file; token content is irrelevant here
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      const config = resolveOmpBridgeCommandConfig();
      expect(config).toBeDefined();
      expect(config?.url).toBe(URL);
      expect(config?.sessionId).toBe('sess-a');
    } finally {
      restore();
    }
  });

  it('returns undefined when the token file is missing', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: URL,
      OMP_BRIDGE_TOKEN_FILE: '/nonexistent/bridge-token',
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('returns undefined when any env field is absent', () => {
    const restore = withEnv({ OMP_BRIDGE_URL: URL });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('rejects a non-loopback URL', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: 'http://evil.example.com',
      OMP_BRIDGE_TOKEN_FILE: __filename,
      OMP_BRIDGE_SESSION_ID: 'sess-a',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('rejects a session id containing a slash', () => {
    const restore = withEnv({
      OMP_BRIDGE_URL: URL,
      OMP_BRIDGE_TOKEN_FILE: __filename,
      OMP_BRIDGE_SESSION_ID: 'a/b',
    });
    try {
      expect(resolveOmpBridgeCommandConfig()).toBeUndefined();
    } finally {
      restore();
    }
  });
});
