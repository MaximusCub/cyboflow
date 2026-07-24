/**
 * VerificationAgentRunner — deploys the workflow-defined `visual-verify` agent
 * for ONE verification request (docs/proposals/verification-agent-redesign.md
 * §5.4). It is the replacement for the capture-backend + VLM-judge core: instead
 * of the scheduler capturing a screenshot and a VLM judging it, the runner hands
 * a provisioned environment to a single Claude SDK session that BUILDS, SERVES,
 * DRIVES, and JUDGES a composed `VerificationTaskV1` itself, returning a
 * structured `VerificationReportV1`.
 *
 * Electron-free by construction (mirrors the backends / vlmJudge): every
 * side-effecting collaborator is INJECTED — the SDK boundary (`query`), the
 * effective-agent + model resolvers, snapshot provisioning, git checks, fs
 * probes, and the driver-teardown seams all have real defaults but are faked in
 * the unit test, so the module under test imports NO `@anthropic-ai/*` SDK,
 * `electron`, or `better-sqlite3`. The scheduler owns the leases, the per-request
 * deadline, the budget, and persisting the terminal status + `report_json`; this
 * module owns steps 1-6 of §5.4 (resolve → provision → deploy → validate →
 * mutation-check → teardown) and returns the mapped verdict.
 *
 * Provider dispatch (§5.4 step 1): the resolved agent's runtime picks the query
 * seam. An explicit `runtime: 'codex-sdk'` pin — or an unpinned agent inheriting a
 * Codex-provider run — routes to the injected `codexQuery`; everything else routes
 * to the Claude `query`. On the Claude branch model resolution is
 * Claude-namespace-only (a pinned alias → concrete, else the Claude-provider run
 * model, else a validated Claude default). On the Codex branch the model is
 * `agent.codexModel`, else the Codex-provider run model, else the account default
 * the query resolves. When a request routes to Codex but no `codexQuery` dep is
 * wired, it maps to the fail-open `skipped` bucket — never a silent Claude fallback.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, chmod, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { LoggerLike } from '../types';
import { emitSeamError } from '../telemetrySink';
import {
  type VerificationTaskV1,
  type VerificationReportV1,
  type VerdictV1,
  type RequestStatus,
  normalizeVerificationReportV1,
} from '../../../../shared/types/visualVerification';
import { verifyTranscriptFileName } from '../../../../shared/types/artifacts';
import type { AgentModelAlias } from '../../../../shared/types/agents';
import { providerForRuntime, type AgentProvider } from '../../../../shared/types/agentRuntime';
import { normalizeAgentModelSelection } from '../../../../shared/types/agentModels';
import type { EffectiveAgent } from '../agents/effectiveAgents';
import {
  provisionSnapshot,
  SnapshotProvisionError,
  type SnapshotProvision,
  type ProvisionSnapshotOptions,
} from './snapshotProvisioner';
import { pidFilePath } from './driver/driverCore';

const execFileAsync = promisify(execFile);

/** The hard tool ceiling the agent runs under — config can NEVER widen it (§5.4 step 3). */
export const VERIFY_AGENT_ALLOWED_TOOLS: readonly string[] = ['Bash', 'Read', 'Grep', 'Glob'] as const;

/** Subdir under VERIFY_ARTIFACTS_DIR holding the driver wrapper script (co-located with the driver's pid file). */
const DRIVER_STATE_DIR = '.driver';
/** The wrapper script the agent invokes as `$VERIFY_DRIVER`. */
const DRIVER_SCRIPT_NAME = 'verify-driver.sh';

// ---------------------------------------------------------------------------
// SDK-query seam (the module under test injects a fake — NO SDK import here)
// ---------------------------------------------------------------------------

/** Args the runner hands the (production or fake) structured SDK query. */
export interface VerificationAgentQueryArgs {
  /** The composed user prompt (task JSON + framing). */
  prompt: string;
  /** The full custom system prompt (workflow instructions + immutable harness contract). */
  systemPrompt: string;
  /** cwd of the deployed session — the provisioned snapshot worktree (or the live worktree in fallback). */
  cwd: string;
  /** The resolved Claude model id (namespace-checked upstream). */
  model?: string;
  /** The hard tool ceiling — {@link VERIFY_AGENT_ALLOWED_TOOLS}. */
  allowedTools: string[];
  /** The VERIFY_* env the agent's Bash needs (merged onto process.env by the production impl). */
  env: Record<string, string>;
  /**
   * The scheduler's effective per-request deadline (adversarial-review fix). When
   * present the query uses THIS for its internal deadline instead of its own
   * default — so a task-supplied `timeoutMs` above the query default is honored
   * rather than silently cut to 10 minutes.
   */
  timeoutMs?: number;
  /** Deadline/cancel signal. */
  signal?: AbortSignal;
}

