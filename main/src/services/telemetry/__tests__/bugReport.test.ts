/**
 * Regression guards for bug-report delivery.
 *
 * These encode the SDK behaviors that make a naive implementation quietly wrong,
 * all verified against the installed @sentry/electron 7.13.0:
 *
 *   - `beforeSend` never runs on feedback events, and a bare NodeClient defaults
 *     `serverName` to os.hostname(). Together those ship the user's machine
 *     hostname unless the client opts out AND the scope scrubs explicitly.
 *   - `captureFeedback` returns an event id synchronously even with no DSN and
 *     no transport, so treating that id as proof of delivery tells users their
 *     report was filed when nothing was sent.
 *   - NEITHER IS A SUCCESSFUL FLUSH. `makeOfflineTransport` swallows a failed
 *     send, writes the envelope to disk, and resolves with `{}`; a 4xx likewise
 *     resolves. So `flush` returns true for a report that never left the
 *     machine, and delivery has to be read off the transport's own send result.
 *
 * The mock therefore models the real call shape rather than stubbing `flush`: a
 * client that builds its transport from the options it was given, and reaches
 * `transport.send` from INSIDE `captureFeedback` — which is what actually
 * happens, because Sentry's internal `SyncPromise` runs `.then` handlers
 * synchronously when already settled. A live smoke caught that: keying the
 * tracker on `captureFeedback`'s RETURN value never matched, so a report the
 * server accepted was reported to the user as queued.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Event } from '@sentry/electron/main';

const sentry = vi.hoisted(() => ({
  nodeClientCtor: vi.fn(),
  clientInit: vi.fn(),
  /**
   * Reaches the transport SYNCHRONOUSLY, before returning — the SyncPromise
   * behaviour above. The id comes from `hint.event_id`, which Sentry honours for
   * feedback events (they carry no `event_id` of their own).
   */
  captureFeedback: vi.fn((_params: unknown, hint: { event_id?: string }) => {
    const id = hint?.event_id ?? 'sentry-generated-id';
    void sentry.transport.current?.send([{ event_id: id }, []]);
    return id;
  }),
  addEventProcessor: vi.fn(),
  setClient: vi.fn(),
  /** The innermost (offline) transport send the tracked wrapper delegates to. */
  innerSend: vi.fn(async (): Promise<{ statusCode?: number }> => ({ statusCode: 200 })),
  innerFlush: vi.fn(async () => true),
  offlineFactory: vi.fn(),
  /** Transport built by the client under test, so the mock client can drive it. */
  transport: { current: null as null | { send: (envelope: unknown) => Promise<unknown> } },
}));

vi.mock('@sentry/electron/main', () => ({
  NodeClient: class {
    constructor(options: {
      transport: (o: unknown) => { send: (e: unknown) => Promise<unknown> };
      transportOptions?: unknown;
    }) {
      sentry.nodeClientCtor(options);
      sentry.transport.current = options.transport(options.transportOptions ?? {});
    }
    init = sentry.clientInit;
    /**
     * Models `Client.flush`: it resolves whether or not the envelope reached
     * Sentry, so it carries no delivery information at all.
     */
    flush = async (): Promise<boolean> => true;
  },
  Scope: class {
    setClient = sentry.setClient;
    addEventProcessor = sentry.addEventProcessor;
  },
  captureFeedback: sentry.captureFeedback,
  defaultStackParser: 'stack-parser',
  makeElectronOfflineTransport: () => {
    sentry.offlineFactory();
    return () => ({ send: sentry.innerSend, flush: sentry.innerFlush });
  },
}));

const creds = vi.hoisted(() => ({
  resolveTelemetryCredentials: vi.fn(
    (): {
      sentryDsn: string | undefined;
      aptabaseAppKey: string | undefined;
      environment: 'stable' | 'local';
    } => ({
      sentryDsn: 'https://key@example.ingest.sentry.io/1',
      aptabaseAppKey: undefined,
      environment: 'stable',
    }),
  ),
}));

const files = vi.hoisted(() => ({
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn((): string[] => []),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: vi.fn(() => '0.1.35'),
    getPath: vi.fn(() => '/tmp/userData'),
  },
}));

vi.mock('fs', () => ({
  existsSync: files.existsSync,
  readdirSync: files.readdirSync,
}));

vi.mock('../credentials', () => creds);

import {
  submitBugReport,
  composeFeedbackMessage,
  buildFeedbackTags,
  drainQueuedBugReports,
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
  sentry.transport.current = null;
  sentry.innerSend.mockResolvedValue({ statusCode: 200 });
  files.existsSync.mockReturnValue(false);
  files.readdirSync.mockReturnValue([]);
  creds.resolveTelemetryCredentials.mockReturnValue({
    sentryDsn: 'https://key@example.ingest.sentry.io/1',
    aptabaseAppKey: undefined,
    environment: 'stable',
  });
});

function ctorOptions(): Record<string, unknown> {
  return sentry.nodeClientCtor.mock.calls[0]?.[0] as Record<string, unknown>;
}

/** The event id the module minted and passed to Sentry via the hint. */
function capturedEventId(): string | undefined {
  const hint = sentry.captureFeedback.mock.calls[0]?.[1] as { event_id?: string } | undefined;
  return hint?.event_id;
}

