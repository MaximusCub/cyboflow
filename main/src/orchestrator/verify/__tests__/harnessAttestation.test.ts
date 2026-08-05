/**
 * harnessAttestation unit tests — the §7.1 identity probe the HARNESS performs
 * itself, now that `.driver/attest.json` is agent-forgeable and no longer read.
 *
 * Everything that touches the outside world is injected (an HTTP GET, a CDP
 * evaluate, a window listing), so this suite dials no socket, launches no
 * browser, and spawns no peekaboo. `sleep` is injected too — the retry loop is
 * asserted by counting attempts and delays, not by spending real seconds.
 *
 * The invariants worth protecting here, in priority order:
 *  1. A probe THROW is `verified: false`, never an exception. An escape lands in
 *     the runner's outer catch, which fails OPEN (`skipped` ADVANCES the lane) —
 *     the exact hole this module exists to close.
 *  2. `verified: true` requires the surface to hand back something only THIS
 *     request's deliverable could know; a 200, a rendered page, or a window
 *     existing is never enough on its own.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  performHarnessAttestation,
  HARNESS_ATTEST_ATTEMPTS,
  HARNESS_ATTEST_RETRY_DELAY_MS,
  type HarnessAttestationDeps,
} from '../harnessAttestation';
import type { AttestationSpec } from '../../../../../shared/types/visualVerification';

const NONCE = 'nonce-9f3c-4a21-bb70';
const VERIFY_PORT = 29260;
const DRIVER_PORT = 29261;

interface Probes {
  deps: HarnessAttestationDeps;
  httpGetBody: ReturnType<typeof vi.fn>;
  cdpEvaluate: ReturnType<typeof vi.fn>;
  listNativeWindows: ReturnType<typeof vi.fn>;
  sleeps: number[];
}

/**
 * What each probe ANSWERS — implementations, not whole deps. The spy wrapper is
 * always built here, so `probes.cdpEvaluate` is guaranteed to be the very
 * function the module called (a test that swapped in its own `vi.fn` via a deps
 * override would leave the returned spy silently unused, and every
 * `toHaveBeenCalled` on it would be a lie).
 */
interface ProbeAnswers {
  httpGetBody?: (url: string, timeoutMs: number) => Promise<string>;
  cdpEvaluate?: (port: number, expression: string, timeoutMs: number) => Promise<string>;
  listNativeWindows?: (app: string) => Promise<string[]>;
}

