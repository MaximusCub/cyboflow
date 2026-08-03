/**
 * Regression guards for bug-report diagnostics.
 *
 * Two of these encode findings from adversarial review that a naive
 * implementation gets wrong in a way no type check would catch:
 *
 *   - the recent-error buffer must fill even when Sentry is INACTIVE, because
 *     that is exactly the state a hand-filed bug report is submitted from;
 *   - the log source must be chosen by RUNTIME MODE, not by which file happens
 *     to exist, because under `pnpm dev` BOTH sinks exist.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: vi.fn(() => '0.1.35') },
}));

import {
  recordLocalError,
  getRecentErrors,
  collectDiagnostics,
  resolveLogSourceKind,
  __resetRecentErrorsForTests,
} from '../diagnostics';
import { captureSeamError } from '../index';

const AT = '2026-08-03T12:00:00.000Z';

describe('recent-error ring buffer', () => {
  beforeEach(() => {
    __resetRecentErrorsForTests();
  });

  it('records a classified, redacted entry', () => {
    recordLocalError('cli-spawn', new TypeError('bad handle at /Users/alice/repo/x.ts'), AT);

    expect(getRecentErrors()).toEqual([
      {
        at: AT,
        seam: 'cli-spawn',
        errorClass: 'TypeError',
        message: 'bad handle at ~/repo/x.ts',
      },
    ]);
  });

  it('coerces a non-Error throw without losing the value', () => {
    recordLocalError('seam', 'plain string failure', AT);

    const [entry] = getRecentErrors();
    expect(entry.errorClass).toBe('Error');
    expect(entry.message).toBe('plain string failure');
  });

  it('truncates an oversized message rather than storing it whole', () => {
    recordLocalError('seam', new Error('x'.repeat(5_000)), AT);

    const [entry] = getRecentErrors();
    expect(entry.message.length).toBeLessThan(1_000);
    expect(entry.message.endsWith('… [truncated]')).toBe(true);
  });

  it('evicts oldest entries beyond the cap so a crash loop cannot grow it unbounded', () => {
    for (let i = 0; i < 50; i++) {
      recordLocalError('seam', new Error(`failure ${i}`), AT);
    }

    const entries = getRecentErrors();
    expect(entries).toHaveLength(20);
    // Oldest evicted, newest retained.
    expect(entries[0].message).toBe('failure 30');
    expect(entries[19].message).toBe('failure 49');
  });

  it('never throws, even on a value with a throwing message getter', () => {
    const hostile = {
      get message() {
        throw new Error('boom');
      },
    };

    expect(() => recordLocalError('seam', hostile, AT)).not.toThrow();
  });
});

describe('captureSeamError records locally when Sentry is inactive', () => {
  beforeEach(() => {
    __resetRecentErrorsForTests();
  });

  /**
   * The regression this guards: feeding the buffer from INSIDE captureSeamError's
   * `if (!sentryActive) return` guard leaves it empty for every user who has
   * error reporting switched off — the precise population most likely to file a
   * report by hand. initTelemetry is never called here, so sentryActive is false.
   */
  it('populates the buffer with no Sentry client initialized', () => {
    captureSeamError('orch-socket', new Error('connect ECONNREFUSED'));

    const entries = getRecentErrors();
    expect(entries).toHaveLength(1);
    expect(entries[0].seam).toBe('orch-socket');
    expect(entries[0].message).toBe('connect ECONNREFUSED');
  });
});

describe('collectDiagnostics', () => {
  beforeEach(() => {
    __resetRecentErrorsForTests();
  });

  it('emits only allowlisted fields and carries the recorded errors', () => {
    recordLocalError('seam', new Error('boom'), AT);

    const diagnostics = collectDiagnostics({
      appVersion: '0.1.35',
      electronVersion: '38.0.0',
      environment: 'stable',
      installId: 'install-uuid',
    });

    expect(Object.keys(diagnostics).sort()).toEqual([
      'appVersion',
      'arch',
      'electronVersion',
      'environment',
      'installId',
      'platform',
      'recentErrors',
    ]);
    expect(diagnostics.recentErrors).toHaveLength(1);
  });
});

describe('log source selection', () => {
  /**
   * Under `pnpm dev` the persistent Logger is ALSO constructed, so
   * ~/.cyboflow_dev/logs/ exists alongside the root debug log. An
   * existence-ordered check would silently pick the thinner file every time.
   */
  it('chooses by runtime mode, not by which file exists', () => {
    expect(resolveLogSourceKind(false)).toBe('dev-debug');
    expect(resolveLogSourceKind(true)).toBe('app-log');
  });
});
