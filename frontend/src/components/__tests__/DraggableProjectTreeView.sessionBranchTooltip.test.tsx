/**
 * SessionRow branch hover tooltip (sidebar rail) — hovering a session's name
 * lazily resolves the worktree's live branch and folds it into the row's
 * `title`. SessionRow-local state only (no new props; sessionRowPropsEqual is
 * untouched). Scaffolding copied from
 * DraggableProjectTreeView.sessionRename.test.tsx.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRow, type SessionRowProps } from '../DraggableProjectTreeView';
import type { Session } from '../../types/session';
import { API } from '../../utils/api';

vi.mock('../../utils/api', () => ({
  API: {
    sessions: {
      rename: vi.fn(),
      getCurrentBranch: vi.fn(),
    },
  },
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    name: 'My Session',
    projectId: 1,
    displayOrder: 0,
    worktreePath: '/tmp/sess-1',
    prompt: '',
    status: 'ready',
    createdAt: '2026-01-01',
    output: [],
    jsonMessages: [],
    ...overrides,
  };
}

function makeProps(overrides: Partial<SessionRowProps> = {}): SessionRowProps {
  return {
    session: makeSession(),
    projectId: 1,
    isLastSession: true,
    isActive: false,
    relativeTime: '5 minutes ago',
    sessionDropIndicator: null,
    childRuns: [],
    activeRunId: null,
    onSessionClick: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
    onDragEnter: vi.fn(),
    onDragLeave: vi.fn(),
    onActiveRunClick: vi.fn(),
    ...overrides,
  };
}

const mockedGetCurrentBranch = vi.mocked(API.sessions.getCurrentBranch);

describe('SessionRow — branch hover tooltip', () => {
  beforeEach(() => {
    mockedGetCurrentBranch.mockReset();
    mockedGetCurrentBranch.mockResolvedValue({ success: true, data: { branch: 'steady-reef' } });
  });

  it('shows only the name until the row is hovered', () => {
    render(<SessionRow {...makeProps()} />);

    expect(screen.getByText('My Session')).toHaveAttribute('title', 'My Session');
    expect(mockedGetCurrentBranch).not.toHaveBeenCalled();
  });

  it('hovering the name fetches the branch and folds it into the title', async () => {
    render(<SessionRow {...makeProps({ session: makeSession({ id: 'sess-7' }) })} />);

    fireEvent.mouseEnter(screen.getByText('My Session'));

    await waitFor(() =>
      expect(screen.getByText('My Session')).toHaveAttribute('title', 'My Session\nBranch: steady-reef'),
    );
    expect(mockedGetCurrentBranch).toHaveBeenCalledWith('sess-7');
  });

  it('re-fetches on each hover so a rebased branch stays honest', async () => {
    render(<SessionRow {...makeProps()} />);
    const name = screen.getByText('My Session');

    fireEvent.mouseEnter(name);
    await waitFor(() => expect(name).toHaveAttribute('title', 'My Session\nBranch: steady-reef'));

    mockedGetCurrentBranch.mockResolvedValue({ success: true, data: { branch: 'renamed-branch' } });
    fireEvent.mouseEnter(name);

    await waitFor(() => expect(name).toHaveAttribute('title', 'My Session\nBranch: renamed-branch'));
    expect(mockedGetCurrentBranch).toHaveBeenCalledTimes(2);
  });

  it('never calls the API for an archived session (its worktree is gone)', () => {
    render(<SessionRow {...makeProps({ session: makeSession({ archived: true }) })} />);

    fireEvent.mouseEnter(screen.getByText('My Session'));

    expect(mockedGetCurrentBranch).not.toHaveBeenCalled();
  });

  it('falls back to the bare name when the branch cannot be resolved', async () => {
    mockedGetCurrentBranch.mockResolvedValue({ success: true, data: { branch: null } });
    render(<SessionRow {...makeProps()} />);

    fireEvent.mouseEnter(screen.getByText('My Session'));

    await waitFor(() => expect(mockedGetCurrentBranch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('My Session')).toHaveAttribute('title', 'My Session');
  });

  it('swallows a rejected lookup rather than surfacing it', async () => {
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree unreadable'));
    render(<SessionRow {...makeProps()} />);

    fireEvent.mouseEnter(screen.getByText('My Session'));

    await waitFor(() => expect(mockedGetCurrentBranch).toHaveBeenCalledTimes(1));
    expect(screen.getByText('My Session')).toHaveAttribute('title', 'My Session');
  });
});
