/**
 * runAgentPreflight — the agent-path pre-deploy gate
 * (docs/proposals/verification-setup-flow.md §3.5). The agent engine
 * (`VerificationAgentRunner`) bypasses the legacy `selectCandidates` health
 * gate entirely, so today a missing chromium (or an occupied leased port)
 * only surfaces *after* budget increment + snapshot provisioning + a full SDK
 * deploy (`driverCore.ts:330-336`) — an expensive, slow way to learn the host
 * cannot run the check at all. This module is the cheap check that runs
 * BEFORE any of that: chromium/node resolvable, the driver CLI present, and
 * the ports the agent is about to bind/attach to are genuinely free.
 *
 * Preflight results are the EVIDENCE BASE for the §3.1 conservative failure
 * classifier (`failureClassifier.ts`) — a failed check here is what lets a
 * downstream FAIL be reclassified `env` (advancing skip) instead of staying
 * lane-blocking. This is also the §1(e) "false-ready" fix's evidence
 * source: the port pool is an in-process mutex that "guards the logical
 * slot, NOT the OS socket" (shared/types/visualVerification.ts), so a
 * `port-free` check that actually connects to the leased port before launch
 * is what would have caught the production incident (a stale Vite from an
 * unrelated worktree answering 404 on a leased pool port).
 *
 * PURE MODULE — no `fs` / `net` / `child_process` import. Every side-effecting
 * probe (resolving node, resolving chromium, checking a file, dialing a port)
 * is INJECTED via {@link AgentPreflightDeps} so this file typechecks and unit
 * tests standalone; the runner (VerificationScheduler / VerificationAgentRunner)
 * wires the real implementations (Node's own `process.execPath`, Playwright's
 * chromium resolution, `fs.access`, a raw TCP connect probe).
 *
 * CRITICAL FAIL-OPEN RULE — read this before touching any check body: a probe
 * that THROWS is INCONCLUSIVE, not evidence. A preflight failure converts a
 * lane-blocking FAIL into an advancing SKIP downstream (via the classifier),
 * so only AFFIRMATIVE evidence may fail a check — chromium resolved `null`,
 * a file was confirmed absent, a port connect actually succeeded (a
 * squatter), or node resolution threw. A probe that merely COULDN'T ANSWER
 * (network hiccup, permission denial, an unexpected exception shape) must
 * record `ok:true` with the error folded into `detail` and let the run
 * proceed to the real deploy — guessing `ok:false` from an inconclusive probe
 * would let an env-eligible skip fire on no real evidence, which is exactly
 * the danger the classifier's own doc warns against (a false 'env' verdict
 * is dangerous — it advances the lane — while a false 'ambiguous' is merely
 * annoying).
 *
 * THE ONE EXCEPTION: `resolveNode()` throwing IS treated as affirmative
 * evidence (`ok:false`) — unlike the other probes, "node is unresolvable" is
 * itself the harness-derived fact being checked (there is no separate
 * "inconclusive" outcome for it: either a node binary was resolved, in which
 * case the deploy can proceed, or it wasn't, in which case nothing downstream
 * can run at all — the driver wrapper cannot even be written).
 */
import type { VerificationTaskV1 } from '../../../../shared/types/visualVerification';

/** One preflight check's outcome. Only checks that RAN appear in {@link AgentPreflightResult.checks}. */
export interface PreflightCheckResult {
  id: 'node' | 'chromium' | 'driver-cli' | 'port-free' | 'driver-port-free';
  ok: boolean;
  /** Bounded human-readable detail — what was resolved, or why the check failed / was inconclusive. */
  detail: string;
}

/** The aggregate preflight result: `ok` iff every APPLICABLE check ran and passed. */
export interface AgentPreflightResult {
  ok: boolean;
  /** The checks that ran, in the order {@link runAgentPreflight} evaluates them. Inapplicable checks are omitted, not recorded as skipped. */
  checks: PreflightCheckResult[];
}

/**
 * The injected probes `runAgentPreflight` calls. The runner wires real
 * implementations; tests wire fakes. Every probe may reject/throw — per the
 * module doc, a throw is inconclusive (fail-open) for every probe EXCEPT
 * `resolveNode`.
 */
export interface AgentPreflightDeps {
  /** Resolve an executable node path (e.g. `process.execPath`, or a resolved node binary for the driver wrapper). MUST throw when unresolvable — that throw is the affirmative evidence this check fails on. */
  resolveNode: () => Promise<string>;
  /** Resolve a launchable chromium binary path, or `null` when none is installed/resolvable. A throw here is INCONCLUSIVE (fail-open), not a `null`. */
  resolveChromium: () => Promise<string | null>;
  /** Whether a file exists at an absolute path (e.g. the driver CLI entrypoint). */
  fileExists: (absPath: string) => Promise<boolean>;
  /** `true` when nothing is listening on `port` (a connect attempt was refused/timed out); `false` when something answered — a squatter. */
  portFreeProbe: (port: number) => Promise<boolean>;
}

function errorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 'node' — ALWAYS applicable. Harness-derived: the driver wrapper (the
 * script the scheduler spawns to drive the CDP session) cannot be written or
 * executed without a resolvable node binary. `resolveNode()` throwing is the
 * one exception to the fail-open rule (see module doc) — it fails the check.
 */
async function checkNode(deps: AgentPreflightDeps): Promise<PreflightCheckResult> {
  try {
    const path = await deps.resolveNode();
    return { id: 'node', ok: true, detail: `resolved: ${path}` };
  } catch (err) {
    return { id: 'node', ok: false, detail: `node unresolvable: ${errorDetail(err)}` };
  }
}

/**
 * 'chromium' — applicable ONLY when `task.serve?.attach !== 'cdp'`. In
 * attach mode the driver ATTACHES to the deliverable app's OWN CDP endpoint
 * (`VERIFY_DRIVER_ATTACH_ONLY` — driverCore.ts's attach-only mode never
 * launches a browser, its "launch fallback is DISABLED"); no chromium is
 * ever needed. Every other shape — a web serve, a static build, or a bare
 * pre-live target (the degenerate path, `task.serve` absent entirely) —
 * drives via a chromium the driver launches itself, so the check runs.
 * `resolveChromium()` returning `null` is affirmative evidence (absent);
 * a throw is inconclusive (fail-open).
 */
async function checkChromium(deps: AgentPreflightDeps): Promise<PreflightCheckResult> {
  try {
    const path = await deps.resolveChromium();
    if (path === null) {
      return { id: 'chromium', ok: false, detail: 'chromium not resolved (absent)' };
    }
    return { id: 'chromium', ok: true, detail: `resolved: ${path}` };
  } catch (err) {
    return {
      id: 'chromium',
      ok: true,
      detail: `chromium probe inconclusive (fail-open): ${errorDetail(err)}`,
    };
  }
}

/** 'driver-cli' — ALWAYS applicable: the bundled driver CLI entrypoint must exist before the runner can spawn it. A `fileExists` throw is inconclusive (fail-open). */
async function checkDriverCli(deps: AgentPreflightDeps, driverCliPath: string): Promise<PreflightCheckResult> {
  try {
    const exists = await deps.fileExists(driverCliPath);
    if (!exists) {
      return { id: 'driver-cli', ok: false, detail: `driver CLI not found at ${driverCliPath}` };
    }
    return { id: 'driver-cli', ok: true, detail: `present at ${driverCliPath}` };
  } catch (err) {
    return {
      id: 'driver-cli',
      ok: true,
      detail: `driver-cli probe inconclusive (fail-open): ${errorDetail(err)}`,
    };
  }
}

/**
 * Shared port-probe body for both 'port-free' and 'driver-port-free'. A
 * connect-SUCCESS (`portFreeProbe` resolves `false`) is affirmative evidence
 * of a squatter — the §1(e) false-ready fix's evidence base. A throw is
 * inconclusive (fail-open): the probe couldn't determine occupancy either
 * way, so proceed and let the real deploy discover the truth.
 */
async function checkPortFree(
  deps: AgentPreflightDeps,
  id: 'port-free' | 'driver-port-free',
  port: number,
): Promise<PreflightCheckResult> {
  try {
    const free = await deps.portFreeProbe(port);
    if (!free) {
      return { id, ok: false, detail: `port ${port} is occupied — a connect probe succeeded (squatter)` };
    }
    return { id, ok: true, detail: `port ${port} free` };
  } catch (err) {
    return { id, ok: true, detail: `port ${port} probe inconclusive (fail-open): ${errorDetail(err)}` };
  }
}

/**
 * Run every APPLICABLE preflight check for a composed task, in order:
 * node → chromium (conditional) → driver-cli → port-free (conditional) →
 * driver-port-free. See each check's own doc for its applicability rule.
 * `ok` is the conjunction of every check that RAN; an inapplicable check is
 * simply absent from `checks`, never counted for or against `ok`.
 */
export async function runAgentPreflight(
  deps: AgentPreflightDeps,
  args: { task: VerificationTaskV1; driverCliPath: string; leasedPort: number; driverPort: number },
): Promise<AgentPreflightResult> {
  const { task, driverCliPath, leasedPort, driverPort } = args;
  const isAttachCdp = task.serve?.attach === 'cdp';
  const checks: PreflightCheckResult[] = [];

  checks.push(await checkNode(deps));

  if (!isAttachCdp) {
    checks.push(await checkChromium(deps));
  }

  checks.push(await checkDriverCli(deps, driverCliPath));

  // The agent must BIND the leased port itself only when there is a serve
  // step it is NOT attaching to an existing CDP endpoint for.
  if (task.serve !== undefined && !isAttachCdp) {
    checks.push(await checkPortFree(deps, 'port-free', leasedPort));
  }

  // The driver's own CDP port (or, in attach mode, the app's own CDP
  // endpoint) must always be free pre-launch.
  checks.push(await checkPortFree(deps, 'driver-port-free', driverPort));

  return { ok: checks.every((c) => c.ok), checks };
}
