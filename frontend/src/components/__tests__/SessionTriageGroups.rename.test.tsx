/**
 * SessionTriageGroups — inline rename affordance on each row type.
 *
 * Ported from the deleted QuickSessionsTable.rename.test.tsx (commit 26d811841,
 * click-away fix 083695a6c) onto the three row shapes that replaced the old
 * flat board's single row: NeedsInputCard (full-width card), ReadyRow, and
 * WorkingRow (both compact `div[role=button]` rows). All three share one
 * `useInlineRename` hook + `InlineNameEditor`, so the same case list is run
 * against each via `describe.each`. Pins:
 *   - pencil swaps in a seeded input without opening the session
 *   - Enter commits (API.sessions.rename + store refresh); Escape cancels; an
 *     unchanged/whitespace-only submit closes with no call
 *   - a native-order click-away (fireEvent mousedown → blur → click, matching
 *     the real browser ordering) commits the rename WITHOUT opening the
 *     session or marking it viewed — the 083695a6c regression — and the
 *     one-shot suppression doesn't swallow the next ordinary click
 *   - a plain click on the row while editing (no click-away sequence) is
 *     guarded by the `isEditing` check on its own
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';

let mockQuickRows: QuickSessionRow[] = [];

const mockRename = vi.fn();
const mockGetSummary = vi.fn();
vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      rename: (...args: Parameters<typeof mockRename>) => mockRename(...args),
      getSummary: (...args: Parameters<typeof mockGetSummary>) => mockGetSummary(...args),
    },
  },
}));

const mockSetActiveQuickSession = vi.fn();
vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveQuickSession: mockSetActiveQuickSession }) },
}));

const mockSetActiveProjectId = vi.fn();
const mockGoToSession = vi.fn();
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ setActiveProjectId: mockSetActiveProjectId, goToSession: mockGoToSession }) },
}));

const mockMarkSessionAsViewed = vi.fn().mockResolvedValue(undefined);
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ markSessionAsViewed: mockMarkSessionAsViewed }) },
}));

const mockRefresh = vi.fn();
vi.mock('../../stores/quickSessionsStore', () => ({
  useQuickSessionRows: () => mockQuickRows,
  useQuickSessionsStore: { getState: () => ({ init: () => () => undefined, refresh: mockRefresh }) },
}));

vi.mock('../../stores/dynamicWorkflowStore', () => ({
  useActiveDynamicWorkflows: () => [],
}));

import { SessionTriageGroups } from '../landing/SessionTriageGroups';

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'smooth-falcon',
    projectId: 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? '2026-07-06T00:00:00.000Z',
    unviewed: overrides.unviewed ?? false,
    restedAtIso: overrides.restedAtIso ?? '2026-07-06T00:00:00.000Z',
    rawStatus: overrides.rawStatus ?? 'completed',
    exitCode: overrides.exitCode ?? null,
    summary: overrides.summary ?? null,
    summaryState: overrides.summaryState ?? null,
    waitingOn: overrides.waitingOn ?? null,
    summarySupported: overrides.summarySupported ?? true,
    worktreeName: overrides.worktreeName ?? null,
    git: overrides.git ?? null,
  };
}

function expectNotOpened(): void {
  expect(mockSetActiveQuickSession).not.toHaveBeenCalled();
  expect(mockSetActiveProjectId).not.toHaveBeenCalled();
  expect(mockGoToSession).not.toHaveBeenCalled();
  expect(mockMarkSessionAsViewed).not.toHaveBeenCalled();
}

beforeEach(() => {
  mockQuickRows = [];
  mockRename.mockReset().mockResolvedValue({ success: true });
  mockGetSummary.mockReset().mockResolvedValue({
    success: true,
    data: { enabled: true, summary: null, updatedAt: null, entries: [] },
  });
  mockSetActiveQuickSession.mockReset();
  mockSetActiveProjectId.mockReset();
  mockGoToSession.mockReset();
  mockMarkSessionAsViewed.mockReset().mockResolvedValue(undefined);
  mockRefresh.mockReset();
});

/** One row fixture per triage group — see utils/quickSessionTriage.ts for the classification rules. */
const ROW_FIXTURES: Record<'ReadyRow' | 'WorkingRow' | 'NeedsInputCard', Partial<QuickSessionRow>> = {
  ReadyRow: { state: 'idle', summaryState: null },
  WorkingRow: { state: 'running', idleSince: null },
  NeedsInputCard: { state: 'blocked', idleSince: null },
};

