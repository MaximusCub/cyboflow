import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runQuitDrain, QUIT_DRAIN_TIMEOUT_MS } from '../quitDrain';

/** A promise plus the handles to settle it from the test body. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks run without advancing fake timers. */
const flush = (): Promise<void> => Promise.resolve().then(() => undefined);

describe('runQuitDrain', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does NOT finish until the teardown has actually completed', async () => {
    // The whole point: the previous `async before-quit` listener let the quit
    // proceed on the first await, which is what raced Node env teardown.
    const teardown = deferred();
    const finish = vi.fn();
    const done = runQuitDrain({ drain: () => teardown.promise, finish });

    await flush();
    expect(finish).not.toHaveBeenCalled();

    teardown.resolve();
    await done;
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('finishes exactly once on clean completion', async () => {
    const finish = vi.fn();
    await runQuitDrain({ drain: async () => {}, finish });
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('finishes anyway when the teardown rejects — a failed teardown must not trap the user in the app', async () => {
    const finish = vi.fn();
    const warn = vi.fn();
    await runQuitDrain({
      drain: async () => {
        throw new Error('orchestrator.stop() blew up');
      },
      finish,
      logger: { warn },
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('teardown failed'), expect.any(Error));
  });

  it('never propagates a teardown failure to the caller', async () => {
    await expect(
      runQuitDrain({ drain: async () => Promise.reject(new Error('boom')), finish: vi.fn() }),
    ).resolves.toBeUndefined();
  });

  it('gives up at the deadline when the teardown hangs', async () => {
    const wedged = deferred();
    const finish = vi.fn();
    const warn = vi.fn();
    const done = runQuitDrain({ drain: () => wedged.promise, finish, logger: { warn } });

    await vi.advanceTimersByTimeAsync(QUIT_DRAIN_TIMEOUT_MS - 1);
    expect(finish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(finish).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still running'));
  });

  it('does not finish a second time when a timed-out teardown later settles', async () => {
    const wedged = deferred();
    const finish = vi.fn();
    const done = runQuitDrain({ drain: () => wedged.promise, finish });

    await vi.advanceTimersByTimeAsync(QUIT_DRAIN_TIMEOUT_MS);
    await done;
    expect(finish).toHaveBeenCalledTimes(1);

    wedged.resolve();
    await flush();
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('honours a caller-supplied deadline', async () => {
    const finish = vi.fn();
    const done = runQuitDrain({ drain: () => deferred().promise, finish, timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it('clears the deadline timer when the teardown wins the race', async () => {
    // Left armed, the timer would keep the process alive for its full duration
    // after the teardown is already done — a visibly slow quit.
    await runQuitDrain({ drain: async () => {}, finish: vi.fn() });
    expect(vi.getTimerCount()).toBe(0);
  });
});
