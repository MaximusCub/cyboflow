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
import { mkdir, writeFile, chmod, access, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { LoggerLike } from '../types';
import { emitSeamError } from '../telemetrySink';
import {
  type VerificationTaskV1,
  type VerificationReportV1,
  type VerdictV1,
  type RequestStatus,
  type VerificationModality,
  type VerificationType,
  type AttestationSpec,
  normalizeVerificationReportV1,
  resolveTaskModality,
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
import { runAgentPreflight, type AgentPreflightResult } from './preflight';
import {
  attestFilePath,
  pidFilePath,
  probeChromiumExecutable,
  DEFAULT_PEEKABOO_BIN,
} from './driver/driverCore';

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
  /**
   * The §4 roster modality this request runs under, when the SCHEDULER already
   * resolved one (it owns the `VerificationType` this module never sees — the
   * agent path historically "never consults verify_type", §3.3). OPTIONAL
   * today because that scheduler-side plumbing is a follow-up: when absent the
   * runner derives the modality from the task alone
   * ({@link resolveRequestModality}). A present value WINS — only the
   * scheduler can know a request is `native-desktop`/`mobile-flow`, which no
   * amount of task-shape inspection can recover.
   */
  modality?: VerificationModality;
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
  /**
   * Whether an SDK agent session was ACTUALLY deployed for this request
   * (docs/proposals/verification-setup-flow.md §3.6, budget accounting). REQUIRED
   * — the scheduler charges `judge_calls_used` off THIS flag rather than off
   * "we got as far as calling the runner", so the §3.5 pre-deploy preflight (and
   * the other genuinely pre-deploy exits: an unresolvable agent, a failed
   * snapshot provision, an abort before deploy) cannot burn a project's lifetime
   * verification budget on work that never spent a token. `true` from the moment
   * the query seam is invoked — INCLUDING a query that then threw, since that
   * session was deployed and did consume budget.
   */
  deployed: boolean;
  /**
   * The §3.5 pre-deploy preflight result, when preflight ran (it always does on
   * this path today). The scheduler persists it to `preflight_json` and feeds it
   * to the §3.1 classifier as the EVIDENCE BASE for an `'env'` verdict — a
   * failure with no failed preflight check has no harness-derived provenance and
   * stays conservatively `'ambiguous'` (blocking).
   */
  preflight?: AgentPreflightResult;
  /**
   * How the code under test was provisioned: `'snapshot'` (the normal detached
   * worktree at the recorded sha) or `'fallback'` (the dirty live worktree).
   * Absent when provisioning never started. The §3.1 classifier reads this: only
   * a JUDGED `'snapshot'`-mode failure may be classified `'deliverable'`, because
   * a degraded provisioning path cannot attest to the deliverable's own health.
   */
  provisionMode?: 'snapshot' | 'fallback';
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
  /**
   * §3.5 preflight probe: resolve a launchable chromium binary, or `null` when
   * none is installed. Defaults to the driver's OWN resolution
   * (`driverCore.probeChromiumExecutable`, LAZILY imported so this module keeps
   * its no-playwright-at-module-scope posture) — deliberately the same function
   * the driver's launch fallback calls, so the preflight verdict and the driver's
   * later behavior can never disagree.
   */
  resolveChromium?: () => Promise<string | null>;
  /**
   * §3.5 preflight probe: `true` when nothing is listening on `port`. The REAL
   * implementation is injected from index.ts — the very same TCP connect probe
   * the scheduler's agent teardown uses to decide release-vs-quarantine, so
   * "occupied" means the identical thing at both ends of a request. Defaults to
   * always-free, which makes the check a harmless no-op under test and on any
   * deployment wired without a net probe (fail-open: an unprobed port must never
   * be affirmative evidence of a squatter).
   */
  portFreeProbe?: (port: number) => Promise<boolean>;
  /**
   * §3.5 preflight probe for the `native-screen` modality only: `true` when
   * this host can actually capture the screen (the retired
   * `peekabooBackend.healthCheck()` — binary present AND both TCC grants —
   * is the intended wiring, §4 "Driver additions"). ABSENT means the check
   * does not run at all rather than fails: the scheduler-side gate already
   * refuses a `native-screen` request on a host with no capability probe, so
   * a second, evidence-free failure here would only add noise.
   */
  nativeCaptureProbe?: () => Promise<boolean>;
  /**
   * The peekaboo binary exported as `VERIFY_PEEKABOO_BIN` for a
   * `native-screen` request (the driver's `attest window` /
   * `native-screenshot` commands shell it). Defaults to the bare `peekaboo`
   * PATH name — the same assumption `peekabooBackend`'s production client
   * makes.
   */
  peekabooBin?: string;
  /**
   * Read the driver-written `.driver/attest.json` (§7.1) for this request, or
   * `null` when it is absent/unreadable/malformed. This is the ONLY
   * attestation input the runner trusts — the agent's
   * `VerificationReportV1.attestation` echo is human-facing narrative, and a
   * model cannot forge a file only the driver CLI writes. FAIL-SOFT by
   * contract: every "could not read it" answer is `null`, which the floor
   * treats exactly like "the channel never came up".
   */
  readAttestFile?: (artifactsDir: string) => Promise<AttestationRecord | null>;
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
    "$VERIFY_DRIVER" native-screenshot <name> [--app <appTarget>]  # OS-screen capture
    "$VERIFY_DRIVER" attest http <urlPath>
    "$VERIFY_DRIVER" attest dom <selector>
    "$VERIFY_DRIVER" attest cdp <expression> <expected>
    "$VERIFY_DRIVER" attest window <titlePattern>
    "$VERIFY_DRIVER" stop
  All driver commands act on ONE persistent browser page across invocations.
- VERIFY_PORT — when present, bind your dev/preview server to THIS port (the task's
  serve command references it). When absent, the task points at an already-live target.
- VERIFY_ATTEST_NONCE — a per-request secret. It is what makes an attestation mean
  something: the surface you verified must hand this exact value back (in the
  attest http response body, or in the attest dom element's text /
  data-verify-nonce attribute). A port answering, or a page rendering, proves
  nothing on its own — a stale server or the user's own running app answers too.
- VERIFY_MODALITY — "web" | "cdp-app" | "native-screen" | "mobile".
- CDP-attach mode — when the task's serve has "attach": "cdp", its serve command
  launches the deliverable APP ITSELF exposing a DevTools endpoint on
  VERIFY_DRIVER_PORT (e.g. --remote-debugging-port="$VERIFY_DRIVER_PORT"). Run that
  command, wait for the app window to be up, then drive with the SAME driver
  subcommands — the driver attaches to the app's own web-view (no separate browser,
  and usually no goto: the app window is already the surface under test).

ATTESTATION (required whenever the task carries an "attestation" object):
- You MUST run the task's attest step and see it SUCCEED before you report
  outcome "pass". The harness reads the driver's own record of that step, not your
  word for it — a report claiming "pass" without a successful attest run is
  rejected as unproven, whatever the screenshots show.
- Match the channel to the task's spec: kind "http-endpoint" → attest http <urlPath>;
  "dom-marker" → attest dom <selector>; "cdp-token" → attest cdp <expression> <expected>;
  "window-identity" → attest window <titlePattern>. Running a DIFFERENT channel than
  the task declared does not satisfy it.
- You may echo what you saw in the report's optional "attestation" field
  ({ "verified": bool, "kind": "...", "detail": "..." }) — that is for humans reading
  the verdict; it is never treated as proof.

NATIVE-SCREEN IS OBSERVE-ONLY:
- When VERIFY_MODALITY is "native-screen" the goto/click/type/screenshot commands are
  REFUSED (driving a native surface has no supported path yet). Use
  native-screenshot to capture and attest window to prove identity. Any behavior you
  cannot exercise without driving MUST be reported "not_testable" — never guessed.

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
  "issues": [{ "severity": "low"|"medium"|"high", "description": "...", "fileName": "shot.png" }],
  "attestation": { "verified": true, "kind": "http-endpoint", "detail": "<what you saw>" }
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

/**
 * The `VerificationType` fed to {@link resolveTaskModality} when the runner
 * must DERIVE a modality from the task alone. `VerificationAgentRequest`
 * carries no type today (the agent dispatch path "never consults verify_type",
 * §3.3), and the resolver only uses the type to short-circuit the two
 * modalities a task shape cannot express — `native-desktop` → `native-screen`
 * and `mobile-flow` → `mobile`. Passing a web-shaped type therefore hands the
 * decision entirely to the `serve.attach === 'cdp'` discriminant, which IS
 * derivable, and leaves the two undertermined modalities to the explicit
 * declaration channels (`req.modality` from the scheduler, `task.modality`
 * from the composer).
 */
const MODALITY_DERIVATION_TYPE: VerificationType = 'interactive-web-behavior';

/**
 * Resolve the §4 roster modality for one request, in precedence order:
 * the SCHEDULER's explicit `req.modality` (it owns the request row's
 * `VerificationType`, the only source that can say `native-screen`/`mobile`),
 * then the COMPOSER's `task.modality` declaration, then the task-shape
 * derivation.
 *
 * A declared `web`/`cdp-app` that disagrees with the derivation is LOGGED, not
 * corrected: the two channels are meant to agree, and a silent override in
 * either direction would hide a composer bug (a `cdp-app` task composed with
 * no `attach: 'cdp'` serve drives the wrong surface; a `web` declaration on an
 * attach task launches a blank chromium). A declared `native-screen`/`mobile`
 * NEVER logs a mismatch — those are structurally underivable from a task, so
 * the "disagreement" carries no information.
 */
export function resolveRequestModality(
  req: Pick<VerificationAgentRequest, 'modality' | 'task'>,
  logger?: LoggerLike,
): VerificationModality {
  const derived = resolveTaskModality(MODALITY_DERIVATION_TYPE, req.task);
  const declared = req.modality ?? req.task.modality;
  if (declared === undefined) return derived;
  if ((declared === 'web' || declared === 'cdp-app') && declared !== derived) {
    logger?.warn('[VerificationAgentRunner] declared modality disagrees with the composed task shape', {
      declared,
      derived,
      attach: req.task.serve?.attach ?? null,
    });
  }
  return declared;
}

// ---------------------------------------------------------------------------
// Attestation floor (§7.1 — "no attestation ⇒ no passed")
// ---------------------------------------------------------------------------

/** Terminal error for a pass the harness could not prove was about THIS deliverable. */
export const ATTESTATION_MISSING_MESSAGE =
  "attestation missing/mismatched — could not prove the verified surface is this task's deliverable";

/** Explanatory note attached when a pass is capped for having no attestation channel at all. */
export const ATTESTATION_UNCAPPED_MESSAGE = 'no attestation channel — pass capped at low_confidence';

/**
 * The driver-written attestation record, as the runner consumes it (a
 * structural subset of driverCore's `DriverAttestRecord`, so the file's
 * contents drop straight in). `kind` is a plain `string` on purpose: an
 * unrecognized channel name must simply MATCH NO declared spec — the floor
 * compares it to the task's declared kind, and a value outside the union can
 * only ever fail that comparison, which is the conservative direction.
 */
export interface AttestationRecord {
  ok: boolean;
  kind: string;
  detail: string;
}

/** What the floor decided about a PASS report's identity proof. */
export type AttestationFloorOutcome =
  /** The declared channel came up and matched (or is true by construction). */
  | { kind: 'verified'; channel: AttestationSpec['kind']; detail: string }
  /** A channel WAS declared but its driver record is absent or names a different channel. */
  | { kind: 'missing'; detail: string }
  /** No channel was declared at all — the pass is advisory, capped at low_confidence. */
  | { kind: 'uncapped'; detail: string };

/**
 * The attestation channel a task's proof actually rests on: its own declared
 * spec, else an IMPLICIT `file-identity` for the degenerate pre-live path
 * (`target.htmlPath` with nothing to build and nothing to serve). The implicit
 * case is not a loophole — identity there is true by construction, because the
 * runner itself owns the path being opened: there is no live process, no port,
 * and nothing for a stale server or the user's own app to race.
 *
 * A `target.url` task gets NO implicit spec: a bare URL is exactly the shape
 * whose identity cannot be assumed (that URL may be answered by anything).
 */
export function effectiveAttestationSpec(task: VerificationTaskV1): AttestationSpec | null {
  if (task.attestation !== undefined) return task.attestation;
  const htmlPath = task.target?.htmlPath;
  const degenerate =
    typeof htmlPath === 'string' &&
    htmlPath.trim().length > 0 &&
    (task.build === undefined || task.build.length === 0) &&
    task.serve === undefined;
  return degenerate ? { kind: 'file-identity' } : null;
}

/**
 * Apply §7.1's floor to a PASS report, given the effective spec and the
 * driver-written attestation record.
 *
 *  - `file-identity` ⇒ `verified` without consulting any record (see
 *    {@link effectiveAttestationSpec}).
 *  - Any other declared spec ⇒ `verified` ONLY when the record exists, says
 *    `ok:true`, AND names the SAME channel. A record for a different channel
 *    does not satisfy the declaration: proving a window title says nothing
 *    about the HTTP endpoint the task said it would prove. Anything else is
 *    `missing` — §7.1's hard rule, "no attestation ⇒ no `passed`, period".
 *  - No spec at all ⇒ `uncapped`. This is the one place the proposal's strict
 *    wording is softened deliberately: a task that never declared a channel
 *    has not FAILED an identity check, it simply never had one, and failing it
 *    outright would break every pre-existing bare-`target.url` check. Capping
 *    it at `low_confidence` keeps the invariant that ONLY a proven surface can
 *    reach `passed`, while leaving the result advisory rather than blocking.
 */
export function evaluateAttestationFloor(
  spec: AttestationSpec | null,
  record: AttestationRecord | null,
): AttestationFloorOutcome {
  if (spec === null) {
    return {
      kind: 'uncapped',
      detail: 'the composed task declared no attestation channel and is not a degenerate file target',
    };
  }
  if (spec.kind === 'file-identity') {
    return {
      kind: 'verified',
      channel: 'file-identity',
      detail: 'file-identity: the runner owns the opened path, so identity holds by construction',
    };
  }
  if (record === null) {
    return {
      kind: 'missing',
      detail: `declared channel "${spec.kind}" but the driver wrote no attestation record — the attest step never ran`,
    };
  }
  if (record.kind !== spec.kind) {
    return {
      kind: 'missing',
      detail: `declared channel "${spec.kind}" but the driver's attestation record is for "${record.kind}"`,
    };
  }
  if (!record.ok) {
    return { kind: 'missing', detail: `channel "${spec.kind}" ran and FAILED: ${record.detail}` };
  }
  return { kind: 'verified', channel: spec.kind, detail: record.detail };
}

/**
 * §4 fn.² coercion: on `native-screen` — which is observe-only until a native
 * drive API exists — every behavior the TASK marked `requiresDrive` must land
 * as `not_testable`, whatever the agent claimed. The agent is told this in the
 * harness contract, but the harness must not DEPEND on it: a model that
 * "passed" a click-through it could not possibly have performed is exactly the
 * fabricated evidence this whole path exists to prevent, and a driver refusal
 * it papered over is invisible in a screenshot.
 *
 * Deliberately does NOT re-derive `report.outcome`. Coercion only ever removes
 * a claim; letting it turn an agent-reported `fail` back into a `pass` would
 * be the harness upgrading a verdict on the strength of a rule about what the
 * agent COULDN'T do. A coerced report still reaches `low_confidence` through
 * {@link mapReportToResult}'s existing `anyNotTestable && !anyFail` branch,
 * which is the honest ceiling for a run whose drive-required behaviors were
 * never exercised.
 */
export function coerceDriveUnsupportedBehaviors(
  report: VerificationReportV1,
  task: VerificationTaskV1,
  modality: VerificationModality,
): { report: VerificationReportV1; coerced: number } {
  if (modality !== 'native-screen') return { report, coerced: 0 };
  const driveIds = new Set(task.behaviors.filter((b) => b.requiresDrive === true).map((b) => b.id));
  if (driveIds.size === 0) return { report, coerced: 0 };

  let coerced = 0;
  const behaviors = report.behaviors.map((behavior) => {
    if (!driveIds.has(behavior.id) || behavior.result === 'not_testable') return behavior;
    coerced += 1;
    const notes = behavior.evidence.notes.trim();
    return {
      ...behavior,
      result: 'not_testable' as const,
      evidence: {
        ...behavior.evidence,
        notes: notes.length > 0 ? `${notes}\ncoerced: drive-unsupported` : 'coerced: drive-unsupported',
      },
    };
  });
  return coerced > 0 ? { report: { ...report, behaviors }, coerced } : { report, coerced: 0 };
}

/**
 * Fold an `uncapped` floor outcome into an otherwise-passing result: `passed`
 * becomes `low_confidence`, with the reason on both the errorMessage and the
 * verdict feedback (the merge gate reads the status; a human reads the
 * feedback). A result that is ALREADY non-`passed` is returned untouched — it
 * has either failed outright or been demoted for its own reason, and
 * `low_confidence` is the cap this outcome asks for, not a floor to raise it
 * to.
 *
 * `low_confidence` ADVANCES the lane as advisory (mergeGateLaneAdvance), which
 * is the point: a degenerate URL check with no provable identity stays useful
 * without being allowed to assert an identity it cannot prove.
 */
function applyAttestationCap(
  result: VerificationAgentRunResult,
  floor: AttestationFloorOutcome | null,
): VerificationAgentRunResult {
  if (floor === null || floor.kind !== 'uncapped' || result.status !== 'passed') return result;
  const note = `${ATTESTATION_UNCAPPED_MESSAGE} (${floor.detail})`;
  return {
    ...result,
    status: 'low_confidence',
    ...(result.verdict
      ? {
          verdict: {
            ...result.verdict,
            status: 'low_confidence',
            feedback: `${result.verdict.feedback}\n\n${note}`,
          },
        }
      : {}),
    errorMessage: note,
  };
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
  // Every outcome mapped here came back FROM a deployed session, so it is
  // budget-charged (§3.6) and carries its provisioning mode for the §3.1
  // classifier's `'deliverable'` gate (snapshot-only).
  const provenance = { deployed: true, provisionMode: mode } as const;
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
        ...provenance,
      };
    }
    // In the snapshot, a deliverable that cannot build from its own committed state
    // is a smoke FAIL — verdict-less, error_message carries the build log excerpt.
    return { status: 'failed', errorMessage: excerpt, report, fileNames, ...provenance };
  }

  if (report.outcome === 'fail') {
    return { status: 'failed', verdict: verdictOf('fail'), report, fileNames, ...provenance };
  }

  // outcome === 'pass'
  if (mutated) {
    return {
      status: 'low_confidence',
      verdict: verdictOf('low_confidence'),
      report,
      fileNames,
      errorMessage: 'verifier modified tracked sources in the snapshot',
      ...provenance,
    };
  }
  const anyNotTestable = report.behaviors.some((b) => b.result === 'not_testable');
  const anyFail = report.behaviors.some((b) => b.result === 'fail');
  if (anyNotTestable && !anyFail) {
    return { status: 'low_confidence', verdict: verdictOf('low_confidence'), report, fileNames, ...provenance };
  }
  return { status: 'passed', verdict: verdictOf('pass'), report, fileNames, ...provenance };
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

