/**
 * ompGateExtension — cyboflow's SOLE policy engine for OMP (oh-my-pi) tool calls.
 *
 * Loaded INSIDE the spawned `omp` process by its Bun runtime via
 * `-e <path>` (see `ompGatePath.ts` for how the path is resolved). It registers
 * a `tool_call` handler that applies cyboflow's permission predicate and, for
 * anything it cannot decide locally, blocks on the orchestrator socket for a
 * human verdict — the interactive-Claude shell-hook pattern
 * (`main/src/orchestrator/shellHooks/preToolUseShellHook.ts`) ported to OMP's
 * extension API, reusing that hook's wire protocol verbatim.
 *
 * WHY THIS EXISTS AT ALL (docs/proposals/omp-provider-integration.md §5.3):
 * OMP's own tool tiers are NEVER cyboflow's trust boundary. OMP's `write`
 * approval mode auto-approves every write-tier tool and classifies ALL MCP
 * tools as write-tier — far wider than cyboflow's `acceptEdits` allowance. So
 * cyboflow spawns OMP with `--approval-mode always-ask` and decides here.
 *
 * ===========================================================================
 * FAIL-CLOSED CONTRACT
 * ===========================================================================
 * Three independent layers, all verified in OMP v17.3.3 source (citations in
 * `ompGateTypes.ts`):
 *
 *  1. A handler THROW blocks the call. `ExtensionRunner.emitToolCall` runs each
 *     handler through `#runHandlerWithTimeout` with an `onFailure` that
 *     synthesizes `{ block: true, reason: 'Extension <path> failed: <message>' }`
 *     (runner.ts:1235-1270, 1099-1110). So every `throw` below is a BLOCK whose
 *     text reaches the model — never a silent pass.
 *  2. A `{ block: true }` return short-circuits the remaining handlers AND is
 *     evaluated BEFORE OMP's own approval prompt (wrapper.ts:201-235 precedes
 *     wrapper.ts:237-339; the model-issued path blocks even earlier, in
 *     agent-session.ts:3300-3333). A block therefore SUPPRESSES the prompt.
 *  3. If this module fails to load at all, OMP records the error and continues
 *     WITHOUT the gate (loader.ts:437-443 — load errors are collected, not
 *     fatal). That is why the load sentinel exists: no sentinel file ⇒ the
 *     manager refuses the session. Never infer "gate active" from a live
 *     process.
 *
 * ===========================================================================
 * !! OMP CAPS EVERY tool_call HANDLER AT 30 SECONDS !!
 * ===========================================================================
 * `EXTENSION_HANDLER_TIMEOUT_MS = 30_000` (runner.ts:84) is raced against the
 * handler by `raceHandlerWithTimeout` (runner.ts:192-227) and applied to
 * `tool_call` at runner.ts:1237. On expiry the handler is ABORTED and converted
 * to `{ block: true, reason: 'Extension <path> timed out after 30000ms' }`.
 * There is no env var, setting, or CLI flag that changes it — the only mutator
 * is `testSetExtensionHandlerTimeoutMs` (runner.ts:91-93), a test-only export
 * with no production callsite.
 *
 * MEASURED against omp v17.3.2: with a stub orchestrator that accepts the
 * approval connection and never answers, the turn ended 31.1s after the request
 * with exactly that block text. The model then RETRIED the tool call, paying a
 * second full 30s — so an unanswerable gate costs 30s per attempt, not once.
 *
 * CONSEQUENCE: a human approval that takes longer than 30s is auto-BLOCKED by
 * OMP. That is fail-closed (safe), but it means the blocking human gate this
 * module implements is only usable for sub-30s decisions. We deliberately do
 * NOT add a timeout of our own (a shorter deadline would only deny sooner, and
 * "human is slow" must never be confused with "orchestrator is down" — the
 * shell-hook lesson). Resolving this needs a change OUTSIDE this file: either
 * an upstream OMP knob for the tool_call budget, or a non-blocking gate shape
 * (block immediately with a "pending approval" reason and let the model retry
 * once the verdict lands). Recorded for the manager step.
 *
 * WHAT WE DO ABOUT IT: {@link HUMAN_DECISION_BUDGET_MS} — a 25s budget on the
 * socket wait, 5s inside OMP's cap. Expiring the budget ourselves buys three
 * things OMP's own expiry cannot: the orchestrator sees a real disconnect
 * instead of a zombie socket, the model gets an actionable sentence instead of
 * "Extension <path> timed out", and the run's logs distinguish "nobody answered
 * in time" from "the gate crashed". Budget expiry is a BLOCK, not a throw —
 * socket-liveness failures keep throwing, so the two stay distinguishable.
 *
 * SOCKET LEAK GUARD: any socket still in flight when the session ends (a
 * handler OMP abandoned before our budget fired) is tracked and destroyed on
 * `session_shutdown`, so the leak is bounded by the session, not the app.
 *
 * ===========================================================================
 * RUNTIME CONSTRAINTS
 * ===========================================================================
 * This file executes in OMP's Bun process. It therefore:
 *  - imports NOTHING from cyboflow's source tree (the sibling `ompGateTypes`
 *    import is `import type`, which erases at compile time);
 *  - uses only `node:`-namespace APIs Bun implements (`node:net`, `node:fs`);
 *  - avoids every Bun-only API, so the same module runs under plain Node in the
 *    unit tests.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';

import type {
  OmpExtensionApi,
  OmpGateApprovalResponse,
  OmpGateConfig,
  OmpGatePermissionMode,
  OmpGateSentinel,
  OmpToolCallEvent,
  OmpToolCallEventResult,
} from './ompGateTypes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Env var carrying the run the decisions are keyed by (workflow_runs.id). */
export const ENV_RUN_ID = 'CYBOFLOW_RUN_ID';
/** Env var carrying the orchestrator's Unix socket path. */
export const ENV_ORCH_SOCKET = 'CYBOFLOW_ORCH_SOCKET';
/** Env var carrying the JSON gate config (see {@link OmpGateConfig}). */
export const ENV_GATE_CONFIG = 'CYBOFLOW_OMP_GATE_CONFIG';
/** Env var carrying the load-sentinel file path. */
export const ENV_GATE_SENTINEL = 'CYBOFLOW_OMP_GATE_SENTINEL';

