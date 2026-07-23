/**
 * wireSessionSummaryScheduler — the event-subscription glue between the
 * substrate managers and the {@link SessionSummarySchedulerLike} (plan §5).
 *
 * Extracted from the `index.ts` wiring site into a pure, dep-injected helper
 * (mirroring `orchestrator/terminalEvalSubscriber.ts`) so the composition tests
 * (plan §8) can drive REAL `EventEmitter`s through the SAME subscriptions
 * production uses, rather than calling the scheduler's methods by hand.
 *
 * It subscribes only — the arming/clearing/gating all live in the scheduler,
 * and the probes/config/summarizer are injected into the scheduler at its
 * construction site. This helper therefore imports nothing from `services/*`
 * (orchestrator layering rule): it takes the emitters as the narrow
 * {@link TurnEventSource} structural type any `EventEmitter` satisfies.
 *
 * The two substrate seams (plan §2.1):
 *  - SDK `claudeCodeManager`: per-logical-turn `'exit'` → arm; `'spawned'` → clear.
 *  - PTY facade `SubstrateDispatchFacade`: Stop-hook `'turn-end'` → arm.
 *
 * The PTY relay seam (plan §2.2) — where a composer turn on a live REPL emits
 * NO `'spawned'` — is cleared from the `sessions:input` IPC handler instead
 * (it calls `scheduler.noteTurnStart` directly with the sessionId), and is not
 * wired here.
 */
import type { SessionSummarySchedulerLike } from './sessionSummaryScheduler';

/** Payload of the SDK `'exit'` / `'spawned'` events — both carry `sessionId`. */
interface SessionTurnPayload {
  sessionId: string;
}

/** The narrow event surface any Node `EventEmitter` satisfies structurally. */
export interface TurnEventSource {
  on(event: string, listener: (payload: SessionTurnPayload) => void): unknown;
  off(event: string, listener: (payload: SessionTurnPayload) => void): unknown;
}

export interface WireSessionSummarySchedulerDeps {
  /** The SDK Claude manager (`claudeCodeManager`): `'exit'` arms, `'spawned'` clears. */
  claudeManager: TurnEventSource;
  /** The `SubstrateDispatchFacade`: its re-emitted `'turn-end'` (PTY Stop-hook) arms. */
  facade: TurnEventSource;
  scheduler: SessionSummarySchedulerLike;
}

/**
 * Subscribe the scheduler to the substrate turn events. Returns an unsubscribe
 * that detaches every listener (symmetry for tests / hot-reload; app shutdown
 * relies on `scheduler.dispose()` for the timers).
 */
export function wireSessionSummaryScheduler(deps: WireSessionSummarySchedulerDeps): () => void {
  const { claudeManager, facade, scheduler } = deps;

  const onExit = (payload: SessionTurnPayload): void => {
    if (payload?.sessionId) scheduler.noteTurnEnd(payload.sessionId);
  };
  const onSpawned = (payload: SessionTurnPayload): void => {
    if (payload?.sessionId) scheduler.noteTurnStart(payload.sessionId);
  };
  const onTurnEnd = (payload: SessionTurnPayload): void => {
    if (payload?.sessionId) scheduler.noteTurnEnd(payload.sessionId);
  };

  claudeManager.on('exit', onExit);
  claudeManager.on('spawned', onSpawned);
  facade.on('turn-end', onTurnEnd);

  return () => {
    claudeManager.off('exit', onExit);
    claudeManager.off('spawned', onSpawned);
    facade.off('turn-end', onTurnEnd);
  };
}
