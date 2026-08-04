/**
 * hostProbeAdapters — the two host-probe adapters behind the §6 health panel.
 *
 * Both rules here were previously written INLINE in index.ts, where no test can
 * reach them: the router's own tests inject stubs that stand in for these
 * adapters, so a stub that rejects proves the router maps rejections correctly
 * while proving nothing about whether the production adapter ever rejects.
 * That gap is exactly where both defects lived.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeChromiumProvisioner, makeDriverCliProbe } from '../hostProbeAdapters';

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
