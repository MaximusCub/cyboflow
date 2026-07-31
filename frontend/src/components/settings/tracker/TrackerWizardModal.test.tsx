/**
 * TrackerWizardModal — connect-wizard tests.
 *
 * Same harness as IntegrationsSettings.test.tsx (render the real component over
 * a module mock of its dependency), with every `cyboflow.tracker.wizard*` probe
 * stubbed so the six steps can be walked without a provider.
 *
 * Coverage: the Step-0 gate (no forward navigation before a successful
 * validate); the two Step-2 footer guards (by-assignee with nobody picked,
 * manual with nothing ticked); the Step-3 mapping table seeded from the
 * canonical state groups; the Step-4 defaults (a row with a suggestion starts on
 * Link, everything else on Keep); and the payload `connect` finally receives.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TrackerIssue,
  TrackerReconcileItem,
  TrackerSourceNarrow,
  TrackerSourceTree,
  TrackerState,
} from '../../../../../shared/types/trackerSync';

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tracker: {
        wizardValidate: { mutate: vi.fn() },
        wizardContainers: { mutate: vi.fn() },
        wizardNarrows: { mutate: vi.fn() },
        wizardIssues: { mutate: vi.fn() },
        wizardStates: { mutate: vi.fn() },
        reconcilePreview: { mutate: vi.fn() },
        connect: { mutate: vi.fn() },
      },
    },
  },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerWizardModal } from './TrackerWizardModal';
import { trpc } from '../../../trpc/client';

const mockValidate = vi.mocked(trpc.cyboflow.tracker.wizardValidate.mutate);
const mockContainers = vi.mocked(trpc.cyboflow.tracker.wizardContainers.mutate);
const mockNarrows = vi.mocked(trpc.cyboflow.tracker.wizardNarrows.mutate);
const mockIssues = vi.mocked(trpc.cyboflow.tracker.wizardIssues.mutate);
const mockStates = vi.mocked(trpc.cyboflow.tracker.wizardStates.mutate);
const mockReconcile = vi.mocked(trpc.cyboflow.tracker.reconcilePreview.mutate);
const mockConnect = vi.mocked(trpc.cyboflow.tracker.connect.mutate);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TREE: TrackerSourceTree = {
  containerLabel: 'Team',
  containers: [
    { id: 'core', name: 'Core', key: 'COR', openIssueCount: 24 },
    { id: 'plat', name: 'Platform', key: 'PLT', openIssueCount: 17 },
  ],
};

const NARROWS: TrackerSourceNarrow[] = [
  { id: 'all', kind: 'all', name: 'Whole team · all open issues', issueCount: 24 },
  { id: 'cyc-12', kind: 'cycle', name: 'Current cycle', issueCount: 8 },
];

function makeIssue(overrides: Partial<TrackerIssue> & Pick<TrackerIssue, 'externalId'>): TrackerIssue {
  return {
    identifier: 'CORE-1',
    title: 'An issue',
    description: null,
    url: 'https://linear.app/x/CORE-1',
    stateId: 'todo',
    assignee: null,
    estimate: null,
    parentExternalId: null,
    updatedAt: '2026-07-30T09:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

const ISSUES: TrackerIssue[] = [
  makeIssue({
    externalId: 'iss-1',
    identifier: 'CORE-138',
    title: 'Token budget alerts',
    stateId: 'todo',
    assignee: { id: 'jk', name: 'Jaya Kesteva', initials: 'JK' },
    estimate: 3,
  }),
  makeIssue({
    externalId: 'iss-2',
    identifier: 'CORE-118',
    title: 'Diff gutter spacing',
    stateId: 'inprog',
    assignee: { id: 'mr', name: 'Mira Rao', initials: 'MR' },
  }),
];

const STATES: TrackerState[] = [
  { id: 'triage', name: 'Triage', color: null, group: 'triage' },
  { id: 'backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'todo', name: 'Todo', color: null, group: 'unstarted' },
  { id: 'inprog', name: 'In Progress', color: null, group: 'started' },
  { id: 'done', name: 'Done', color: null, group: 'completed' },
  { id: 'cancel', name: 'Canceled', color: null, group: 'cancelled' },
];

const RECONCILE: TrackerReconcileItem[] = [
  {
    entityType: 'idea',
    entityId: 'idea-4',
    ref: 'IDEA-004',
    title: 'Add token budget alerts',
    suggestedExternalId: 'iss-1',
  },
  {
    entityType: 'task',
    entityId: 'task-7',
    ref: 'TASK-007',
    title: 'Refactor executor retry loop',
    suggestedExternalId: null,
  },
];

const onClose = vi.fn();
const onConnected = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockValidate.mockResolvedValue({
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    actorLabel: 'J. Kesteva',
  });
  mockContainers.mockResolvedValue(TREE);
  mockNarrows.mockResolvedValue(NARROWS);
  mockIssues.mockResolvedValue(ISSUES);
  mockStates.mockResolvedValue(STATES);
  mockReconcile.mockResolvedValue(RECONCILE);
  mockConnect.mockResolvedValue({ connectionId: 'conn-1' });
});

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

function renderWizard(): void {
  render(
    <TrackerWizardModal
      isOpen
      provider="linear"
      projectId={7}
      onClose={onClose}
      onConnected={onConnected}
    />,
  );
}

/** Paste a key, authorize, and land on Step 1. */
async function authorize(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'lin_api_x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
  await screen.findByTestId('tracker-authorized-card');
}

/**
 * Walk forward `count` steps from Step 0 through the Continue/Review button,
 * settling on the rail's `aria-current` rather than the button itself (the
 * clicked node is unmounted mid-transition and keeps its stale attributes).
 */