/**
 * §3.5 default chromium probe — driverCore's OWN resolver, so the preflight
 * verdict and the driver's later launch behavior can never disagree. driverCore
 * is already a static import here (`pidFilePath`) and is itself
 * no-playwright-at-module-scope: it `await import('playwright')` INSIDE the
 * resolver, so a packaged build that pruned the devDependency soft-fails to
 * `null` ("chromium absent") at call time instead of MODULE_NOT_FOUND-crashing
 * this module's import.
 */
const defaultResolveChromium = (): Promise<string | null> => probeChromiumExecutable();

/**
 * Read `<artifactsDir>/.driver/attest.json` (§7.1). FAIL-SOFT to `null` on
 * EVERY unhappy path — absent file, unreadable, unparseable, or a shape that
 * is not the driver's record — because the floor's answer for "no usable
 * record" is identical to its answer for "the channel never came up", and a
 * throw here would turn a provable verification failure into an unexplained
 * runner crash. The path is resolved through driverCore's own
 * {@link attestFilePath} so writer and reader can never drift.
 */
const defaultReadAttestFile = async (artifactsDir: string): Promise<AttestationRecord | null> => {
  try {
    const raw = await readFile(attestFilePath(artifactsDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.ok !== 'boolean' || typeof record.kind !== 'string') return null;
    return {
      ok: record.ok,
      kind: record.kind,
      detail: typeof record.detail === 'string' ? record.detail : '',
    };
  } catch {
    return null;
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
   * The §3.5 PRE-DEPLOY gate (docs/proposals/verification-setup-flow.md). Runs
   * FIRST — before agent resolution, before snapshot provisioning, before the SDK
   * deploy — because everything after it is expensive: a missing chromium today
   * only surfaces at driver-launch time, inside a deployed session, after the
   * scheduler already charged the project's verification budget and built a
   * detached worktree. Every probe is delegated to an injectable dep so this
   * module stays fs/net/playwright-free at module scope.
   *
   * The leased-port argument mirrors what the scheduler leased: `req.verifyPort`
   * when the task implies a server it must BIND, else the slot the driver port
   * was derived from (`verifyDriverPort - 1`) — the scheduler always leases the
   * pair (p, p+1), so that arithmetic recovers the pool slot for a non-serving
   * task without widening {@link VerificationAgentRequest}.
   */
  private async preflight(
    req: VerificationAgentRequest,
    modality: VerificationModality,
  ): Promise<AgentPreflightResult> {
    const nativeCaptureProbe = this.deps.nativeCaptureProbe;
    return runAgentPreflight(
      {
        resolveNode: this.deps.resolveNode,
        resolveChromium: this.deps.resolveChromium ?? defaultResolveChromium,
        fileExists: this.deps.fileExists ?? defaultFileExists,
        portFreeProbe: this.deps.portFreeProbe ?? (async () => true),
        // Passed through only when wired: an ABSENT probe means the
        // 'native-capture' check does not run at all (see the dep's doc), so
        // no default may be substituted here.
        ...(nativeCaptureProbe ? { nativeCaptureProbe } : {}),
      },
      {
        task: req.task,
        driverCliPath: this.deps.driverCliPath,
        leasedPort: req.verifyPort ?? req.verifyDriverPort - 1,
        driverPort: req.verifyDriverPort,
        modality,
      },
    );
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

    // (a) The §4 roster modality — resolved FIRST because everything below
    // keys on it: which preflight checks apply, which env the agent gets, and
    // whether drive-required behaviors are coerced out of the report.
    const modality = resolveRequestModality(req, logger);

    // (a0) §3.5 preflight — the cheap host check, BEFORE any spend. A failure
    // returns immediately with NO snapshot and NO deploy; `deployed:false` tells
    // the scheduler not to charge the budget, and the carried `preflight` is the
    // harness-derived evidence the §3.1 classifier needs to call the resulting
    // terminal `'env'` (an advancing skip) rather than a lane-blocking FAIL.
    const preflight = await this.preflight(req, modality);
    if (!preflight.ok) {
      const failed = preflight.checks.filter((c) => !c.ok);
      logger?.warn('[VerificationAgentRunner] preflight failed; skipping without deploy', {
        runId: req.runId,
        requestId: req.requestId,
        failedChecks: failed.map((c) => c.id),
      });
      return {
        status: 'skipped',
        deployed: false,
        preflight,
        errorMessage: failed.map((c) => c.detail).join('; '),
        fileNames: [],
      };
    }

    const resolved = this.deps.resolveVerifyAgent(req.runId);
    if (!resolved) {
      return {
        status: 'skipped',
        deployed: false,
        preflight,
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
    // Hoisted out of the try so the outer catch can report the provisioning mode
    // it failed under (the §3.1 classifier's `'deliverable'` gate is
    // snapshot-only, so an unknown mode must stay `undefined`, never guessed).
    let mode: 'snapshot' | 'fallback' | null = null;

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
            // Nothing was deployed, so nothing is charged (§3.6).
            return {
              status: 'skipped',
              deployed: false,
              preflight,
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
        // §7.1: the per-REQUEST identity secret. Minted fresh here (never
        // reused, never derived from anything the deliverable could guess) so
        // that a surface handing it back cannot be a stale server, a warm
        // cache, or the user's own running app — only something this request's
        // serve step injected can carry it.
        VERIFY_ATTEST_NONCE: randomUUID(),
        VERIFY_MODALITY: modality,
        ...(modality === 'native-screen'
          ? { VERIFY_PEEKABOO_BIN: this.deps.peekabooBin ?? DEFAULT_PEEKABOO_BIN }
          : {}),
        ...(req.verifyPort !== null ? { VERIFY_PORT: String(req.verifyPort) } : {}),
        // CDP-attach mode (task.serve.attach === 'cdp'): the serve command
        // launches the app under test exposing CDP on VERIFY_DRIVER_PORT, so the
        // driver must ATTACH and never launch its own chromium (a blank chromium
        // there would screenshot the wrong surface). driverCore honors this flag.
        ...(req.task.serve?.attach === 'cdp' ? { VERIFY_DRIVER_ATTACH_ONLY: '1' } : {}),
      };

      if (controller.signal.aborted) {
        return {
          status: 'timeout',
          deployed: false,
          preflight,
          provisionMode: mode,
          errorMessage: 'aborted before deploy',
          fileNames: [],
        };
      }

      // (c) Deploy ONE structured session on the resolved provider's query seam,
      // with the provider-matched harness contract appended to the agent prompt.
      const systemPrompt = `${resolved.agent.systemPrompt}\n\n${verifyHarnessContract(provider)}`;
      // From HERE on the session is deployed and has spent tokens — every exit
      // below is budget-charged (§3.6), including a query that threw.
      const deployedProvenance = { deployed: true, preflight, provisionMode: mode } as const;
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
          return {
            status: 'timeout',
            errorMessage: 'deadline exceeded during deploy',
            fileNames: [],
            ...deployedProvenance,
          };
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
        return {
          status: 'skipped',
          errorMessage: `agent deploy error: ${message}`,
          fileNames: [],
          ...deployedProvenance,
        };
      }

      if (controller.signal.aborted) {
        return { status: 'timeout', errorMessage: 'deadline exceeded', fileNames: [], ...deployedProvenance };
      }

      // (d) Validate the report harness-side (never trust the model verbatim).
      const expectedIds = req.task.behaviors.map((b) => b.id);
      const normalized = normalizeVerificationReportV1(raw, expectedIds);
      if (!normalized.ok) {
        return {
          status: 'skipped',
          errorMessage: `invalid report: ${normalized.error}`,
          fileNames: [],
          ...deployedProvenance,
        };
      }
      // (d1) §4 fn.² native-screen coercion — applied BEFORE any verdict
      // mapping so every downstream branch (the attestation floor, the
      // mutation demotion, the not_testable→low_confidence rule) sees the same
      // honest behavior set. A claimed pass/fail on a behavior the driver would
      // have REFUSED to drive is not evidence of anything.
      const { report, coerced } = coerceDriveUnsupportedBehaviors(normalized.report, req.task, modality);
      if (coerced > 0) {
        logger?.info('[VerificationAgentRunner] coerced drive-required behaviors to not_testable', {
          runId: req.runId,
          requestId: req.requestId,
          modality,
          coerced,
        });
      }

      // Every screenshots[].fileName must be a BARE basename that exists in the
      // artifacts dir (mirrors cyboflow_report_artifact's safety rules).
      const fileExists = this.deps.fileExists ?? defaultFileExists;
      for (const shot of report.screenshots) {
        if (basename(shot.fileName) !== shot.fileName) {
          return {
            status: 'skipped',
            errorMessage: `report screenshot "${shot.fileName}" must be a bare filename`,
            fileNames: [],
            ...deployedProvenance,
          };
        }
        if (!(await fileExists(join(req.artifactsDir, shot.fileName)))) {
          return {
            status: 'skipped',
            errorMessage: `report screenshot "${shot.fileName}" not found in artifacts dir`,
            fileNames: [],
            ...deployedProvenance,
          };
        }
      }

      // (d2) §7.1 ATTESTATION FLOOR — evaluated on the PASS path only, and
      // BEFORE the mutation check, because "we cannot prove this was your
      // deliverable" outranks every other demotion: a low_confidence for a
      // mutated snapshot still ADVANCES the lane, so a surface that was never
      // identified must fail first rather than be softened into an advance.
      //
      // The record is read from the DRIVER'S file — never `report.attestation`,
      // which is the agent's own narrative echo. That asymmetry is the whole
      // point of §7.1: the harness must not accept a model's word that it
      // proved something.
      let floor: AttestationFloorOutcome | null = null;
      if (report.outcome === 'pass') {
        const spec = effectiveAttestationSpec(req.task);
        // Only a channel that needs proving costs a read: `file-identity` is
        // true by construction and "no spec" has nothing to look for.
        const record =
          spec !== null && spec.kind !== 'file-identity'
            ? await (this.deps.readAttestFile ?? defaultReadAttestFile)(req.artifactsDir)
            : null;
        floor = evaluateAttestationFloor(spec, record);
        if (floor.kind === 'missing') {
          // Terminal FAIL, not a skip. The §3.1 classifier sees a report
          // outcome of 'pass' (not 'fail'), so this lands 'ambiguous' — which
          // REMAINS BLOCKING. That is §7.1's stated posture: without
          // foreign-occupancy evidence a missing attestation is ambiguous and
          // blocks, and calling it 'env' would advance the lane on a
          // verification that proved nothing.
          logger?.warn('[VerificationAgentRunner] attestation floor rejected a pass report', {
            runId: req.runId,
            requestId: req.requestId,
            modality,
            detail: floor.detail,
          });
          return {
            status: 'failed',
            errorMessage: `${ATTESTATION_MISSING_MESSAGE} (${floor.detail})`,
            report,
            fileNames: report.screenshots.map((s) => s.fileName),
            ...deployedProvenance,
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

      // mapReportToResult already stamps deployed:true + provisionMode; the
      // preflight rides along so the scheduler persists it on EVERY terminal.
      // The report is persisted AS-IS (including the agent's own attestation
      // echo) — the floor changes the verdict, never the record of what the
      // agent said.
      return {
        ...applyAttestationCap(mapReportToResult(report, mode, mutated, verdictModel), floor),
        preflight,
      };
    } catch (err) {
      // The outer catch can fire before OR after the deploy; `deployedProvenance`
      // is not in scope here, so budget attribution falls back to the honest
      // "unknown ⇒ do not charge" answer (deployed:false). Under-charging by one
      // on a rare unexpected throw is preferable to charging a request that may
      // never have reached the SDK at all (§3.6).
      if (controller.signal.aborted) {
        return {
          status: 'timeout',
          deployed: false,
          preflight,
          ...(mode !== null ? { provisionMode: mode } : {}),
          errorMessage: 'deadline exceeded',
          fileNames: [],
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      logger?.error('[VerificationAgentRunner] unexpected error', { runId: req.runId, error: message });
      emitSeamError('verify-agent-error', err instanceof Error ? err : new Error(message), {
        agentKey: 'visual-verify',
      });
      return {
        status: 'skipped',
        deployed: false,
        preflight,
        ...(mode !== null ? { provisionMode: mode } : {}),
        errorMessage: `agent runner error: ${message}`,
        fileNames: [],
      };
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