/** All three probes as spies, defaulting to answers that FAIL to verify (opt into success per test). */
function makeProbes(answers: ProbeAnswers = {}): Probes {
  const sleeps: number[] = [];
  const httpGetBody = vi.fn(answers.httpGetBody ?? (async (): Promise<string> => 'nothing useful here'));
  const cdpEvaluate = vi.fn(answers.cdpEvaluate ?? (async (): Promise<string> => ''));
  const listNativeWindows = vi.fn(answers.listNativeWindows ?? (async (): Promise<string[]> => []));
  const deps: HarnessAttestationDeps = {
    httpGetBody,
    cdpEvaluate,
    listNativeWindows,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { deps, httpGetBody, cdpEvaluate, listNativeWindows, sleeps };
}

function run(spec: AttestationSpec, probes: Probes, verifyPort: number | null = VERIFY_PORT) {
  return performHarnessAttestation(spec, {
    verifyPort,
    driverPort: DRIVER_PORT,
    nonce: NONCE,
    deps: probes.deps,
  });
}

// ---------------------------------------------------------------------------
// The kind matrix — one channel at a time, verified and not
// ---------------------------------------------------------------------------

describe('performHarnessAttestation — http-endpoint', () => {
  it('GETs the leased port at the declared path and verifies on a body carrying the nonce', async () => {
    const probes = makeProbes({ httpGetBody: (async () => `{"verify":"${NONCE}"}`) });
    const result = await run({ kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' }, probes);

    expect(result).toMatchObject({ verified: true, kind: 'http-endpoint' });
    expect(probes.deps.httpGetBody).toHaveBeenCalledWith(
      `http://127.0.0.1:${VERIFY_PORT}/__cyboflow_verify__`,
      expect.any(Number),
    );
  });

  it('normalizes a path missing its leading slash', async () => {
    const probes = makeProbes({ httpGetBody: (async () => NONCE) });
    await run({ kind: 'http-endpoint', urlPath: '__cyboflow_verify__' }, probes);
    expect(probes.deps.httpGetBody).toHaveBeenCalledWith(
      `http://127.0.0.1:${VERIFY_PORT}/__cyboflow_verify__`,
      expect.any(Number),
    );
  });

  it('does NOT verify a port that answers without the nonce — that is the stale-server case', async () => {
    const probes = makeProbes({ httpGetBody: (async () => '<html>some other app</html>') });
    const result = await run({ kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' }, probes);

    expect(result.verified).toBe(false);
    expect(result.detail).toContain('is NOT this deliverable');
  });

  it('does not verify when no server port was leased (nothing to ask)', async () => {
    const probes = makeProbes({ httpGetBody: (async () => NONCE) });
    const result = await run({ kind: 'http-endpoint', urlPath: '/x' }, probes, null);

    expect(result.verified).toBe(false);
    expect(probes.deps.httpGetBody).not.toHaveBeenCalled();
  });
});

describe('performHarnessAttestation — dom-marker', () => {
  it('evaluates over the DRIVER port and verifies when the element carries the nonce', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => `build ${NONCE}`) });
    const result = await run({ kind: 'dom-marker', selector: '[data-verify]' }, probes);

    expect(result).toMatchObject({ verified: true, kind: 'dom-marker' });
    const [port, expression] = probes.cdpEvaluate.mock.calls[0];
    expect(port).toBe(DRIVER_PORT);
    // Reads BOTH channels the spec allows, with the selector embedded as a
    // string literal (a quote in the selector must not rewrite the expression).
    expect(expression).toContain('document.querySelector("[data-verify]")');
    expect(expression).toContain('textContent');
    expect(expression).toContain('data-verify-nonce');
  });

  it('does not verify when the marker renders without the nonce', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => 'Settings ') });
    const result = await run({ kind: 'dom-marker', selector: '#root' }, probes);
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('#root');
  });

  it('embeds a quote-bearing selector safely', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => NONCE) });
    await run({ kind: 'dom-marker', selector: '[data-x="a b"]' }, probes);
    expect(probes.cdpEvaluate.mock.calls[0][1]).toContain(String.raw`document.querySelector("[data-x=\"a b\"]")`);
  });
});

describe('performHarnessAttestation — cdp-token', () => {
  it('verifies on an EXACT match of the declared expected value', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => 'v1-abc') });
    const result = await run(
      { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1-abc' },
      probes,
    );
    expect(result).toMatchObject({ verified: true, kind: 'cdp-token' });
    expect(probes.cdpEvaluate).toHaveBeenCalledWith(DRIVER_PORT, 'window.__BUILD__', expect.any(Number));
  });

  it('does not verify a near-miss, and says what it saw', async () => {
    const probes = makeProbes({ cdpEvaluate: (async () => 'v0-old') });
    const result = await run(
      { kind: 'cdp-token', expression: 'window.__BUILD__', expected: 'v1-abc' },
      probes,
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('v0-old');
    expect(result.detail).toContain('v1-abc');
  });
});

