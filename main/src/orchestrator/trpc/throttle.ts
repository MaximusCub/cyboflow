/**
 * Async-iterator throttle utility for tRPC v11 subscriptions.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 *
 * ## Coalescing semantics
 *
 * When the source produces multiple events within a single tick window
 * (1000/hz milliseconds), only the **latest** event is emitted — earlier
 * events in the same window are silently discarded. This is intentional:
 * the renderer cares about "current state of this run", not a replay of
 * every intermediate state. The raw EventEmitter source (consumed by the
 * raw_events DB writer) remains unthrottled and retains full fidelity.
 *
 * ## Memory-leak mitigation
 *
 * tRPC v11 subscriptions backed by high-frequency sources (e.g., long Bash
 * output) can saturate the IPC queue if every source event crosses the
 * boundary. This throttle caps the per-subscription emission rate at `hz`
 * events per second regardless of source throughput.
 *
 * ## Algorithm
 *
 * 1. A background consumer loop reads from `source`, always overwriting
 *    `latest`, setting `dirty = true`, and asking for a flush to be scheduled.
 * 2. `scheduleFlush` arms a SINGLE `setTimeout` for the earliest instant the
 *    rate cap allows (`intervalMs` after the last emission). When it fires it
 *    moves `latest` into the queue and clears `dirty`.
 * 3. The outer generator dequeues and yields, blocking between dequeues
 *    until the next flush signal or source completion.
 *
 * ## Why on-demand timers, not a steady interval
 *
 * This used to arm `setInterval(1000/hz)` for the whole life of the
 * subscription, which ticked whether or not the source had produced anything.
 * In the Electron MAIN process that is expensive in a way it is not in plain
 * Node: libuv is driven by Chromium's CFRunLoop, so each fire costs a
 * `__CFRunLoopDoSources0 → uv_run → uv__run_timers` round trip plus a
 * `uv__loop_interrupt`/`kevent` to re-arm. Measured on an IDLE app, two live
 * subscriptions at `hz=60` fired ~98 times/second between them and did 0.8ms of
 * real work per 5000ms — ~2% of a core spent almost entirely on wakeup
 * overhead. Arming the timer only while a value is actually pending drops that
 * to ZERO timers when nothing is streaming, with identical emission semantics.
 *
 * ## Emission-timing equivalence
 *
 * `lastEmitAt` starts at construction time, so the first value is still held
 * for a full `intervalMs` rather than emitted on the leading edge — matching
 * the old fixed-grid behaviour (a value is never forwarded faster than the cap
 * would have allowed) and keeping coalescing observable to callers.
 *
 * ## Lifecycle / cleanup
 *
 * When the outer generator is returned or thrown (client disconnect, error),
 * the `finally` block sets `done = true`, clears any pending flush timer, and
 * awaits the consumer promise so the background loop exits cleanly.
 */

/**
 * Wraps `source` in a throttled async generator that emits at most `hz`
 * values per second, always yielding the **latest** value seen within each
 * tick window (coalescing semantics).
 *
 * @param source - Any async iterable (EventEmitter-backed iterator, etc.).
 * @param hz     - Target emission rate in events per second (e.g. 60).
 * @returns      An async generator suitable for use in a tRPC subscription.
 */
export async function* throttleAsyncIterator<T>(
  source: AsyncIterable<T>,
  hz: number,
): AsyncGenerator<T> {
  const intervalMs = 1000 / hz;

  let latest: T | undefined = undefined;
  let dirty = false;
  let done = false;
  let sourceDone = false;

  // Queue of values ready to yield.
  const queue: T[] = [];

  // Pending resolve callback: the outer generator awaits this between yields.
  let waitResolve: (() => void) | null = null;

  // The single in-flight flush timer, or null when nothing is pending. At most
  // one exists at a time, and none at all while the source is quiet.
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Wall-clock of the last emission, seeded at construction so the first value
  // is rate-limited exactly as the old fixed-grid interval limited it.
  let lastEmitAt = Date.now();

  /** Wake up the outer generator loop (new value enqueued or source done). */
  function wake(): void {
    if (waitResolve) {
      const r = waitResolve;
      waitResolve = null;
      r();
    }
  }

  /** Move `latest` into the queue and wake the generator. */
  function flush(): void {
    if (!dirty) return;
    const toEmit = latest as T;
    dirty = false;
    latest = undefined;
    lastEmitAt = Date.now();
    queue.push(toEmit);
    wake();
  }

  /**
   * Arm the flush timer for the earliest instant the rate cap allows. A no-op
   * when one is already pending (so a burst of source events shares a single
   * timer) or when the generator has been torn down.
   */
  function scheduleFlush(): void {
    if (flushTimer !== null || done) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastEmitAt));
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, delay);
  }

  // Background consumer: reads source, updates latest+dirty, and arms the
  // flush. Deliberately does NOT enqueue directly — only `flush` does, so the
  // rate cap and coalescing stay in one place.
  const consumerPromise = (async () => {
    try {
      for await (const event of source) {
        if (done) break;
        latest = event;
        dirty = true;
        scheduleFlush();
      }
    } finally {
      sourceDone = true;
      wake();
    }
  })();

  try {
    while (!done) {
      // Drain the queue first.
      while (queue.length > 0) {
        yield queue.shift() as T;
      }

      // If source is done and queue is empty and nothing dirty remains,
      // we are finished. (A still-dirty value keeps us here: its flush timer
      // was armed when it was set, so it will fire and wake us — that's what
      // ensures the very last event is not lost when the source exhausts
      // quickly.)
      if (sourceDone && queue.length === 0 && !dirty) {
        break;
      }

      // Wait for next wake() call (tick enqueue or source-done).
      await new Promise<void>((resolve) => {
        // Re-check inside the constructor to avoid a race between the
        // `while(queue.length)` check above and registering the callback.
        if (queue.length > 0 || (sourceDone && !dirty)) {
          resolve();
        } else {
          waitResolve = resolve;
        }
      });
    }
  } finally {
    done = true;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    wake(); // unblock consumer if waiting
    await consumerPromise;
  }
}