/**
 * The result of one deployed SDK session: the last `structured_output` (or null
 * on drain-without-result) PLUS the harness-accumulated transcript (markdown),
 * captured so a wrong verdict is auditable (verifier-transcript capture).
 */
export interface VerificationAgentQueryOutcome {
  /** The last structured_output (or null on drain-without-result). */
  structured: unknown;
  /** Harness-accumulated transcript of the session (markdown), or null when nothing accumulated. */
  transcript: string | null;
}

/**
 * The SDK boundary: deploy ONE structured session and return the outcome
 * (structured output + transcript). The production impl (verificationAgentQuery.ts)
 * bakes in the hermetic sandbox (`settingSources: []`, `strictMcpConfig`,
 * `mcpServers: {}`, `outputFormat: json_schema`); this seam carries only what the
 * runner controls so the runner stays SDK-free + fakeable.
 */
export interface VerificationAgentQueryFn {
  (args: VerificationAgentQueryArgs): Promise<VerificationAgentQueryOutcome>;
}

/**
 * Thrown by the production query on failure/timeout so a partial transcript
 * survives the throw (verifier-transcript capture) — the runner's catch writes it
 * fail-soft before mapping the error to the usual skipped/timeout result.
 */
export class VerificationAgentQueryError extends Error {
  readonly transcript: string | null;
  /**
   * True when the query's INTERNAL deadline fired (adversarial-review fix): the
   * runner maps a timed-out deploy to the terminal `timeout` status instead of the
   * fail-open `skipped` bucket, so a deadline expiry is not misreported as an
   * infra skip. A caller-signal abort is classified by the runner's own
   * `controller.signal.aborted` check, not this flag.
   */
  readonly timedOut: boolean;
  constructor(message: string, transcript: string | null, timedOut = false) {
    super(message);
    this.name = 'VerificationAgentQueryError';
    this.transcript = transcript;
    this.timedOut = timedOut;
  }
}

// ---------------------------------------------------------------------------
// Agent resolution (injected thunk)
// ---------------------------------------------------------------------------

/**
 * The resolved workflow-defined `visual-verify` agent plus the run's
 * provider/model — everything the runner needs to apply the Claude-namespace
 * model rule (§5.4 step 1). Built at index.ts over `resolveRunEffectiveAgents`.
 */
export interface ResolvedVerifyAgent {
  agent: EffectiveAgent;
  runProvider: AgentProvider;
  runModel: string | null;
}

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

/** One verification the runner deploys the agent for. */
export interface VerificationAgentRequest {
  runId: string;
  requestId: string;
  projectId: number;
  /** The composed task the agent drives + judges. */
  task: VerificationTaskV1;
  /** The run's live shared worktree — the snapshot source and the dirty-fallback cwd. */
  runWorktreePath: string;
  /** The git sha to snapshot at (§5.5); null ⇒ dirty-worktree fallback. */
  snapshotSha: string | null;
  /** VERIFY_ARTIFACTS_DIR — where the agent writes screenshots. */
  artifactsDir: string;
  /** The leased dev-server port, exported as VERIFY_PORT only when the task implies a server; else null. */
  verifyPort: number | null;
  /** The CDP port for the bundled driver (VERIFY_DRIVER_PORT) — always present. */
  verifyDriverPort: number;
  /**
   * The scheduler's effective per-request deadline in ms (`agentDeadlineMs`:
   * task.timeoutMs capped by the ceiling, else the default). Threaded into the
   * query so its internal deadline matches — absent (older callers/fakes) the
   * query falls back to its own default.
   */
  timeoutMs?: number;
  /** The scheduler's per-request deadline/cancel signal. */
  signal: AbortSignal;
}

/** The mapped verdict the scheduler persists (§5.7). */
export interface VerificationAgentRunResult {
  status: Extract<RequestStatus, 'passed' | 'failed' | 'skipped' | 'timeout' | 'low_confidence'>;
  /** Present for a judged outcome (passed/failed/low_confidence); build/launch failures are verdict-less. */
  verdict?: VerdictV1;
  /** The normalized report (persisted as report_json), when one was produced + validated. */
  report?: VerificationReportV1;
  /** Concrete reason for skipped/timeout, or the build/launch log excerpt for a build failure. */
  errorMessage?: string;
  /** The screenshot fileNames for the artifact payload. */
  fileNames: string[];
}

