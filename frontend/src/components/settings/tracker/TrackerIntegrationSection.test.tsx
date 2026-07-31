/**
 * TrackerIntegrationSection — catalog tests.
 *
 * Harness mirrors IntegrationsSettings.test.tsx: render the real component over
 * a module mock of its one dependency (here the tRPC client rather than the IPC
 * API facade), then assert on what the user sees.
 *
 * Coverage: exactly two rows regardless of what came back; a provider with a
 * connection renders Connected + Manage while its sibling renders Not connected
 * + Connect; no active project disables Connect and never queries; the live
 * subscription re-reads on a change event.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerConnectionSummary } from '../../../../../shared/types/trackerSync';

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tracker: {
        connections: { query: vi.fn() },
        conflicts: { query: vi.fn() },
        onTrackerChanged: { subscribe: vi.fn() },
      },
    },
  },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerIntegrationSection } from './TrackerIntegrationSection';
import { trpc } from '../../../trpc/client';
import { useNavigationStore } from '../../../stores/navigationStore';

const mockConnections = vi.mocked(trpc.cyboflow.tracker.connections.query);
const mockSubscribe = vi.mocked(trpc.cyboflow.tracker.onTrackerChanged.subscribe);

function makeConnection(
  overrides: Partial<TrackerConnectionSummary> = {},
): TrackerConnectionSummary {
  return {
    id: 'conn-1',
    projectId: 7,
    provider: 'linear',
    status: 'active',
    workspaceName: 'Acme',
    actorLabel: 'J. Kesteva',
    baseUrl: null,
    sourceLabel: 'Core · Current cycle',
    selectionMode: 'all',
    twoWay: true,
    mirrorSubissues: true,
    conflictMode: 'auto',
    stateMapping: { s1: 'idea', s2: 'ready' },
    lastSyncAt: '2026-07-30T10:00:00.000Z',
    lastSyncLog: [],
    linkedCount: 12,
    openConflictCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConnections.mockResolvedValue([]);
  mockSubscribe.mockReturnValue({ unsubscribe: vi.fn() });
  useNavigationStore.setState({ activeProjectId: 7 });
});

describe('TrackerIntegrationSection', () => {
  it('renders exactly the Linear and Plane rows', async () => {
    render(<TrackerIntegrationSection />);

    expect(await screen.findByText('Linear')).toBeInTheDocument();
    expect(screen.getByText('Plane')).toBeInTheDocument();
    // No GitHub/Jira/Slack rows survive from the prototype.
    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
    expect(screen.queryByText('Jira')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(2);
  });

  it('shows Connected + Manage for a connected provider and leaves its sibling connectable', async () => {
    mockConnections.mockResolvedValue([makeConnection()]);
    render(<TrackerIntegrationSection />);

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    // Plane is still the one connectable row.
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Connect' })).toHaveLength(1);
  });

  it('queries the ACTIVE project and re-reads when a tracker change arrives', async () => {
    render(<TrackerIntegrationSection />);

    await waitFor(() => expect(mockConnections).toHaveBeenCalledWith({ projectId: 7 }));
    expect(mockSubscribe).toHaveBeenCalledWith({ projectId: 7 }, expect.anything());

    // Fire the subscription's onData the way the router would.
    const handlers = mockSubscribe.mock.calls[0][1];
    handlers.onData?.({ projectId: 7, connectionId: 'conn-1', kind: 'sync' });
    await waitFor(() => expect(mockConnections).toHaveBeenCalledTimes(2));
  });

  it('never queries and cannot connect without an active project', async () => {
    useNavigationStore.setState({ activeProjectId: null });
    render(<TrackerIntegrationSection />);

    expect(await screen.findByText('Select a project to connect an issue tracker.')).toBeInTheDocument();
    expect(mockConnections).not.toHaveBeenCalled();
    for (const button of screen.getAllByRole('button', { name: 'Connect' })) {
      expect(button).toBeDisabled();
    }
  });

  it('opens the wizard for the provider whose Connect was pressed', async () => {
    render(<TrackerIntegrationSection />);

    const [linearConnect] = await screen.findAllByRole('button', { name: 'Connect' });
    fireEvent.click(linearConnect);

    expect(await screen.findByTestId('tracker-wizard-modal')).toBeInTheDocument();
    expect(screen.getByText('/ Connect Linear')).toBeInTheDocument();
  });
});
