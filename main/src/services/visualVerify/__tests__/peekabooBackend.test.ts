/**
 * PeekabooBackend (Rung 2) unit tests.
 *
 * NO real binary runs + NO real capture: a FAKE PeekabooClient is dependency-
 * injected (binaryAvailable / permissions / capture are all knobbed). The fake
 * drives the real backend orchestration — the ALWAYS verify:screen lease, the
 * two-gate healthCheck (binary absent OR a TCC grant declined ⇒ false, no throw,
 * no hang), probeGrants' three-way split (granted / declined / could-not-ask), a
 * successful capture writing a PNG into a temp artifactsDir, and a client error
 * falling forward to ok:false (never a throw).
 *
 * parsePermissionsJson is tested against the REAL shapes the CLI emits — the
 * v2.x `{ success, data: { permissions } }` envelope included, since reading
 * only the un-nested shapes is what made every probe report both grants denied.
 *
 * Live peekaboo capture (real binary + 2 TCC grants on the host) is environmental
 * ⇒ smoke-only, NOT a unit-gate AC.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeekabooBackend, parsePermissionsJson, type PeekabooClient } from '../peekabooBackend';
import { VERIFY_SCREEN_LEASE } from '../../../orchestrator/verify/verificationScheduler';
import type {
  CaptureContext,
  NativeGrants,
} from '../../../../../shared/types/visualVerification';

/** Per-test behaviour knobs for the fake PeekabooClient. */
interface FakeOpts {
  /** Whether the `peekaboo` binary is on PATH. Default true. */
  binary?: boolean;
  /** When set, binaryAvailable() rejects with this message. */
  binaryError?: string;
  /** The grants the CLI reports. Default: both held. */
  permissions?: NativeGrants;
  /** When set, permissions() rejects with this message (the CLI could not answer). */
  permissionsError?: string;
  /** When set, capture() rejects with this message (a CLI failure). */
  captureError?: string;
  /** Whether a successful capture writes a real PNG byte to outPath. Default true. */
  writePng?: boolean;
}

/** A recorded capture call against the fake client. */
interface FakeCalls {
  captures: Array<{ appTarget: string; outPath: string }>;
  binaryProbes: number;
  permissionProbes: number;
}

// The smallest valid PNG (the fake capture writes it to prove a real byte landed).
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function makeFakeClient(opts: FakeOpts, calls: FakeCalls): PeekabooClient {
  return {
    async binaryAvailable(): Promise<boolean> {
      calls.binaryProbes += 1;
      if (opts.binaryError) throw new Error(opts.binaryError);
      return opts.binary ?? true;
    },
    async permissions(): Promise<NativeGrants> {
      calls.permissionProbes += 1;
      if (opts.permissionsError) throw new Error(opts.permissionsError);
      return opts.permissions ?? { screenRecording: true, accessibility: true };
    },
    async capture(args, _signal): Promise<void> {
      calls.captures.push({ appTarget: args.appTarget, outPath: args.outPath });
      if (opts.captureError) {
        throw new Error(opts.captureError);
      }
      if (opts.writePng ?? true) {
        await writeFile(args.outPath, ONE_PX_PNG);
      }
    },
  };
}

let artifactsDir: string;

beforeEach(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), 'cvv-pkb-'));
});

afterEach(async () => {
  await rm(artifactsDir, { recursive: true, force: true });
});

function freshCalls(): FakeCalls {
  return { captures: [], binaryProbes: 0, permissionProbes: 0 };
}

function ctx(): CaptureContext {
  return {
    requestId: 'req-1',
    runId: 'run-1',
    artifactsDir,
    type: 'native-desktop',
    input: { intent: 'the app renders correctly' },
  };
}

