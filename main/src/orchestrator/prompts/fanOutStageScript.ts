/**
 * fanOutStageScript.ts
 *
 * Pure, side-effect-free renderer that turns ONE inner step of a `FanOutSpec`
 * into a Claude Code **dynamic-workflow script** (`.claude/workflows/*.js`, the
 * `Workflow` tool's named-script surface).
 *
 * ── Stage-major, not item-major ──────────────────────────────────────────────
 * The obvious design — one script that walks each item through the WHOLE inner
 * chain — is wrong for cyboflow, and an adversarial review of the first plan
 * killed it. Three reasons, all structural:
 *
 *   1. SINGLE WRITER. Between inner steps the main session does entity work:
 *      it moves the lane's `current_step` (`cyboflow_update_sprint_task`),
 *      carries `attempt: <n>` on loopback, files findings, and makes ONE git
 *      commit per task on success. Workflow subagents cannot do any of it —
 *      every `cyboflow-<agent>` definition pins a `tools:` allowlist with no
 *      cyboflow MCP tools, deliberately ("Never writes cyboflow state"). One
 *      whole-chain call leaves no control point for the writes.
 *   2. HOST-OWNED STAGES. `visual-verify` has no subagent at all: the main
 *      session fires `cyboflow_request_verification` and PARKS the lane while an
 *      async external verdict drives it. See HOST_OWNED_INNER_IDS below.
 *   3. LIVE WAVE RE-RESOLUTION. Dispatch is dependency-ready and file-disjoint,
 *      and the ready set is re-read at every wave boundary. A frozen item list
 *      plus a concurrency cap does not reproduce that.
 *
 * So a script here fans exactly ONE stage across ONE already-chosen wave, and
 * returns structured per-item results. The top-level agent stays the DAG walker,
 * the single writer, and the human seam; it reconciles each stage's results
 * through the router chokepoints before dispatching the next one.
 *
 * ── Domain outcome vs promise outcome ────────────────────────────────────────
 * `code-review` and `task-verify` return NORMALLY while reporting failure
 * (`REVIEW: BLOCKING`, `VERDICT: FAIL`) — the programmatic controller carries
 * explicit parsers for exactly this. A stage result is therefore a SCHEMA'd
 * object with an explicit `outcome`, never a resolved/rejected promise.
 *
 * No DB, IPC, Electron, or fs imports — a pure string builder, mirroring
 * `fan-out-instructions.ts` (its prose sibling) so both stay testable in plain
 * Node/vitest. Fail-soft: an unrenderable stage yields `null`, never a throw.
 */
import type { FanOutInnerStep, FanOutSpec, WorkflowStep } from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Host-owned stages
// ---------------------------------------------------------------------------

/**
 * Inner-step ids the HOST (main session) owns end-to-end — never rendered as a
 * script, never delegated to a workflow subagent.
 *
 * `visual-verify` is the async visual merge-gate: the orchestrator calls
 * `cyboflow_request_verification` and parks the lane at `awaiting-verify`; the
 * central verification agent is deployed separately by the main-process
 * scheduler into an ISOLATED snapshot worktree with `$VERIFY_PORT` /
 * `$VERIFY_ARTIFACTS_DIR` / `$VERIFY_DRIVER` provided. Invoking
 * `cyboflow-visual-verify` as a bare workflow agent in the lane's shared
 * worktree would break both its isolation and its environment contract — and
 * because the step is `optional`, a failure there would be SILENTLY skipped,
 * turning the merge-gate into a no-op.
 *
 * KEEP IN SYNC with the `case 'visual-verify'` arm of
 * `fan-out-instructions.ts` — that switch is the prose authority for the same
 * fact. Matched on BOTH the step id and the agent id, because a custom flow may
 * rename one without the other.
 */
export const HOST_OWNED_INNER_IDS: ReadonlySet<string> = new Set(['visual-verify']);

/** True when this inner step must stay with the main session (see above). */
export function isHostOwnedInnerStep(inner: FanOutInnerStep): boolean {
  return HOST_OWNED_INNER_IDS.has(inner.id) || HOST_OWNED_INNER_IDS.has(inner.agent);
}

// ---------------------------------------------------------------------------
// Naming — the single source of truth for script identity
// ---------------------------------------------------------------------------

/** The namespace every generated cyboflow file carries (WorkflowBundleWriter's). */
const CYBOFLOW_PREFIX = 'cyboflow-';

/** Max characters per slug segment — keeps the composed basename well under any FS limit. */
const MAX_SEGMENT = 40;

