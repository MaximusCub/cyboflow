import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderDetectionResult } from '../../../../shared/types/onboarding';
import type { AgentProviderAccess } from '../../../../shared/types/agentRuntime';
import { useConfigStore } from '../../stores/configStore';
import type { AppConfig } from '../../types/config';
import { IntegrationsSettings } from './IntegrationsSettings';

const detectClaude = vi.fn();
const detectCodex = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    providers: {
      detect: (provider: string) => (provider === 'claude' ? detectClaude() : detectCodex()),
    },
  },
}));

/** Seed the config store as the app's boot fetch would. */
function setProviderAccess(access: AgentProviderAccess | undefined): void {
  useConfigStore.setState({
    config: { gitRepoPath: '/repo', agentProviderAccess: access } as AppConfig,
  });
}

const CLAUDE_CONNECTED: ProviderDetectionResult<'claude'> = {
  state: 'detected',
  credentials: { found: true, source: 'keychain', account: 'claude@example.com' },
  binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
};

const CODEX_CONNECTED: ProviderDetectionResult<'codex'> = {
  state: 'detected',
  runtime: { found: true, path: '/app/codex', version: '0.144.3' },
  account: { found: true, email: 'codex@example.com', planType: 'plus' },
};

let updateConfig: ReturnType<typeof vi.fn>;

beforeEach(() => {
  detectClaude.mockReset().mockResolvedValue({ success: true, data: CLAUDE_CONNECTED });
  detectCodex.mockReset().mockResolvedValue({ success: true, data: CODEX_CONNECTED });
  updateConfig = vi.fn().mockResolvedValue(true);
  useConfigStore.setState({ config: null, error: null, updateConfig });
});

describe('IntegrationsSettings', () => {
  it('shows Claude and Codex account status independently', async () => {
    render(<IntegrationsSettings />);

    expect(await screen.findByText('claude@example.com')).toBeInTheDocument();
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
    expect(screen.getByText(/ChatGPT plus · Codex 0\.144\.3/)).toBeInTheDocument();
    expect(screen.getAllByText('Connected')).toHaveLength(2);
  });

  it('keeps a connected provider usable when its sibling needs sign-in', async () => {
    detectClaude.mockResolvedValue({
      success: true,
      data: {
        state: 'loggedOut',
        credentials: { found: false, source: null, account: null },
        binary: { found: true, path: '/usr/local/bin/claude', version: '1.2.3' },
      } satisfies ProviderDetectionResult<'claude'>,
    });

    render(<IntegrationsSettings />);

    expect(await screen.findByText('Sign-in required')).toBeInTheDocument();
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
  });

  it('reports one failed probe without hiding the other provider and retries both', async () => {
    detectCodex.mockResolvedValueOnce({ success: false, error: 'Account probe timed out' });
    render(<IntegrationsSettings />);

    expect(await screen.findByText('Account probe timed out')).toBeInTheDocument();
    expect(await screen.findByText('claude@example.com')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(detectClaude).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(detectCodex).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('codex@example.com')).toBeInTheDocument();
  });
});

describe('IntegrationsSettings — provider access toggles', () => {
  it('shows both providers on when the setting has never been touched', async () => {
    setProviderAccess(undefined);
    render(<IntegrationsSettings />);

    expect(await screen.findByRole('switch', { name: 'Use Claude Code in Cyboflow' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Use Codex in Cyboflow' })).toBeChecked();
  });

  it('persists the FULL access object when a provider is switched off', async () => {
    setProviderAccess(undefined);
    render(<IntegrationsSettings />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Use Codex in Cyboflow' }));

    // Full object, never a partial patch — the sibling must not be dropped.
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: false },
      }),
    );
  });

  it('switches a provider back on from the off state', async () => {
    setProviderAccess({ claude: true, codex: false });
    render(<IntegrationsSettings />);

    const codexSwitch = await screen.findByRole('switch', { name: 'Use Codex in Cyboflow' });
    expect(codexSwitch).not.toBeChecked();

    fireEvent.click(codexSwitch);
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        agentProviderAccess: { claude: true, codex: true },
      }),
    );
  });

  it('locks the last enabled provider so the app can never end up with none', async () => {
    setProviderAccess({ claude: true, codex: false });
    render(<IntegrationsSettings />);

    const claudeSwitch = await screen.findByRole('switch', { name: 'Use Claude Code in Cyboflow' });
    expect(claudeSwitch).toBeDisabled();
    expect(claudeSwitch).toHaveAttribute('title', 'At least one provider must stay enabled.');

    fireEvent.click(claudeSwitch);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('explains what a disabled provider means, and warns about the Claude-only surfaces', async () => {
    setProviderAccess({ claude: false, codex: true });
    render(<IntegrationsSettings />);

    expect(await screen.findByText(/hidden from every runtime picker/i)).toBeInTheDocument();
    expect(
      screen.getByText(/design sessions and visual verification, which always run on Claude/i),
    ).toBeInTheDocument();
  });

  it('surfaces a failed save instead of silently reverting', async () => {
    setProviderAccess(undefined);
    updateConfig.mockResolvedValue(false);
    useConfigStore.setState({ error: 'disk full' });
    render(<IntegrationsSettings />);

    fireEvent.click(await screen.findByRole('switch', { name: 'Use Codex in Cyboflow' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
  });
});
