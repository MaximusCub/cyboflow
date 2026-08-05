/**
 * hostProbeAdapters — the host-probe adapters behind the §6 health panel.
 *
 * These rules were previously written INLINE in index.ts, where no test can
 * reach them: the router's own tests inject stubs that stand in for these
 * adapters, so a stub that rejects proves the router maps rejections correctly
 * while proving nothing about whether the production adapter ever rejects.
 * That gap is exactly where both original defects lived.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ACCESSIBILITY_SETTINGS_URL,
  SCREEN_RECORDING_SETTINGS_URL,
  makeAccessibilityRequester,
  makeChromiumProvisioner,
  makeDriverCliProbe,
  makeScreenRecordingSettingsOpener,
} from '../hostProbeAdapters';

function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`${code}: simulated`);
  err.code = code;
  return err;
}

describe('makeDriverCliProbe', () => {
  it('reports the CLI present when access resolves', async () => {
    const probe = makeDriverCliProbe('/app/driver/cli.js', async () => {});
    await expect(probe()).resolves.toEqual({ path: '/app/driver/cli.js', exists: true });
  });

  it('reports MISSING only for ENOENT — the one affirmative absence', async () => {
    const probe = makeDriverCliProbe('/app/driver/cli.js', () => Promise.reject(errno('ENOENT')));
    await expect(probe()).resolves.toEqual({ path: '/app/driver/cli.js', exists: false });
  });

  it.each(['EACCES', 'EPERM', 'EIO', 'ELOOP'])(
    'REJECTS on %s so the router can call it inconclusive, never missing',
    async (code) => {
      // The fail-open rule from preflight.ts: a probe that could not answer is
      // not evidence. Resolving `exists: false` here would launder "could not
      // check" into a confident "missing" BEFORE the router's rejection branch
      // could see it — sending a user to reinstall a CLI that is sitting right
      // there behind an unsearchable parent directory.
      const probe = makeDriverCliProbe('/app/driver/cli.js', () => Promise.reject(errno(code)));
      await expect(probe()).rejects.toThrow(code);
    },
  );

  it('rejects on a non-errno throw rather than guessing', async () => {
    const probe = makeDriverCliProbe('/app/driver/cli.js', () => Promise.reject(new Error('boom')));
    await expect(probe()).rejects.toThrow('boom');
  });
});

describe('makeChromiumProvisioner', () => {
  it('returns the install result and keeps a SUCCESSFUL installer', async () => {
    const ensureChromium = vi.fn().mockResolvedValue(true);
    const createInstaller = vi.fn(() => ({ ensureChromium }));
    const provision = makeChromiumProvisioner(createInstaller);

    await expect(provision()).resolves.toBe(true);
    await expect(provision()).resolves.toBe(true);

    // One construction: nothing failed, so nothing needed replacing.
    expect(createInstaller).toHaveBeenCalledTimes(1);
    expect(ensureChromium).toHaveBeenCalledTimes(2);
  });

  it('takes a FRESH installer after a resolved-false attempt', async () => {
    // PlaywrightInstaller memoizes its first promise, so reusing it would
    // return the cached false forever and the fix-it button would look broken
    // from its second click onward.
    const first = vi.fn().mockResolvedValue(false);
    const second = vi.fn().mockResolvedValue(true);
    const createInstaller = vi
      .fn()
      .mockReturnValueOnce({ ensureChromium: first })
      .mockReturnValueOnce({ ensureChromium: second });
    const provision = makeChromiumProvisioner(createInstaller);

    await expect(provision()).resolves.toBe(false);
    await expect(provision()).resolves.toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('takes a FRESH installer after a REJECTED attempt, so a retry still runs', async () => {
    // The half that used to be missed: `.then` is skipped on rejection, so the
    // poisoned installer was kept and every later click failed instantly on the
    // same settled promise without ever spawning a second install.
    const first = vi.fn().mockRejectedValue(new Error('network down'));
    const second = vi.fn().mockResolvedValue(true);
    const createInstaller = vi
      .fn()
      .mockReturnValueOnce({ ensureChromium: first })
      .mockReturnValueOnce({ ensureChromium: second });
    const provision = makeChromiumProvisioner(createInstaller);

    await expect(provision()).rejects.toThrow('network down');
    await expect(provision()).resolves.toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('logs the reset when an attempt throws', async () => {
    const warn = vi.fn();
    const provision = makeChromiumProvisioner(
      () => ({ ensureChromium: () => Promise.reject(new Error('spawn ENOENT')) }),
      { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    );

    await expect(provision()).rejects.toThrow('spawn ENOENT');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('chromium provisioning threw'),
      expect.objectContaining({ error: 'spawn ENOENT' }),
    );
  });

  it('shares ONE attempt between concurrent callers', async () => {
    // An impatient double-click must not race two installs at the same cache.
    let release: (ok: boolean) => void = () => {};
    const ensureChromium = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const provision = makeChromiumProvisioner(() => ({ ensureChromium }));

    const a = provision();
    const b = provision();
    release(true);

    await expect(Promise.all([a, b])).resolves.toEqual([true, true]);
    expect(ensureChromium).toHaveBeenCalledTimes(1);
  });

  it('clears the in-flight guard once an attempt settles, including on rejection', async () => {
    const ensureChromium = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce(true);
    const provision = makeChromiumProvisioner(() => ({ ensureChromium }));

    await expect(provision()).rejects.toThrow('transient');
    // A stuck guard would hand this caller the SAME rejected promise forever.
    await expect(provision()).resolves.toBe(true);
  });
});

describe('makeAccessibilityRequester', () => {
  it('PROMPTS via the OS and does not open Settings when the app is already trusted', async () => {
    const isTrusted = vi.fn().mockReturnValue(true);
    const openSettings = vi.fn().mockResolvedValue(undefined);
    await makeAccessibilityRequester({ isTrustedAccessibilityClient: isTrusted, openSettings })();

    // `true` is the argument that makes macOS show the consent dialog.
    expect(isTrusted).toHaveBeenCalledWith(true);
    // Sending someone to enable a switch that is already on is its own wrong answer.
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('falls through to the Settings pane when the app is NOT trusted', async () => {
    // macOS shows the consent dialog at most ONCE per binary and silently
    // no-ops forever after. Without this fallback the button works exactly one
    // time in the app's lifetime and then reads as broken.
    const openSettings = vi.fn().mockResolvedValue(undefined);
    await makeAccessibilityRequester({
      isTrustedAccessibilityClient: () => false,
      openSettings,
    })();

    expect(openSettings).toHaveBeenCalledWith(ACCESSIBILITY_SETTINGS_URL);
  });

  it('still opens Settings when the trust check itself THROWS', async () => {
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    await makeAccessibilityRequester({
      isTrustedAccessibilityClient: () => {
        throw new Error('no such API');
      },
      openSettings,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    })();

    // An unanswerable trust check is not evidence of trust, so the user still
    // gets the pane.
    expect(openSettings).toHaveBeenCalledWith(ACCESSIBILITY_SETTINGS_URL);
    expect(warn).toHaveBeenCalled();
  });

  it('swallows a failed openExternal — the action is advisory', async () => {
    const warn = vi.fn();
    const request = makeAccessibilityRequester({
      isTrustedAccessibilityClient: () => false,
      openSettings: () => Promise.reject(new Error('no handler for the URL scheme')),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });

    // Nothing downstream depends on the pane having opened; the caller
    // re-probes either way.
    await expect(request()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('makeScreenRecordingSettingsOpener', () => {
  it('opens the Screen Recording pane with no prompt attempt', async () => {
    // Unlike Accessibility there is no macOS API to REQUEST this grant at any
    // privilege level, so showing the switch is the entire available remedy.
    const openSettings = vi.fn().mockResolvedValue(undefined);
    await makeScreenRecordingSettingsOpener({ openSettings })();

    expect(openSettings).toHaveBeenCalledWith(SCREEN_RECORDING_SETTINGS_URL);
  });

  it('swallows a failed open rather than failing the action', async () => {
    const warn = vi.fn();
    const open = makeScreenRecordingSettingsOpener({
      openSettings: () => Promise.reject(new Error('boom')),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });

    await expect(open()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('targets the two DISTINCT panes — the grants live in different places', () => {
    expect(SCREEN_RECORDING_SETTINGS_URL).not.toBe(ACCESSIBILITY_SETTINGS_URL);
    expect(SCREEN_RECORDING_SETTINGS_URL).toMatch(/Privacy_ScreenCapture$/);
    expect(ACCESSIBILITY_SETTINGS_URL).toMatch(/Privacy_Accessibility$/);
  });
});
