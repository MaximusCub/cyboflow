/**
 * TrackerWizardModal — connect-wizard tests.
 *
 * Same harness as IntegrationsSettings.test.tsx (render the real component over
 * a module mock of its dependency), with every `cyboflow.tracker.wizard*` probe
 * stubbed so the six steps can be walked without a provider.
 *
 * The fixture maps a workspace of three groups onto two cyboflow projects — two
 * groups sharing one project, one group on its own — because that is the shape
 * every rev-4 behaviour keys off: the push-target radio, the per-scope state
 * tables, the per-project reconcile previews, and the routing of a link decision
 * to the one mapping whose issue set holds it.
 *
 * Coverage: the Step-0 gate; the Map step (group rows, N:1 push-target radio);
 * per-mapping issue probes; one states probe per distinct scope key; one
 * reconcile probe per target project; the sequential per-mapping connect
 * payloads; and a partial failure that keeps the modal open and retries only
 * the row that failed.
 *
 * Plus ADD-MAPPING MODE (`sourceConnection` set), whose whole point is that no
 * key is asked for or sent a second time: Step 0 is absent rather than
 * pre-answered, every probe names the connection, `connect` carries
 * `sourceConnectionId`, and the Map step chips the scopes its siblings cover
 * without locking them.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TrackerConnectionSummary,
  TrackerGroupTree,
  TrackerIssue,
  TrackerReconcileItem,
  TrackerSourceSelection,
  TrackerState,
} from '../../../../../shared/types/trackerSync';

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tracker: {
        wizardValidate: { mutate: vi.fn() },
        wizardGroups: { mutate: vi.fn() },
        wizardIssues: { mutate: vi.fn() },
        wizardStates: { mutate: vi.fn() },
        reconcilePreview: { mutate: vi.fn() },
        connect: { mutate: vi.fn() },
        mappings: { query: vi.fn() },
      },
    },
  },
}));

// The Map step's project list comes over IPC, not tRPC — same module-mock pattern.
vi.mock('../../../utils/api', () => ({
  API: { projects: { getAll: vi.fn() } },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerWizardModal } from './TrackerWizardModal';
import { trpc } from '../../../trpc/client';
import { API } from '../../../utils/api';

const mockValidate = vi.mocked(trpc.cyboflow.tracker.wizardValidate.mutate);
const mockGroups = vi.mocked(trpc.cyboflow.tracker.wizardGroups.mutate);
const mockIssues = vi.mocked(trpc.cyboflow.tracker.wizardIssues.mutate);
const mockStates = vi.mocked(trpc.cyboflow.tracker.wizardStates.mutate);
const mockReconcile = vi.mocked(trpc.cyboflow.tracker.reconcilePreview.mutate);
const mockConnect = vi.mocked(trpc.cyboflow.tracker.connect.mutate);
const mockMappings = vi.mocked(trpc.cyboflow.tracker.mappings.query);
const mockProjectsGetAll = vi.mocked(API.projects.getAll);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECTS = [
  {
    id: 7,
    name: 'Cyboflow',
    path: '/dev/cyboflow',
    active: true,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
  {
    id: 9,
    name: 'Website',
    path: '/dev/website',
    active: false,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  },
];

/**
 * Two Linear projects under the SAME team (so they share a state scope) plus a
 * whole-team group under a second team.
 */
const GROUPS: TrackerGroupTree = {
  sections: [
    {
      label: 'Projects',
      groups: [
        {
          id: 'proj-alpha',
          name: 'Alpha',
          key: 'COR',
          sourceLabel: 'Core · Alpha',
          selection: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
          stateScopeKey: 'core',
        },
        {
          id: 'proj-beta',
          name: 'Beta',
          key: 'COR',
          sourceLabel: 'Core · Beta',
          selection: { containerId: 'core', narrowId: 'beta', narrowKind: 'project' },
          stateScopeKey: 'core',
        },
      ],
    },
    {
      label: 'Whole teams',
      groups: [
        {
          id: 'team-core',
          name: 'Core',
          key: 'COR',
          sourceLabel: 'Core · all open issues',
          selection: { containerId: 'core', narrowId: 'all', narrowKind: 'all' },
          stateScopeKey: 'core',
        },
        {
          id: 'team-plat',
          name: 'Platform',
          key: 'PLT',
          sourceLabel: 'Platform · all open issues',
          selection: { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
          stateScopeKey: 'plat',
        },
      ],
    },
  ],
};

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
    recoveryClientKey: null,
    ...overrides,
  };
}

