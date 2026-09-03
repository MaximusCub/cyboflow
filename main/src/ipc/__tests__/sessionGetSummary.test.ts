/**
 * Unit tests for `getSummary` in main/src/ipc/sessionOps.ts — the ops
 * implementation behind the `cyboflow.sessions.getSummary` tRPC procedure,
 * formerly the `sessions:get-summary` IPC handler (session-summary-plan.md
 * §7). The read returns the persisted rolling summary + append-only history plus
 * the config-enabled flag, and — when it observes conversation_messages above
 * the summarizer's watermark AND the feature is enabled — fires the §2.7 lazy
 * catch-up kick (fire-and-forget; the read never awaits it or mutates state).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
    createPanel: vi.fn(),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: { getSession: vi.fn() },
}));

vi.mock('../../utils/sessionValidation', () => ({
  validateSessionExists: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  validatePanelSessionOwnership: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  validatePanelExists: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  validateSessionIsActive: vi.fn(() => ({ valid: true, sessionId: 'sess-001' })),
  logValidationFailure: vi.fn(),
  createValidationError: vi.fn(() => ({ success: false, error: 'validation' })),
}));

vi.mock('../../orchestrator/dynamicWorkflows', () => ({
  DynamicWorkflowTracker: { tryGetInstance: vi.fn(() => undefined) },
}));

import { createSessionOps } from '../sessionOps';
import type { AppServices } from '../types';
import type { SessionSummaryPayload } from '../../../../shared/types/sessionSummary';

const SID = 'sess-001';

interface DbStubOpts {
  enabled?: boolean;
  summary?: { summary: string; last_turn_id: number; updated_at: string } | undefined;
  entries?: Array<{ id: number; entry: string; created_at: string }>;
  newerRows?: number; // how many conversation_messages sit above the watermark
}

function makeServices(opts: DbStubOpts = {}) {
  const maybeSummarizeNow = vi.fn();
  const getConversationMessagesAfter = vi.fn(() =>
    Array.from({ length: opts.newerRows ?? 0 }, (_v, i) => ({ id: 100 + i })),
  );
  const services = {
    sessionManager: { getSession: vi.fn(), emit: vi.fn() },
    databaseService: {
      getSession: vi.fn(),
      getSessionSummary: vi.fn(() => opts.summary),
      listSessionSummaryEntries: vi.fn(() => opts.entries ?? []),
      getConversationMessagesAfter,
    },
    configManager: { isSessionSummaryEnabled: () => opts.enabled ?? true, isDemoMode: () => false },
    sessionSummaryScheduler: { maybeSummarizeNow, noteTurnStart: vi.fn(), noteTurnEnd: vi.fn(), dispose: vi.fn() },
    taskQueue: {},
    worktreeManager: {},
    cliManagerFactory: {},
    claudeCodeManager: {},
    interactiveCliManager: {},
    killLiveSession: vi.fn(),
    registerLivePanel: vi.fn(),
    gitStatusManager: {},
    cyboflow: { workflowRegistry: {}, runLauncher: {} },
  } as unknown as AppServices;
  return { services, maybeSummarizeNow, getConversationMessagesAfter };
}


beforeEach(() => {
  vi.clearAllMocks();
});

describe('sessionOps.getSummary', () => {
  it('returns the persisted summary, updatedAt, entries and enabled flag', async () => {
    const { services } = makeServices({
      enabled: true,
      summary: { summary: 'building the widget', last_turn_id: 4, updated_at: '2026-01-01 00:00:00' },
      entries: [
        { id: 1, entry: 'did A', created_at: '2026-01-01 00:00:00' },
        { id: 2, entry: 'did B', created_at: '2026-01-01 00:05:00' },
      ],
      newerRows: 0,
    });
    const ops = createSessionOps(services);

    const res = (await ops.getSummary({ sessionId: SID })) as {
      success: boolean;
      data: SessionSummaryPayload;
    };

    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      enabled: true,
      summary: 'building the widget',
      updatedAt: '2026-01-01 00:00:00',
      entries: [
        { id: 1, entry: 'did A', createdAt: '2026-01-01 00:00:00' },
        { id: 2, entry: 'did B', createdAt: '2026-01-01 00:05:00' },
      ],
    });
  });

  it('returns null summary/updatedAt for a never-summarized session', async () => {
    const { services } = makeServices({ enabled: true, summary: undefined, newerRows: 0 });
    const ops = createSessionOps(services);

    const res = (await ops.getSummary({ sessionId: SID })) as { data: SessionSummaryPayload };
    expect(res.data.summary).toBeNull();
    expect(res.data.updatedAt).toBeNull();
    expect(res.data.entries).toEqual([]);
  });

  it('kicks lazy catch-up when enabled and content sits above the watermark', async () => {
    const { services, maybeSummarizeNow, getConversationMessagesAfter } = makeServices({
      enabled: true,
      summary: { summary: 'x', last_turn_id: 4, updated_at: '2026-01-01 00:00:00' },
      newerRows: 2,
    });
    const ops = createSessionOps(services);

    await ops.getSummary({ sessionId: SID });

    expect(getConversationMessagesAfter).toHaveBeenCalledWith(SID, 4);
    expect(maybeSummarizeNow).toHaveBeenCalledWith(SID, 'lazy-catchup');
  });

  it('does NOT kick when there is no content above the watermark', async () => {
    const { services, maybeSummarizeNow } = makeServices({ enabled: true, newerRows: 0 });
    const ops = createSessionOps(services);

    await ops.getSummary({ sessionId: SID });
    expect(maybeSummarizeNow).not.toHaveBeenCalled();
  });

  it('does NOT kick when the feature is disabled, and reports enabled:false', async () => {
    const { services, maybeSummarizeNow } = makeServices({ enabled: false, newerRows: 5 });
    const ops = createSessionOps(services);

    const res = (await ops.getSummary({ sessionId: SID })) as { data: SessionSummaryPayload };
    expect(res.data.enabled).toBe(false);
    expect(maybeSummarizeNow).not.toHaveBeenCalled();
  });
});
