/**
 * RunTypeOverridesSection — the per-run-type override list + detail screen that
 * hangs below "Global defaults" in Settings → AI → Session settings.
 *
 * These tests run against the REAL `configStore` over an in-memory fake of the
 * `config:*` IPC surface whose `applyRunTypeDefault` reimplements ConfigManager's
 * merge/replace rules (which are themselves pinned by
 * `main/src/services/__tests__/configManagerRunTypeDefaults.test.ts`). That is
 * what lets the merge-to-empty contract be exercised END TO END — component →
 * store → IPC → refetch → re-render — instead of stopping at a spy.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { RunTypeOverridesSection } from '../RunTypeOverridesSection';
import { useConfigStore } from '../../../stores/configStore';
import type { AppConfig } from '../../../types/config';
import type { WorkflowRow } from '../../../../../shared/types/workflows';
import type {
  RunTypeDefaults,
  RunTypeDefaultsOp,
} from '../../../../../shared/types/sessionDefaults';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function wfRow(over: Partial<WorkflowRow> & Pick<WorkflowRow, 'id' | 'name'>): WorkflowRow {
  return {
    project_id: null,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: '{}',
    created_at: '2026-01-01T00:00:00Z',
    archived_at: null,
    ...over,
  };
}

const WORKFLOW_ENTRIES = [
  { row: wfRow({ id: 'wf-global-sprint', name: 'sprint' }), projectName: '' },
  { row: wfRow({ id: 'wf-global-planner', name: 'planner' }), projectName: '' },
  { row: wfRow({ id: 'wf-global-custom-aa', name: 'triage' }), projectName: '' },
  { row: wfRow({ id: 'wf-3-custom-bb', name: 'nightly', project_id: 3 }), projectName: 'Cyboflow' },
];

const workflowsState = vi.hoisted(() => ({
  workflows: [] as unknown[],
  init: vi.fn(),
}));

vi.mock('../../../stores/workflowsStore', () => ({
  useWorkflowsStore: (selector?: (s: typeof workflowsState) => unknown) =>
    selector ? selector(workflowsState) : workflowsState,
}));

// ---------------------------------------------------------------------------
// In-memory `config:*` IPC fake
// ---------------------------------------------------------------------------

const configUpdate = vi.fn();
const applyRunTypeDefaultSpy = vi.fn();

let liveConfig: AppConfig;

/** Mirrors ConfigManager.applyRunTypeDefault: null deletes a member; an empty key is dropped. */
function applyOp(key: string, op: RunTypeDefaultsOp): RunTypeDefaults | undefined {
  const all: Record<string, RunTypeDefaults> = { ...liveConfig.runTypeDefaults };
  const previous = all[key];

  if (op.kind === 'replace') {
    if (op.value === null || Object.keys(op.value).length === 0) delete all[key];
    else all[key] = { ...op.value };
  } else {
    const merged: RunTypeDefaults = { ...previous };
    for (const [field, value] of Object.entries(op.value) as [keyof RunTypeDefaults, unknown][]) {
      if (value === null) delete merged[field];
      else if (value !== undefined) {
        Object.assign(merged, { [field]: value });
      }
    }
    if (Object.keys(merged).length === 0) delete all[key];
    else all[key] = merged;
  }

  liveConfig = {
    ...liveConfig,
    runTypeDefaults: Object.keys(all).length > 0 ? all : undefined,
  };
  return previous;
}

vi.mock('../../../utils/api', () => ({
  API: {
    config: {
      get: () => Promise.resolve({ success: true, data: liveConfig }),
      update: (...a: unknown[]) => {
        configUpdate(...a);
        return Promise.resolve({ success: true });
      },
      applyRunTypeDefault: (key: string, op: RunTypeDefaultsOp) => {
        applyRunTypeDefaultSpy(key, op);
        const previous = applyOp(key, op);
        return Promise.resolve({ success: true, data: { previous, config: liveConfig } });
      },
    },
  },
}));

async function renderList(
  over: Partial<AppConfig> = {},
  entries: unknown[] = WORKFLOW_ENTRIES,
): Promise<void> {
  liveConfig = { gitRepoPath: '/repo', ...over };
  workflowsState.workflows = entries;
  await useConfigStore.getState().fetchConfig();
  render(<RunTypeOverridesSection />);
}