async function advance(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const label = screen.queryByRole('button', { name: 'Continue' }) !== null ? 'Continue' : 'Review';
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(screen.getByTestId(`tracker-step-${i + 1}`)).toHaveAttribute('aria-current', 'step'),
    );
  }
}

describe('TrackerWizardModal — Step 0 gate', () => {
  it('locks every later step until the key validates', async () => {
    renderWizard();

    for (const index of [1, 2, 3, 4, 5]) {
      expect(screen.getByTestId(`tracker-step-${index}`)).toBeDisabled();
    }
    // Nothing to authorize with yet.
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'lin_api_x' } });
    expect(screen.getByRole('button', { name: 'Authorize' })).toBeEnabled();

    // A rail click before validating is inert — no probe fires, step 0 stays.
    fireEvent.click(screen.getByTestId('tracker-step-1'));
    expect(mockContainers).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(await screen.findByText('Authorized as J. Kesteva')).toBeInTheDocument();
    expect(screen.getByText('workspace Acme')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(/Pick a team/)).toBeInTheDocument();
    expect(mockContainers).toHaveBeenCalledTimes(1);
  });

  it('retires the validated identity when the key is edited', async () => {
    renderWizard();
    await authorize();

    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'lin_other' } });

    await waitFor(() =>
      expect(screen.queryByTestId('tracker-authorized-card')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('tracker-step-1')).toBeDisabled();
  });

  it('surfaces a rejected key instead of advancing', async () => {
    mockValidate.mockRejectedValue(new Error('The tracker rejected these credentials.'));
    renderWizard();

    fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The tracker rejected these credentials.',
    );
    expect(screen.getByTestId('tracker-step-1')).toBeDisabled();
  });
});

describe('TrackerWizardModal — Step 2 guards', () => {
  it('blocks by-assignee with nobody picked and manual with nothing ticked', async () => {
    renderWizard();
    await authorize();
    await advance(2); // → Source → Tasks

    expect(await screen.findByText('Which issues come in?')).toBeInTheDocument();
    // "All tasks" imports everything, so Continue is live.
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'By assignee' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Jaya Kesteva/ }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /CORE-118/ }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(screen.getByText('1 issues will sync')).toBeInTheDocument();
  });
});

describe('TrackerWizardModal — Step 3 mapping', () => {
  it('seeds each tracker state from its canonical group', async () => {
    renderWizard();
    await authorize();
    await advance(3); // → Source → Tasks → States

    expect(await screen.findByText('Map Linear states to cyboflow')).toBeInTheDocument();
    const seeded: Record<string, string> = {
      Triage: 'dont',
      Backlog: 'idea',
      Todo: 'ready',
      'In Progress': 'ready',
      Done: 'done',
      Canceled: 'wontdo',
    };
    for (const [state, target] of Object.entries(seeded)) {
      expect(screen.getByLabelText(`Cyboflow state for ${state}`)).toHaveValue(target);
    }
  });

  it('reveals mirroring + conflict mode only while two-way sync is on', async () => {
    renderWizard();
    await authorize();
    await advance(3);

    await screen.findByText('Map Linear states to cyboflow');
    expect(
      screen.getByRole('switch', { name: 'Mirror task breakdowns as sub-issues' }),
    ).toBeChecked();
    expect(screen.getByRole('group', { name: 'Conflict mode' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Two-way sync' }));

    expect(
      screen.queryByRole('switch', { name: 'Mirror task breakdowns as sub-issues' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Conflict mode' })).not.toBeInTheDocument();
  });
});

describe('TrackerWizardModal — Step 4 reconcile', () => {
  it('defaults a suggested row to Link and everything else to Keep', async () => {
    renderWizard();
    await authorize();
    await advance(4); // → Source → Tasks → States → Reconcile

    expect(await screen.findByText('Your existing cyboflow backlog')).toBeInTheDocument();
    expect(mockReconcile).toHaveBeenCalledWith({ projectId: 7, issues: ISSUES });

    const suggested = screen.getByRole('group', { name: 'Action for IDEA-004' });
    expect(within(suggested).getByRole('button', { name: 'Link' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // The link target pre-fills with the suggestion.
    expect(screen.getByLabelText('Merge IDEA-004 into')).toHaveValue('iss-1');

    const unsuggested = screen.getByRole('group', { name: 'Action for TASK-007' });
    expect(within(unsuggested).getByRole('button', { name: 'Keep' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText(/1 kept/)).toBeInTheDocument();
  });

  it('hands the review step and connect the accumulated decisions', async () => {
    renderWizard();
    await authorize();
    await advance(5); // → … → Review

    expect(await screen.findByText('Review the connection')).toBeInTheDocument();
    expect(screen.getByText('Core · Whole team · all open issues')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 2 issues/ }));

    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));
    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        credentials: { provider: 'linear', apiKey: 'lin_api_x' },
        source: { containerId: 'core', narrowId: 'all', narrowKind: 'all' },
        sourceLabel: 'Core · Whole team · all open issues',
        selectionMode: 'all',
        selectionJson: null,
        twoWay: true,
        mirrorSubissues: true,
        conflictMode: 'auto',
        stateMapping: {
          triage: 'dont',
          backlog: 'idea',
          todo: 'ready',
          inprog: 'ready',
          done: 'done',
          cancel: 'wontdo',
        },
        reconcile: [
          {
            entityType: 'idea',
            entityId: 'idea-4',
            action: 'link',
            linkExternalId: 'iss-1',
            linkIdentifier: 'CORE-138',
            linkUrl: 'https://linear.app/x/CORE-1',
          },
          { entityType: 'task', entityId: 'task-7', action: 'keep' },
        ],
      }),
    );
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