/**
 * OMP's subagent-dispatch tool (`tools/builtin-names.ts:19`). Denied outside
 * `dontAsk` until hook scope inside OMP subagents is verified — OMP's docs say
 * subagents run forced-yolo, and whether this extension's `tool_call` handler
 * is even installed in a subagent session is UNKNOWN.
 */
export const OMP_TASK_TOOL_NAME = 'task';

/**
 * Prefix of an MCP tool exposed by cyboflow's own `cyboflow` MCP server.
 *
 * `createMCPToolName('cyboflow', 'cyboflow_report_finding')` yields
 * `mcp__cyboflow_report_finding`: the server name is lowercased and sanitized,
 * then a redundant `<server>_` prefix on the tool name is stripped
 * (`mcp/tool-bridge.ts:335-358`).
 *
 * KNOWN LIMITATION (reported as a follow-up, not fixable inside this file): a
 * DIFFERENT MCP server whose sanitized name begins `cyboflow_` — e.g. one named
 * `cyboflow-extra`, which sanitizes to `cyboflow_extra` — produces tool names
 * that also start with this prefix and would be auto-allowed. OMP auto-imports
 * foreign MCP configs, so such a server is not purely hypothetical. The
 * available mitigation today is `disallowedTools` (rule 1), which is evaluated
 * BEFORE this rule.
 */
export const CYBOFLOW_MCP_TOOL_PREFIX = 'mcp__cyboflow_';