/**
 * The narrow shape the scheduler injects + calls (mirrors how the capture backends
 * are injected as an interface, not the concrete class). Keeping the scheduler dep
 * an interface lets tests pass a plain stub — {@link VerificationAgentRunner} has a
 * private field, so a class type would be nominal + un-stubbable.
 */
export interface VerificationAgentRunnerLike {
  run(req: VerificationAgentRequest): Promise<VerificationAgentRunResult>;
}

// ---------------------------------------------------------------------------
// Injected deps
// ---------------------------------------------------------------------------

export interface VerificationAgentRunnerDeps {
  query: VerificationAgentQueryFn;
  /**
   * The Codex-runtime query seam, dispatched to when the resolved agent's provider
   * is `codex` (a `runtime: 'codex-sdk'` pin or an unpinned agent inheriting a
   * Codex-provider run). ABSENT ⇒ a codex-routed request maps to the fail-open
   * `skipped` bucket with an actionable message — never a silent Claude fallback.
   */
  codexQuery?: VerificationAgentQueryFn;
  resolveVerifyAgent: (runId: string) => ResolvedVerifyAgent | undefined;
  /** Alias→concrete Claude model id (wraps `bareModelId` at index.ts); null when unresolvable. */
  resolveClaudeAlias: (alias: AgentModelAlias) => string | null;
  /** The validated Claude fallback model (reuse the vlm/eval default source). */
  claudeDefaultModel: string;
  /** Resolve the node executable for the driver wrapper (wraps `findNodeExecutable`). */
  resolveNode: () => Promise<string>;
  /** Absolute path to the compiled driverCli.js (resolved at index.ts for dev + asar). */
  driverCliPath: string;
  logger?: LoggerLike;
  // -- seams (real defaults; faked in tests) --
  provision?: (opts: ProvisionSnapshotOptions) => Promise<SnapshotProvision>;
  /** `git diff --quiet HEAD` on the snapshot — true when the verifier mutated tracked sources. */
  checkSnapshotMutated?: (worktreePath: string) => Promise<boolean>;
  fileExists?: (absPath: string) => Promise<boolean>;
  /** Write the `$VERIFY_DRIVER` wrapper script; returns its absolute path. */
  writeDriverScript?: (artifactsDir: string, nodePath: string, driverCliPath: string) => Promise<string>;
  /** Best-effort `$VERIFY_DRIVER stop`. */
  stopDriver?: (driverScriptPath: string, env: Record<string, string>) => Promise<void>;
  /** Best-effort SIGKILL of the driver's recorded browser pid, if still alive. */
  reapBrowser?: (artifactsDir: string) => void;
  /**
   * Write the harness-captured transcript to `<artifactsDir>/<fileName>` (creating
   * the directory as needed). Injected so tests can assert the call without
   * touching disk; a failure here is ALWAYS fail-soft (logged, never changes the
   * verdict path — see {@link VerificationAgentRunner.run}).
   */
  writeTranscript?: (artifactsDir: string, fileName: string, content: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Immutable harness contract (config shapes persona/judgment, NEVER the sandbox)
// ---------------------------------------------------------------------------

/**
 * The head of the harness contract (environment + framing) — shared verbatim
 * across the Claude and Codex variants. Ends at the `Rules:` label; the
 * provider-specific rules block and the shared tail complete the contract.
 */
const VERIFY_CONTRACT_HEAD = `
=== VERIFICATION HARNESS CONTRACT (immutable) ===
You are a visual-verification agent deployed by cyboflow. You run in a git worktree
checked out at the code under test. Your job: build/serve the deliverable, drive its
UI, capture screenshots at meaningful states, and JUDGE each requested behavior
against its expected result — then return ONE structured report.

Environment (already set for your Bash tool):
- VERIFY_ARTIFACTS_DIR — write every screenshot here (bare filenames, no subdirs).
- VERIFY_DRIVER — a CLI you drive the headless browser with. Subcommands:
    "$VERIFY_DRIVER" goto <url>
    "$VERIFY_DRIVER" click <selector>
    "$VERIFY_DRIVER" type <selector> <text...>
    "$VERIFY_DRIVER" screenshot <name> [--viewport WxH]   # writes to VERIFY_ARTIFACTS_DIR
    "$VERIFY_DRIVER" stop
  All driver commands act on ONE persistent browser page across invocations.
- VERIFY_PORT — when present, bind your dev/preview server to THIS port (the task's
  serve command references it). When absent, the task points at an already-live target.
- CDP-attach mode — when the task's serve has "attach": "cdp", its serve command
  launches the deliverable APP ITSELF exposing a DevTools endpoint on
  VERIFY_DRIVER_PORT (e.g. --remote-debugging-port="$VERIFY_DRIVER_PORT"). Run that
  command, wait for the app window to be up, then drive with the SAME driver
  subcommands — the driver attaches to the app's own web-view (no separate browser,
  and usually no goto: the app window is already the surface under test).

Rules:
`;

/** The Claude-runtime rules block — the tool ceiling is Bash/Read/Grep/Glob and
 * screenshots are viewed via the Read tool. */
const VERIFY_CONTRACT_CLAUDE_RULES = `- Use ONLY Bash, Read, Grep, Glob. You have NO Write/Edit and NO MCP tools. Do not
  attempt to modify tracked source files — you are JUDGING code, not changing it.
- Run the task's build steps first. If the build or the server launch fails, set
  outcome to "build_failed" / "launch_failed" and put the failing log tail in
  buildLogExcerpt — do not fabricate screenshots.
- Read your own screenshots (Read renders PNGs) and judge each behavior honestly.
  Mark a behavior "not_testable" when you genuinely could not exercise it; never
  guess a pass.
`;

/** The Codex-runtime rules block — the enforcement is the shell + view_image (no
 * Bash/Read tool ceiling), and there are no MCP tools on this runtime. */
const VERIFY_CONTRACT_CODEX_RULES = `- Use ONLY your shell and view_image tools. View each screenshot you capture with
  view_image and judge it honestly. You have NO MCP tools. Do not modify tracked
  source files — you are JUDGING code, not changing it.
- Run the task's build steps first. If the build or the server launch fails, set
  outcome to "build_failed" / "launch_failed" and put the failing log tail in
  buildLogExcerpt — do not fabricate screenshots.
- Mark a behavior "not_testable" when you genuinely could not exercise it; never
  guess a pass.
`;

/** The tail of the harness contract (the required output schema) — shared verbatim. */
const VERIFY_CONTRACT_TAIL = `
Return a VerificationReportV1 as the structured output:
{
  "version": 1,
  "behaviors": [{ "id": "<echoes the task behavior id>",
                  "result": "pass" | "fail" | "not_testable",
                  "evidence": { "screenshots": ["shot.png"], "notes": "..." } }],
  "screenshots": [{ "fileName": "shot.png", "caption": "..." }],
  "outcome": "pass" | "fail" | "build_failed" | "launch_failed",
  "buildLogExcerpt": "<required when outcome is build_failed/launch_failed>",
  "confidence": 0.0-1.0,
  "feedback": "<one-paragraph human summary>",
  "issues": [{ "severity": "low"|"medium"|"high", "description": "...", "fileName": "shot.png" }]
}
Every screenshots[].fileName MUST be a file you actually wrote to VERIFY_ARTIFACTS_DIR.
=== END HARNESS CONTRACT ===`;

/**
 * Appended to the workflow-defined system prompt at deploy time (§5.4 step 3).
 * Restates the environment, the required output schema, and the prohibitions the
 * sandbox enforces — so an edited/overridden prompt can shape HOW the agent judges
 * but never what environment it believes it has or what it is allowed to do. Built
 * from the shared head/tail + the CLAUDE rules block so the Claude and Codex
 * variants cannot drift in their environment/schema framing.
 */
export const VERIFY_HARNESS_CONTRACT =
  VERIFY_CONTRACT_HEAD + VERIFY_CONTRACT_CLAUDE_RULES + VERIFY_CONTRACT_TAIL;

/**
 * The Codex-runtime harness contract — identical head/tail to
 * {@link VERIFY_HARNESS_CONTRACT}, with the Codex rules block (shell + view_image,
 * no Bash/Read tool ceiling) swapped in.
 */
export const VERIFY_HARNESS_CONTRACT_CODEX =
  VERIFY_CONTRACT_HEAD + VERIFY_CONTRACT_CODEX_RULES + VERIFY_CONTRACT_TAIL;

/** Pick the harness contract for the resolved provider (§5.4 step 3). */
export function verifyHarnessContract(provider: AgentProvider): string {
  return provider === 'codex' ? VERIFY_HARNESS_CONTRACT_CODEX : VERIFY_HARNESS_CONTRACT;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * The CLAUDE branch of the provider dispatch (§5.4 step 1): Claude-namespace-only
 * model resolution, reached when {@link resolveVerifyProvider} returns `claude`. A
 * pinned alias resolves through the injected alias→concrete mechanism; an unpinned
 * agent inherits the run model ONLY on a Claude-provider run; otherwise the
 * validated Claude default. The result is ALWAYS a Claude id — `agent.codexModel`
 * is never consulted and the run model is used only when the run is Claude, so a
 * `gpt-*` id cannot reach the Claude query.
 */
export function resolveVerifyModel(
  resolved: ResolvedVerifyAgent,
  resolveClaudeAlias: (alias: AgentModelAlias) => string | null,
  claudeDefaultModel: string,
): string {
  const { agent, runProvider, runModel } = resolved;
  if (agent.model !== null) {
    return resolveClaudeAlias(agent.model) ?? claudeDefaultModel;
  }
  if (runProvider === 'claude' && typeof runModel === 'string' && runModel.trim().length > 0) {
    return runModel;
  }
  return claudeDefaultModel;
}

/**
 * The provider the verifier deploys on (§5.4 step 1). An explicit agent runtime pin
 * wins (`providerForRuntime` maps `codex-sdk` → codex, the Claude runtimes → claude);
 * an unpinned agent inherits the RUN provider — so an unpinned visual-verify on a
 * Codex-provider run resolves to Codex.
 */
export function resolveVerifyProvider(resolved: ResolvedVerifyAgent): AgentProvider {
  return resolved.agent.runtime ? providerForRuntime(resolved.agent.runtime) : resolved.runProvider;
}

/**
 * Normalize one Codex model selection exactly like the standard spawn seam
 * (`resolveAgentModelAlias('codex', …)` in agentModelContext — adversarial-review
 * fix): the persisted picker sentinel `'auto'` (any case), `'default'`, blanks, and
 * a cross-family Claude id all mean "no explicit model" — forwarding `'auto'`
 * verbatim to `turn/start` breaks the deployment.
 */
function normalizeCodexModelSelection(value: string | null | undefined): string | undefined {
  const normalized = normalizeAgentModelSelection('codex', value);
  if (!normalized || normalized.toLowerCase() === 'auto') return undefined;
  return normalized;
}

/**
 * The CODEX branch model (§5.4 step 1), reached when {@link resolveVerifyProvider}
 * returns `codex`. A pinned `agent.codexModel` wins; else the run model when the run
 * itself is Codex; else `undefined` — the Codex query then resolves the account's
 * default model. Both sources pass through {@link normalizeCodexModelSelection}, so
 * an `'auto'`/`'default'` sentinel (or a cross-family id) falls through rather than
 * reaching the query verbatim.
 */
export function resolveVerifyCodexModel(resolved: ResolvedVerifyAgent): string | undefined {
  const { agent, runProvider, runModel } = resolved;
  const pinned = normalizeCodexModelSelection(agent.codexModel);
  if (pinned) return pinned;
  if (runProvider === 'codex') return normalizeCodexModelSelection(runModel);
  return undefined;
}

/** Compose the agent's user prompt from the task: the JSON payload plus a short framing. */
export function composeVerifyUserPrompt(task: VerificationTaskV1): string {
  return [
    'Verify the following composed task. Build/serve/drive/screenshot/judge it, then',
    'return the structured VerificationReportV1 (see the harness contract).',
    '',
    'TASK (VerificationTaskV1):',
    '```json',
    JSON.stringify(task, null, 2),
    '```',
  ].join('\n');
}

/**
 * Map a validated report + provisioning mode + mutation flag onto the terminal
 * verdict (§5.7 posture table). `normalizeVerificationReportV1` has already coerced
 * a pass-with-failed-behavior to `fail`, so the outcome here is authoritative.
 */
export function mapReportToResult(
  report: VerificationReportV1,
  mode: 'snapshot' | 'fallback',
  mutated: boolean,
  model: string,
): VerificationAgentRunResult {
  const fileNames = report.screenshots.map((s) => s.fileName);
  const verdictOf = (status: VerdictV1['status']): VerdictV1 => ({
    status,
    confidence: report.confidence,
    issues: report.issues,
    feedback: report.feedback,
    judgedFileNames: fileNames,
    baselineUsed: false,
    model,
  });

  if (report.outcome === 'build_failed' || report.outcome === 'launch_failed') {
    const excerpt = report.buildLogExcerpt ?? report.outcome;
    if (mode === 'fallback') {
      // Dirty-worktree fallback: attribution is unprovable, so a build/launch
      // failure is fail-OPEN infra (skipped), never the lane's retry budget (§5.7).
      return {
        status: 'skipped',
        errorMessage: `unattributable shared-worktree ${report.outcome}: ${excerpt}`,
        report,
        fileNames,
      };
    }
    // In the snapshot, a deliverable that cannot build from its own committed state
    // is a smoke FAIL — verdict-less, error_message carries the build log excerpt.
    return { status: 'failed', errorMessage: excerpt, report, fileNames };
  }

  if (report.outcome === 'fail') {
    return { status: 'failed', verdict: verdictOf('fail'), report, fileNames };
  }

  // outcome === 'pass'
  if (mutated) {
    return {
      status: 'low_confidence',
      verdict: verdictOf('low_confidence'),
      report,
      fileNames,
      errorMessage: 'verifier modified tracked sources in the snapshot',
    };
  }
  const anyNotTestable = report.behaviors.some((b) => b.result === 'not_testable');
  const anyFail = report.behaviors.some((b) => b.result === 'fail');
  if (anyNotTestable && !anyFail) {
    return { status: 'low_confidence', verdict: verdictOf('low_confidence'), report, fileNames };
  }
  return { status: 'passed', verdict: verdictOf('pass'), report, fileNames };
}

// ---------------------------------------------------------------------------
// Default seam implementations (node builtins only; never used by tests)
// ---------------------------------------------------------------------------

const defaultCheckSnapshotMutated = async (worktreePath: string): Promise<boolean> => {
  // `git diff --quiet HEAD` exits 1 when tracked files differ from HEAD (the
  // snapshot commit) — untracked build output is ignored, so only a mutation of a
  // TRACKED source trips this.
  try {
    await execFileAsync('git', ['diff', '--quiet', 'HEAD'], {
      cwd: worktreePath,
      timeout: 30_000,
    });
    return false;
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: unknown }).code === 1) return true;
    // A git failure other than "diff found" (spawn error, timeout) is treated as
    // NOT mutated — never turn an infra hiccup into a false low_confidence.
    return false;
  }
};

