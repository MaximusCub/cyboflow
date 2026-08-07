/**
 * Settings AI tab — the 12 sections now live in two top-level groups inside the
 * SAME tab: "Feature controls" (is the capability available at all) and
 * "Session settings" (what a new session or run starts with). This pins the
 * user-approved, frozen membership of each group — an earlier decomposition pass
 * inverted three rows — plus zero content loss, the surviving `initialTab: 'ai'`
 * entry point, and the unchanged single `API.config.update` round trip (the
 * groups are props-in/callback-out containers over Settings.tsx's lifted state,
 * NOT self-fetching panels like IntegrationsSettings).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Settings } from '../../Settings';
import type { AppConfig } from '../../../types/config';

const configGet = vi.fn();
const configUpdate = vi.fn();
const getVersionInfo = vi.fn();
const projectsGetAll = vi.fn();

vi.mock('../../../utils/api', () => ({
  API: {
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    projects: {
      getAll: (...a: unknown[]) => projectsGetAll(...a),
    },
    getVersionInfo: (...a: unknown[]) => getVersionInfo(...a),
  },
}));

vi.mock('../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'paper', setTheme: vi.fn() }),
}));

vi.mock('../../../stores/configStore', () => ({
  useConfigStore: () => ({ fetchConfig: vi.fn().mockResolvedValue(undefined) }),
}));

/** Frozen classification — do NOT re-derive from section order. */
const FEATURE_CONTROLS = [
  'Cyboflow Attribution',
  'CLI Runtime',
  'Computed Run Cost',
  'Artifact Commit Location',
  'Visual Verification',
  'Idle Session Review',
] as const;

const SESSION_SETTINGS = [
  'Global Instructions',
  'Agent Permission Mode',
  'Workflow Orchestration',
  'Quick Sessions',
  'Quick Session Runtime',
  'Code Review Eval',
] as const;

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    gitRepoPath: '/repo',
    ...over,
  };
}

beforeEach(() => {
  configGet.mockReset().mockResolvedValue({ success: true, data: baseConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  getVersionInfo.mockReset().mockResolvedValue({ success: true, data: { variant: 'dev' } });
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
});

describe('Settings — AI tab groups', () => {
  it("still opens on the AI tab for initialTab: 'ai', and the tab strip is unchanged", async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    expect(await screen.findByTestId('settings-feature-controls')).toBeInTheDocument();
    for (const tab of ['General', 'AI', 'Assistant', 'Integrations', 'Notifications', 'Updates']) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument();
    }
  });

  it('renders both groups as top-level blocks of the AI tab', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    expect(await screen.findByRole('heading', { name: 'Feature controls', level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Session settings', level: 3 })).toBeInTheDocument();
  });

  it('renders all 12 sections with zero content loss', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
    await screen.findByTestId('settings-feature-controls');

    for (const title of [...FEATURE_CONTROLS, ...SESSION_SETTINGS]) {
      expect(screen.getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  it.each(FEATURE_CONTROLS)('places "%s" in Feature controls only', async (title) => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    const features = await screen.findByTestId('settings-feature-controls');
    const sessions = screen.getByTestId('settings-session-settings');
    expect(within(features).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    expect(within(sessions).queryByRole('heading', { name: title, level: 4 })).not.toBeInTheDocument();
  });

  it.each(SESSION_SETTINGS)('places "%s" in Session settings only', async (title) => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    const features = await screen.findByTestId('settings-feature-controls');
    const sessions = screen.getByTestId('settings-session-settings');
    expect(within(sessions).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    expect(within(features).queryByRole('heading', { name: title, level: 4 })).not.toBeInTheDocument();
  });

  it('hangs the Session-settings sections off a "Global defaults" sub-block', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    const globalDefaults = await screen.findByRole('region', { name: 'Global defaults' });
    for (const title of SESSION_SETTINGS) {
      expect(within(globalDefaults).getByRole('heading', { name: title, level: 4 })).toBeInTheDocument();
    }
  });

  it('saves both groups through the one existing API.config.update round trip', async () => {
    configGet.mockResolvedValue({
      success: true,
      data: baseConfig({
        systemPromptAppend: 'be terse',
        enableCyboflowFooter: false,
        defaultAgentPermissionMode: 'acceptEdits',
        interactivePtyOnly: true,
        defaultExecutionModel: 'orchestrated',
        quickSessionWorktreeMode: 'in-place',
        quickSessionDefaultSubstrate: 'sdk',
        codeReviewEvalEnabled: false,
        autoGradeVariantRuns: false,
        computeCostFromRates: true,
        artifactCommitDir: 'docs/artifacts',
        visualVerify: { enabled: true },
        idleSessionReview: { enabled: false, thresholdMinutes: 11 },
      }),
    });
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);
    await screen.findByTestId('settings-feature-controls');

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
    expect(configUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        // Feature controls
        enableCyboflowFooter: false,
        interactivePtyOnly: true,
        computeCostFromRates: true,
        artifactCommitDir: 'docs/artifacts',
        visualVerify: { enabled: true },
        idleSessionReview: { enabled: false, thresholdMinutes: 11 },
        // Session settings
        systemPromptAppend: 'be terse',
        defaultAgentPermissionMode: 'acceptEdits',
        defaultExecutionModel: 'orchestrated',
        quickSessionWorktreeMode: 'in-place',
        quickSessionDefaultSubstrate: 'sdk',
        codeReviewEvalEnabled: false,
        autoGradeVariantRuns: false,
      }),
    );
  });

  it('carries edits from BOTH groups into the same save', async () => {
    render(<Settings isOpen onClose={vi.fn()} initialTab="ai" />);

    // Feature controls edit …
    fireEvent.click(await screen.findByTestId('computed-run-cost-on'));
    // … and a Session settings edit, in one form.
    fireEvent.click(screen.getByRole('button', { name: /Orchestrated/ }));

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(configUpdate).toHaveBeenCalledTimes(1));
    expect(configUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        computeCostFromRates: true,
        defaultExecutionModel: 'orchestrated',
      }),
    );
  });
});
