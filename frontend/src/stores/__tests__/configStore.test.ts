/**
 * configStore — `updateConfig` success/failure return-value contract. This is
 * the ONLY behavioral change on top of the pre-existing (non-throwing, `error`
 * state) contract: `updateConfig` now resolves `true` on success and `false`
 * on failure (API rejects `success`, or the call throws), so a caller like the
 * onboarding Telemetry step can get a definitive per-call signal without
 * racing the shared `error` field. Pre-existing behavior (setting `config` /
 * `error` state, refetching on success) is unchanged and re-asserted here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useConfigStore } from '../configStore';
import type { AppConfig } from '../../types/config';

const configGet = vi.fn();
const configUpdate = vi.fn();
const configApplyRunTypeDefault = vi.fn();

vi.mock('../../utils/api', () => ({
  API: {
    config: {
      get: (...a: unknown[]) => configGet(...a),
      update: (...a: unknown[]) => configUpdate(...a),
      applyRunTypeDefault: (...a: unknown[]) => configApplyRunTypeDefault(...a),
    },
  },
}));

function baseConfig(over: Partial<AppConfig> = {}): AppConfig {
  return { gitRepoPath: '/repo', ...over };
}

beforeEach(() => {
  configGet.mockReset();
  configUpdate.mockReset();
  configApplyRunTypeDefault.mockReset();
  useConfigStore.setState({ config: null, isLoading: false, error: null });
});

describe('configStore.updateConfig', () => {
  it('resolves true and refetches config on a successful update', async () => {
    configUpdate.mockResolvedValue({ success: true });
    configGet.mockResolvedValue({ success: true, data: baseConfig({ verbose: true }) });

    const ok = await useConfigStore.getState().updateConfig({ verbose: true });

    expect(ok).toBe(true);
    expect(configGet).toHaveBeenCalledTimes(1);
    expect(useConfigStore.getState().config).toEqual(baseConfig({ verbose: true }));
    expect(useConfigStore.getState().error).toBeNull();
  });

  it('resolves false and sets error state when the API reports failure', async () => {
    configUpdate.mockResolvedValue({ success: false, error: 'nope' });

    const ok = await useConfigStore.getState().updateConfig({ verbose: true });

    expect(ok).toBe(false);
    expect(configGet).not.toHaveBeenCalled();
    expect(useConfigStore.getState().error).toBe('nope');
  });

  it('resolves false and sets error state when the API call throws', async () => {
    configUpdate.mockRejectedValue(new Error('network down'));

    const ok = await useConfigStore.getState().updateConfig({ verbose: true });

    expect(ok).toBe(false);
    expect(useConfigStore.getState().error).toBe('Failed to update config');
  });
});

describe('configStore.applyRunTypeDefault', () => {
  it('returns the previous value and refetches after a successful write', async () => {
    const previous = { model: 'sonnet' };
    const initial = baseConfig({ runTypeDefaults: { workflow: { model: 'sonnet' } } });
    const writeResponseConfig = baseConfig({
      runTypeDefaults: { workflow: { model: 'opus' } },
      verbose: false,
    });
    const fetchedConfig = baseConfig({
      runTypeDefaults: { workflow: { model: 'opus' } },
      verbose: true,
    });
    const calls: string[] = [];
    useConfigStore.setState({ config: initial });
    configApplyRunTypeDefault.mockImplementation(async () => {
      calls.push('write');
      return { success: true, data: { previous, config: writeResponseConfig } };
    });
    configGet.mockImplementation(async () => {
      calls.push('get');
      return { success: true, data: fetchedConfig };
    });

    const result = await useConfigStore.getState().applyRunTypeDefault(
      'workflow',
      { kind: 'merge', value: { model: 'opus' } },
    );

    expect(result).toBe(previous);
    expect(configApplyRunTypeDefault).toHaveBeenCalledWith(
      'workflow',
      { kind: 'merge', value: { model: 'opus' } },
    );
    expect(calls).toEqual(['write', 'get']);
    expect(configGet).toHaveBeenCalledTimes(1);
    expect(useConfigStore.getState().config).toBe(fetchedConfig);
    expect(useConfigStore.getState().config).not.toBe(writeResponseConfig);
  });

  it('leaves config untouched and does not refetch when the write fails', async () => {
    const existing = baseConfig({ runTypeDefaults: { workflow: { model: 'sonnet' } } });
    useConfigStore.setState({ config: existing });
    configApplyRunTypeDefault.mockResolvedValue({ success: false, error: 'nope' });

    const result = await useConfigStore.getState().applyRunTypeDefault('workflow', {
      kind: 'replace',
      value: null,
    });

    expect(result).toBeUndefined();
    expect(configGet).not.toHaveBeenCalled();
    expect(useConfigStore.getState().config).toBe(existing);
    expect(useConfigStore.getState().error).toBe('nope');
  });

  it('swallows a thrown write error', async () => {
    configApplyRunTypeDefault.mockRejectedValue(new Error('network down'));

    const result = await useConfigStore.getState().applyRunTypeDefault('workflow', {
      kind: 'merge',
      value: { model: 'opus' },
    });

    expect(result).toBeUndefined();
    expect(useConfigStore.getState().error).toBe('Failed to apply run type default');
  });
});