const defaultFileExists = async (absPath: string): Promise<boolean> => {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
};

const defaultWriteDriverScript = async (
  artifactsDir: string,
  nodePath: string,
  driverCliPath: string,
): Promise<string> => {
  const dir = join(artifactsDir, DRIVER_STATE_DIR);
  await mkdir(dir, { recursive: true });
  const scriptPath = join(dir, DRIVER_SCRIPT_NAME);
  // ELECTRON_RUN_AS_NODE makes the packaged Electron binary (process.execPath, the
  // findNodeExecutable fallback in a packaged app) behave as plain node; harmless
  // for a real node. `exec` so the driver process replaces the shell (clean signals).
  const body = `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec "${nodePath}" "${driverCliPath}" "$@"\n`;
  await writeFile(scriptPath, body, 'utf8');
  await chmod(scriptPath, 0o755);
  return scriptPath;
};

const defaultStopDriver = async (
  driverScriptPath: string,
  env: Record<string, string>,
): Promise<void> => {
  try {
    await execFileAsync(driverScriptPath, ['stop'], { env: { ...process.env, ...env }, timeout: 20_000 });
  } catch {
    // best-effort — the reaper + port probe are the real backstop.
  }
};

const defaultWriteTranscript = async (
  artifactsDir: string,
  fileName: string,
  content: string,
): Promise<void> => {
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(join(artifactsDir, fileName), content, 'utf8');
};