/**
 * How long we wait for a human verdict before giving up ourselves.
 *
 * OMP caps every `tool_call` handler at 30s
 * (`extensibility/extensions/runner.ts:84`, `EXTENSION_HANDLER_TIMEOUT_MS`,
 * raced at `runner.ts:192-227` — measured at 31.1s wall clock against omp
 * v17.3.2). If we simply waited, OMP would abort us at its own deadline and
 * report `Extension <path> timed out after 30000ms` to the model, leaving the
 * orchestrator holding a socket nobody will ever read.
 *
 * 25s leaves a 5s margin for the block to travel back through
 * `emitToolCall` before OMP's cap fires, so OUR reason is what the model sees.
 * Raising this above 30s would be inert; the OMP cap would simply win.
 */
export const HUMAN_DECISION_BUDGET_MS = 25_000;

/**
 * The most restrictive config: gate everything, allow nothing, deny subagents.
 * A missing or unparseable `CYBOFLOW_OMP_GATE_CONFIG` resolves to exactly this
 * — the gate never fails open.
 */
export const MOST_RESTRICTIVE_GATE_CONFIG: OmpGateConfig = {
  permissionMode: 'default',
  disallowedTools: [],
  autoAllowTools: [],
  editTools: [],
  allowRules: [],
  denyTaskTool: true,
  // Empty = "the manager did not tell us the exact names", which keeps rule 3
  // on its prefix fallback. There is nothing to tighten here: a config this
  // degraded means no cyboflow MCP server was wired for the session either.
  cyboflowMcpToolNames: [],
};

const PERMISSION_MODES: readonly OmpGatePermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
];

/** Shell control operators that separate independently-evaluated commands. */
const SHELL_SEPARATORS = ['&&', '||', ';', '|'] as const;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Diagnostics sink. Deliberately NOT OMP's `pi.logger`: binding to that would
 * pin one more upstream shape for no benefit. stderr of the `omp --mode rpc`
 * child is captured by the manager, and stdout is reserved for the NDJSON
 * protocol, so stderr is the correct channel.
 */
export interface OmpGateLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const stderrLogger: OmpGateLogger = {
  debug: (m: string) => void process.stderr.write(`[cyboflow-omp-gate] ${m}\n`),
  warn: (m: string) => void process.stderr.write(`[cyboflow-omp-gate] ${m}\n`),
  error: (m: string) => void process.stderr.write(`[cyboflow-omp-gate] ${m}\n`),
};

// ---------------------------------------------------------------------------
// Config parsing — defensive, never fails open
// ---------------------------------------------------------------------------

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function permissionMode(value: unknown): OmpGatePermissionMode | undefined {
  return typeof value === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as OmpGatePermissionMode)
    : undefined;
}

/**
 * Parse `CYBOFLOW_OMP_GATE_CONFIG`.
 *
 * Missing, non-JSON, or non-object input yields {@link MOST_RESTRICTIVE_GATE_CONFIG}.
 * A parseable object with an individually malformed field falls back to the
 * restrictive default FOR THAT FIELD ONLY, so one bad key cannot quietly widen
 * (or needlessly narrow) the rest of the policy.
 */