beforeEach(() => {
  configUpdate.mockReset();
  applyRunTypeDefaultSpy.mockReset();
  workflowsState.init.mockReset().mockResolvedValue(undefined);
  useConfigStore.setState({ config: null, error: null, isLoading: false });
});

// ---------------------------------------------------------------------------

describe('RunTypeOverridesSection — grouped list', () => {
  it('groups built-in flows, quick sessions, and custom flows (project-scoped under the project name)', async () => {
    await renderList();

    expect(screen.getByText('Built-in flows')).toBeInTheDocument();
    expect(screen.getByText('Quick sessions')).toBeInTheDocument();
    expect(screen.getByText('Custom flows')).toBeInTheDocument();
    expect(screen.getByText('Custom flows · Cyboflow')).toBeInTheDocument();

    // Built-ins keep their wizard titles; the synthetic quick row is always present.
    expect(screen.getByTestId('run-type-row-workflow:wf-global-sprint')).toHaveTextContent('Sprint');
    expect(screen.getByTestId('run-type-row-workflow:wf-global-planner')).toHaveTextContent('Planner');
    expect(screen.getByTestId('run-type-row-quick')).toHaveTextContent('Quick session');
    // A GLOBAL custom flow is ungrouped; a project-scoped one is under its project.
    expect(screen.getByTestId('run-type-row-workflow:wf-global-custom-aa')).toHaveTextContent('Triage');
    expect(screen.getByTestId('run-type-row-workflow:wf-3-custom-bb')).toHaveTextContent('Nightly');
  });

  // AC 4 — a row with no override shows "Following defaults" and NO chips.
  it('renders "Following defaults" and no chips for a type with no stored override', async () => {
    await renderList();

    const row = screen.getByTestId('run-type-row-workflow:wf-global-planner');
    expect(within(row).getByTestId('run-type-status-workflow:wf-global-planner')).toHaveTextContent(
      'Following defaults',
    );
    expect(within(row).queryByTestId(/^run-type-chip-/)).not.toBeInTheDocument();
  });

  // AC 4 — the summary is a DIFF: a stored value equal to the baseline is not an override.
  it('treats a stored value equal to the global default as "Following defaults" (no chip)', async () => {
    await renderList({
      // 'opus' IS the workflow model floor, and 'sdk' IS DEFAULT_SUBSTRATE.
      runTypeDefaults: { 'workflow:wf-global-sprint': { model: 'opus', substrate: 'sdk' } },
    });

    const row = screen.getByTestId('run-type-row-workflow:wf-global-sprint');
    expect(within(row).getByTestId('run-type-status-workflow:wf-global-sprint')).toHaveTextContent(
      'Following defaults',
    );
    expect(within(row).queryByTestId(/^run-type-chip-/)).not.toBeInTheDocument();
  });

  // AC 4 — an overridden row chips ONLY the differing values.
  it('chips only the values that differ from the global defaults', async () => {
    await renderList({
      defaultAgentPermissionMode: 'acceptEdits',
      runTypeDefaults: {
        'workflow:wf-global-sprint': {
          model: 'sonnet', // differs from the 'opus' floor  → chip
          substrate: 'sdk', // equals DEFAULT_SUBSTRATE       → no chip
          permissionMode: 'acceptEdits', // equals the global → no chip
        },
      },
    });

    const row = screen.getByTestId('run-type-row-workflow:wf-global-sprint');
    expect(within(row).getByTestId('run-type-status-workflow:wf-global-sprint')).toHaveTextContent(
      '1 override',
    );
    // The same regex the "no chips" assertions use — proven here to actually match,
    // so those negatives cannot pass vacuously.
    expect(within(row).getAllByTestId(/^run-type-chip-/)).toHaveLength(1);
    expect(
      within(row).getByTestId('run-type-chip-workflow:wf-global-sprint-model'),
    ).toHaveTextContent('Model: Sonnet 5 · 1M');
    expect(
      within(row).queryByTestId('run-type-chip-workflow:wf-global-sprint-substrate'),
    ).not.toBeInTheDocument();
    expect(
      within(row).queryByTestId('run-type-chip-workflow:wf-global-sprint-permissionMode'),
    ).not.toBeInTheDocument();
  });

  it('counts multiple differing values in the status badge', async () => {
    await renderList({
      runTypeDefaults: { quick: { model: 'sonnet', reasoningEffort: 'high', substrate: 'sdk' } },
    });

    // quick's substrate baseline is 'interactive', so 'sdk' IS a difference.
    expect(screen.getByTestId('run-type-status-quick')).toHaveTextContent('3 overrides');
    expect(screen.getByTestId('run-type-chip-quick-reasoningEffort')).toHaveTextContent(
      'Reasoning effort: High',
    );
  });

  // AC 5 — a stale key is inert but never filtered out.
  it('still renders a stored key whose workflow no longer resolves, labelled with the raw key', async () => {
    await renderList({
      runTypeDefaults: { 'workflow:wf-deleted-999': { substrate: 'interactive' } },
    });

    const row = screen.getByTestId('run-type-row-workflow:wf-deleted-999');
    expect(row).toHaveTextContent('workflow:wf-deleted-999');
    expect(screen.getByText('Unmatched saved defaults')).toBeInTheDocument();
    // Still summarised as a real override, so it can be seen and cleared.
    expect(within(row).getByTestId('run-type-chip-workflow:wf-deleted-999-substrate')).toHaveTextContent(
      'Substrate: Interactive terminal',
    );
  });

  it('renders the quick row even when the workflow fan-out yields nothing', async () => {
    await renderList({}, []);

    expect(screen.getByTestId('run-type-row-quick')).toBeInTheDocument();
    expect(screen.queryByText('Built-in flows')).not.toBeInTheDocument();
  });

  it('does not surface a workflows-store bootstrap failure as an unhandled rejection', async () => {
    workflowsState.init.mockRejectedValue(new Error('fan-out failed'));
    await renderList({}, []);

    expect(screen.getByTestId('run-type-row-quick')).toBeInTheDocument();
  });
});