const ALPHA_ISSUES: TrackerIssue[] = [
  makeIssue({
    externalId: 'iss-1',
    identifier: 'CORE-138',
    title: 'Token budget alerts',
    stateId: 'todo',
    assignee: { id: 'jk', name: 'Jaya Kesteva', initials: 'JK' },
    estimate: 3,
  }),
];

const BETA_ISSUES: TrackerIssue[] = [
  makeIssue({
    externalId: 'iss-2',
    identifier: 'CORE-118',
    title: 'Diff gutter spacing',
    stateId: 'inprog',
    assignee: { id: 'mr', name: 'Mira Rao', initials: 'MR' },
  }),
];

const PLAT_ISSUES: TrackerIssue[] = [
  makeIssue({
    externalId: 'iss-3',
    identifier: 'PLT-9',
    title: 'Ship the installer',
    stateId: 'todo',
    assignee: { id: 'jk', name: 'Jaya Kesteva', initials: 'JK' },
  }),
];

const ISSUES_BY_CONTAINER: Record<string, Record<string, TrackerIssue[]>> = {
  core: { alpha: ALPHA_ISSUES, beta: BETA_ISSUES },
  plat: { all: PLAT_ISSUES },
};

const CORE_STATES: TrackerState[] = [
  { id: 'triage', name: 'Triage', color: null, group: 'triage' },
  { id: 'backlog', name: 'Backlog', color: null, group: 'backlog' },
  { id: 'todo', name: 'Todo', color: null, group: 'unstarted' },
  { id: 'inprog', name: 'In Progress', color: null, group: 'started' },
  { id: 'done', name: 'Done', color: null, group: 'completed' },
  { id: 'cancel', name: 'Canceled', color: null, group: 'cancelled' },
];

const PLAT_STATES: TrackerState[] = [
  { id: 'plat-todo', name: 'Todo', color: null, group: 'unstarted' },
  { id: 'plat-done', name: 'Shipped', color: null, group: 'completed' },
];

/** The Cyboflow project's pre-existing backlog; its one suggestion is a Beta issue. */
const RECONCILE_7: TrackerReconcileItem[] = [
  {
    entityType: 'idea',
    entityId: 'idea-4',
    ref: 'IDEA-004',
    title: 'Diff gutter spacing',
    suggestedExternalId: 'iss-2',
  },
  {
    entityType: 'task',
    entityId: 'task-7',
    ref: 'TASK-007',
    title: 'Refactor executor retry loop',
    suggestedExternalId: null,
  },
];

const RECONCILE_9: TrackerReconcileItem[] = [
  {
    entityType: 'idea',
    entityId: 'idea-9',
    ref: 'IDEA-009',
    title: 'Website backlog item',
    suggestedExternalId: null,
  },
];

/**
 * The connection add-mapping mode extends: one live mapping of the whole
 * Platform team into Cyboflow, on the authorization every probe then reuses.
 */
