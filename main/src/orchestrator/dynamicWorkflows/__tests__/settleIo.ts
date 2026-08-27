/**
 * Test-only event-loop settling for the dynamic-workflow tailer suites.
 *
 * WHY THIS EXISTS. Both suites drive JournalTailer under `vi.useFakeTimers()`,
 * but the tailer does its work in `fs/promises` calls that resolve on the libuv
 * POLL phase — which fake timers do not advance. So after firing the fake
 * interval a test must turn the REAL event loop before the emissions it is
 * about to assert on have happened.
 *
 * Both files used to do that by turning the loop a FIXED number of times:
 *
 *     for (let i = 0; i < 40; i++) await stat(dir);
 *
 * That is a bounded wait with no condition and no deadline. How many turns the
 * queue actually needs depends on how the real fs completions interleave with
 * `advanceTimersByTimeAsync`'s own await points, and under vitest's parallel
 * pool that interleaving shifts far enough that 40 stops being enough: the tick
 * has not emitted yet when the assertion runs. The failure is therefore always
 * an UNDER-drain (`expected "spy" to be called 1 times, but got 0 times`), never
 * a duplicate emission — product code was never implicated. That was the
 * `dynamicWorkflows/` full-suite flake, reproducible roughly 1 run in 8 via
 * `npx vitest run src/orchestrator`, and reproducible ON DEMAND by starving the
 * loop to 2 turns.
 *
 * The fix is to wait on the CONDITION rather than on a turn count. Every tick
 * and drain runs through the tailer's single serialized promise chain (see
 * JournalTailer.enqueue), so "the chain tail changed" is exactly "more work was
 * queued". Turn the loop until no tailer's tail has moved and none has a tick
 * pending, for a few consecutive turns — bounded by a REAL-TIME deadline so a
 * genuinely wedged tailer fails loudly instead of hanging the suite.
 */
import { stat } from 'node:fs/promises';
import type { JournalTailer } from '../journalTailer';

/**
 * White-box view of the serialized queue every JournalTailer tick/drain runs
 * through. `queue` is the chain TAIL: enqueue() replaces it, so tail identity is
 * a precise "was anything queued since I looked" signal. `tickScheduled` covers
 * the gap where an interval fire has claimed the next tick but the queued task
 * has not started yet.
 */
interface TailerQueue {
  queue: Promise<void>;
  tickScheduled: boolean;
}

function queueOf(tailer: JournalTailer): TailerQueue {
  return tailer as unknown as TailerQueue;
}

/**
 * Real-time budget for one settle. Only ever reached when a tailer is genuinely
 * wedged — a healthy settle finishes in a handful of turns, well under a
 * millisecond. Read via `process.hrtime.bigint()`, which fake timers do not
 * intercept (`Date.now()` would be frozen here).
 */
const SETTLE_BUDGET_MS = 10_000;

/**
 * Consecutive quiet turns required before we call it settled. More than one
 * because a cascade the tailer does NOT own can re-queue work a turn later: the
 * tracker kicks off `finalize()` / `handleStalled()` un-awaited, and those reach
 * the tailer's queue only once their own synchronous prefix has run.
 */
const QUIET_TURNS = 4;

/**
 * Turn the real event loop until every live tailer's serialized queue has gone
 * quiet, then return. `path` is any real path on disk — it is stat()ed purely to
 * put a poll-phase turn between checks. `tailers` is re-read every turn because
 * the set is not fixed: the tracker creates one per detected workflow and drops
 * them on dismiss/eviction.
 *
 * @throws if the tailers have not gone quiet within {@link SETTLE_BUDGET_MS}.
 */
export async function settleTailerIo(
  path: string,
  tailers: () => readonly JournalTailer[],
): Promise<void> {
  const deadline = process.hrtime.bigint() + BigInt(SETTLE_BUDGET_MS) * 1_000_000n;
  let quiet = 0;
  while (quiet < QUIET_TURNS) {
    const before = tailers();
    const tails = before.map((t) => queueOf(t).queue);
    // Awaiting the chain tail awaits the whole queued run INCLUDING each tick's
    // own fs/promises IO, which is awaited inside the queued task. A rejected
    // task must not fail the settle — enqueue() deliberately keeps the chain
    // alive across one, and the test asserting on the outcome is the judge.
    await Promise.all(tails.map((q) => q.catch(() => undefined)));
    // One real poll-phase turn, so anything that completed during the await
    // above gets its continuations (and their microtasks) drained before we
    // decide whether the queue moved.
    await stat(path);
    const after = tailers();
    const stable =
      after.length === before.length &&
      after.every((t, i) => t === before[i] && queueOf(t).queue === tails[i] && !queueOf(t).tickScheduled);
    quiet = stable ? quiet + 1 : 0;
    if (process.hrtime.bigint() > deadline) {
      throw new Error(`settleTailerIo: tailer IO did not settle within ${SETTLE_BUDGET_MS}ms`);
    }
  }
}
