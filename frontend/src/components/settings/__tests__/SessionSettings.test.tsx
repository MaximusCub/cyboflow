/**
 * SessionSettings — the AI tab's "Session settings" group (what a new session or
 * run starts with). Pins the eight sections the user-approved classification
 * assigns to this group, the "Global defaults" sub-block that per-run-type
 * overrides will hang below, and that every control is a pure
 * props-in/callback-out surface (`Settings.tsx` still owns state + the save).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SessionSettings } from '../SessionSettings';
import type { SessionSettingsProps } from '../SessionSettings';
import { MODEL_OPTIONS } from '../../cyboflow/unified/ModelPill';
import {
  SESSION_AGENT_RUNTIMES,
  WORKFLOW_AGENT_RUNTIMES,
} from '../../../../../shared/types/agentRuntime';

vi.mock('../../../utils/telemetry', () => ({
  trackEvent: vi.fn(),
}));

function renderGroup(over: Partial<SessionSettingsProps> = {}) {
  const props: SessionSettingsProps = {
    globalSystemPrompt: '',
    onGlobalSystemPromptChange: vi.fn(),
    defaultAgentPermissionMode: 'default',
    onDefaultAgentPermissionModeChange: vi.fn(),
    defaultLaunchModel: '',
    onDefaultLaunchModelChange: vi.fn(),
    defaultAgentRuntime: undefined,
    onDefaultAgentRuntimeChange: vi.fn(),
    defaultExecutionModel: 'programmatic',
    onDefaultExecutionModelChange: vi.fn(),
    quickSessionWorktreeMode: 'worktree',
    onQuickSessionWorktreeModeChange: vi.fn(),
    quickSessionDefaultSubstrate: 'interactive',
    onQuickSessionDefaultSubstrateChange: vi.fn(),
    codeReviewEvalEnabled: true,
    onCodeReviewEvalEnabledChange: vi.fn(),
    autoGradeVariantRuns: true,
    onAutoGradeVariantRunsChange: vi.fn(),
    ...over,
  };
  render(<SessionSettings {...props} />);
  return props;
}

/** The frozen membership list for this group (see TASK-158's classification). */
const SESSION_SETTINGS_SECTIONS = [
  'Global Instructions',
  'Agent Permission Mode',
  'Default Launch Model',
  'Default Agent Runtime',
  'Workflow Orchestration',
  'Quick Sessions',
  'Quick Session Runtime',
  'Code Review Eval',
] as const;