describe('performHarnessAttestation — window-identity', () => {
  it('verifies on a title matching the pattern as a REGEX', async () => {
    const probes = makeProbes({ listNativeWindows: (async () => ['Finder', 'Cyboflow — dev']) });
    const result = await run(
      { kind: 'window-identity', titlePattern: 'Cyboflow.*dev', app: 'Cyboflow' },
      probes,
    );
    expect(result).toMatchObject({ verified: true, kind: 'window-identity' });
    expect(result.detail).toContain('weakest channel');
    // The listing is SCOPED to the declared app — peekaboo has no host-wide
    // form, and an unscoped match would not be an identity check.
    expect(probes.listNativeWindows).toHaveBeenCalledWith('Cyboflow');
  });

  it('falls back to a substring test for an invalid regex (never a probe failure)', async () => {
    const probes = makeProbes({ listNativeWindows: (async () => ['My App (v1)']) });
    const result = await run(
      { kind: 'window-identity', titlePattern: '(v1)', app: 'My App' },
      probes,
    );
    expect(result.verified).toBe(true);
  });

  it('does not verify when no listed window matches', async () => {
    const probes = makeProbes({ listNativeWindows: (async () => ['Finder', 'Safari']) });
    const result = await run(
      { kind: 'window-identity', titlePattern: 'Cyboflow', app: 'Cyboflow' },
      probes,
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('2 window(s) of "Cyboflow"');
  });
});

describe('performHarnessAttestation — file-identity', () => {
  it('is verified by construction and probes NOTHING', async () => {
    const probes = makeProbes();
    const result = await run({ kind: 'file-identity' }, probes);

    expect(result).toMatchObject({ verified: true, kind: 'file-identity' });
    expect(probes.httpGetBody).not.toHaveBeenCalled();
    expect(probes.cdpEvaluate).not.toHaveBeenCalled();
    expect(probes.listNativeWindows).not.toHaveBeenCalled();
    expect(probes.sleeps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The retry loop (§5.4 flakiness guard)
// ---------------------------------------------------------------------------

describe('performHarnessAttestation — retries', () => {
  it('re-probes up to HARNESS_ATTEST_ATTEMPTS, spaced by the retry delay', async () => {
    const probes = makeProbes();
    const result = await run({ kind: 'http-endpoint', urlPath: '/x' }, probes);

    expect(probes.httpGetBody).toHaveBeenCalledTimes(HARNESS_ATTEST_ATTEMPTS);
    expect(probes.sleeps).toEqual(
      Array.from({ length: HARNESS_ATTEST_ATTEMPTS - 1 }, () => HARNESS_ATTEST_RETRY_DELAY_MS),
    );
    expect(result.verified).toBe(false);
    expect(result.detail).toContain(`${HARNESS_ATTEST_ATTEMPTS}×`);
  });

  it('STOPS at the first verified attempt and does not sleep afterwards', async () => {
    // The realistic shape: a dev server still restarting on the first ask.
    let call = 0;
    const probes = makeProbes({
      httpGetBody: async () => {
        call += 1;
        if (call === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:29260');
        return `ok ${NONCE}`;
      },
    });
    const result = await run({ kind: 'http-endpoint', urlPath: '/x' }, probes);

    expect(result.verified).toBe(true);
    expect(probes.httpGetBody).toHaveBeenCalledTimes(2);
    expect(probes.sleeps).toEqual([HARNESS_ATTEST_RETRY_DELAY_MS]);
  });

  it('retries a DEFINITIVE-looking disagreement too — from outside, "wrong" and "not yet" are the same observation', async () => {
    let call = 0;
    const probes = makeProbes({
      cdpEvaluate: async () => {
        call += 1;
        return call < 3 ? 'undefined' : 'v1';
      },
    });
    const result = await run({ kind: 'cdp-token', expression: 'window.__B__', expected: 'v1' }, probes);
    expect(result.verified).toBe(true);
    expect(probes.cdpEvaluate).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// A throw is an ANSWER, never an exception
// ---------------------------------------------------------------------------

describe('performHarnessAttestation — probe failures', () => {
  const throwers: Array<[string, AttestationSpec, ProbeAnswers]> = [
    [
      'a refused HTTP connection',
      { kind: 'http-endpoint', urlPath: '/x' },
      {
        httpGetBody: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:29260');
        },
      },
    ],
    [
      'an unreachable CDP endpoint (the agent shut its own surface down)',
      { kind: 'cdp-token', expression: 'window.__B__', expected: 'v1' },
      {
        cdpEvaluate: async () => {
          throw new Error('CDP endpoint on port 29261 exposes no page (the surface was closed?)');
        },
      },
    ],
    [
      'a missing peekaboo binary',
      { kind: 'window-identity', titlePattern: 'Cyboflow', app: 'Cyboflow' },
      {
        listNativeWindows: async () => {
          throw new Error('spawn peekaboo ENOENT');
        },
      },
    ],
  ];

  for (const [label, spec, answers] of throwers) {
    it(`resolves verified:false with the error in detail for ${label}`, async () => {
      const probes = makeProbes(answers);
      const result = await run(spec, probes);
      expect(result.verified).toBe(false);
      expect(result.kind).toBe(spec.kind);
      expect(result.detail).toContain('probe failed');
    });
  }

  it('never rejects, whatever a probe does — a throw here would fail OPEN in the runner', async () => {
    const probes = makeProbes({
      httpGetBody: () => Promise.reject(new Error('a rejection with no message shape')),
    });
    await expect(run({ kind: 'http-endpoint', urlPath: '/x' }, probes)).resolves.toMatchObject({
      verified: false,
    });
  });
});