describe('PeekabooBackend', () => {
  it('has the rung-2 native-desktop contract', () => {
    const b = new PeekabooBackend({ client: makeFakeClient({}, freshCalls()) });
    expect(b.id).toBe('peekaboo');
    expect(b.rung).toBe(2);
  });

  it('requiredLease ALWAYS returns the verify:screen lease (one display/focus/input)', () => {
    const b = new PeekabooBackend({ client: makeFakeClient({}, freshCalls()) });
    // Request-independent — every native-desktop capture contends for the one screen.
    expect(b.requiredLease({ intent: 'x' })).toBe(VERIFY_SCREEN_LEASE);
    expect(b.requiredLease({ intent: 'y', url: 'http://x', start: 'npm run dev' })).toBe(
      VERIFY_SCREEN_LEASE,
    );
    // It reuses the scheduler's exported constant, not a hardcoded string drift.
    expect(VERIFY_SCREEN_LEASE).toBe('verify:screen');
  });

  it('healthCheck returns true when the binary is present AND both TCC grants are held', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({ client: makeFakeClient({ binary: true }, calls) });
    await expect(b.healthCheck()).resolves.toBe(true);
    expect(calls.binaryProbes).toBe(1);
    expect(calls.permissionProbes).toBe(1);
  });

  it('healthCheck returns false when the binary is ABSENT (no throw, no hang) — degrade to SKIPPED', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({ client: makeFakeClient({ binary: false }, calls) });
    await expect(b.healthCheck()).resolves.toBe(false);
    // Short-circuits before probing permissions (binary is the first gate).
    expect(calls.binaryProbes).toBe(1);
    expect(calls.permissionProbes).toBe(0);
  });

  it('healthCheck returns false when EITHER grant is declined — a missing grant must never wedge a sprint', async () => {
    // Each grant alone is insufficient: capture needs Screen Recording, and the
    // gate additionally requires Accessibility because that is what any future
    // drive step would need.
    for (const permissions of [
      { screenRecording: true, accessibility: false },
      { screenRecording: false, accessibility: true },
      { screenRecording: false, accessibility: false },
    ]) {
      const b = new PeekabooBackend({ client: makeFakeClient({ permissions }, freshCalls()) });
      await expect(b.healthCheck()).resolves.toBe(false);
    }
  });

  it('healthCheck soft-fails (false) when a probe THROWS — never propagates', async () => {
    const b = new PeekabooBackend({
      client: makeFakeClient({ binaryError: 'probe exploded' }, freshCalls()),
    });
    await expect(b.healthCheck()).resolves.toBe(false);
  });

  it('healthCheck folds an UNANSWERABLE permissions probe to false, where probeGrants keeps it distinct', async () => {
    // The gate cannot proceed on an unverified grant (that would hang a sprint
    // on a permission dialog) but the panel must not call it a denial.
    const client = makeFakeClient({ permissionsError: 'peekaboo exited 64' }, freshCalls());
    const b = new PeekabooBackend({ client });
    await expect(b.healthCheck()).resolves.toBe(false);
    expect(await b.probeGrants()).toEqual({
      kind: 'inconclusive',
      detail: 'peekaboo exited 64',
    });
  });

  it('probeGrants reports the two grants SEPARATELY, not as one conjunction', async () => {
    const b = new PeekabooBackend({
      client: makeFakeClient(
        { permissions: { screenRecording: true, accessibility: false } },
        freshCalls(),
      ),
    });
    expect(await b.probeGrants()).toEqual({
      kind: 'ok',
      screenRecording: true,
      accessibility: false,
    });
  });

  it('probeGrants distinguishes a MISSING BINARY from a declined grant', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({ client: makeFakeClient({ binary: false }, calls) });
    const probe = await b.probeGrants();
    expect(probe.kind).toBe('binary-missing');
    // Nothing to hold a grant, so the grant probe is never even attempted.
    expect(calls.permissionProbes).toBe(0);
  });

  it('probeGrants treats a THROWING binary probe as inconclusive, not as absent', async () => {
    // preflight.ts's fail-open rule: a probe that could not answer is not
    // evidence the binary is gone.
    const b = new PeekabooBackend({
      client: makeFakeClient({ binaryError: 'EPERM' }, freshCalls()),
    });
    expect(await b.probeGrants()).toEqual({ kind: 'inconclusive', detail: 'EPERM' });
  });

  it('capture writes a PNG into artifactsDir and returns ok:true on success', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({
      client: makeFakeClient({}, calls),
      appTarget: 'Cyboflow',
    });
    const result = await b.capture(ctx(), new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(result.fileNames).toEqual(['Cyboflow.png']);
    expect(result.fileNames.every((f) => !f.includes('/'))).toBe(true);
    // The capture targeted the configured app + the real PNG landed in artifactsDir.
    expect(calls.captures).toHaveLength(1);
    expect(calls.captures[0].appTarget).toBe('Cyboflow');
    const written = await readdir(artifactsDir);
    expect(written).toContain('Cyboflow.png');
  });

  it('capture returns ok:false (fall-forward) when the client errors — NEVER throws', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({
      client: makeFakeClient({ captureError: 'peekaboo exited 1: no window' }, calls),
    });
    const result = await b.capture(ctx(), new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.fileNames).toEqual([]);
    expect(result.error).toContain('peekaboo exited 1');
    // No PNG was written on the failure path.
    const written = await readdir(artifactsDir);
    expect(written).toEqual([]);
  });

  it('capture returns ok:false when already aborted (no client call)', async () => {
    const calls = freshCalls();
    const b = new PeekabooBackend({ client: makeFakeClient({}, calls) });
    const controller = new AbortController();
    controller.abort();
    const result = await b.capture(ctx(), controller.signal);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('capture aborted');
    expect(calls.captures).toHaveLength(0);
  });
});