describe('RunTypeOverridesSection — detail screen', () => {
  async function openDetail(label: string, over: Partial<AppConfig> = {}): Promise<void> {
    await renderList(over);
    fireEvent.click(screen.getByRole('button', { name: `Configure ${label}` }));
    await screen.findByTestId('run-type-detail');
  }

  it('opens the detail screen from the Configure CTA, with a breadcrumb back to the list', async () => {
    await openDetail('Quick session');

    expect(screen.getByRole('button', { name: /Session settings \/ Quick session/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Session settings \/ Quick session/ }));
    expect(screen.getByTestId('run-type-overrides')).toBeInTheDocument();
  });

  it('renders only the knob cards backed by a real RunTypeDefaults field', async () => {
    await openDetail('Quick session');

    expect(screen.getByTestId('knob-card-model')).toBeInTheDocument();
    expect(screen.getByTestId('knob-card-runtime')).toBeInTheDocument();
    expect(screen.getByTestId('knob-card-permission')).toBeInTheDocument();
    // `orchestration` / `eval` have no storage field — deliberately not rendered.
    expect(screen.queryByTestId('knob-card-orchestration')).not.toBeInTheDocument();
    expect(screen.queryByTestId('knob-card-eval')).not.toBeInTheDocument();
  });

  // AC 3 — effort is Quick-Session-only.
  it("shows a reasoning-effort field on the 'quick' detail screen", async () => {
    await openDetail('Quick session', { runTypeDefaults: { quick: { model: 'sonnet' } } });

    expect(screen.getByTestId('run-type-field-reasoningEffort')).toBeInTheDocument();
  });

  // AC 3 — and never on a `workflow:<id>` one (runs.start has no sink for it).
  it('does NOT show a reasoning-effort field on a workflow detail screen', async () => {
    await openDetail('Sprint', {
      runTypeDefaults: { 'workflow:wf-global-sprint': { model: 'sonnet' } },
    });

    expect(screen.queryByTestId('run-type-field-reasoningEffort')).not.toBeInTheDocument();
  });

  it('tags an un-overridden card "from defaults · <value>" and flips to live controls when switched on', async () => {
    await openDetail('Sprint');

    const card = screen.getByTestId('knob-card-permission');
    expect(within(card).getByTestId('run-type-field-permissionMode')).toHaveTextContent(
      'from defaults · Ask before edits',
    );
    expect(within(card).getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(within(card).getByRole('switch'));

    expect(within(card).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    // Seeded from the baseline, so nothing reads as overridden yet.
    expect(within(card).getByLabelText('Permission')).toHaveValue('default');
    expect(within(card).queryByTestId('run-type-changed-permissionMode')).not.toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText('Permission'), { target: { value: 'dontAsk' } });
    expect(within(card).getByTestId('run-type-changed-permissionMode')).toHaveTextContent(
      'overridden · default is Ask before edits',
    );
  });

  // AC 2 — Save goes through applyRunTypeDefault, never API.config.update or the parent form.
  it('saves through applyRunTypeDefault without touching config.update or the parent form', async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    liveConfig = { gitRepoPath: '/repo' };
    workflowsState.workflows = WORKFLOW_ENTRIES;
    await useConfigStore.getState().fetchConfig();
    render(
      <form onSubmit={onSubmit}>
        <RunTypeOverridesSection />
      </form>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Configure Sprint' }));
    const card = await screen.findByTestId('knob-card-model');
    fireEvent.click(within(card).getByRole('switch'));
    fireEvent.change(within(card).getByLabelText('Model'), { target: { value: 'sonnet' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('workflow:wf-global-sprint', {
        kind: 'merge',
        value: {
          model: 'sonnet',
          reasoningEffort: null,
          substrate: null,
          agentRuntime: null,
          permissionMode: null,
        },
      }),
    );
    expect(configUpdate).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    // Back on the list, the new override is summarised as a diff.
    await waitFor(() =>
      expect(screen.getByTestId('run-type-chip-workflow:wf-global-sprint-model')).toHaveTextContent(
        'Model: Sonnet 5 · 1M',
      ),
    );
  });

  // AC 6 — clearing every field merges the key to empty, which deletes it.
  it('deletes the key end-to-end when every field is cleared and saved', async () => {
    await openDetail('Quick session', {
      runTypeDefaults: {
        quick: { model: 'sonnet', reasoningEffort: 'high', substrate: 'sdk' },
        'workflow:wf-global-sprint': { model: 'haiku' },
      },
    });

    // Switch every card OFF — each clears its own fields back to "follow defaults".
    for (const cardId of ['model', 'runtime', 'permission']) {
      const card = screen.getByTestId(`knob-card-${cardId}`);
      const toggle = within(card).getByRole('switch');
      if (toggle.getAttribute('aria-checked') === 'true') fireEvent.click(toggle);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('quick', {
        kind: 'merge',
        value: {
          model: null,
          reasoningEffort: null,
          substrate: null,
          agentRuntime: null,
          permissionMode: null,
        },
      }),
    );

    // The store refetched: the key is GONE from config, the sibling key survives.
    await waitFor(() =>
      expect(useConfigStore.getState().config?.runTypeDefaults).toEqual({
        'workflow:wf-global-sprint': { model: 'haiku' },
      }),
    );
    expect(screen.getByTestId('run-type-status-quick')).toHaveTextContent('Following defaults');
  });

  it('resets a type to defaults with a replace-null op', async () => {
    await openDetail('Quick session', {
      runTypeDefaults: { quick: { model: 'sonnet' } },
    });

    fireEvent.click(screen.getByRole('button', { name: /Reset Quick session to defaults/ }));

    await waitFor(() =>
      expect(applyRunTypeDefaultSpy).toHaveBeenCalledWith('quick', { kind: 'replace', value: null }),
    );
    await waitFor(() =>
      expect(useConfigStore.getState().config?.runTypeDefaults).toBeUndefined(),
    );
    expect(configUpdate).not.toHaveBeenCalled();
  });

  it('discards the draft on Cancel', async () => {
    await openDetail('Quick session');

    const card = screen.getByTestId('knob-card-model');
    fireEvent.click(within(card).getByRole('switch'));
    fireEvent.change(within(card).getByLabelText('Model'), { target: { value: 'haiku' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(applyRunTypeDefaultSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('run-type-status-quick')).toHaveTextContent('Following defaults');
  });
});
