/**
 * Fan-out dispatch mode — HOW an orchestrated run executes a fan-out step's
 * inner chain.
 *
 * - `prose` — the orchestrator agent drives each lane itself via Agent-tool
 *   subagents, following the instruction block `fan-out-instructions.ts`
 *   renders. Today's behavior, and the floor.
 * - `workflow` — the orchestrator dispatches ONE inner stage of ONE wave at a
 *   time to a pre-installed Claude Code dynamic workflow
 *   (`.claude/workflows/cyboflow-*.js`, rendered by `fanOutStageScript.ts`),
 *   reads back structured per-item results, and performs every cyboflow write
 *   itself between stages. Stage-major, so single-writer, the host-owned visual
 *   merge-gate, and live wave re-resolution all survive.
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