describe('parsePermissionsJson', () => {
  it('reads the REAL v2.x envelope — { success, data: { permissions } }', () => {
    // Verbatim from `peekaboo permissions --json-output` (v2.0.3), the shape the
    // previous reader could not see: it looked only at `permissions` and the
    // root, found neither, and reported both grants denied on a host holding
    // both. That is the bug this case exists to keep fixed.
    const stdout = JSON.stringify({
      success: true,
      data: { permissions: { accessibility: true, screen_recording: true } },
      debug_logs: [],
    });
    expect(parsePermissionsJson(stdout)).toEqual({
      screenRecording: true,
      accessibility: true,
    });
  });

  it('reads v3\'s LIST of named grants, so the version bump is not a parser rewrite', () => {
    // Verbatim shape from `@steipete/peekaboo` v3: an array of named grants
    // rather than a keyed object, with extra grants we do not require.
    const stdout = JSON.stringify({
      success: true,
      data: {
        source: 'bridge',
        permissions: [
          { name: 'Screen Recording', isGranted: true, isRequired: true },
          { name: 'Accessibility', isGranted: false, isRequired: true },
          { name: 'Event Synthesizing', isGranted: true, isRequired: false },
        ],
      },
    });
    expect(parsePermissionsJson(stdout)).toEqual({
      screenRecording: true,
      accessibility: false,
    });
  });

  it('still reads the un-nested shapes older versions emitted', () => {
    expect(
      parsePermissionsJson(JSON.stringify({ permissions: { screenRecording: true, accessibility: false } })),
    ).toEqual({ screenRecording: true, accessibility: false });
    expect(parsePermissionsJson(JSON.stringify({ screenCapture: true, accessibility: true }))).toEqual({
      screenRecording: true,
      accessibility: true,
    });
  });

  it('reports the grants SEPARATELY rather than conjoining them', () => {
    const stdout = JSON.stringify({
      data: { permissions: { screen_recording: true, accessibility: false } },
    });
    expect(parsePermissionsJson(stdout)).toEqual({ screenRecording: true, accessibility: false });
  });

  it('treats an absent or non-true grant within a recognised object as DENIED', () => {
    // Absence inside a shape we understand is real evidence — unlike a shape we
    // do not understand, which throws.
    expect(parsePermissionsJson(JSON.stringify({ data: { permissions: { accessibility: true } } }))).toEqual({
      screenRecording: false,
      accessibility: true,
    });
    expect(
      parsePermissionsJson(JSON.stringify({ data: { permissions: { accessibility: 'yes', screen_recording: 1 } } })),
    ).toEqual({ screenRecording: false, accessibility: false });
  });

  it('THROWS on output it cannot read, rather than answering "both denied" for the host', () => {
    // Answering on the host's behalf is what sends a user to re-grant a
    // permission they already hold.
    expect(() => parsePermissionsJson('Error: Unknown option')).toThrow(/not JSON/);
    expect(() => parsePermissionsJson('null')).toThrow(/no recognisable permissions/);
    expect(() => parsePermissionsJson(JSON.stringify({ success: true, data: {} }))).toThrow(
      /no recognisable permissions/,
    );
    expect(() => parsePermissionsJson(JSON.stringify([{ accessibility: true }]))).toThrow(
      /no recognisable permissions/,
    );
  });
});
