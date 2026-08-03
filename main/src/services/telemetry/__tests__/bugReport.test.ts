/**
 * Regression guards for bug-report delivery.
 *
 * These encode the two SDK behaviors that make a naive implementation quietly
 * wrong, both verified against the installed @sentry/electron 7.13.0:
 *
 *   - `beforeSend` never runs on feedback events, and a bare NodeClient defaults
 *     `serverName` to os.hostname(). Together those ship the user's machine
 *     hostname unless the client opts out AND the scope scrubs explicitly.
 *   - `captureFeedback` returns an event id synchronously even with no DSN and
 *     no transport, so treating that id as proof of delivery tells users their
 *     report was filed when nothing was sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Event } from '@sentry/electron/main';

const sentry = vi.hoisted(() => ({
  nodeClientCtor: vi.fn(),
  clientInit: vi.fn(),
  clientFlush: vi.fn(async () => true),
  captureFeedback: vi.fn(() => 'event-id-123'),
  getClient: vi.fn(() => undefined),
  addEventProcessor: vi.fn(),
  setClient: vi.fn(),
  makeElectronOfflineTransport: vi.fn(() => 'offline-transport'),
}));

const creds = vi.hoisted(() => ({
  resolveTelemetryCredentials: vi.fn(() => ({
    sentryDsn: 'https://key@example.ingest.sentry.io/1',
    aptabaseAppKey: undefined,
    environment: 'stable' as const,
  })),
}));

const active = vi.hoisted(() => ({ isSentryActive: vi.fn(() => false) }));

vi.mock('@sentry/electron/main', () => ({
  NodeClient: class {
    constructor(options: unknown) {
      sentry.nodeClientCtor(options);
    }
    init = sentry.clientInit;
    flush = sentry.clientFlush;
  },
  Scope: class {
    setClient = sentry.setClient;
    addEventProcessor = sentry.addEventProcessor;
  },
  captureFeedback: sentry.captureFeedback,
  defaultStackParser: 'stack-parser',
  makeElectronOfflineTransport: sentry.makeElectronOfflineTransport,
  getClient: sentry.getClient,
}));

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: vi.fn(() => '0.1.35') },
}));

vi.mock('../credentials', () => creds);
vi.mock('../index', () => active);

import {
  submitBugReport,
  composeFeedbackMessage,
  buildFeedbackTags,
  __resetIsolatedClientForTests,
} from '../bugReport';
import type { BugReportDiagnostics } from '../diagnostics';

const DIAGNOSTICS: BugReportDiagnostics = {
  appVersion: '0.1.35',
  platform: 'darwin',
  arch: 'arm64',
  electronVersion: '38.0.0',
  environment: 'stable',
  installId: 'install-uuid',
  recentErrors: [],
};

const REPORT = {
  whatHappened: 'The sidebar froze.',
  stepsToReproduce: '1. Open a run\n2. Wait',
  expectedBehavior: 'It should not freeze.',
};

beforeEach(() => {
  __resetIsolatedClientForTests();
  vi.clearAllMocks();
  sentry.clientFlush.mockResolvedValue(true);
  sentry.captureFeedback.mockReturnValue('event-id-123');
  sentry.getClient.mockReturnValue(undefined);
  active.isSentryActive.mockReturnValue(false);
  creds.resolveTelemetryCredentials.mockReturnValue({
    sentryDsn: 'https://key@example.ingest.sentry.io/1',
    aptabaseAppKey: undefined,
    environment: 'stable',
  });
});

describe('isolated client construction', () => {
  it('opts out of serverName so the machine hostname is never attached', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    expect(sentry.nodeClientCtor).toHaveBeenCalledTimes(1);
    const options = sentry.nodeClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(options.includeServerName).toBe(false);
  });

  it('uses the disk-backed offline transport so reports filed offline are not dropped', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    const options = sentry.nodeClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(options.transport).toBe('offline-transport');
    expect(options.stackParser).toBe('stack-parser');
  });

  it('registers no integrations, so filing a report does not re-enable passive capture', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    const options = sentry.nodeClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(options.integrations).toEqual([]);
  });

  it('builds the client once and reuses it across submissions', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);
    await submitBugReport(REPORT, DIAGNOSTICS);

    expect(sentry.nodeClientCtor).toHaveBeenCalledTimes(1);
  });
});

describe('scope event processor', () => {
  /**
   * feedback bypasses `beforeSend`, so this processor is the ONLY thing standing
   * between an ambient scope and the outbound envelope.
   */
  it('strips server_name, user, and breadcrumbs from the outbound event', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    const processor = sentry.addEventProcessor.mock.calls[0][0] as (e: Event) => Event;
    const processed = processor({
      server_name: 'krishnas-macbook.local',
      user: { email: 'someone@example.com', ip_address: '10.0.0.1' },
      breadcrumbs: [{ message: '/Users/krishna/private-repo/src/secret.ts' }],
      contexts: { feedback: { message: 'kept' } },
    } as Event);

    expect(processed.server_name).toBeUndefined();
    expect(processed.user).toBeUndefined();
    expect(processed.breadcrumbs).toBeUndefined();
    // The report itself must survive scrubbing.
    expect(processed.contexts?.feedback?.message).toBe('kept');
  });

  it('applies on the globally-initialized path too, not just the isolated one', async () => {
    active.isSentryActive.mockReturnValue(true);
    sentry.getClient.mockReturnValue({ flush: sentry.clientFlush } as never);

    await submitBugReport(REPORT, DIAGNOSTICS);

    expect(sentry.addEventProcessor).toHaveBeenCalledTimes(1);
    // The global client is reused rather than a second one constructed.
    expect(sentry.nodeClientCtor).not.toHaveBeenCalled();
  });
});