/**
 * Reduce an arbitrary, user-editable identifier to a filename-safe segment.
 *
 * Load-bearing for SAFETY, not aesthetics: workflow names are validated only as
 * non-empty strings and step/agent ids are explicitly free-form, so a raw value
 * could carry `/`, `..`, quotes, backticks, or newlines — which would escape the
 * target directory when joined into a path, or break/inject the generated
 * JavaScript when interpolated. Everything outside `[a-z0-9-]` collapses to a
 * single dash. Returns `''` for input with no usable characters, which callers
 * treat as unrenderable.
 */
export function slugSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SEGMENT)
    .replace(/-+$/g, '');
}

/**
 * The LOGICAL bundle name for a stage script — i.e. WITHOUT the `cyboflow-`
 * prefix, because `WorkflowBundleWriter` prepends that itself when it writes.
 * Returns `null` when any segment slugs to empty.
 */
export function fanOutStageLogicalName(
  workflowName: string,
  outerStepId: string,
  innerStepId: string,
): string | null {
  const parts = [slugSegment(workflowName), slugSegment(outerStepId), slugSegment(innerStepId)];
  if (parts.some((p) => p.length === 0)) return null;
  return parts.join('-');
}

/**
 * The INVOCABLE workflow name — what `meta.name` carries, what the on-disk
 * basename is (`<name>.js`), and what the prompt passes to `Workflow({name})`.
 * Exactly `cyboflow-` + the logical name, so the three can never drift.
 */
