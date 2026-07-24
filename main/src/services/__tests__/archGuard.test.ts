import { describe, it, expect } from 'vitest';
import {
  detectArchMismatch,
  formatArchMismatchLog,
  formatArchMismatchDialog,
} from '../archGuard';

describe('detectArchMismatch', () => {
  it('reports the bundle arch and an arm64 host when translated on macOS', () => {
    expect(
      detectArchMismatch({
        runningUnderARM64Translation: true,
        processArch: 'x64',
        platform: 'darwin',
      }),
    ).toEqual({ bundleArch: 'x64', nativeArch: 'arm64' });
  });

  it('reports a mismatch under Windows WOW translation', () => {
    expect(
      detectArchMismatch({
        runningUnderARM64Translation: true,
        processArch: 'x64',
        platform: 'win32',
      }),
    ).toEqual({ bundleArch: 'x64', nativeArch: 'arm64' });
  });

  it('returns null for a native arm64 build (the healthy case)', () => {
    expect(
      detectArchMismatch({
        runningUnderARM64Translation: false,
        processArch: 'arm64',
        platform: 'darwin',
      }),
    ).toBeNull();
  });

  it('returns null for a native x64 build on genuine Intel hardware', () => {
    // The whole point of gating on the translator flag rather than comparing
    // process.arch to os.arch(): an x64 build on a real Intel Mac is correct and
    // must NOT warn.
    expect(
      detectArchMismatch({
        runningUnderARM64Translation: false,
        processArch: 'x64',
        platform: 'darwin',
      }),
    ).toBeNull();
  });

  it('returns null on platforms without ARM64 translation', () => {
    expect(
      detectArchMismatch({
        runningUnderARM64Translation: true,
        processArch: 'x64',
        platform: 'linux',
      }),
    ).toBeNull();
  });
});

describe('arch mismatch copy', () => {
  const mismatch = { bundleArch: 'x64', nativeArch: 'arm64' };

  it('names both architectures in the log line', () => {
    const line = formatArchMismatchLog(mismatch);
    expect(line).toContain('x64');
    expect(line).toContain('arm64');
  });

  it('uses Mac wording on darwin and PC wording on win32', () => {
    expect(formatArchMismatchDialog(mismatch, 'darwin').message).toContain('Apple Silicon Mac');
    expect(formatArchMismatchDialog(mismatch, 'win32').message).toContain('ARM PC');
  });

  it('ties the warning to the SDK timeout symptom users actually see', () => {
    // The dialog is only useful if it connects the mismatch to the error text
    // surfaced by the first-event watchdog; otherwise it reads as trivia.
    expect(formatArchMismatchDialog(mismatch, 'darwin').detail).toContain(
      'claude subprocess may have failed to start',
    );
  });
});
