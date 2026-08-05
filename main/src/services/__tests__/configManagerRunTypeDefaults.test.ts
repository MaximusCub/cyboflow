import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-runtype-defaults-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager run-type defaults', () => {
  it('reads sparse entries raw and keeps launch floors separate from defaultModel', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    expect(manager.getConfig().runTypeDefaults).toBeUndefined();
    expect(manager.getDefaultModel()).toBe('sonnet');
    expect(manager.getRunTypeDefaults('workflow:nonexistent')).toBeUndefined();
    expect(manager.getDefaultLaunchModel('workflow:nonexistent')).toBe('opus');
    expect(manager.getDefaultLaunchModel('workflow:nonexistent')).not.toBe(manager.getDefaultModel());
    expect(manager.getDefaultLaunchModel('quick')).toBe('opus');

    await manager.updateConfig({ runTypeDefaults: { 'workflow:flow-a': { model: 'sonnet' } } });
    expect(manager.getRunTypeDefaults('workflow:flow-a')).toEqual({ model: 'sonnet' });
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe('sonnet');
  });

  it('returns the previous value and applies sparse merge deletion', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    const prior = { model: 'opus' as const };
    await manager.updateConfig({ runTypeDefaults: { quick: prior } });

    const updated = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { model: null },
    });

    expect(updated.previous).toEqual(prior);
    expect(updated.config.runTypeDefaults).toBeUndefined();
    expect(manager.getRunTypeDefaults('quick')).toBeUndefined();
  });

  it('creates a sparse key when merging an override that did not previously exist', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    const created = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { substrate: 'sdk' },
    });

    expect(created.previous).toBeUndefined();
    expect(created.config.runTypeDefaults?.quick).toEqual({ substrate: 'sdk' });
  });

  it('returns undefined when the key did not exist and supports replace', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    const created = await manager.applyRunTypeDefault('workflow:flow-a', {
      kind: 'replace',
      value: { model: 'sonnet', substrate: 'sdk' },
    });
    expect(created.previous).toBeUndefined();
    expect(created.config.runTypeDefaults?.['workflow:flow-a']).toEqual({ model: 'sonnet', substrate: 'sdk' });

    const persistedAfterCreate = JSON.parse(
      await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'),
    ) as { runTypeDefaults?: Record<string, Record<string, string>> };
    expect(persistedAfterCreate.runTypeDefaults?.['workflow:flow-a']).toEqual({
      model: 'sonnet',
      substrate: 'sdk',
    });

    const replaced = await manager.applyRunTypeDefault('workflow:flow-a', {
      kind: 'replace',
      value: null,
    });
    expect(replaced.previous).toEqual({ model: 'sonnet', substrate: 'sdk' });
    expect(replaced.config.runTypeDefaults).toBeUndefined();

    const persistedAfterDelete = JSON.parse(
      await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'),
    ) as { runTypeDefaults?: Record<string, Record<string, string>> };
    expect(persistedAfterDelete.runTypeDefaults).toBeUndefined();
  });

  it('preserves unrelated sparse fields across merge patches before deleting the empty key', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    await manager.updateConfig({
      runTypeDefaults: {
        quick: {
          model: 'opus',
          substrate: 'sdk',
          reasoningEffort: 'high',
        },
      },
    });

    const merged = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { model: null, substrate: 'interactive' },
    });

    expect(merged.previous).toEqual({
      model: 'opus',
      substrate: 'sdk',
      reasoningEffort: 'high',
    });
    expect(merged.config.runTypeDefaults?.quick).toEqual({
      substrate: 'interactive',
      reasoningEffort: 'high',
    });

    const deleted = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { substrate: null, reasoningEffort: null },
    });

    expect(deleted.previous).toEqual({
      substrate: 'interactive',
      reasoningEffort: 'high',
    });
    expect(deleted.config.runTypeDefaults).toBeUndefined();
  });

  it('deletes a key when replace receives an empty object and returns the whole updated config', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    await manager.updateConfig({ runTypeDefaults: { quick: { model: 'opus' } } });

    const result = await manager.applyRunTypeDefault('quick', {
      kind: 'replace',
      value: {},
    });

    expect(result.previous).toEqual({ model: 'opus' });
    expect(result.config).toBe(manager.getConfig());
    expect(result.config.runTypeDefaults).toBeUndefined();
  });
});