export function fanOutStageWorkflowName(
  workflowName: string,
  outerStepId: string,
  innerStepId: string,
): string | null {
  const logical = fanOutStageLogicalName(workflowName, outerStepId, innerStepId);
  return logical === null ? null : `${CYBOFLOW_PREFIX}${logical}`;
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/**
 * Encode any value as a JavaScript literal via JSON.
 *
 * EVERY interpolated value in the emitted script goes through this — names,
 * descriptions, ids, agent types. Raw interpolation of a free-form id carrying a
 * quote, backtick, newline, or `${` would produce broken or injected source.
 * `</script` is not a concern here (this is never HTML), but line separators are
 * escaped by JSON.stringify already.
 */
function lit(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Human label for an inner step (its `name`, falling back to its id). */
function innerLabel(inner: FanOutInnerStep): string {
  return inner.name !== undefined && inner.name.trim().length > 0 ? inner.name : inner.id;
}

// ---------------------------------------------------------------------------
// The rendered script
// ---------------------------------------------------------------------------

/**
 * Render the dynamic-workflow script for ONE inner stage of a fan-out step.
 *
 * The emitted script takes the wave as `args` — an array of item objects the
 * top-level agent composes (`{ id, ref?, title?, brief?, expectedFiles?,
 * priorSummary? }`) — runs ONE `cyboflow-<agent>` subagent per item
 * concurrently, and returns `{ stage, results: [...] }` with one schema-validated
 * result per item. It performs NO cyboflow writes and reaches no MCP tool.
 *
 * @returns The script source, or `null` when the stage is host-owned, when the
 *   name cannot be slugged, or when the spec carries no inner steps.
 */
export function renderFanOutStageScript(
  workflowName: string,
  step: WorkflowStep,
  fanOut: FanOutSpec,
  inner: FanOutInnerStep,
): string | null {
  if (fanOut.inner.length === 0) return null;
  if (isHostOwnedInnerStep(inner)) return null;

  const name = fanOutStageWorkflowName(workflowName, step.id, inner.id);
  if (name === null) return null;

  const label = innerLabel(inner);
  const agentType = `${CYBOFLOW_PREFIX}${inner.agent}`;
  const description = `Fan the ${label} stage of ${step.id} across one wave of items; returns structured per-item results and writes no cyboflow state.`;

  // NOTE ON CONSTRUCTS: no `isolation` (lanes deliberately SHARE one worktree —
  // a per-agent worktree would break lane verification and the settled-tree test
  // run); no Date.now()/Math.random()/argless new Date() (they throw inside a
  // script body); `parallel` rather than `pipeline` because a stage-major
  // dispatch IS one barrier by construction — the caller already sized the wave
  // to the concurrency cap, so there is nothing to batch here.
  return `${'/'}* GENERATED by cyboflow (fanOutStageScript.ts) — do not edit. *${'/'}
export const meta = {
  name: ${lit(name)},
  description: ${lit(description)},
  phases: [{ title: ${lit(label)}, detail: ${lit(`one ${agentType} agent per item in the wave`)} }],
}

// One schema'd result per item. \`outcome\` is the DOMAIN verdict and is
// authoritative: an agent that finishes normally while reporting a blocking
// review or a failed verification MUST return 'blocked'/'failed' here. The
// top-level orchestrator reads these and performs every cyboflow write itself.
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string',
      enum: ['ok', 'blocked', 'failed', 'not_applicable'],
      description:
        "'ok' = stage succeeded. 'blocked' = finished but the work is not acceptable " +
        '(blocking review comments, failing verification, unmet acceptance criteria). ' +
        "'failed' = could not complete. 'not_applicable' = nothing to do for this item.",
    },
    summary: { type: 'string', description: 'What you did, or why it is blocked/failed. 1-4 sentences.' },
    filesTouched: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths written.' },
    findings: {
      type: 'array',
      description: 'Out-of-scope or minor issues worth human triage. Blocking issues belong in outcome/summary.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['severity', 'title'],
      },
    },
    visualTask: {
      type: 'string',
      description:
        'Verbatim JSON fence for the visual merge-gate when this stage produces one; omit otherwise. ' +
        'The orchestrator forwards it to cyboflow_request_verification — do not act on it yourself.',
    },
  },
  required: ['outcome', 'summary'],
}

const STAGE_ID = ${lit(inner.id)}
const AGENT_TYPE = ${lit(agentType)}
const STAGE_LABEL = ${lit(label)}

${'/'}** Compose the per-item prompt. \`item\` is supplied by the orchestrator. *${'/'}
function buildPrompt(item) {
  const lines = [
    'You are running the ' + STAGE_LABEL + ' stage for ONE item of a cyboflow fan-out.',
    '',
    'Item id: ' + String(item && item.id),
  ]
  if (item && item.ref) lines.push('Item ref: ' + String(item.ref))
  if (item && item.title) lines.push('Title: ' + String(item.title))
  if (item && item.brief) lines.push('', String(item.brief))
  if (item && item.expectedFiles && item.expectedFiles.length > 0) {
    lines.push('', 'Expected files: ' + item.expectedFiles.join(', '))
  }
  if (item && item.priorSummary) {
    lines.push('', 'Result of the previous stage for this item:', String(item.priorSummary))
  }
  lines.push(
    '',
    'Work ONLY on this item, in the shared worktree. Do NOT commit, do NOT touch',
    'cyboflow state, and do NOT start work belonging to another stage or item.',
    'Return the structured result: set outcome to the DOMAIN verdict (a blocking',
    'review or a failed check is "blocked", not "ok"), and list every file you wrote.',
  )
  return lines.join('\\n')
}

const items = Array.isArray(args) ? args.filter((it) => it && it.id !== undefined) : []
if (items.length === 0) {
  log('no items in this wave — nothing to dispatch')
  return { stage: STAGE_ID, results: [] }
}

log(STAGE_LABEL + ': dispatching ' + items.length + ' item(s)')

// The wave is already sized to the fan-out cap by the orchestrator, so this
// barrier is the whole point of a stage-major dispatch: every item's result is
// reconciled together before the next stage is chosen.
const settled = await parallel(
  items.map((item) => () =>
    agent(buildPrompt(item), {
      label: STAGE_ID + ':' + String(item.id),
      phase: STAGE_LABEL,
      schema: RESULT_SCHEMA,
      agentType: AGENT_TYPE,
    }).then((result) => ({ itemId: item.id, ...(result || {}) })),
  ),
)

// A null slot means the agent died or was skipped — surface it as a failed item
// rather than dropping it, so the orchestrator can loop it back or fail the lane.
const results = settled.map((entry, i) =>
  entry && entry.outcome
    ? entry
    : { itemId: items[i].id, outcome: 'failed', summary: 'agent produced no result' },
)

return { stage: STAGE_ID, results }
`;
}

/**
 * Render every scriptable stage of a resolved definition's fan-out steps.
 *
 * Returns one entry per rendered stage, keyed by the LOGICAL bundle name (the
 * writer adds the `cyboflow-` prefix). Host-owned and unslug-able stages are
 * skipped silently — they stay on the prose path.
 */
export function renderFanOutStageScripts(
  workflowName: string,
  steps: ReadonlyArray<WorkflowStep>,
): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = [];
  for (const step of steps) {
    const fanOut = step.fanOut;
    if (fanOut === undefined) continue;
    for (const inner of fanOut.inner) {
      const content = renderFanOutStageScript(workflowName, step, fanOut, inner);
      const logical = fanOutStageLogicalName(workflowName, step.id, inner.id);
      if (content === null || logical === null) continue;
      out.push({ name: logical, content });
    }
  }
  return out;
}
