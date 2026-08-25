/**
 * QuickSessionsTable — inline rename affordance on each board row.
 *
 * The row is a whole-row click/keyboard target (opens the session), so the
 * pencil + its inline input must fully isolate their own click/keydown events
 * from that row-level handler — otherwise clicking to rename would ALSO
 * navigate away and mark the session viewed. These tests pin:
 *   - pencil click swaps in a seeded input without opening the session
 *   - Enter commits (API.sessions.rename + store refresh); Escape cancels;
 *     an unchanged/whitespace-only submit closes with no call
 *   - a plain row click (outside the pencil) still opens the session
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';

let mockQuickRows: QuickSessionRow[] = [];

const mockRename = vi.fn();
vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      rename: (...args: Parameters<typeof mockRename>) => mockRename(...args),
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

import { QuickSessionsTable } from '../landing/QuickSessionsTable';

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'smooth-falcon',
    projectId: 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? '2026-07-06T00:00:00.000Z',
    unviewed: overrides.unviewed ?? false,
  };
}

function expectNotOpened(): void {
  expect(mockSetActiveQuickSession).not.toHaveBeenCalled();
  expect(mockSetActiveProjectId).not.toHaveBeenCalled();
  expect(mockGoToSession).not.toHaveBeenCalled();
  expect(mockMarkSessionAsViewed).not.toHaveBeenCalled();
}

beforeEach(() => {
  mockQuickRows = [quickRow()];
  mockRename.mockReset();
  mockRename.mockResolvedValue({ success: true });
  mockSetActiveQuickSession.mockReset();
  mockSetActiveProjectId.mockReset();
  mockGoToSession.mockReset();
  mockMarkSessionAsViewed.mockReset();
  mockMarkSessionAsViewed.mockResolvedValue(undefined);
  mockRefresh.mockReset();
});

describe('QuickSessionsTable — rename affordance', () => {
  it('pencil click swaps in an input seeded with the row name, without opening the session', () => {
    render(<QuickSessionsTable />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));

    const input = screen.getByDisplayValue('smooth-falcon');
    expect(input).toBeInTheDocument();
    expectNotOpened();
  });

  it('new name + Enter calls API.sessions.rename(sessionId, trimmed) once and triggers a store refresh', async () => {
    render(<QuickSessionsTable />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));

    const input = screen.getByDisplayValue('smooth-falcon');
    fireEvent.change(input, { target: { value: '  renamed-otter  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledWith('sess-a', 'renamed-otter');
    await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expectNotOpened();
  });

  it('Escape cancels without calling rename', () => {
    render(<QuickSessionsTable />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));

    const input = screen.getByDisplayValue('smooth-falcon');
    fireEvent.change(input, { target: { value: 'discarded-name' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByText('smooth-falcon')).toBeInTheDocument();
    expectNotOpened();
  });

  it('an unchanged or whitespace-only submit closes without calling rename', () => {
    render(<QuickSessionsTable />);

    // Whitespace-only.
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));
    const blankInput = screen.getByDisplayValue('smooth-falcon');
    fireEvent.change(blankInput, { target: { value: '   ' } });
    fireEvent.keyDown(blankInput, { key: 'Enter' });
    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByText('smooth-falcon')).toBeInTheDocument();

    // Unchanged (whitespace-padded but same trimmed value).
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));
    const paddedInput = screen.getByDisplayValue('smooth-falcon');
    fireEvent.change(paddedInput, { target: { value: '  smooth-falcon  ' } });
    fireEvent.keyDown(paddedInput, { key: 'Enter' });
    expect(mockRename).not.toHaveBeenCalled();
    expect(screen.getByText('smooth-falcon')).toBeInTheDocument();
    expectNotOpened();
  });

  it('row click outside the pencil still opens the session as before', () => {
    render(<QuickSessionsTable />);
    fireEvent.click(screen.getByText('smooth-falcon'));

    expect(mockSetActiveQuickSession).toHaveBeenCalledWith('sess-a', 'quick-run-1');
    expect(mockSetActiveProjectId).toHaveBeenCalledWith(1);
    expect(mockGoToSession).toHaveBeenCalled();
    expect(mockMarkSessionAsViewed).toHaveBeenCalledWith('sess-a');
  });

  it('a blur-dismissed rename still commits after a prior Enter/Escape commit on the same row (no stale suppression latch)', () => {
    render(<QuickSessionsTable />);

    // First commit via Enter — the row component instance is keyed by
    // sessionId and stays mounted, so any latch left behind here must not
    // survive into the next edit.
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));
    fireEvent.change(screen.getByDisplayValue('smooth-falcon'), { target: { value: 'first-rename' } });
    fireEvent.keyDown(screen.getByDisplayValue('first-rename'), { key: 'Enter' });
    expect(mockRename).toHaveBeenCalledTimes(1);
    mockRename.mockClear();

    // Re-open and dismiss by blur this time (unmounting the focused input
    // fires no blur event, so this must not be a silent no-op).
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));
    const input = screen.getByDisplayValue('smooth-falcon');
    fireEvent.change(input, { target: { value: 'second-rename' } });
    fireEvent.blur(input);

    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledWith('sess-a', 'second-rename');
    expect(screen.queryByDisplayValue('second-rename')).toBeNull();
  });

  it('clicking the row outside the input while editing does not open the session', () => {
    render(<QuickSessionsTable />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));
    fireEvent.change(screen.getByDisplayValue('smooth-falcon'), { target: { value: 'draft-name' } });

    // The state chip sits outside the input but is still part of the row.
    fireEvent.click(screen.getByText('idle'));

    expectNotOpened();
  });

  it('a native-order click-away dismiss (mousedown → blur → click) commits the rename without opening the session', () => {
    // Real browsers dispatch the dismissing click's mousedown, then the input's
    // blur (which saves and closes the editor), then the click — so by click
    // time the row's isEditing guard already sees false. The mousedown-armed
    // suppression must swallow exactly that click.
    render(<QuickSessionsTable />);
    fireEvent.click(screen.getByRole('button', { name: 'Rename session' }));
    const input = screen.getByDisplayValue('smooth-falcon');
    fireEvent.change(input, { target: { value: 'clicked-away' } });

    const chip = screen.getByText('idle');
    fireEvent.mouseDown(chip);
    fireEvent.blur(input);
    fireEvent.click(chip);

    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockRename).toHaveBeenCalledWith('sess-a', 'clicked-away');
    expectNotOpened();

    // The suppression is one-shot: the next ordinary click opens the session.
    fireEvent.mouseDown(chip);
    fireEvent.click(chip);
    expect(mockSetActiveQuickSession).toHaveBeenCalledTimes(1);
  });
});
