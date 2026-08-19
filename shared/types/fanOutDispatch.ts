/**
 * Fan-out dispatch mode — HOW an orchestrated run executes a fan-out step's
 * inner chain.
 *
 * - `prose` — the orchestrator agent drives each lane itself via Agent-tool
 *   subagents, following the instruction block `fan-out-instructions.ts`
 *   renders. Today's behavior, and the floor.
 * - `workflow` — the orchestrator dispatches a BATCH of consecutive non-gated
 *   inner stages for ONE wave to a pre-installed Claude Code dynamic workflow
 *   (`.claude/workflows/cyboflow-*.js`, rendered by `fanOutStageScript.ts`),
 *   reads back structured per-item results, and performs every cyboflow write
 *   itself at the batch boundary.
 *
 *   LANE-MAJOR, not stage-major: the script runs
 *   `parallel(items.map(runItem))`, and each `runItem` walks its own item
 *   through the whole batch sequentially. Items run concurrently and no item
 *   waits on a sibling between stages — that absence of a per-stage barrier is
 *   where the speed comes from. The batch as a whole IS a barrier: it resolves
 *   only once every item has settled.
 *
 *   The chain is split at FIRM GATES (`FanOutInnerStep.firmGate`), which end a
 *   batch and stay with the orchestrator — that is how single-writer, the
 *   host-owned visual merge-gate, and live wave re-resolution all survive.
 *   `visual-verify` is the only firm gate in the built-in chains, and it is
 *   terminal there; `builtInFirmGatesAreTerminal.test.ts` pins that, because a
 *   MID-chain gate would fragment the chain into multiple batches and
 *   reintroduce a full cross-lane barrier at each split.
 *
 *   The deliberate trade: lane `current_step` does not tick per stage inside a
 *   batch. The script returns each item's full stage trail and the orchestrator
 *   backfills it when the batch returns. See `fanOutStageScript.ts` for the
 *   rendering contract and `FanOutInnerStep.firmGate` for the gate semantics.
 *
 * Lives in `shared/` rather than beside either AppConfig because BOTH the main
 * and frontend `AppConfig` declarations carry the field and must stay in parity
 * (docs/CODE-PATTERNS.md → IPC / type-parity rules).
 *
 * INTERACTIVE-ONLY in practice: the SDK substrate composes its prompt through
 * `workflowPromptReaderAdapter` and its spawn passes `prose` explicitly. The
 * install seam is substrate-shared, so the mode is threaded to it as an argument
 * rather than read from global config inside it — otherwise SDK worktrees would
 * accrue scripts nothing consumes.
 */

/** How a fan-out step's inner chain is executed. */
export type FanOutDispatch = 'prose' | 'workflow';

/** The floor: today's agent-driven prose behavior. */
export const DEFAULT_FAN_OUT_DISPATCH: FanOutDispatch = 'prose';

/** Runtime guard — config.json is user-editable, so reads are validated. */
export function isFanOutDispatch(value: unknown): value is FanOutDispatch {
  return value === 'prose' || value === 'workflow';
}