const defaultReapBrowser = (artifactsDir: string): void => {
  try {
    const raw = readFileSync(pidFilePath(artifactsDir), 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 1) return;
    try {
      process.kill(pid, 0); // alive?
    } catch {
      return; // already gone
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // best-effort
    }
  } catch {
    // no pid file / unreadable — nothing to reap.
  }
};

// ---------------------------------------------------------------------------
// VerificationAgentRunner
// ---------------------------------------------------------------------------

export class VerificationAgentRunner implements VerificationAgentRunnerLike {
  private readonly deps: VerificationAgentRunnerDeps;

  constructor(deps: VerificationAgentRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Write the harness-captured transcript to the deterministic filename (§
   * verifyTranscriptFileName), FAIL-SOFT: a write failure is logged at warn and
   * NEVER propagates — it must never change the verdict path. A null/empty
   * transcript is a no-op (nothing accumulated).
   */
  private async writeTranscriptFailSoft(
    req: VerificationAgentRequest,
    transcript: string | null,
    logger: LoggerLike | undefined,
  ): Promise<void> {
    if (!transcript || transcript.length === 0) return;
    const write = this.deps.writeTranscript ?? defaultWriteTranscript;
    try {
      await write(req.artifactsDir, verifyTranscriptFileName(req.requestId), transcript);
    } catch (err) {
      logger?.warn('[VerificationAgentRunner] transcript write failed (fail-soft)', {
        runId: req.runId,
        requestId: req.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Deploy the agent for one request and return the mapped verdict. NEVER throws
   * for an ordinary failure — every infra/agent error maps to a fail-open
   * `skipped` (or `timeout` on abort) so a verification problem can never wedge a
   * lane; only a truly unexpected error would escape. Teardown (abort the query,
   * stop the driver, reap the browser, dispose the snapshot) runs on EVERY path.
   */
  async run(req: VerificationAgentRequest): Promise<VerificationAgentRunResult> {
    const logger = this.deps.logger;

    const resolved = this.deps.resolveVerifyAgent(req.runId);
    if (!resolved) {
      return {
        status: 'skipped',
        errorMessage: 'visual-verify agent not resolvable for this run',
        fileNames: [],
      };
    }

    // Provider dispatch (§5.4 step 1): the resolved agent's runtime picks the query
    // seam + model rule. A codex request with no wired codexQuery dep fails open.
    const provider = resolveVerifyProvider(resolved);
    let queryFn: VerificationAgentQueryFn;
    let model: string | undefined;
    let verdictModel: string;
    if (provider === 'codex') {
      if (!this.deps.codexQuery) {
        return { status: 'skipped', errorMessage: 'codex verify runtime not wired', fileNames: [] };
      }
      queryFn = this.deps.codexQuery;
      // May be undefined — the Codex query resolves the account default in that case.
      model = resolveVerifyCodexModel(resolved);
      // The verdict label must stay a string even when the model is account-default.
      verdictModel = model ?? 'codex-default';
    } else {
      queryFn = this.deps.query;
      model = resolveVerifyModel(resolved, this.deps.resolveClaudeAlias, this.deps.claudeDefaultModel);
      verdictModel = model;
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener('abort', onAbort, { once: true });

    let snapshot: SnapshotProvision | null = null;
    let driverScriptPath: string | null = null;
    let env: Record<string, string> | null = null;

    try {
      // (b) Provision — ALWAYS snapshot when a sha is present; the live-worktree
      // fallback is reserved for a failed sha capture (req.snapshotSha === null).
      // A whole-tree dirty check used to gate the snapshot here, but any sibling
      // lane's mid-edit state in the shared sprint worktree tripped it and routed
      // verification into the live worktree — the exact cross-lane contamination
      // snapshots exist to prevent (adversarial-review fix 2026-07-23). The sprint
      // chain commits per task before task-verify fires, so the recorded HEAD
      // contains this lane's deliverable; an uncommitted lane diff fails closed in
      // the snapshot with "not present in build" feedback instead (§5.5 amended).
      let cwd: string;
      let mode: 'snapshot' | 'fallback';
      if (req.snapshotSha !== null) {
        const provision = this.deps.provision ?? provisionSnapshot;
        try {
          snapshot = await provision({
            runWorktreePath: req.runWorktreePath,
            snapshotSha: req.snapshotSha,
            ...(logger ? { logger } : {}),
          });
        } catch (err) {
          if (err instanceof SnapshotProvisionError) {
            // bad_sha / worktree_add_failed — the fail-open infra bucket (§5.5).
            return {
              status: 'skipped',
              errorMessage: `snapshot provisioning failed (${err.code})`,
              fileNames: [],
            };
          }
          throw err;
        }
        cwd = snapshot.worktreePath;
        mode = 'snapshot';
      } else {
        cwd = req.runWorktreePath;
        mode = 'fallback';
      }

      // (b cont.) Env + the driver wrapper script. VERIFY_PORT rides only when the
      // task implies a server (the scheduler decided that when it leased the port).
      const node = await this.deps.resolveNode();
      const writeScript = this.deps.writeDriverScript ?? defaultWriteDriverScript;
      driverScriptPath = await writeScript(req.artifactsDir, node, this.deps.driverCliPath);
      env = {
        VERIFY_ARTIFACTS_DIR: req.artifactsDir,
        VERIFY_DRIVER_PORT: String(req.verifyDriverPort),
        VERIFY_DRIVER: driverScriptPath,
        ...(req.verifyPort !== null ? { VERIFY_PORT: String(req.verifyPort) } : {}),
        // CDP-attach mode (task.serve.attach === 'cdp'): the serve command
        // launches the app under test exposing CDP on VERIFY_DRIVER_PORT, so the
        // driver must ATTACH and never launch its own chromium (a blank chromium
        // there would screenshot the wrong surface). driverCore honors this flag.
        ...(req.task.serve?.attach === 'cdp' ? { VERIFY_DRIVER_ATTACH_ONLY: '1' } : {}),
      };

      if (controller.signal.aborted) {
        return { status: 'timeout', errorMessage: 'aborted before deploy', fileNames: [] };
      }

      // (c) Deploy ONE structured session on the resolved provider's query seam,
      // with the provider-matched harness contract appended to the agent prompt.
      const systemPrompt = `${resolved.agent.systemPrompt}\n\n${verifyHarnessContract(provider)}`;
      let raw: unknown;
      try {
        const outcome = await queryFn({
          prompt: composeVerifyUserPrompt(req.task),
          systemPrompt,
          cwd,
          model,
          allowedTools: [...VERIFY_AGENT_ALLOWED_TOOLS],
          env,
          ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
          signal: controller.signal,
        });
        // Write the transcript BEFORE report validation, so an invalid-report or
        // skipped outcome still leaves the transcript on disk (fail-soft — never
        // changes the verdict path).
        await this.writeTranscriptFailSoft(req, outcome.transcript, logger);
        raw = outcome.structured;
      } catch (err) {
        if (err instanceof VerificationAgentQueryError) {
          await this.writeTranscriptFailSoft(req, err.transcript, logger);
        }
        if (controller.signal.aborted) {
          return { status: 'timeout', errorMessage: 'deadline exceeded during deploy', fileNames: [] };
        }
        // A query-INTERNAL deadline expiry is a real timeout, not an infra skip
        // (adversarial-review fix): report it as the terminal `timeout` status.
        if (err instanceof VerificationAgentQueryError && err.timedOut) {
          return { status: 'timeout', errorMessage: err.message, fileNames: [] };
        }
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn('[VerificationAgentRunner] agent query failed', { runId: req.runId, error: message });
        emitSeamError('verify-agent-deploy-failed', err instanceof Error ? err : new Error(message), {
          agentKey: 'visual-verify',
        });
        return { status: 'skipped', errorMessage: `agent deploy error: ${message}`, fileNames: [] };
      }

      if (controller.signal.aborted) {
        return { status: 'timeout', errorMessage: 'deadline exceeded', fileNames: [] };
      }

      // (d) Validate the report harness-side (never trust the model verbatim).
      const expectedIds = req.task.behaviors.map((b) => b.id);
      const normalized = normalizeVerificationReportV1(raw, expectedIds);
      if (!normalized.ok) {
        return { status: 'skipped', errorMessage: `invalid report: ${normalized.error}`, fileNames: [] };
      }
      const report = normalized.report;

      // Every screenshots[].fileName must be a BARE basename that exists in the
      // artifacts dir (mirrors cyboflow_report_artifact's safety rules).
      const fileExists = this.deps.fileExists ?? defaultFileExists;
      for (const shot of report.screenshots) {
        if (basename(shot.fileName) !== shot.fileName) {
          return {
            status: 'skipped',
            errorMessage: `report screenshot "${shot.fileName}" must be a bare filename`,
            fileNames: [],
          };
        }
        if (!(await fileExists(join(req.artifactsDir, shot.fileName)))) {
          return {
            status: 'skipped',
            errorMessage: `report screenshot "${shot.fileName}" not found in artifacts dir`,
            fileNames: [],
          };
        }
      }

      // (e) Post-run mutation check — snapshot mode only (the fallback worktree is
      // expected to be dirty). A tracked-source mutation demotes to low_confidence.
      let mutated = false;
      if (mode === 'snapshot' && snapshot) {
        const checkMutated = this.deps.checkSnapshotMutated ?? defaultCheckSnapshotMutated;
        mutated = await checkMutated(snapshot.worktreePath);
      }

      return mapReportToResult(report, mode, mutated, verdictModel);
    } catch (err) {
      if (controller.signal.aborted) {
        return { status: 'timeout', errorMessage: 'deadline exceeded', fileNames: [] };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger?.error('[VerificationAgentRunner] unexpected error', { runId: req.runId, error: message });
      emitSeamError('verify-agent-error', err instanceof Error ? err : new Error(message), {
        agentKey: 'visual-verify',
      });
      return { status: 'skipped', errorMessage: `agent runner error: ${message}`, fileNames: [] };
    } finally {
      // (f) Teardown — ALWAYS, abort-safe, best-effort. Stop the browser via the
      // driver, independently reap its pid, dispose the snapshot. The scheduler
      // owns the leased-port probe + quarantine after this returns.
      req.signal.removeEventListener('abort', onAbort);
      controller.abort();
      if (driverScriptPath && env) {
        const stopDriver = this.deps.stopDriver ?? defaultStopDriver;
        try {
          await stopDriver(driverScriptPath, env);
        } catch (err) {
          logger?.debug('[VerificationAgentRunner] driver stop threw (ignored)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const reapBrowser = this.deps.reapBrowser ?? defaultReapBrowser;
      try {
        reapBrowser(req.artifactsDir);
      } catch {
        // best-effort
      }
      if (snapshot) {
        await snapshot.dispose();
      }
    }
  }
}