const SOURCE_CONNECTION: TrackerConnectionSummary = {
  id: 'conn-src',
  projectId: 7,
  provider: 'linear',
  status: 'active',
  workspaceName: 'Acme',
  actorLabel: 'J. Kesteva',
  baseUrl: null,
  sourceLabel: 'Platform · all open issues',
  sourceScope: { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
  selectionMode: 'all',
  statusSyncMode: 'auto',
  pullMode: 'auto',
  pushMode: 'auto',
  mirrorSubissues: true,
  conflictMode: 'auto',
  pushTarget: true,
  stateMapping: {},
  lastSyncAt: null,
  lastSyncLog: [],
  linkedCount: 4,
  openConflictCount: 0,
};

/** A sibling on the SAME authorization, mapping Alpha into the Website project. */
const ALPHA_SIBLING: TrackerConnectionSummary = {
  ...SOURCE_CONNECTION,
  id: 'conn-alpha',
  projectId: 9,
  sourceLabel: 'Core · Alpha',
  sourceScope: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
  pushTarget: false,
};

const onClose = vi.fn();
const onConnected = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockValidate.mockResolvedValue({
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    actorLabel: 'J. Kesteva',
  });
  mockGroups.mockResolvedValue(GROUPS);
  // Issues + states are answered from the SELECTION, since the wizard fires one
  // call per mapping and a call-index stub would encode probe order as fact.
  mockIssues.mockImplementation(
    ({ selection }: { selection: TrackerSourceSelection }): Promise<TrackerIssue[]> =>
      Promise.resolve(ISSUES_BY_CONTAINER[selection.containerId]?.[selection.narrowId] ?? []),
  );
  mockStates.mockImplementation(
    ({ selection }: { selection: TrackerSourceSelection }): Promise<TrackerState[]> =>
      Promise.resolve(selection.containerId === 'core' ? CORE_STATES : PLAT_STATES),
  );
  mockReconcile.mockImplementation(
    ({ projectId }: { projectId: number }): Promise<TrackerReconcileItem[]> =>
      Promise.resolve(projectId === 7 ? RECONCILE_7 : RECONCILE_9),
  );
  mockConnect.mockResolvedValue({ connectionId: 'conn-1' });
  // The live siblings of the source connection — itself alone by default, which
  // is what a connection with one mapping actually reports.
  mockMappings.mockResolvedValue([SOURCE_CONNECTION]);
  mockProjectsGetAll.mockResolvedValue({ success: true, data: PROJECTS });
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

/**
 * Open the wizard in add-mapping mode and wait until the Map step is usable:
 * BOTH async reads (the group tree and the project list) have to land before a
 * select can be changed — a `fireEvent.change` to a value whose <option> has not
 * rendered yet is silently a no-op.
 */
async function openAddMapping(): Promise<void> {
  render(
    <TrackerWizardModal
      isOpen
      provider="linear"
      projectId={7}
      sourceConnection={SOURCE_CONNECTION}
      onClose={onClose}
      onConnected={onConnected}
    />,
  );
  await screen.findByLabelText('Cyboflow project for Alpha');
  await screen.findAllByRole('option', { name: 'Cyboflow (Active)' });
}

/** Paste a key, authorize, and land on the Map step. */
async function authorize(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'lin_api_x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
  await screen.findByTestId('tracker-authorized-card');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('Map Linear onto cyboflow projects');
}

function mapGroup(groupName: string, projectId: number): void {
  fireEvent.change(screen.getByLabelText(`Cyboflow project for ${groupName}`), {
    target: { value: String(projectId) },
  });
}

/** The default fixture mapping: Alpha + Beta → Cyboflow (7), Platform → Website (9). */
function mapDefaults(): void {
  mapGroup('Alpha', 7);
  mapGroup('Beta', 7);
  mapGroup('Platform', 9);
}

/**
 * Walk forward `count` steps (from step `from`) through the Continue/Review
 * button, settling on the rail's `aria-current` rather than the button itself
 * (the clicked node is unmounted mid-transition and keeps its stale attributes).
 */
async function advance(count: number, from = 1): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const label = screen.queryByRole('button', { name: 'Continue' }) !== null ? 'Continue' : 'Review';
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(screen.getByTestId(`tracker-step-${from + i + 1}`)).toHaveAttribute(
        'aria-current',
        'step',
      ),
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
    expect(mockGroups).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(await screen.findByText('Authorized as J. Kesteva')).toBeInTheDocument();
    expect(screen.getByText('workspace Acme')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Map Linear onto cyboflow projects')).toBeInTheDocument();
    expect(mockGroups).toHaveBeenCalledTimes(1);
  });

  it('retires the validated identity when the key is edited', async () => {
    renderWizard();
    await authorize();

    fireEvent.click(screen.getByTestId('tracker-step-0'));
    fireEvent.change(await screen.findByLabelText('Personal API key'), {
      target: { value: 'lin_other' },
    });

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

describe('TrackerWizardModal — Map step', () => {
  it('renders every section and blocks Continue until something is mapped', async () => {
    renderWizard();
    await authorize();

    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.getByText('Whole teams')).toBeInTheDocument();
    for (const name of ['Alpha', 'Beta', 'Platform']) {
      expect(screen.getByLabelText(`Cyboflow project for ${name}`)).toHaveValue('');
    }
    // The active project is marked in every select.
    expect(
      within(screen.getByLabelText('Cyboflow project for Alpha')).getByRole('option', {
        name: 'Cyboflow (Active)',
      }),
    ).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    mapGroup('Alpha', 7);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('offers a push-target radio only where two groups share one project', async () => {
    renderWizard();
    await authorize();

    mapGroup('Platform', 9);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();

    mapGroup('Alpha', 7);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();

    mapGroup('Beta', 7);
    expect(screen.getByText('New cyboflow ideas in Cyboflow push to:')).toBeInTheDocument();
    // The first mapped group of the cluster is the default pusher.
    expect(screen.getByRole('radio', { name: 'Alpha' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Beta' })).not.toBeChecked();
    // Website has a single mapping, so it gets no cluster of its own.
    expect(screen.queryByText('New cyboflow ideas in Website push to:')).not.toBeInTheDocument();
  });

  it('warns when a whole-team mapping subsumes a mapped project under it', async () => {
    renderWizard();
    await authorize();

    mapGroup('Alpha', 7);
    const warning =
      'Issues in Alpha are covered by both mappings — each imports once, under whichever mapping syncs it first.';
    expect(screen.queryByText(warning)).not.toBeInTheDocument();

    // Platform is a different team, so it subsumes nothing.
    mapGroup('Platform', 9);
    expect(screen.queryByText(warning)).not.toBeInTheDocument();

    // The whole Core team does subsume Alpha — including across projects, since
    // the engine's guard is keyed by external id, not by target project.
    mapGroup('Core', 9);
    expect(screen.getByText(warning)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Cyboflow project for Core'), {
      target: { value: '' },
    });
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
  });
});

describe('TrackerWizardModal — Tasks step', () => {
  it('fetches issues per mapping and unions the assignee roster', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(1); // → Tasks

    expect(mockIssues).toHaveBeenCalledTimes(3);
    for (const selection of [
      { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
      { containerId: 'core', narrowId: 'beta', narrowKind: 'project' },
      { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
    ]) {
      expect(mockIssues).toHaveBeenCalledWith({
        credentials: { provider: 'linear', apiKey: 'lin_api_x' },
        selection,
      });
    }

    // Rows are grouped per mapping, each under its target project.
    expect(
      within(screen.getByTestId('tracker-issues-proj-alpha')).getByText('Token budget alerts'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('tracker-issues-team-plat')).getByText('Ship the installer'),
    ).toBeInTheDocument();
    expect(screen.getByText('Platform → Website')).toBeInTheDocument();
    expect(screen.getByText('3 issues will sync')).toBeInTheDocument();

    // One roster across all three mappings, deduped by assignee id — Jaya is
    // assigned in two different mappings and appears once, with both counted.
    fireEvent.click(screen.getByRole('button', { name: 'By assignee' }));
    expect(screen.getByRole('button', { name: /Jaya Kesteva/ })).toHaveTextContent('JKJaya Kesteva2');
    expect(screen.getByRole('button', { name: /Mira Rao/ })).toHaveTextContent('MRMira Rao1');
  });

  it('blocks by-assignee with nobody picked and manual with nothing ticked', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(1); // → Tasks

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

describe('TrackerWizardModal — States step', () => {
  it('fetches one table per distinct state scope, not per mapping', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States

    // Three mappings, two scopes: Alpha and Beta share the Core team's states.
    expect(mockStates).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('tracker-state-scope-core')).toBeInTheDocument();
    expect(screen.getByTestId('tracker-state-scope-plat')).toBeInTheDocument();
    expect(screen.getByText('Alpha, Beta')).toBeInTheDocument();

    // Each table is seeded from its own canonical groups, and the labels carry
    // the scope because "Todo" exists in both.
    expect(screen.getByLabelText('Cyboflow state for Todo in Alpha, Beta')).toHaveValue('ready');
    expect(screen.getByLabelText('Cyboflow state for Shipped in Platform')).toHaveValue('done');

    // Direction / mirroring / conflict mode stay global, rendered once.
    expect(screen.getAllByRole('group', { name: 'Sync task status' })).toHaveLength(1);
    expect(
      screen.getByRole('switch', { name: 'Mirror task breakdowns as sub-issues' }),
    ).toBeChecked();
  });

  it('drops both tables when a mapping changes', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(2); // → Tasks → States
    expect(mockStates).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('tracker-step-1'));
    await screen.findByText('Map Linear onto cyboflow projects');
    mapGroup('Beta', 9);

    // The rail clamps back to Map, so States is re-probed on the way forward.
    await waitFor(() => expect(screen.getByTestId('tracker-step-3')).toBeDisabled());
    await advance(2);
    expect(mockStates).toHaveBeenCalledTimes(4);
  });
});

describe('TrackerWizardModal — Reconcile step', () => {
  it('previews each target project once and groups the rows under it', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(3); // → Tasks → States → Reconcile

    expect(mockReconcile).toHaveBeenCalledTimes(2);
    expect(mockReconcile).toHaveBeenCalledWith({
      projectId: 7,
      issues: [...ALPHA_ISSUES, ...BETA_ISSUES],
    });
    expect(mockReconcile).toHaveBeenCalledWith({ projectId: 9, issues: PLAT_ISSUES });

    expect(
      within(screen.getByTestId('tracker-reconcile-7')).getByText('Diff gutter spacing'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('tracker-reconcile-9')).getByText('Website backlog item'),
    ).toBeInTheDocument();

    // A suggested row starts on Link, pre-filled; the rest start on Keep.
    const suggested = screen.getByRole('group', { name: 'Action for IDEA-004' });
    expect(within(suggested).getByRole('button', { name: 'Link' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Merge IDEA-004 into')).toHaveValue('iss-2');
    expect(screen.getByText(/2 kept/)).toBeInTheDocument();
  });
});

describe('TrackerWizardModal — Review + connect', () => {
  it('connects each mapping sequentially with its own source, states and decisions', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    // Beta pushes for Cyboflow instead of Alpha, so Alpha lands pushTarget=false.
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    await advance(4); // → Tasks → States → Reconcile → Review

    expect(await screen.findByText('Review the connections')).toBeInTheDocument();
    expect(screen.getByText('Core · Alpha → Cyboflow')).toBeInTheDocument();
    expect(screen.getByText('Platform · all open issues → Website')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 3 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(3));

    const CORE_MAPPING = {
      triage: 'dont',
      backlog: 'idea',
      todo: 'ready',
      inprog: 'ready',
      done: 'done',
      cancel: 'wontdo',
    };

    // Alpha: the project's first mapping, so it carries the non-link decision —
    // but not the link, whose issue belongs to Beta.
    expect(mockConnect).toHaveBeenNthCalledWith(1, {
      projectId: 7,
      credentials: { provider: 'linear', apiKey: 'lin_api_x' },
      source: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
      sourceLabel: 'Core · Alpha',
      selectionMode: 'all',
      selectionJson: null,
      stateMapping: CORE_MAPPING,
      statusSyncMode: 'auto',
      pullMode: 'auto',
      pushMode: 'auto',
      mirrorSubissues: true,
      conflictMode: 'auto',
      reconcile: [{ entityType: 'task', entityId: 'task-7', action: 'keep' }],
      pushTarget: false,
    });

    // Beta: same scope table, the chosen pusher, and the owner of the link.
    expect(mockConnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        projectId: 7,
        source: { containerId: 'core', narrowId: 'beta', narrowKind: 'project' },
        sourceLabel: 'Core · Beta',
        stateMapping: CORE_MAPPING,
        pushTarget: true,
        reconcile: [
          {
            entityType: 'idea',
            entityId: 'idea-4',
            action: 'link',
            linkExternalId: 'iss-2',
            linkIdentifier: 'CORE-118',
            linkUrl: 'https://linear.app/x/CORE-1',
          },
        ],
      }),
    );

    // Platform: its own project, its own state table, sole pusher there.
    expect(mockConnect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        projectId: 9,
        source: { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
        stateMapping: { 'plat-todo': 'ready', 'plat-done': 'done' },
        pushTarget: true,
        reconcile: [{ entityType: 'idea', entityId: 'idea-9', action: 'keep' }],
      }),
    );

    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives each mapping its OWN manual picks in selectionJson', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(1); // → Tasks

    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    fireEvent.click(screen.getByRole('button', { name: /CORE-138/ }));
    fireEvent.click(screen.getByRole('button', { name: /PLT-9/ }));

    await advance(3, 2); // → States → Reconcile → Review
    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 2 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(3));

    expect(mockConnect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ selectionMode: 'manual', selectionJson: { issueIds: ['iss-1'] } }),
    );
    // Beta contributed nothing to the manual pick, so its list is empty.
    expect(mockConnect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ selectionJson: { issueIds: [] } }),
    );
    expect(mockConnect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ selectionJson: { issueIds: ['iss-3'] } }),
    );
  });

  it('keeps the modal open on a partial failure and retries only the failed mapping', async () => {
    renderWizard();
    await authorize();
    mapDefaults();
    await advance(4); // → … → Review

    mockConnect
      .mockResolvedValueOnce({ connectionId: 'conn-a' })
      .mockRejectedValueOnce(new Error('Linear returned 500.'))
      .mockResolvedValueOnce({ connectionId: 'conn-c' });

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 3 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(3));

    // The modal stays open with the failure attributed to its own row.
    expect(onClose).not.toHaveBeenCalled();
    expect(onConnected).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId('tracker-mapping-proj-beta')).getByText('Linear returned 500.'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('tracker-mapping-proj-alpha')).getByText('Connected'),
    ).toBeInTheDocument();

    mockConnect.mockResolvedValue({ connectionId: 'conn-b' });
    fireEvent.click(await screen.findByRole('button', { name: /Retry 1 failed/ }));

    // Only Beta is re-sent; the two that succeeded are filtered out client-side.
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(4));
    expect(mockConnect).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ sourceLabel: 'Core · Beta' }),
    );
    await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('TrackerWizardModal — add-mapping mode', () => {
  it('opens on Map with no Connect step and never re-asks for the key', async () => {
    await openAddMapping();

    // Step 0 is ABSENT, not disabled: the run has no authorize step to reach.
    expect(screen.queryByTestId('tracker-step-0')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Personal API key')).not.toBeInTheDocument();
    expect(mockValidate).not.toHaveBeenCalled();

    // Map is step 1 of the five that remain, and it is where the wizard landed.
    expect(screen.getByTestId('tracker-step-1')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Map Linear onto cyboflow projects')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 5')).toBeInTheDocument();
    // Nothing sits behind Map, so Back is not offered.
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();

    // The group tree came from the connection, and the header attributes the
    // run to the identity it inherited rather than one it probed.
    expect(mockGroups).toHaveBeenCalledTimes(1);
    expect(mockGroups).toHaveBeenCalledWith({ connectionId: 'conn-src' });
    expect(screen.getByText('/ Add a Linear mapping')).toBeInTheDocument();
    expect(screen.getByText('/ Acme · J. Kesteva')).toBeInTheDocument();
  });

  it('names the connection on every probe instead of carrying credentials', async () => {
    await openAddMapping();
    mapGroup('Alpha', 9);
    mapGroup('Platform', 9);
    await advance(2); // → Tasks → States

    expect(mockIssues).toHaveBeenCalledWith({
      connectionId: 'conn-src',
      selection: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
    });
    expect(mockStates).toHaveBeenCalledWith({
      connectionId: 'conn-src',
      selection: { containerId: 'plat', narrowId: 'all', narrowKind: 'all' },
    });

    // The point of the mode: no probe on any step carries a key.
    const probeInputs: unknown[] = [
      ...mockGroups.mock.calls,
      ...mockIssues.mock.calls,
      ...mockStates.mock.calls,
    ].map((call) => call[0]);
    expect(probeInputs).toHaveLength(5);
    for (const input of probeInputs) {
      expect(input).not.toHaveProperty('credentials');
    }
  });

  it('connects with sourceConnectionId and no credentials key', async () => {
    await openAddMapping();
    mapGroup('Alpha', 9);
    await advance(4); // → Tasks → States → Reconcile → Review

    // The inherited authorization is stated on Review, since no "Authorized as
    // …" card was ever shown in this mode.
    expect(screen.getByText('Reusing the key authorized as J. Kesteva')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Connect & sync 1 issues/ }));
    await waitFor(() => expect(mockConnect).toHaveBeenCalledTimes(1));

    const payload = mockConnect.mock.calls[0][0];
    expect(payload).not.toHaveProperty('credentials');
    expect(payload).toMatchObject({
      projectId: 9,
      sourceConnectionId: 'conn-src',
      source: { containerId: 'core', narrowId: 'alpha', narrowKind: 'project' },
      sourceLabel: 'Core · Alpha',
      pushTarget: true,
    });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it('chips the scopes its siblings already cover, without locking them', async () => {
    mockMappings.mockResolvedValue([SOURCE_CONNECTION, ALPHA_SIBLING]);
    await openAddMapping();

    expect(mockMappings).toHaveBeenCalledWith({ connectionId: 'conn-src' });
    // Each chip names the cyboflow project the sibling maps into.
    expect(
      await within(screen.getByTestId('tracker-group-proj-alpha')).findByText('mapped → Website'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('tracker-group-team-plat')).getByText('mapped → Cyboflow'),
    ).toBeInTheDocument();
    // Beta shares Alpha's container but not its narrow, so it is NOT covered.
    expect(
      within(screen.getByTestId('tracker-group-proj-beta')).queryByText(/^mapped →/),
    ).not.toBeInTheDocument();

    // Information, not a lock: a chipped group still maps, and re-mapping it to
    // the same project is exactly the idempotent re-connect.
    const alphaSelect = screen.getByLabelText('Cyboflow project for Alpha');
    expect(alphaSelect).toBeEnabled();
    fireEvent.change(alphaSelect, { target: { value: '9' } });
    expect(alphaSelect).toHaveValue('9');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });
});