describe('SessionSettings', () => {
  it('renders exactly the eight Session-settings sections', () => {
    renderGroup();

    for (const title of SESSION_SETTINGS_SECTIONS) {
      expect(screen.getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  it('carries no Feature-control sections', () => {
    renderGroup();

    for (const title of [
      'Cyboflow Attribution',
      'CLI Runtime',
      'Computed Run Cost',
      'Artifact Commit Location',
      'Visual Verification',
      'Idle Session Review',
    ]) {
      expect(screen.queryByRole('heading', { name: title, level: 4 })).not.toBeInTheDocument();
    }
  });

  it('nests all eight under a "Global defaults" sub-block (per-run-type overrides land below it)', () => {
    renderGroup();

    const globalDefaults = screen.getByRole('region', { name: 'Global defaults' });
    for (const title of SESSION_SETTINGS_SECTIONS) {
      expect(within(globalDefaults).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  // The mount point itself: nothing else in the suite would notice if the
  // overrides section were dropped from this group, since it is self-fetching
  // and takes none of this component's props.
  it('mounts the per-run-type overrides section BELOW the Global defaults sub-block', () => {
    renderGroup();

    const globalDefaults = screen.getByRole('region', { name: 'Global defaults' });
    const overrides = screen.getByRole('region', { name: 'Session type overrides' });

    // A sibling, not a child: it writes through its own IPC op, not this
    // group's props-in/callback-out contract.
    expect(globalDefaults).not.toContainElement(overrides);
    expect(
      globalDefaults.compareDocumentPosition(overrides) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Really mounted, not just a heading: the synthetic quick row always renders
    // even with no config and no workflow rows fetched.
    expect(within(overrides).getByTestId('run-type-row-quick')).toBeInTheDocument();
  });

  it('renders every control the sections own', () => {
    renderGroup({ globalSystemPrompt: 'Always use TypeScript' });

    expect(screen.getByLabelText('Global System Prompt')).toHaveValue('Always use TypeScript');
    expect(screen.getByRole('button', { name: /Ask before edits/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Programmatic/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Own worktree/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Interactive terminal/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^On/ })).toHaveAttribute('aria-pressed', 'true');
    // The auto-grade sub-toggle stays inside Code Review Eval — not split out.
    expect(screen.getByLabelText('Auto-grade variant & experiment runs')).toBeChecked();
  });

  it('reports every change back through its callback (no local state)', () => {
    const props = renderGroup();

    fireEvent.change(screen.getByLabelText('Global System Prompt'), { target: { value: 'be terse' } });
    expect(props.onGlobalSystemPromptChange).toHaveBeenCalledWith('be terse');

    fireEvent.click(screen.getByRole('button', { name: /Allow edits/ }));
    expect(props.onDefaultAgentPermissionModeChange).toHaveBeenCalledWith('acceptEdits');

    fireEvent.click(screen.getByRole('button', { name: /Orchestrated/ }));
    expect(props.onDefaultExecutionModelChange).toHaveBeenCalledWith('orchestrated');

    fireEvent.click(screen.getByRole('button', { name: /Project checkout/ }));
    expect(props.onQuickSessionWorktreeModeChange).toHaveBeenCalledWith('in-place');

    fireEvent.click(screen.getByRole('button', { name: /^SDK/ }));
    expect(props.onQuickSessionDefaultSubstrateChange).toHaveBeenCalledWith('sdk');

    fireEvent.click(screen.getByRole('button', { name: /^Off/ }));
    expect(props.onCodeReviewEvalEnabledChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByLabelText('Auto-grade variant & experiment runs'));
    expect(props.onAutoGradeVariantRunsChange).toHaveBeenCalledWith(false);
  });

  it('reflects stored non-default values as pressed', () => {
    renderGroup({
      defaultAgentPermissionMode: 'dontAsk',
      defaultExecutionModel: 'orchestrated',
      quickSessionWorktreeMode: 'in-place',
      quickSessionDefaultSubstrate: 'sdk',
      codeReviewEvalEnabled: false,
      autoGradeVariantRuns: false,
    });

    expect(screen.getByRole('button', { name: /Don't ask/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Orchestrated/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Project checkout/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^SDK/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Off/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Auto-grade variant & experiment runs')).not.toBeChecked();
  });

  describe('Default Launch Model', () => {
    it('renders the built-in-default state when nothing is stored', () => {
      renderGroup();

      expect(screen.getByTestId('default-launch-model-unset')).toHaveAttribute('aria-pressed', 'true');
      for (const id of ['fable', 'opus', 'sonnet', 'haiku', 'auto']) {
        expect(screen.getByTestId(`default-launch-model-${id}`)).toHaveAttribute('aria-pressed', 'false');
      }
    });

    // The picker must not grow a second hand-written alias list — every option
    // comes from the launch surfaces' shared MODEL_OPTIONS.
    it("offers exactly the launch surfaces' model options, plus the clear choice", () => {
      renderGroup();

      const rendered = Array.from(
        document.body.querySelectorAll('[data-testid^="default-launch-model-"]'),
      ).map((el) => el.getAttribute('data-testid'));
      expect(rendered).toEqual([
        'default-launch-model-unset',
        ...MODEL_OPTIONS.map((o) => `default-launch-model-${o.id}`),
      ]);
    });

    it('reflects a stored model as pressed and reports a pick back through the callback', () => {
      const props = renderGroup({ defaultLaunchModel: 'sonnet' });

      expect(screen.getByTestId('default-launch-model-sonnet')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('default-launch-model-unset')).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(screen.getByTestId('default-launch-model-haiku'));
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('haiku');
    });

    it('clears back to "" (the absent marker Settings.tsx maps to undefined)', () => {
      const props = renderGroup({ defaultLaunchModel: 'opus' });

      fireEvent.click(screen.getByTestId('default-launch-model-unset'));
      expect(props.onDefaultLaunchModelChange).toHaveBeenCalledWith('');
    });
  });

  describe('Default Agent Runtime', () => {
    it('renders the built-in-default state and the full session runtime set', () => {
      renderGroup();

      expect(screen.getByTestId('default-agent-runtime-unset')).toHaveAttribute('aria-pressed', 'true');
      for (const runtime of SESSION_AGENT_RUNTIMES) {
        expect(screen.getByTestId(`default-agent-runtime-${runtime}`)).toHaveAttribute(
          'aria-pressed',
          'false',
        );
      }
    });

    // codex-exec is headless — it reaches no launch picker, so it must not be
    // offered here even though it is a member of ALL_AGENT_RUNTIMES.
    it('never offers codex-exec', () => {
      renderGroup();

      expect(screen.queryByTestId('default-agent-runtime-codex-exec')).not.toBeInTheDocument();
    });

    it('reports a pick, and clears to undefined (not null, not "")', () => {
      const props = renderGroup({ defaultAgentRuntime: 'claude-interactive' });

      expect(screen.getByTestId('default-agent-runtime-claude-interactive')).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      fireEvent.click(screen.getByTestId('default-agent-runtime-codex-sdk'));
      expect(props.onDefaultAgentRuntimeChange).toHaveBeenCalledWith('codex-sdk');

      fireEvent.click(screen.getByTestId('default-agent-runtime-unset'));
      expect(props.onDefaultAgentRuntimeChange).toHaveBeenLastCalledWith(undefined);
    });

    // The whole point of the note: one global field, coerced per surface. A
    // quick-only runtime is DROPPED by a flow launch, and the control says so.
    it('flags a quick-only runtime as inapplicable to flow runs', () => {
      renderGroup({ defaultAgentRuntime: 'codex-pty' });

      const note = screen.getByTestId('default-agent-runtime-workflow-note');
      expect(note).toHaveTextContent(/quick sessions only/i);
      expect(note).toHaveTextContent(/Codex terminal/);
    });

    it.each(WORKFLOW_AGENT_RUNTIMES)('renders no note for the workflow-valid runtime %s', (runtime) => {
      renderGroup({ defaultAgentRuntime: runtime });

      expect(screen.queryByTestId('default-agent-runtime-workflow-note')).not.toBeInTheDocument();
    });

    it('renders no note while following the built-in default', () => {
      renderGroup({ defaultAgentRuntime: undefined });

      expect(screen.queryByTestId('default-agent-runtime-workflow-note')).not.toBeInTheDocument();
    });

    it('drops runtimes whose provider is switched off', () => {
      renderGroup({ agentProviderAccess: { claude: true, codex: false } });

      expect(screen.getByTestId('default-agent-runtime-claude-sdk')).toBeEnabled();
      expect(screen.getByTestId('default-agent-runtime-claude-interactive')).toBeEnabled();
      expect(screen.queryByTestId('default-agent-runtime-codex-sdk')).not.toBeInTheDocument();
      expect(screen.queryByTestId('default-agent-runtime-codex-pty')).not.toBeInTheDocument();
    });

    // A stored value on a now-off provider stays VISIBLE (it is still what the
    // launch resolves) but is not selectable — the user clears it instead.
    it('keeps a stored runtime on a disabled provider visible but unselectable', () => {
      const props = renderGroup({
        defaultAgentRuntime: 'codex-sdk',
        agentProviderAccess: { claude: true, codex: false },
      });

      const button = screen.getByTestId('default-agent-runtime-codex-sdk');
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent(/provider off/i);

      fireEvent.click(button);
      expect(props.onDefaultAgentRuntimeChange).not.toHaveBeenCalled();
    });
  });
});