describe('client construction', () => {
  it('opts out of serverName so the machine hostname is never attached', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    expect(sentry.nodeClientCtor).toHaveBeenCalledTimes(1);
    expect(ctorOptions().includeServerName).toBe(false);
  });

  it('registers no integrations, so filing a report does not re-enable passive capture', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    expect(ctorOptions().integrations).toEqual([]);
  });

  /**
   * Two `Store` instances over one queue file each cache it in memory behind a
   * per-instance mutex, so sharing the error reporter's queue would let the two
   * clients overwrite each other's pending envelopes.
   */
  it('keeps its own offline queue rather than sharing the error reporter’s', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    const options = ctorOptions().transportOptions as { queuePath: string };
    expect(options.queuePath).toContain('bug-report-queue');
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
  it('strips server_name, user, breadcrumbs, and extra from the outbound event', async () => {
    await submitBugReport(REPORT, DIAGNOSTICS);

    const processor = sentry.addEventProcessor.mock.calls[0][0] as (e: Event) => Event;
    const processed = processor({
      server_name: 'krishnas-macbook.local',
      user: { email: 'someone@example.com', ip_address: '10.0.0.1' },
      breadcrumbs: [{ message: '/Users/krishna/private-repo/src/secret.ts' }],
      extra: { prompt: 'a user prompt that was never reviewed' },
      contexts: { feedback: { message: 'kept' } },
    } as Event);

    expect(processed.server_name).toBeUndefined();
    expect(processed.user).toBeUndefined();
    expect(processed.breadcrumbs).toBeUndefined();
    expect(processed.extra).toBeUndefined();
    // The report itself must survive scrubbing.
    expect(processed.contexts?.feedback?.message).toBe('kept');
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

  it('reports accepted when the transport got a success response', async () => {
    sentry.innerSend.mockResolvedValue({ statusCode: 200 });

    const result = await submitBugReport(REPORT, DIAGNOSTICS);

    expect(result.delivery).toBe('accepted');
    expect(result.eventId).toBe(capturedEventId());
  });

  /**
   * Live-smoke regression. Sentry reaches the transport from INSIDE
   * `captureFeedback` (SyncPromise), so an event id read from its return value is
   * assigned too late to match the envelope already in flight — every delivered
   * report then fell through to the settle timeout and was reported as queued.
   * The id must be minted up front and handed to Sentry via `hint.event_id`.
   */
  it('matches the envelope even though the send starts before captureFeedback returns', async () => {
    sentry.innerSend.mockResolvedValue({ statusCode: 200 });

    const result = await submitBugReport(REPORT, DIAGNOSTICS);

    const hint = sentry.captureFeedback.mock.calls[0][1] as { event_id?: string };
    expect(hint.event_id).toMatch(/^[0-9a-f]{32}$/);
    // Resolved from the send, not from the 10s "unknown" fallback.
    expect(result.delivery).toBe('accepted');
  });

  /**
   * The load-bearing case. `makeOfflineTransport` catches a failed send, writes
   * the envelope to its disk queue, and resolves with `{}` — so the client sees
   * success and `flush` returns true for a report that never left the machine.
   */
  it('reports queued — not accepted — when the offline transport swallowed the send', async () => {
    sentry.innerSend.mockResolvedValue({});

    const result = await submitBugReport(REPORT, DIAGNOSTICS);

    expect(result.delivery).toBe('queued');
    expect(result.eventId).toBe(capturedEventId());
  });

  it('reports failed, with the status, when Sentry rejected the envelope', async () => {
    sentry.innerSend.mockResolvedValue({ statusCode: 429 });

    const result = await submitBugReport(REPORT, DIAGNOSTICS);

    expect(result.delivery).toBe('failed');
    expect(result.error).toContain('429');
  });

  it('reports queued rather than accepted when the send never settles', async () => {
    vi.useFakeTimers();
    try {
      sentry.innerSend.mockImplementation(() => new Promise(() => {}));

      const pending = submitBugReport(REPORT, DIAGNOSTICS);
      await vi.advanceTimersByTimeAsync(11_000);

      expect((await pending).delivery).toBe('queued');
    } finally {
      vi.useRealTimers();
    }
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

describe('draining reports queued by an earlier session', () => {
  /**
   * The client is built lazily on first submission and its offline queue only
   * flushes at construction, so without a boot drain a report queued while
   * offline waits for the user to happen to file another one.
   */
  it('builds the client when queued envelope bodies are on disk', () => {
    files.existsSync.mockReturnValue(true);
    files.readdirSync.mockReturnValue(['queue-v2.json', 'abc123']);

    drainQueuedBugReports();

    expect(sentry.nodeClientCtor).toHaveBeenCalledTimes(1);
  });

  it('does nothing when only the queue index remains', () => {
    files.existsSync.mockReturnValue(true);
    files.readdirSync.mockReturnValue(['queue-v2.json']);

    drainQueuedBugReports();

    expect(sentry.nodeClientCtor).not.toHaveBeenCalled();
  });

  it('does nothing, and never throws, when the queue directory is absent', () => {
    files.existsSync.mockReturnValue(false);

    expect(() => drainQueuedBugReports()).not.toThrow();
    expect(sentry.nodeClientCtor).not.toHaveBeenCalled();
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

  it('attaches exactly the diagnostics it was handed, not a freshly collected set', async () => {
    const reviewed: BugReportDiagnostics = {
      ...DIAGNOSTICS,
      recentErrors: [
        { at: '2026-08-03T00:00:00.000Z', seam: 'run-start', errorClass: 'Error', message: 'boom' },
      ],
    };

    await submitBugReport(REPORT, reviewed);

    const hint = sentry.captureFeedback.mock.calls[0][1] as {
      attachments: Array<{ filename: string; data: Uint8Array }>;
    };
    const attached = JSON.parse(new TextDecoder().decode(hint.attachments[0].data));
    expect(attached.recentErrors).toEqual(reviewed.recentErrors);
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

afterEach(() => {
  vi.useRealTimers();
});
