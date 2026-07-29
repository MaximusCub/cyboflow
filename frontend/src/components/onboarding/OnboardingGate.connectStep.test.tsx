/**
 * OnboardingGate — step 1 (Connect) provider-access coverage.
 *
 * The step-1 toggles are not a tour-local consent flag: Continue persists them
 * to AppConfig.agentProviderAccess, the SAME field Settings → Integrations
 * edits, so a provider left off during onboarding is off app-wide (hidden from
 * every runtime picker, rejected at the launch seams).
 *
 * Drives the real onboardingStore + configStore (only the API/IPC layers are
 * mocked) so the seed → toggle → persist → advance wiring is exercised end to
 * end: seeding from a SAVED setting on replay, a pristine install staying
 * opt-in, the full (never partial) persisted payload, and the non-fatal
 * failure path.
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnboardingGate } from './OnboardingGate';
import { useOnboardingStore } from '../../stores/onboardingStore';
import { useConfigStore } from '../../stores/configStore';
import { CLAUDE_DETECT_CHANNEL, CODEX_DETECT_CHANNEL } from '../../../../shared/types/onboarding';
import type { ClaudeDetectionResult, CodexDetectionResult } from '../../../../shared/types/onboarding';
import type { AgentProviderAccess } from '../../../../shared/types/agentRuntime';
import type { AppConfig } from '../../types/config';

const projectsGetAll = vi.fn();
const configGet = vi.fn();
const configUpdate = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    projects: { getAll: (...a: unknown[]) => projectsGetAll(...a) },
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
    },
    dialog: { openFile: vi.fn(), openDirectory: vi.fn() },
  },
}));

const CLAUDE_DETECTED: ClaudeDetectionResult = {
  state: 'detected',
  credentials: { found: true, source: 'keychain', account: 'claude@example.com' },
  binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
};

const CODEX_DETECTED: CodexDetectionResult = {
  state: 'detected',
  runtime: { found: true, path: '/app/codex', version: '0.144.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
};

function baseAppConfig(access?: AgentProviderAccess): AppConfig {
  return {
    gitRepoPath: '/repo',
    telemetry: { installId: 'inst-1', errorReportingEnabled: true, usageMetricsEnabled: true },
    ...(access ? { agentProviderAccess: access } : {}),
  };
}

const INITIAL_ONBOARDING_STATE = {
  status: 'idle' as const,
  step: 0,
  maxVisitedStep: 0,
  replay: false,
  detection: null,
  connected: false,
  codexDetection: null,
  codexConnected: false,
  permMode: 'auto' as const,
  hydrated: false,
};

// Both probes report a healthy account, so the step's toggles are enabled and
// the "at least one detected provider" gate can actually be satisfied.
const invoke = vi.fn(async (channel: string) => {
  if (channel === CLAUDE_DETECT_CHANNEL) return { success: true, data: CLAUDE_DETECTED };
  if (channel === CODEX_DETECT_CHANNEL) return { success: true, data: CODEX_DETECTED };
  return { success: true };
});

beforeEach(() => {
  projectsGetAll.mockReset().mockResolvedValue({ success: true, data: [] });
  configGet.mockReset().mockResolvedValue({ success: true, data: baseAppConfig() });
  configUpdate.mockReset().mockResolvedValue({ success: true });
  invoke.mockClear();
  (window as unknown as { electron: { invoke: typeof invoke } }).electron = { invoke };
  useOnboardingStore.setState(INITIAL_ONBOARDING_STATE);
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
});

/** Renders the gate, waits for boot hydration, then parks it on step 1. */
async function mountAtConnectStep(config: AppConfig | null): Promise<void> {
  render(<OnboardingGate />);
  await waitFor(() => expect(useOnboardingStore.getState().hydrated).toBe(true));
  act(() => {
    if (config) useConfigStore.setState({ config });
    useOnboardingStore.setState({ status: 'active', step: 1, maxVisitedStep: 1 });
  });
  await screen.findByRole('switch', { name: 'Use Claude Code in Cyboflow' });
}

describe('OnboardingGate — Connect step (1) provider access', () => {
  it('leaves both toggles off on a pristine install (no saved setting)', async () => {
    await mountAtConnectStep(baseAppConfig());

    expect(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // The gate still demands an explicit opt-in.
    expect(screen.getByRole('button', { name: /Continue/ })).toBeDisabled();
  });

  it('seeds the toggles from the SAVED provider access (replay on a configured install)', async () => {
    await mountAtConnectStep(baseAppConfig({ claude: true, codex: false }));

    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' })).toHaveAttribute(
        'aria-checked',
        'true',
      ),
    );
    expect(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('persists BOTH toggles to agentProviderAccess on Continue, then advances', async () => {
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    // Full object, never a partial patch: the provider the user left off must be
    // written as explicitly off, not merely omitted (omission floors to ON).
    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: false },
      }),
    );
    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(2));
  });

  it('writes both providers on when the user enables both', async () => {
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Claude Code in Cyboflow' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await waitFor(() =>
      expect(configUpdate).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: true },
      }),
    );
  });

  it('advances anyway when the config write fails (non-fatal — Settings still owns the toggles)', async () => {
    configUpdate.mockRejectedValue(new Error('disk full'));
    await mountAtConnectStep(baseAppConfig());

    fireEvent.click(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/ }));

    await waitFor(() => expect(useOnboardingStore.getState().step).toBe(2));
  });
});