export function parseGateConfig(raw: string | undefined, logger: OmpGateLogger): OmpGateConfig {
  if (raw === undefined || raw.trim().length === 0) {
    logger.warn(`${ENV_GATE_CONFIG} is unset — falling back to the most restrictive policy`);
    return { ...MOST_RESTRICTIVE_GATE_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      `${ENV_GATE_CONFIG} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — ` +
        'falling back to the most restrictive policy',
    );
    return { ...MOST_RESTRICTIVE_GATE_CONFIG };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.error(`${ENV_GATE_CONFIG} is not a JSON object — falling back to the most restrictive policy`);
    return { ...MOST_RESTRICTIVE_GATE_CONFIG };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    permissionMode: permissionMode(obj['permissionMode']) ?? MOST_RESTRICTIVE_GATE_CONFIG.permissionMode,
    disallowedTools: stringArray(obj['disallowedTools']) ?? [],
    autoAllowTools: stringArray(obj['autoAllowTools']) ?? [],
    editTools: stringArray(obj['editTools']) ?? [],
    allowRules: stringArray(obj['allowRules']) ?? [],
    // Anything that is not an explicit `false` denies the subagent tool.
    denyTaskTool: obj['denyTaskTool'] === false ? false : true,
    cyboflowMcpToolNames: stringArray(obj['cyboflowMcpToolNames']) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Permission-rule matching (the honored subset of cyboflow's rule grammar)
// ---------------------------------------------------------------------------

/** A parsed permission rule: `ToolName` or `ToolName(content)`. */
export interface ParsedGateRule {
  toolName: string;
  content?: string;
}

/**
 * Parse a raw rule string into `{ toolName, content }` — a verbatim port of
 * `main/src/orchestrator/permissionRules.ts:67-81` (it cannot be imported:
 * this module must not reach into cyboflow's source tree).
 */
export function parsePermissionRule(rule: string): ParsedGateRule | null {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return null;

  const open = trimmed.indexOf('(');
  if (open === -1) return { toolName: trimmed };
  if (!trimmed.endsWith(')')) return null;

  const toolName = trimmed.slice(0, open).trim();
  const content = trimmed.slice(open + 1, -1).trim();
  if (toolName.length === 0) return null;
  return content.length === 0 ? { toolName } : { toolName, content };
}

/** Split a command on unquoted shell separators. Port of permissionRules.ts:84-125. */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === SHELL_SEPARATORS[0] || two === SHELL_SEPARATORS[1]) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === SHELL_SEPARATORS[2] || ch === SHELL_SEPARATORS[3]) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** True if a command segment contains command substitution we refuse to trust. */
export function hasCommandSubstitution(segment: string): boolean {
  return segment.includes('$(') || segment.includes('`');
}

/** `git add:*` → prefix match; `done` → exact match. Port of permissionRules.ts:138-146. */
function matchBashSpecifier(content: string, segment: string): boolean {
  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2).trim();
    if (prefix.length === 0) return false; // refuse to match-all
    return segment === prefix || segment.startsWith(prefix + ' ');
  }
  return segment === content;
}

/**
 * True if the `(toolName, input)` pair matches at least one allow rule.
 *
 * HONORED SUBSET, and the two deliberate divergences from
 * `permissionRules.ts:177-208`:
 *
 *  1. Tool names are compared CASE-INSENSITIVELY. cyboflow's rules are written
 *     against Claude's PascalCase tool names (`Bash`, `Read`, `Write`) while
 *     OMP's canonical names are lowercase (`bash`, `read`, `write`,
 *     `tools/builtin-names.ts:1-31`). Without this, no rule would ever match an
 *     OMP call and `auto` mode would silently degrade to `default`.
 *  2. `WebFetch(domain:X)` is NOT honored. OMP has no `WebFetch` tool (it ships
 *     `fetch` and `web_search`), and inventing a URL-field mapping would be
 *     policy we cannot cite. It falls into the conservative default below.
 *
 * Everything else mirrors the original: a bare tool-name rule grants the whole
 * tool; `Bash(...)` specifiers must match EVERY segment of a compound command
 * and any segment with command substitution fails; every other specifier kind
 * (path globs in particular) does NOT auto-allow.
 */
