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
  it('reads sparse entries raw and keeps workflow floor separate from defaultModel', () => {
    const manager = new ConfigManager('/tmp/test-git-path');

    expect(manager.getConfig().runTypeDefaults).toBeUndefined();
    expect(manager.getRunTypeDefaults('workflow:nonexistent')).toBeUndefined();
    expect(manager.getDefaultLaunchModel('workflow:nonexistent')).toBe('opus');
    expect(manager.getDefaultLaunchModel('workflow:nonexistent')).not.toBe(manager.getDefaultModel());
    expect(manager.getDefaultLaunchModel('quick')).toBe('opus');
  });

  it('returns the previous value and applies sparse merge deletion', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    await manager.updateConfig({ runTypeDefaults: { quick: { model: 'opus' } } });

    const updated = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { model: null },
    });

    expect(updated.previous).toEqual({ model: 'opus' });
    expect(updated.config.runTypeDefaults).toBeUndefined();
    expect(manager.getRunTypeDefaults('quick')).toBeUndefined();
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

    const replaced = await manager.applyRunTypeDefault('workflow:flow-a', {
      kind: 'replace',
      value: null,
    });
    expect(replaced.previous).toEqual({ model: 'sonnet', substrate: 'sdk' });
    expect(replaced.config.runTypeDefaults).toBeUndefined();
  });
});
