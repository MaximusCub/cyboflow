/**
 * Boundary guards for `bugReport:submit`.
 *
 * The handler is a renderer-controlled path to a quota-backed external service.
 * A disabled button in the dialog protects nothing, so validation, size caps,
 * rate limiting, single-flight, and idempotency are all enforced HERE and tested
 * by driving the registered handler directly, as a compromised or looping
 * renderer would.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMain } from 'electron';
import type { BugReportSubmitResponse } from '../../../../shared/types/bugReport';

const service = vi.hoisted(() => ({
  submitBugReport: vi.fn(async () => ({ delivery: 'accepted' as const, eventId: 'evt-1' })),
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: vi.fn(() => '0.1.35') },
}));

vi.mock('../../services/telemetry/bugReport', () => service);

vi.mock('../../services/telemetry/diagnostics', () => ({
  collectDiagnostics: vi.fn(() => ({
    appVersion: '0.1.35',
    platform: 'darwin',
    arch: 'arm64',
    electronVersion: '38.0.0',
    environment: 'stable',
    installId: 'install-uuid',
    recentErrors: [],
  })),
  readLogTail: vi.fn(() => ({
    kind: 'app-log',
    filePath: '/logs/cyboflow-2026-08-03.log',
    text: 'log line',
    unavailable: false,
  })),
}));

vi.mock('../../services/telemetry/credentials', () => ({
  resolveTelemetryCredentials: vi.fn(() => ({
    sentryDsn: 'https://key@example.ingest.sentry.io/1',
    aptabaseAppKey: undefined,
    environment: 'stable',
  })),
}));

vi.mock('../../services/configManager', () => ({
  readTelemetryConfigSync: vi.fn(() => ({
    errorReportingEnabled: false,
    usageMetricsEnabled: false,
    installId: 'install-uuid',
  })),
}));

import { registerBugReportHandlers, __resetBugReportLimiterForTests } from '../bugReport';
import type { AppServices } from '../types';

type Handler = (event: unknown, args: unknown) => Promise<unknown>;

interface IpcResult {
  success: boolean;
  data?: BugReportSubmitResponse;
  error?: string;
}

let handlers: Map<string, Handler>;

function submit(args: unknown): Promise<IpcResult> {
  const handler = handlers.get('bugReport:submit');
  if (!handler) throw new Error('bugReport:submit was not registered');
  return handler({}, args) as Promise<IpcResult>;
}

const VALID = {
  whatHappened: 'The sidebar froze.',
  stepsToReproduce: '1. Open a run',
  expectedBehavior: 'No freeze.',
  contactConsent: false,
  idempotencyKey: 'key-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  service.submitBugReport.mockResolvedValue({ delivery: 'accepted', eventId: 'evt-1' });
  __resetBugReportLimiterForTests();
  handlers = new Map();
  const ipcMain = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
  } as unknown as IpcMain;
  registerBugReportHandlers(ipcMain, {} as AppServices);
});

describe('input validation', () => {
  it('registers both channels', () => {
    expect([...handlers.keys()].sort()).toEqual(['bugReport:getPreview', 'bugReport:submit']);
  });

  it('rejects a submission with no description', async () => {
    const result = await submit({ ...VALID, whatHappened: '   ' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('whatHappened');
    expect(service.submitBugReport).not.toHaveBeenCalled();
  });

  it('rejects a payload that is not an object at all', async () => {
    const result = await submit(undefined);

    expect(result.success).toBe(false);
    expect(service.submitBugReport).not.toHaveBeenCalled();
  });

  it('rejects an oversized log attachment instead of forwarding it', async () => {
    const result = await submit({ ...VALID, logText: 'x'.repeat(200 * 1024) });

    expect(result.success).toBe(false);
    expect(result.error).toContain('logText');
    expect(service.submitBugReport).not.toHaveBeenCalled();
  });

  it('rejects oversized prose', async () => {
    const result = await submit({ ...VALID, whatHappened: 'x'.repeat(10_000) });

    expect(result.success).toBe(false);
    expect(service.submitBugReport).not.toHaveBeenCalled();
  });
});

describe('contact consent', () => {
  it('drops the email when consent was not given, even if the field holds one', async () => {
    await submit({ ...VALID, contactConsent: false, email: 'someone@example.com' });

    expect(service.submitBugReport).toHaveBeenCalledTimes(1);
    const payload = service.submitBugReport.mock.calls[0][0] as { email?: string };
    expect(payload.email).toBeUndefined();
  });

  it('forwards the email when consent was given', async () => {
    await submit({ ...VALID, contactConsent: true, email: 'someone@example.com' });

    const payload = service.submitBugReport.mock.calls[0][0] as { email?: string };
    expect(payload.email).toBe('someone@example.com');
  });
});

describe('rate limiting', () => {
  it('refuses a second submission inside the minimum interval', async () => {
    const first = await submit({ ...VALID, idempotencyKey: 'key-1' });
    const second = await submit({ ...VALID, idempotencyKey: 'key-2' });

    expect(first.data?.delivery).toBe('accepted');
    expect(second.data?.delivery).toBe('rate-limited');
    expect(second.data?.retryAfterSeconds).toBeGreaterThan(0);
    // The refused attempt never reached the service.
    expect(service.submitBugReport).toHaveBeenCalledTimes(1);
  });

  it('does not consume quota when the build cannot deliver', async () => {
    service.submitBugReport.mockResolvedValue({
      delivery: 'unavailable',
      error: 'no DSN',
    } as never);

    const first = await submit({ ...VALID, idempotencyKey: 'key-1' });
    const second = await submit({ ...VALID, idempotencyKey: 'key-2' });

    expect(first.data?.delivery).toBe('unavailable');
    // Not rate-limited: a DSN-less build must not lock the user out of retrying.
    expect(second.data?.delivery).toBe('unavailable');
    expect(service.submitBugReport).toHaveBeenCalledTimes(2);
  });
});

describe('idempotency', () => {
  it('returns the original outcome for a replayed key without filing again', async () => {
    const first = await submit({ ...VALID, idempotencyKey: 'same-key' });
    const replay = await submit({ ...VALID, idempotencyKey: 'same-key' });

    expect(first.data?.eventId).toBe('evt-1');
    expect(replay.data).toEqual(first.data);
    expect(service.submitBugReport).toHaveBeenCalledTimes(1);
  });
});

describe('failure handling', () => {
  it('surfaces a service throw as a failed IPC result rather than rejecting', async () => {
    service.submitBugReport.mockRejectedValue(new Error('boom'));

    const result = await submit(VALID);

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('releases the single-flight lock after a failure so the next attempt proceeds', async () => {
    service.submitBugReport.mockRejectedValueOnce(new Error('boom'));

    await submit({ ...VALID, idempotencyKey: 'key-1' });
    const next = await submit({ ...VALID, idempotencyKey: 'key-2' });

    // Not 'rate-limited' — the failed attempt consumed no quota and left no lock.
    expect(next.data?.delivery).toBe('accepted');
  });
});
