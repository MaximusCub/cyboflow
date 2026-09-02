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

/**
 * How long drainAll waits for one busy queue. Ordinary state mutations are
 * sub-second database writes, so this only ever expires on a task that would
 * not have settled at all. It sits inside the quit-drain ceiling in
 * services/quitDrain.ts, leaving room for the teardown steps that follow.
 */
const DRAIN_CAP_MS = 5_000;

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
   *
   * The wait is bounded. A queue can be held by a task that spans a whole
   * session — a live panel awaiting input, or a run parked at a human gate —
   * and that task never settles on its own. An unbounded wait on one of those
   * burned the whole quit budget, so the steps after the drain (database
   * close, MCP stop) never ran.
   *
   * A queue still busy at the cap is logged and abandoned. Its run row keeps
   * whatever non-terminal status it holds, which is what boot recovery looks
   * for, so the run resumes on the next launch.
   */
  async drainAll(opts?: { capMs?: number }): Promise<void> {
    const capMs = opts?.capMs ?? DRAIN_CAP_MS;
    const entries = [...this.queues.entries()];
    await Promise.allSettled(
      entries.map(async ([runId, q]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settled = await Promise.race([
          q
            .onIdle()
            .then(() => true)
            .catch(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), capMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!settled) {
          console.warn(
            `[RunQueueRegistry] run ${runId} was still busy at shutdown — abandoning its queue`,
          );
        }
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
