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
 *  - The SDK managers: per-logical-turn `'exit'` → arm; `'spawned'` → clear.
 *    EVERY SDK lane is passed, not just Claude's — `codexSdkManager` and
 *    `ompSdkManager` emit the same per-turn pair with the same payload
 *    (`{ panelId, sessionId }`), and their sessions stream conversation rows
 *    exactly like Claude's. Subscribing only `claudeCodeManager` left Codex/OMP
 *    sessions with no idle arming at all: they could be summarized solely by
 *    the §2.7 lazy catch-up a UI read happens to kick, never by the idle timer
 *    the feature is built around. The scheduler re-runs its own eligibility
 *    gate per fire, so passing a manager here never widens WHICH sessions
 *    qualify — only when they are noticed.
 *  - PTY facade `SubstrateDispatchFacade`: Stop-hook `'turn-end'` → arm,
 *    `'turn-start'` (a submitted line that starts a REPL turn) → clear.
 *
 * The composer's own PTY relay seam (plan §2.2) — a turn on a live REPL emits
 * NO `'spawned'` — is ALSO cleared from the `sessions:input` IPC handler (it
 * calls `scheduler.noteTurnStart` directly with the sessionId). That stayed
 * when `'turn-start'` landed: the handler clears BEFORE dispatching, so it
 * still wins the race against an armed timer for a composer turn, while
 * `'turn-start'` covers the raw-keystroke path the IPC handler never sees (a
 * TUI question answered with arrow keys + Enter). noteTurnStart is idempotent,
 * so a composer turn simply clears twice.
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
  /**
   * Every SDK manager whose turns should arm the idle timer (`claudeCodeManager`,
   * `codexSdkManager`, `ompSdkManager`): `'exit'` arms, `'spawned'` clears.
   */
  sdkManagers: readonly TurnEventSource[];
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
  const { sdkManagers, facade, scheduler } = deps;

  const onExit = (payload: SessionTurnPayload): void => {
    if (payload?.sessionId) scheduler.noteTurnEnd(payload.sessionId);
  };
  const onSpawned = (payload: SessionTurnPayload): void => {
    if (payload?.sessionId) scheduler.noteTurnStart(payload.sessionId);
  };
  const onTurnEnd = (payload: SessionTurnPayload): void => {
    if (payload?.sessionId) scheduler.noteTurnEnd(payload.sessionId);
  };
  const onTurnStart = (payload: SessionTurnPayload): void => {
    if (payload?.sessionId) scheduler.noteTurnStart(payload.sessionId);
  };

  for (const manager of sdkManagers) {
    manager.on('exit', onExit);
    manager.on('spawned', onSpawned);
  }
  facade.on('turn-end', onTurnEnd);
  facade.on('turn-start', onTurnStart);

  return () => {
    for (const manager of sdkManagers) {
      manager.off('exit', onExit);
      manager.off('spawned', onSpawned);
    }
    facade.off('turn-end', onTurnEnd);
    facade.off('turn-start', onTurnStart);
  };
}
