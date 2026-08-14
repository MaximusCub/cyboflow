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
 *    `latest`, setting `dirty = true`, and arming the cooldown.
 * 2. `armCooldown` runs a SINGLE `setTimeout(intervalMs)`. When it fires it
 *    moves `latest` into the queue, clears `dirty`, and re-arms; an expiry
 *    with nothing pending stops the chain instead.
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
 * The cadence is driven by a COOLDOWN chain, never by comparing wall-clock
 * timestamps. A value arriving while idle arms a timer for `intervalMs` and is
 * held until it fires — so, exactly as under the old fixed grid, the first
 * value of a burst is coalesced with everything else that lands in that window
 * rather than escaping on the leading edge. Each emission re-arms the cooldown;
 * when it expires with nothing pending, the chain stops and the subscription
 * goes back to holding no timer.
 *
 * Deliberately NO `Date.now()` arithmetic. Deriving the delay from a wall-clock
 * delta makes the throttle wrong across a system clock adjustment in both
 * directions: a backward jump would stall a pending final value for the size of
 * the jump, and a forward jump would compute a zero delay and let emissions
 * exceed `hz`. Relative timer delays are immune to both.
 *
 * ## Lifecycle / cleanup
 *
 * When the outer generator is returned or thrown (client disconnect, error),
 * the `finally` block sets `done = true`, clears any pending cooldown timer, and
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

  // The single in-flight cooldown timer, or null when the chain is stopped. At
  // most one exists at a time, and none at all while the source is quiet.
  let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

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
    queue.push(toEmit);
    wake();
  }

  /**
   * Start one `intervalMs` cooldown. When it expires, anything that arrived
   * during the window is emitted (coalesced to the latest) and the cooldown
   * re-arms; if nothing arrived, the chain stops and we hold no timer until the
   * next value. A no-op when a cooldown is already running or after teardown.
   */
  function armCooldown(): void {
    if (cooldownTimer !== null || done) return;
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (!dirty) return; // quiet window — stop the chain, go back to zero timers
      flush();
      armCooldown();
    }, intervalMs);
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
        armCooldown();
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
      // we are finished. (A still-dirty value keeps us here: its cooldown was
      // armed when it was set, so it will fire and wake us — that's what
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
    if (cooldownTimer !== null) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
    wake(); // unblock consumer if waiting
    await consumerPromise;
  }
}