export function matchesAllowRules(
  toolName: string,
  input: Record<string, unknown>,
  rules: readonly string[],
): boolean {
  const lowered = toolName.toLowerCase();
  const forTool = rules
    .map(parsePermissionRule)
    .filter((r): r is ParsedGateRule => r !== null)
    .filter((r) => r.toolName.toLowerCase() === lowered);

  if (forTool.length === 0) return false;

  // A bare tool-name rule grants the whole tool.
  if (forTool.some((r) => r.content === undefined)) return true;

  if (lowered === 'bash') {
    const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
    if (command.length === 0) return false;
    const contents = forTool.map((r) => r.content).filter((c): c is string => c !== undefined);
    const segments = splitShellSegments(command);
    if (segments.length === 0) return false;
    return segments.every(
      (segment) =>
        !hasCommandSubstitution(segment) &&
        contents.some((content) => matchBashSpecifier(content, segment)),
    );
  }

  // Unsupported specifier kind (path globs, domain:) — never auto-allow.
  return false;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Why a call was allowed locally — carried for the debug log, not the model. */
export type OmpGateAllowRule =
  | 'cyboflow-mcp'
  | 'dont-ask'
  | 'auto-allow-tool'
  | 'edit-tool'
  | 'allow-rule';

export type OmpGateDecision =
  | { kind: 'allow'; rule: OmpGateAllowRule }
  | { kind: 'block'; reason: string }
  | { kind: 'ask' };

/**
 * True when the tool is served by cyboflow's own MCP server.
 *
 * Two modes, and the exact one is strictly preferred:
 *  - `exactNames` non-empty → EXACT membership only. The prefix is not
 *    consulted at all, so a foreign server whose sanitized name starts
 *    `cyboflow_` cannot slip through.
 *  - `exactNames` absent/empty → the {@link CYBOFLOW_MCP_TOOL_PREFIX} fallback,
 *    with the spoofing caveat documented on that constant.
 */
export function isCyboflowMcpTool(toolName: string, exactNames?: readonly string[]): boolean {
  if (exactNames !== undefined && exactNames.length > 0) {
    return exactNames.includes(toolName);
  }
  return toolName.startsWith(CYBOFLOW_MCP_TOOL_PREFIX);
}

/**
 * Apply cyboflow's predicate to one tool call. Pure — the socket round-trip
 * lives in {@link requestSocketDecision}, driven by an `'ask'` result.
 *
 * Rule order is load-bearing:
 *  1. `disallowedTools` — refused in EVERY mode, `dontAsk` included.
 *  2. OMP's `task` subagent tool when `denyTaskTool` — likewise mode-independent.
 *  3. cyboflow's own MCP tools — always allowed (our tools, our server).
 *  4. `dontAsk` — allow (log-only), rules 1-2 having already applied.
 *  5. the mode-scoped allowlists.
 *  6. otherwise: ask the human.
 */
export function decideToolCall(
  event: Pick<OmpToolCallEvent, 'toolName' | 'input'>,
  config: OmpGateConfig,
): OmpGateDecision {
  const { toolName, input } = event;

  // 1. Explicitly disallowed — mode-independent.
  if (config.disallowedTools.includes(toolName)) {
    return {
      kind: 'block',
      reason:
        `cyboflow blocked \`${toolName}\`: it is listed in this run's disallowedTools. ` +
        'Use a different tool, or ask the user to change the run configuration.',
    };
  }

  // 2. Subagent dispatch — mode-independent while hook scope inside OMP
  //    subagents is unverified.
  if (toolName.toLowerCase() === OMP_TASK_TOOL_NAME && config.denyTaskTool) {
    return {
      kind: 'block',
      reason:
        `cyboflow blocked \`${toolName}\`: subagent hook scope is unverified, so cyboflow ` +
        'cannot gate tool calls made inside an OMP subagent. Do the work in this session.',
    };
  }

  // 3. cyboflow's own MCP tools.
  if (isCyboflowMcpTool(toolName, config.cyboflowMcpToolNames)) {
    return { kind: 'allow', rule: 'cyboflow-mcp' };
  }

  // 4. dontAsk — log-only.
  if (config.permissionMode === 'dontAsk') {
    return { kind: 'allow', rule: 'dont-ask' };
  }

  // 5. Mode-scoped allowlists.
  if (config.autoAllowTools.includes(toolName)) {
    return { kind: 'allow', rule: 'auto-allow-tool' };
  }
  if (
    (config.permissionMode === 'acceptEdits' || config.permissionMode === 'auto') &&
    config.editTools.includes(toolName)
  ) {
    return { kind: 'allow', rule: 'edit-tool' };
  }
  if (config.permissionMode === 'auto' && matchesAllowRules(toolName, input, config.allowRules)) {
    return { kind: 'allow', rule: 'allow-rule' };
  }

  // 6. Undecidable locally.
  return { kind: 'ask' };
}

// ---------------------------------------------------------------------------
// The orchestrator socket round-trip
// ---------------------------------------------------------------------------

/**
 * A verdict read off the orchestrator socket.
 *
 * `'timeout'` is NOT an error: the orchestrator was reachable and the request
 * was delivered, but no human answered inside {@link HUMAN_DECISION_BUDGET_MS}.
 * It resolves (as a block upstream) rather than rejecting, precisely so it stays
 * distinguishable from an orchestrator-down failure, which throws.
 */
export interface OmpGateSocketVerdict {
  decision: 'allow' | 'deny' | 'timeout';
  reason?: string;
}

/** Socket factory, injectable so tests can drive a stub. */
export type OmpGateConnect = (socketPath: string) => net.Socket;

export interface OmpGateSocketOptions {
  socketPath: string;
  runId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  logger: OmpGateLogger;
  connect?: OmpGateConnect;
  /** Registry of live sockets, destroyed on `session_shutdown`. */
  inFlight?: Set<net.Socket>;
  /** Human-decision budget; defaults to {@link HUMAN_DECISION_BUDGET_MS}. */
  budgetMs?: number;
}

/**
 * Ask the orchestrator and block until it answers.
 *
 * REJECTS (which OMP converts into a block — see this file's header, layer 1)
 * on every LIVENESS failure: connection error, close before a verdict, an
 * `ok:false` frame, or a correlated frame carrying no recognizable decision.
 *
 * RESOLVES with `'timeout'` when the orchestrator stayed connected but no human
 * answered within the budget. The socket is DESTROYED rather than ended so the
 * orchestrator observes a disconnect and can settle its own pending approval,
 * instead of holding a socket whose reader is gone.
 *
 * The reject/resolve split is the whole point: "orchestrator is down" and
 * "nobody answered yet" are different failures and must stay separable — the
 * invariant preToolUseShellHook.ts:1-40 establishes. What has changed since
 * that hook is only that we can no longer wait forever, because OMP kills the
 * handler at 30s (see this file's header).
 */
export function requestSocketDecision(opts: OmpGateSocketOptions): Promise<OmpGateSocketVerdict> {
  const { socketPath, runId, toolName, toolInput, logger } = opts;
  const connect = opts.connect ?? ((p: string) => net.createConnection(p));

  const requestId = `omp-gate-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  return new Promise<OmpGateSocketVerdict>((resolve, reject) => {
    let settled = false;
    const socket = connect(socketPath);
    opts.inFlight?.add(socket);

    /**
     * @param close 'destroy' on budget expiry — an abrupt disconnect is the
     *   signal that tells the orchestrator to stop holding this approval open.
     *   'end' everywhere else, which is the graceful half-close.
     */
    const settle = (fn: () => void, close: 'end' | 'destroy' = 'end'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      opts.inFlight?.delete(socket);
      try {
        if (close === 'destroy') socket.destroy();
        else socket.end();
      } catch {
        // best-effort close
      }
      fn();
    };

    const budgetMs = opts.budgetMs ?? HUMAN_DECISION_BUDGET_MS;
    const budgetTimer = setTimeout(() => {
      logger.warn(
        `no decision for \`${toolName}\` within ${budgetMs}ms — blocking (OMP would abort us at 30s regardless)`,
      );
      settle(() => resolve({ decision: 'timeout' }), 'destroy');
    }, budgetMs);
    // Never hold the process open on this timer alone.
    budgetTimer.unref?.();

    socket.on('connect', () => {
      logger.debug(`connected to the orchestrator for \`${toolName}\` (run ${runId})`);
      socket.write(
        JSON.stringify({
          type: 'shell-approval-request',
          requestId,
          runId,
          toolName,
          toolInput,
        }) + '\n',
      );
    });

    // Rolling receive buffer — a stream socket can split one JSON frame across
    // 'data' events or batch several into one.
    let recvBuffer = '';
    socket.on('data', (buf: Buffer) => {
      recvBuffer += buf.toString('utf8');
      let nl: number;
      while ((nl = recvBuffer.indexOf('\n')) !== -1) {
        const raw = recvBuffer.slice(0, nl).trim();
        recvBuffer = recvBuffer.slice(nl + 1);
        if (raw.length === 0) continue;

        let msg: OmpGateApprovalResponse;
        try {
          msg = JSON.parse(raw) as OmpGateApprovalResponse;
        } catch {
          // A stray unparseable frame must not kill the gate; keep reading.
          logger.warn('ignored an unparseable frame from the orchestrator');
          continue;
        }
        if (msg.requestId !== requestId) continue;

        const verdict = msg.ok === true ? msg.data?.permissionDecision : undefined;
        if (verdict === 'allow' || verdict === 'deny') {
          const reason = msg.data?.permissionDecisionReason;
          settle(() => resolve(reason === undefined ? { decision: verdict } : { decision: verdict, reason }));
          return;
        }
        settle(() =>
          reject(
            new Error(
              'cyboflow orchestrator returned a malformed approval verdict — failing closed',
            ),
          ),
        );
        return;
      }
    });

    socket.on('error', (err: Error) => {
      settle(() =>
        reject(new Error(`cyboflow orchestrator unreachable (${err.message}) — failing closed`)),
      );
    });
    socket.on('close', () => {
      settle(() =>
        reject(
          new Error('cyboflow orchestrator closed the connection before a decision — failing closed'),
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// The load sentinel
// ---------------------------------------------------------------------------

/**
 * Stamp the load sentinel — the manager's fail-closed handshake. Its ABSENCE is
 * the signal (no sentinel ⇒ the gate never loaded ⇒ refuse the session), so a
 * failed write must leave no file behind rather than write a partial one.
 *
 * @returns true when the sentinel now exists on disk.
 */
export function writeGateSentinel(
  sentinelPath: string | undefined,
  runId: string,
  logger: OmpGateLogger,
  writeFile: (p: string, data: string) => void = (p, data) => fs.writeFileSync(p, data, 'utf8'),
): boolean {
  if (sentinelPath === undefined || sentinelPath.trim().length === 0) {
    logger.warn(`${ENV_GATE_SENTINEL} is unset — the manager cannot confirm the gate loaded`);
    return false;
  }
  const sentinel: OmpGateSentinel = {
    loadedAt: new Date().toISOString(),
    runId,
    pid: process.pid,
  };
  try {
    writeFile(sentinelPath, JSON.stringify(sentinel));
    return true;
  } catch (err) {
    logger.error(
      `failed to write the load sentinel at ${sentinelPath} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Handler assembly
// ---------------------------------------------------------------------------

export interface OmpGateRuntime {
  config: OmpGateConfig;
  runId: string;
  socketPath: string | undefined;
  logger: OmpGateLogger;
  connect?: OmpGateConnect;
  inFlight: Set<net.Socket>;
  /** Human-decision budget override; production leaves it unset. */
  budgetMs?: number;
}

/**
 * Build the `tool_call` handler for a resolved runtime.
 *
 * Returning `undefined` means "no opinion" — OMP proceeds to its own approval
 * gate, which cyboflow's spawn keeps at `always-ask`; the `ompApprovalBridge`
 * auto-approves the now-redundant prompt for calls this gate passed
 * (docs/proposals §5.3). Returning `{ block, reason }` stops the call before
 * that prompt is ever raised.
 */
export function createToolCallHandler(
  runtime: OmpGateRuntime,
): (event: OmpToolCallEvent) => Promise<OmpToolCallEventResult | undefined> {
  return async (event: OmpToolCallEvent): Promise<OmpToolCallEventResult | undefined> => {
    const { config, logger } = runtime;
    const decision = decideToolCall(event, config);

    if (decision.kind === 'block') {
      logger.debug(`blocked \`${event.toolName}\`: ${decision.reason}`);
      return { block: true, reason: decision.reason };
    }
    if (decision.kind === 'allow') {
      logger.debug(`allowed \`${event.toolName}\` (${decision.rule})`);
      return undefined;
    }

    // Undecidable locally — ask the human. A missing socket path means cyboflow
    // never wired the gate; there is nobody to ask, so fail closed by throwing
    // (OMP turns the throw into a block, per this file's header).
    if (runtime.socketPath === undefined || runtime.socketPath.trim().length === 0) {
      throw new Error(
        `cyboflow cannot gate \`${event.toolName}\`: ${ENV_ORCH_SOCKET} is unset — failing closed`,
      );
    }

    const verdict = await requestSocketDecision({
      socketPath: runtime.socketPath,
      runId: runtime.runId,
      toolName: event.toolName,
      toolInput: event.input,
      logger,
      ...(runtime.connect ? { connect: runtime.connect } : {}),
      ...(runtime.budgetMs !== undefined ? { budgetMs: runtime.budgetMs } : {}),
      inFlight: runtime.inFlight,
    });

    if (verdict.decision === 'allow') {
      logger.debug(`allowed \`${event.toolName}\` (human approval)`);
      return undefined;
    }
    if (verdict.decision === 'timeout') {
      return {
        block: true,
        reason:
          `cyboflow surfaced \`${event.toolName}\` to the human for approval, but no decision ` +
          `arrived within ${Math.round(HUMAN_DECISION_BUDGET_MS / 1000)}s (OMP caps gate handlers ` +
          'at 30s, so cyboflow cannot wait longer). The human can approve the request and ask you ' +
          'to retry, or switch this session\'s permission mode.',
      };
    }
    return {
      block: true,
      reason:
        verdict.reason !== undefined && verdict.reason.length > 0
          ? `cyboflow denied \`${event.toolName}\`: ${verdict.reason}`
          : `cyboflow denied \`${event.toolName}\`.`,
    };
  };
}

/** Resolve the runtime from a process environment. Exported for tests. */
export function resolveGateRuntime(
  env: NodeJS.ProcessEnv,
  logger: OmpGateLogger = stderrLogger,
): OmpGateRuntime {
  return {
    config: parseGateConfig(env[ENV_GATE_CONFIG], logger),
    runId: env[ENV_RUN_ID] ?? '',
    socketPath: env[ENV_ORCH_SOCKET],
    logger,
    inFlight: new Set<net.Socket>(),
  };
}

// ---------------------------------------------------------------------------
// The extension factory (OMP's default export contract)
// ---------------------------------------------------------------------------

/**
 * OMP's `-e` entry point: a default-exported factory run at import time
 * (`extensibility/extensions/loader.ts:55-59`).
 *
 * Handler registration happens FIRST and the sentinel is written second, so a
 * sentinel failure can never leave a loaded-but-ungated session: either the
 * gate is installed and the sentinel proves it, or the sentinel is missing and
 * the manager refuses the session.
 *
 * Only registration is legal during load — runtime action methods throw
 * `ExtensionRuntimeNotInitializedError` (`docs/extensions.md:62-66`). Writing a
 * file is not such an action.
 */
export default function cyboflowOmpGate(pi: OmpExtensionApi): void {
  const logger = stderrLogger;
  const runtime = resolveGateRuntime(process.env, logger);

  pi.setLabel?.('cyboflow gate');
  pi.on('tool_call', createToolCallHandler(runtime));

  // Destroy any approval socket still blocked when the session ends. OMP may
  // have abandoned the handler at its 30s cap while the orchestrator still
  // holds the connection open; without this the socket outlives the session.
  pi.on('session_shutdown', () => {
    for (const socket of runtime.inFlight) {
      try {
        socket.destroy();
      } catch {
        // best-effort teardown
      }
    }
    runtime.inFlight.clear();
  });

  writeGateSentinel(process.env[ENV_GATE_SENTINEL], runtime.runId, logger);
}