describe.each(Object.keys(ROW_FIXTURES) as Array<keyof typeof ROW_FIXTURES>)('%s — inline rename', (rowType) => {
  beforeEach(() => {
    mockQuickRows = [quickRow(ROW_FIXTURES[rowType])];
  });

  it('pencil swaps in an input seeded with the row name, without opening the session', async () => {
    const user = userEvent.setup();
    render(<SessionTriageGroups />);

    await user.click(screen.getByRole('button', { name: 'Rename session' }));

    expect(screen.getByDisplayValue('smooth-falcon')).toBeInTheDocument();
    expectNotOpened();
  });

  it('new name + Enter calls API.sessions.rename(sessionId, trimmed) once and triggers a store refresh', async () => {
    const user = userEvent.setup();
    render(<SessionTriageGroups />);
    await user.click(screen.getByRole('button', { name: 'Rename session' }));

    const input = screen.getByDisplayValue('smooth-falcon');
    await user.clear(input);
    await user.type(input, '  renamed-otter  {Enter}');

    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledWith('sess-a', 'renamed-otter');
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expectNotOpened();
  });

  it('Escape cancels without calling rename', async () => {
    const user = userEvent.setup();
    render(<SessionTriageGroups />);
    await user.click(screen.getByRole('button', { name: 'Rename session' }));

    const input = screen.getByDisplayValue('smooth-falcon');
    await user.clear(input);
    await user.type(input, 'discarded-name{Escape}');

    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByText('smooth-falcon')).toBeInTheDocument();
    expectNotOpened();
  });

  it('an unchanged or whitespace-only submit closes without calling rename', async () => {
    const user = userEvent.setup();
    render(<SessionTriageGroups />);

    // Whitespace-only.
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
    const blankInput = screen.getByDisplayValue('smooth-falcon');
    await user.clear(blankInput);
    await user.type(blankInput, '   {Enter}');
    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByText('smooth-falcon')).toBeInTheDocument();

    // Unchanged (whitespace-padded but same trimmed value).
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
    const paddedInput = screen.getByDisplayValue('smooth-falcon');
    await user.clear(paddedInput);
    await user.type(paddedInput, '  smooth-falcon  {Enter}');
    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByText('smooth-falcon')).toBeInTheDocument();
    expectNotOpened();
  });

  it('a native-order click-away dismiss (mousedown → blur → click) commits the rename without opening the session, and the suppression is one-shot', async () => {
    // Real browsers dispatch the dismissing click's mousedown, then the input's
    // blur (which saves and closes the editor), then the click — so by click
    // time the row's isEditing guard already sees false. The mousedown-armed
    // suppression must swallow exactly that click (083695a6c). fireEvent gives
    // exact control over this ordering rather than trusting a helper's default
    // sequencing, which is the point of pinning it.
    const user = userEvent.setup();
    render(<SessionTriageGroups />);
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
    const input = screen.getByDisplayValue('smooth-falcon');
    await user.clear(input);
    await user.type(input, 'clicked-away');

    const row = input.closest('[role="button"]') as HTMLElement;
    expect(row).not.toBeNull();
    fireEvent.mouseDown(row);
    fireEvent.blur(input);
    fireEvent.click(row);

    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledWith('sess-a', 'clicked-away');
    expectNotOpened();

    // The suppression is one-shot: the next ordinary click opens the session.
    fireEvent.mouseDown(row);
    fireEvent.click(row);
    expect(mockSetActiveQuickSession).toHaveBeenCalledTimes(1);
  });

  it('a plain click on the row while editing (no preceding mousedown) does not open the session', async () => {
    // Isolates the plain `if (isEditing) return` guard from the mousedown-armed
    // suppression exercised above — no mousedown precedes this click, so
    // suppressClickRef stays disarmed and the isEditing check alone must hold.
    const user = userEvent.setup();
    render(<SessionTriageGroups />);
    await user.click(screen.getByRole('button', { name: 'Rename session' }));
    const input = screen.getByDisplayValue('smooth-falcon');
    await user.type(input, 'draft-name');

    const row = input.closest('[role="button"]') as HTMLElement;
    fireEvent.click(row);

    expectNotOpened();
  });
});