describe('delivery reporting', () => {
  it('reports unavailable — not accepted — when no DSN is configured', async () => {
    creds.resolveTelemetryCredentials.mockReturnValue({
      sentryDsn: undefined,
      aptabaseAppKey: undefined,
      environment: 'local',
    });

    const result = await submitBugReport(REPORT, DIAGNOSTICS);

    expect(result.delivery).toBe('unavailable');
    expect(result.eventId).toBeUndefined();
    // Nothing may be captured against a client that cannot send.
    expect(sentry.captureFeedback).not.toHaveBeenCalled();
  });

  it('reports accepted only when the transport actually drained', async () => {
    sentry.clientFlush.mockResolvedValue(true);

    const result = await submitBugReport(REPORT, DIAGNOSTICS);

    expect(result.delivery).toBe('accepted');
    expect(result.eventId).toBe('event-id-123');
  });

  it('reports queued when the flush times out, despite an event id existing', async () => {
    sentry.clientFlush.mockResolvedValue(false);

    const result = await submitBugReport(REPORT, DIAGNOSTICS);

    expect(result.delivery).toBe('queued');
    expect(result.eventId).toBe('event-id-123');
  });

  it('reports failed rather than throwing when the SDK errors', async () => {
    sentry.captureFeedback.mockImplementation(() => {
      throw new Error('transport exploded');
    });

    const result = await submitBugReport(REPORT, DIAGNOSTICS);

    expect(result.delivery).toBe('failed');
    expect(result.error).toBe('transport exploded');
  });
});

describe('payload composition', () => {
  it('labels each prose section so the single message body stays readable', () => {
    const message = composeFeedbackMessage(REPORT);

    expect(message).toContain('## What happened\nThe sidebar froze.');
    expect(message).toContain('## Steps to reproduce');
    expect(message).toContain('## Expected\nIt should not freeze.');
  });

  it('marks omitted optional sections rather than leaving them blank', () => {
    const message = composeFeedbackMessage({
      whatHappened: 'It broke.',
      stepsToReproduce: '',
      expectedBehavior: '',
    });

    expect(message).toContain('## Steps to reproduce\n(not provided)');
  });

  it('attaches the log tail only when the user supplied one', async () => {
    await submitBugReport({ ...REPORT, logText: 'line one\nline two' }, DIAGNOSTICS);

    const hint = sentry.captureFeedback.mock.calls[0][1] as {
      attachments: Array<{ filename: string }>;
    };
    expect(hint.attachments.map((a) => a.filename)).toEqual(['diagnostics.json', 'log-tail.txt']);
  });

  it('sends diagnostics alone when logs were not opted into', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    const hint = sentry.captureFeedback.mock.calls[0][1] as {
      attachments: Array<{ filename: string }>;
    };
    expect(hint.attachments.map((a) => a.filename)).toEqual(['diagnostics.json']);
  });

  it('builds filterable, non-PII tags', () => {
    const tags = buildFeedbackTags(
      { ...REPORT, runId: 'run-7', flowName: 'sprint', email: 'a@b.com', logText: 'x' },
      DIAGNOSTICS,
    );

    expect(tags).toMatchObject({
      report_source: 'sidebar',
      environment: 'stable',
      platform: 'darwin',
      run_id: 'run-7',
      flow: 'sprint',
      has_logs: 'yes',
      has_contact: 'yes',
    });
    // The address itself is a native feedback field, never a tag value.
    expect(Object.values(tags)).not.toContain('a@b.com');
  });
});
