/**
 * SessionSettings — the AI tab's "Session settings" group (what a new session or
 * run starts with). Pins the six sections the user-approved classification
 * assigns to this group, the "Global defaults" sub-block that per-run-type
 * overrides will hang below, and that every control is a pure
 * props-in/callback-out surface (`Settings.tsx` still owns state + the save).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { SessionSettings } from '../SessionSettings';
import type { SessionSettingsProps } from '../SessionSettings';

vi.mock('../../../utils/telemetry', () => ({
  trackEvent: vi.fn(),
}));

function renderGroup(over: Partial<SessionSettingsProps> = {}) {
  const props: SessionSettingsProps = {
    globalSystemPrompt: '',
    onGlobalSystemPromptChange: vi.fn(),
    defaultAgentPermissionMode: 'default',
    onDefaultAgentPermissionModeChange: vi.fn(),
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
  'Workflow Orchestration',
  'Quick Sessions',
  'Quick Session Runtime',
  'Code Review Eval',
] as const;

describe('SessionSettings', () => {
  it('renders exactly the six Session-settings sections', () => {
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

  it('nests all six under a "Global defaults" sub-block (per-run-type overrides land below it)', () => {
    renderGroup();

    const globalDefaults = screen.getByRole('region', { name: 'Global defaults' });
    for (const title of SESSION_SETTINGS_SECTIONS) {
      expect(within(globalDefaults).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
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
});
