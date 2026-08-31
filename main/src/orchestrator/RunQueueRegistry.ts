/**
 * RunQueueRegistry — per-run serialization registry.
 *
 * Each workflow run gets its own PQueue({ concurrency: 1 }) so that state
 * mutations within a run are serialized while different runs proceed
 * concurrently.
 *
 * -----------------------------------------------------------------------
 * no-recursive-enqueue rule
 * -----------------------------------------------------------------------
 * Status-change events flow via EventEmitter, NOT by re-entering the queue.
 * Calling registry.getOrCreate(runId).add(...) from inside a task already
 * enqueued on the same runId is a self-deadlock — see p-queue README warning.
 * -----------------------------------------------------------------------
 */
import PQueue from 'p-queue';

export class RunQueueRegistry {
  private queues = new Map<string, PQueue>();

  /**
   * Returns the existing queue for `runId`, or lazily creates one with
   * { concurrency: 1 } and stores it.
   *
   * NOTE: do not call this from inside a task already running on the same
   * runId — that violates the no-recursive-enqueue rule and will deadlock.
   */
  getOrCreate(runId: string): PQueue {
    let q = this.queues.get(runId);
    if (!q) {
      q = new PQueue({ concurrency: 1 });
      this.queues.set(runId, q);
    }
    return q;
  }

  /** Returns true when a queue for `runId` is currently tracked. */
  has(runId: string): boolean {
    return this.queues.has(runId);
  }

  /**
   * Drains the queue for `runId` and removes it from the registry.
   *
   * Callers must ensure any pending tasks for this run have been
   * aborted/cancelled before invoking delete; this method only waits for
   * already-started tasks to finish (onIdle), it does not abort them.
   *
   * NOTE: Do not enqueue new tasks for `runId` after calling delete — that
   * would re-create the queue and violate the no-recursive-enqueue rule if
   * done from a task still winding down on the same runId.
   */
  async delete(runId: string): Promise<void> {
    const q = this.queues.get(runId);
    if (!q) {
      return;
    }
    await q.onIdle();
    this.queues.delete(runId);
  }

  /**
   * Waits for every tracked queue to become idle, then clears the registry.
   * Intended for clean shutdown.
   */
  async drainAll(): Promise<void> {
    // Bounded per-queue wait. A queued task that never settles (observed: a
    // state mutation awaiting a hung agent turn) would hold onIdle forever and
    // starve the rest of shutdown; the quit-drain's own timeout then skips the
    // REMAINING teardown (DB close, MCP stop) — worse than the lost mutation.
    // Wait per queue up to DRAIN_TIMEOUT_MS, attribute any queue that does not
    // drain, and always let shutdown continue.
    const DRAIN_TIMEOUT_MS = 1_500;
    const entries = [...this.queues.entries()];
    await Promise.allSettled(
      entries.map(([runId, q]) => {
        const pending = q.pending;
        return Promise.race([
          q.onIdle().catch((err) => {
            console.error(`[RunQueueRegistry] queue ${runId} onIdle threw:`, err);
          }),
          new Promise<void>((resolve) =>
            setTimeout(() => {
              console.error(
                `[RunQueueRegistry] queue ${runId} did not drain within ${DRAIN_TIMEOUT_MS}ms ` +
                  `(pending=${pending}, size=${q.size}) — its in-flight mutation may be lost; continuing shutdown`,
              );
              resolve();
            }, DRAIN_TIMEOUT_MS),
          ),
        ]);
      }),
    );
    this.queues.clear();
  }

  /** Returns a snapshot of queue depth across all tracked runs. */
  stats(): { runs: number; totalPending: number; totalActive: number } {
    let totalPending = 0;
    let totalActive = 0;
    for (const q of this.queues.values()) {
      totalPending += q.size;
      totalActive += q.pending;
    }
    return { runs: this.queues.size, totalPending, totalActive };
  }
}
