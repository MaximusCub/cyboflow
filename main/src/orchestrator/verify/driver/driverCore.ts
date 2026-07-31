/**
 * driverCore — the logic behind `$VERIFY_DRIVER`, the bundled headless-browser
 * CLI the centrally-deployed verification agent drives from Bash (see
 * docs/proposals/verification-agent-redesign.md §5.4 step 4 + §8 question 1).
 * The agent's tool surface is `Bash`/`Read`/`Grep`/`Glob` only and its
 * `mcpServers` map is deliberately empty — this CLI is the auditable
 * replacement for a Playwright MCP server the agent would otherwise need.
 *
 * Each `goto` / `click` / `type` / `screenshot` / `stop` invocation is a
 * SEPARATE process, but they must all act on ONE living page. This module
 * solves that with CDP reconnection rather than any in-process state:
 *
 *   1. Try `chromium.connectOverCDP('http://127.0.0.1:<port>')`.
 *   2. On failure, resolve a chromium executable, spawn it DETACHED with
 *      `--remote-debugging-port=<port>` (so it outlives this CLI process),
 *      record its pid under `$VERIFY_ARTIFACTS_DIR/.driver/browser.pid`, wait
 *      for the CDP endpoint to accept connections, then connect.
 *   3. Reuse the browser's first context/page (create one if none).
 *   4. After the command runs, simply return — connectOverCDP's `Browser` is
 *      never `.close()`d for goto/click/type/screenshot, which leaves the
 *      real chromium process running (it was never owned by this process to
 *      begin with; we spawned it separately and detached it).
 *
 * ATTACH-ONLY mode (`VERIFY_DRIVER_ATTACH_ONLY=1`): step 2's launch fallback is
 * disabled — the driver connect-ONLY's, because the app under test (an Electron
 * or other web-view host launched by the task's `serve.cmd` with
 * `--remote-debugging-port="$VERIFY_DRIVER_PORT"`) IS the CDP endpoint. A failed
 * connect is a hard, actionable error rather than a blank-chromium launch that
 * would screenshot the wrong surface. No pid is ever recorded in this mode, so
 * `stop`'s SIGKILL path is a natural no-op (the graceful CDP `Browser.close`
 * still fires, closing the app the agent launched).
 *
 * `stop` closes the browser via CDP when the endpoint is still reachable,
 * else SIGKILLs the recorded pid, and always exits 0 (best-effort cleanup —
 * the harness's own sweeper is the backstop, per §5.4 step 6's port-probe /
 * lease-quarantine posture).
 *
 * ATTESTATION + NATIVE-SCREEN (docs/proposals/verification-setup-flow.md §7.1
 * + §4 footnote 2). Two families of subcommands were added on top of the
 * original five:
 *
 *  - `attest http|dom|cdp|window` — the per-modality VERIFIED-ARTIFACT-IDENTITY
 *    channels. §7.1's whole point is that neither a port lease nor an HTTP 200
 *    proves the surface the agent drove IS this request's deliverable (the port
 *    pool "guards the logical slot, NOT the OS socket"; a warm cache or the
 *    user's own running app answers just as happily). Each channel proves
 *    identity a different way — an injected per-request nonce read back over
 *    HTTP or out of the DOM, a build-stamped global evaluated over CDP, or (the
 *    weakest, native-only) a window title. EVERY attest invocation writes
 *    `<VERIFY_ARTIFACTS_DIR>/.driver/attest.json` — the SAME driver-owned
 *    dotdir as `browser.pid` — because the RUNNER trusts that file and NEVER
 *    the agent's own report echo: a model can claim it attested, it cannot
 *    forge a file only this CLI writes (`VerificationReportV1.attestation` is
 *    explicitly "for HUMAN display only"). A failed attestation still writes
 *    the file (with `ok:false`) and exits non-zero with the detail on stderr,
 *    so "the channel came up and disagreed" is distinguishable from "the agent
 *    never ran the step at all" (no file).
 *
 *  - `native-screenshot` — a Peekaboo capture of the REAL screen, the only
 *    observe path for the `native-screen` modality (no CDP endpoint exists for
 *    an arbitrary OS window). Paired with the DRIVE GUARD: when
 *    `VERIFY_MODALITY=native-screen`, `goto`/`click`/`type`/`screenshot` all
 *    REFUSE. Per §4 fn.², native driving has no executable path today (target
 *    identity with no DOM, abort semantics, and per-action evidence are all
 *    unspecified), so the modality is declared observe-only and a drive attempt
 *    must fail loudly rather than silently drive the WRONG surface — the CDP
 *    `screenshot` refuses for the same reason (there is no page to shoot).
 *
 * Everything here is pure/injectable: `runDriverCommand(argv, env, deps)`
 * takes a `DriverDeps` bag so unit tests can fake connect/launch/page
 * operations with no real browser. `playwright` itself is imported ONLY as a
 * type (erased at compile time) plus lazily via `await import('playwright')`
 * inside `createDefaultDriverDeps()`'s helpers — the same pattern
 * `playwrightBackend.ts` / `playwrightInstaller.ts` use so a build that
 * pruned the devDependency soft-fails instead of MODULE_NOT_FOUND-crashing.
 * `createDefaultDriverDeps()` is the only export that touches a real browser,
 * real filesystem, or a real child process; `driverCli.ts` is its only
 * caller.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { AttestationSpec } from '../../../../../shared/types/visualVerification';

/** Subdirectory (under VERIFY_ARTIFACTS_DIR) holding driver-owned state. */
const DRIVER_STATE_DIR = '.driver';

/** Filename (under DRIVER_STATE_DIR) recording the launched browser's pid. */
const PID_FILE_NAME = 'browser.pid';

/**
 * Filename (under DRIVER_STATE_DIR, beside `browser.pid`) recording the LAST
 * attestation this driver performed (§7.1). The runner reads THIS file for its
 * attestation verdict — never the agent's report echo — so it must live
 * somewhere only the driver writes.
 */
const ATTEST_FILE_NAME = 'attest.json';

/** Per-action timeout for click/type locator operations. */
export const ACTION_TIMEOUT_MS = 10_000;

/** Navigation timeout for goto. */
export const NAV_TIMEOUT_MS = 30_000;

/** How long to wait for a freshly-launched chromium's CDP endpoint to accept. */
export const LAUNCH_TIMEOUT_MS = 15_000;

/** How long an `attest http` GET may take before it counts as "channel never came up". */
export const ATTEST_HTTP_TIMEOUT_MS = 10_000;

/** How long ONE peekaboo invocation (window listing / screen capture) may run. */
export const PEEKABOO_TIMEOUT_MS = 30_000;

/** The peekaboo binary used when `VERIFY_PEEKABOO_BIN` is unset (matches peekabooBackend's bare-`peekaboo`-on-PATH assumption). */
export const DEFAULT_PEEKABOO_BIN = 'peekaboo';

/**
 * The exact refusal a drive command gets under `VERIFY_MODALITY=native-screen`
 * (§4 fn.²). Exported so the runner's harness contract and the tests can name
 * the one string rather than re-spelling it.
 */
export const NATIVE_SCREEN_DRIVE_REFUSAL =
  'drive-unsupported on native-screen (observe-only — proposal §4 fn.²)';

export const USAGE = `Usage:
  goto <url>
  click <selector>
  type <selector> <text...>
  screenshot <name> [--viewport WxH]
  native-screenshot <name> [--app <appTarget>]
  attest http <urlPath>
  attest dom <selector>
  attest cdp <expression> <expected>
  attest window <titlePattern>
  stop`;

// ---------------------------------------------------------------------------
// Command model
// ---------------------------------------------------------------------------

/**
 * The four attestation channels, as CLI subcommands. `channel` is the short
 * CLI word; {@link ATTEST_KIND_BY_CHANNEL} maps it onto the shared
 * {@link AttestationSpec} `kind` the runner matches against the task's
 * declared spec — the CLI stays terse while the recorded artifact speaks the
 * shared contract's vocabulary.
 */
export type AttestCommand =
  | { kind: 'attest'; channel: 'http'; urlPath: string }
  | { kind: 'attest'; channel: 'dom'; selector: string }
  | { kind: 'attest'; channel: 'cdp'; expression: string; expected: string }
  | { kind: 'attest'; channel: 'window'; titlePattern: string };

export type DriverCommand =
  | { kind: 'goto'; url: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'screenshot'; name: string; viewport?: { width: number; height: number } }
  | { kind: 'native-screenshot'; name: string; appTarget?: string }
  | AttestCommand
  | { kind: 'stop' };

/** CLI channel word → the shared {@link AttestationSpec} discriminant recorded in attest.json. */
export const ATTEST_KIND_BY_CHANNEL: Record<AttestCommand['channel'], AttestationSpec['kind']> = {
  http: 'http-endpoint',
  dom: 'dom-marker',
  cdp: 'cdp-token',
  window: 'window-identity',
};

/**
 * What the driver writes to `.driver/attest.json` — the runner's ONLY
 * attestation source of truth (§7.1). `kind` lets the runner reject a file
 * written by a DIFFERENT channel than the task declared (an agent that ran
 * `attest window` for a task whose spec is `http-endpoint` has not proven the
 * declared channel), and `at` makes a stale file from an earlier attempt
 * auditable.
 */
export interface DriverAttestRecord {
  ok: boolean;
  kind: AttestationSpec['kind'];
  detail: string;
  /** ISO-8601 timestamp of the attestation attempt. */
  at: string;
}

export type ParseArgvResult = { ok: true; command: DriverCommand } | { ok: false; message: string };

/**
 * Parse the driver CLI's argv (already stripped of the node/script path). Bad
 * args never throw — they return `{ ok: false }` so the caller can print USAGE
 * and exit non-zero.
 */
export function parseArgv(argv: string[]): ParseArgvResult {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'goto': {
      if (rest.length !== 1 || rest[0].trim().length === 0) {
        return { ok: false, message: 'goto requires exactly one argument: <url>' };
      }
      return { ok: true, command: { kind: 'goto', url: rest[0] } };
    }
    case 'click': {
      if (rest.length !== 1 || rest[0].trim().length === 0) {
        return { ok: false, message: 'click requires exactly one argument: <selector>' };
      }
      return { ok: true, command: { kind: 'click', selector: rest[0] } };
    }
    case 'type': {
      if (rest.length < 2) {
        return { ok: false, message: 'type requires two arguments: <selector> <text>' };
      }
      const [selector, ...textParts] = rest;
      return { ok: true, command: { kind: 'type', selector, text: textParts.join(' ') } };
    }
    case 'screenshot': {
      if (rest.length < 1) {
        return { ok: false, message: 'screenshot requires at least one argument: <name>' };
      }
      const [rawName, ...flags] = rest;
      let viewport: { width: number; height: number } | undefined;
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--viewport') {
          const raw = flags[i + 1];
          const parsed = raw ? parseViewport(raw) : null;
          if (!parsed) {
            return { ok: false, message: `invalid --viewport value: ${raw ?? '(missing)'}` };
          }
          viewport = parsed;
          i++;
        } else {
          return { ok: false, message: `unknown flag: ${flags[i]}` };
        }
      }
      const name = sanitizeScreenshotName(rawName);
      if (!name) {
        return { ok: false, message: `invalid screenshot name: ${rawName}` };
      }
      return { ok: true, command: { kind: 'screenshot', name, viewport } };
    }
    case 'native-screenshot': {
      if (rest.length < 1) {
        return { ok: false, message: 'native-screenshot requires at least one argument: <name>' };
      }
      const [rawName, ...flags] = rest;
      let appTarget: string | undefined;
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--app') {
          const raw = flags[i + 1];
          if (!raw || raw.trim().length === 0) {
            return { ok: false, message: '--app requires a value' };
          }
          appTarget = raw;
          i++;
        } else {
          return { ok: false, message: `unknown flag: ${flags[i]}` };
        }
      }
      const name = sanitizeScreenshotName(rawName);
      if (!name) {
        return { ok: false, message: `invalid screenshot name: ${rawName}` };
      }
      return { ok: true, command: { kind: 'native-screenshot', name, appTarget } };
    }
    case 'attest':
      return parseAttestArgv(rest);
    case 'stop': {
      if (rest.length !== 0) {
        return { ok: false, message: 'stop takes no arguments' };
      }
      return { ok: true, command: { kind: 'stop' } };
    }
    default:
      return { ok: false, message: cmd ? `unknown command: ${cmd}` : 'no command given' };
  }
}

/**
 * Parse the `attest <channel> ...` subcommand family (§7.1). Unlike `type`,
 * whose trailing words are JOINED into free text, every attest argument is a
 * COMPARISON TARGET (a url path, a selector, a JS expression, an expected
 * value, a title pattern), so each channel demands an EXACT arity and the
 * caller quotes anything containing spaces. A loose join here would silently
 * turn `attest cdp "a b" c` into a different comparison than the task
 * declared — precisely the class of quiet mismatch attestation exists to
 * prevent.
 */
function parseAttestArgv(rest: string[]): ParseArgvResult {
  const [channel, ...args] = rest;
  const nonEmpty = (i: number): boolean => typeof args[i] === 'string' && args[i].trim().length > 0;
  switch (channel) {
    case 'http':
      if (args.length !== 1 || !nonEmpty(0)) {
        return { ok: false, message: 'attest http requires exactly one argument: <urlPath>' };
      }
      return { ok: true, command: { kind: 'attest', channel: 'http', urlPath: args[0] } };
    case 'dom':
      if (args.length !== 1 || !nonEmpty(0)) {
        return { ok: false, message: 'attest dom requires exactly one argument: <selector>' };
      }
      return { ok: true, command: { kind: 'attest', channel: 'dom', selector: args[0] } };
    case 'cdp':
      if (args.length !== 2 || !nonEmpty(0) || !nonEmpty(1)) {
        return {
          ok: false,
          message: 'attest cdp requires exactly two arguments: <expression> <expected> (quote each)',
        };
      }
      return {
        ok: true,
        command: { kind: 'attest', channel: 'cdp', expression: args[0], expected: args[1] },
      };
    case 'window':
      if (args.length !== 1 || !nonEmpty(0)) {
        return {
          ok: false,
          message: 'attest window requires exactly one argument: <titlePattern> (quote it)',
        };
      }
      return { ok: true, command: { kind: 'attest', channel: 'window', titlePattern: args[0] } };
    default:
      return {
        ok: false,
        message: channel
          ? `unknown attest channel: ${channel} (expected http|dom|cdp|window)`
          : 'attest requires a channel: http|dom|cdp|window',
      };
  }
}

/** Parses a `WIDTHxHEIGHT` viewport spec (e.g. "1280x800"); null when malformed. */
function parseViewport(raw: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/i.exec(raw.trim());
  if (!match) return null;
  const width = Number.parseInt(match[1], 10);
  const height = Number.parseInt(match[2], 10);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * basename-only sanitization (mirrors `cyboflow_report_artifact`'s screenshot
 * fileName rule): strips any directory component so `../evil` -> `evil.png`,
 * then appends `.png` when absent. Returns null for a name that sanitizes to
 * nothing usable (e.g. "..", "/", "").
 */
export function sanitizeScreenshotName(raw: string): string | null {
  const base = basename(raw.trim());
  if (!base || base === '.' || base === '..') return null;
  return /\.png$/i.test(base) ? base : `${base}.png`;
}

// ---------------------------------------------------------------------------
// Dependency seam (the "playwright-like object" tests inject)
// ---------------------------------------------------------------------------

export interface DriverDeps {
  /** `chromium.connectOverCDP(endpointUrl)` — rejects when nothing is listening. */
  connectOverCDP(endpointUrl: string): Promise<Browser>;
  /** Resolve a real chromium binary path, or null when none is installed. */
  resolveChromiumExecutable(): Promise<string | null>;
  /** Launch chromium DETACHED with a CDP port; returns its pid. */
  spawnDetachedChromium(args: {
    executablePath: string;
    port: number;
    userDataDir: string;
  }): Promise<{ pid: number }>;
  /** Poll the CDP endpoint until it accepts connections or timeoutMs elapses. */
  waitForCdpReady(port: number, timeoutMs: number): Promise<void>;
  /** `browser.close()` — for a CDP-attached Browser this terminates it. */
  closeBrowser(browser: Browser): Promise<void>;
  readPidFile(path: string): Promise<number | null>;
  writePidFile(path: string, pid: number): Promise<void>;
  removePidFile(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  isProcessAlive(pid: number): boolean;
  killPid(pid: number, signal: NodeJS.Signals): void;
  /**
   * Plain HTTP GET for the `http-endpoint` attestation channel. Deliberately
   * NOT routed through the browser: the point is to read the serve step's
   * injected marker route directly, with no page, no navigation, and no
   * chromium — it must work for an attach-mode or headless-less deliverable
   * too. Rejecting (connection refused, timeout) is an attestation FAILURE,
   * never a crash.
   */
  httpGet(url: string, timeoutMs: number): Promise<{ status: number; body: string }>;
  /**
   * Run the peekaboo CLI (`window-identity` attestation + `native-screenshot`).
   * Resolves stdout on a clean exit; rejects on non-zero exit / spawn error /
   * timeout — a missing binary therefore surfaces as a failed attestation with
   * the spawn error in its detail, never an unhandled throw.
   */
  runPeekaboo(bin: string, args: string[], timeoutMs: number): Promise<string>;
  /** Write `.driver/attest.json` (creating the dotdir) — the runner's attestation source of truth. */
  writeAttestFile(path: string, record: DriverAttestRecord): Promise<void>;
  stdout(line: string): void;
  stderr(line: string): void;
}

/** `$VERIFY_ARTIFACTS_DIR/.driver/browser.pid` — exported so tests can assert on it. */
export function pidFilePath(artifactsDir: string): string {
  return join(artifactsDir, DRIVER_STATE_DIR, PID_FILE_NAME);
}

/**
 * `$VERIFY_ARTIFACTS_DIR/.driver/attest.json` — the attestation record's path,
 * exported so `verificationAgentRunner`'s default reader and the tests resolve
 * it through the SAME function the writer uses (a path the two ends spelled
 * separately would silently degrade every attestation to "missing").
 */
export function attestFilePath(artifactsDir: string): string {
  return join(artifactsDir, DRIVER_STATE_DIR, ATTEST_FILE_NAME);
}

/**
 * The peekaboo argv for listing the host's windows (`attest window`).
 *
 * `peekabooBackend.ts` — the repo's only other peekaboo integration — pins
 * exactly two invocations: `permissions --json` and
 * `image --app <target> --path <out>`. The window LISTING form is extrapolated
 * from that `--json` convention and has NOT been smoked against a live binary
 * (native-screen is observe-only and its drive/identity surface is a designed
 * prerequisite, §4 fn.²). It is a named function precisely so a live smoke has
 * ONE place to correct, and {@link extractWindowTitles} parses its output
 * defensively rather than assuming a schema.
 */
export function peekabooListWindowsArgs(): string[] {
  return ['list', 'windows', '--json'];
}

/**
 * The peekaboo argv for a screen capture — the SAME flags
 * `DefaultPeekabooClient.capture` uses (`image --app <target> --path <out>`).
 * `--app` is omitted when no target was named, which captures the frontmost
 * surface rather than guessing an app the task never declared.
 */
export function peekabooCaptureArgs(outPath: string, appTarget?: string): string[] {
  return appTarget ? ['image', '--app', appTarget, '--path', outPath] : ['image', '--path', outPath];
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

type EnvCheck =
  | { ok: true; port: number; artifactsDir: string; attachOnly: boolean }
  | { ok: false; message: string };

/** Validates VERIFY_DRIVER_PORT + VERIFY_ARTIFACTS_DIR for the browser-touching commands. */
function requireEnv(env: NodeJS.ProcessEnv): EnvCheck {
  const portRaw = env.VERIFY_DRIVER_PORT;
  if (!portRaw || portRaw.trim().length === 0) {
    return { ok: false, message: 'VERIFY_DRIVER_PORT is required but not set' };
  }
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return { ok: false, message: `VERIFY_DRIVER_PORT is not a valid port: ${portRaw}` };
  }
  const artifactsDir = env.VERIFY_ARTIFACTS_DIR;
  if (!artifactsDir || artifactsDir.trim().length === 0) {
    return { ok: false, message: 'VERIFY_ARTIFACTS_DIR is required but not set' };
  }
  // Attach-only (VERIFY_DRIVER_ATTACH_ONLY=1): the app under test is launched by
  // the task's serve.cmd exposing CDP on VERIFY_DRIVER_PORT, so the connect-or-
  // launch fallback becomes connect-ONLY — never launch a blank chromium (which
  // would let the agent screenshot the WRONG surface and mis-judge).
  const attachOnly = env.VERIFY_DRIVER_ATTACH_ONLY === '1';
  return { ok: true, port, artifactsDir, attachOnly };
}

/**
 * True for the two attestation channels that need a live CDP page. The other
 * two are deliberately PAGELESS: `http-endpoint` reads the serve step's
 * injected marker route with a plain GET (no page, no navigation, no chromium
 * — it must work for an attach-mode deliverable too), and `window-identity` is
 * peekaboo-only by construction. Demanding a browser for those would make them
 * unrunnable on exactly the hosts they exist to serve.
 */
function attestNeedsPage(command: AttestCommand): boolean {
  return command.channel === 'dom' || command.channel === 'cdp';
}

/** True for the four commands that DRIVE or shoot the CDP surface — the ones native-screen refuses (§4 fn.²). */
function isDriveCommand(command: DriverCommand): boolean {
  return (
    command.kind === 'goto' ||
    command.kind === 'click' ||
    command.kind === 'type' ||
    command.kind === 'screenshot'
  );
}

/** VERIFY_ARTIFACTS_DIR alone — all the pageless commands need (no port, no browser). */
function requireArtifactsDir(env: NodeJS.ProcessEnv): { ok: true; artifactsDir: string } | { ok: false; message: string } {
  const artifactsDir = env.VERIFY_ARTIFACTS_DIR;
  if (!artifactsDir || artifactsDir.trim().length === 0) {
    return { ok: false, message: 'VERIFY_ARTIFACTS_DIR is required but not set' };
  }
  return { ok: true, artifactsDir };
}

/**
 * Entry point: parse argv, dispatch, return a process exit code. `stop` is
 * handled separately (it must always exit 0 — missing env there just means
 * "nothing recorded to clean up", not an error) and does not require env.
 *
 * Dispatch order is load-bearing: the native-screen DRIVE GUARD fires BEFORE
 * any env validation or CDP connect, so a drive attempt under that modality
 * always yields the same explicit refusal instead of an incidental
 * "CDP endpoint not reachable" that reads like a transient infra hiccup.
 */
export async function runDriverCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: DriverDeps,
): Promise<number> {
  const parsed = parseArgv(argv);
  if (!parsed.ok) {
    deps.stderr(parsed.message);
    deps.stderr(USAGE);
    return 1;
  }
  const command = parsed.command;

  if (command.kind === 'stop') {
    return stopCommand(env, deps);
  }

  // Native-screen is OBSERVE-ONLY (§4 fn.²): driving it has no executable path
  // (no DOM ⇒ no target identity; abort semantics + per-action evidence are
  // unspecified), so a drive command must fail LOUDLY here rather than reach a
  // CDP endpoint that — if one happens to be listening — belongs to some other
  // surface entirely.
  if (env.VERIFY_MODALITY === 'native-screen' && isDriveCommand(command)) {
    deps.stderr(NATIVE_SCREEN_DRIVE_REFUSAL);
    deps.stderr('native-screen surface: "native-screenshot <name>" to observe, "attest window <titlePattern>" to attest.');
    return 1;
  }

  if (command.kind === 'native-screenshot') {
    const dirResult = requireArtifactsDir(env);
    if (!dirResult.ok) {
      deps.stderr(dirResult.message);
      return 1;
    }
    return nativeScreenshotCommand(command, env, dirResult.artifactsDir, deps);
  }

  if (command.kind === 'attest') {
    if (!attestNeedsPage(command)) {
      const dirResult = requireArtifactsDir(env);
      if (!dirResult.ok) {
        deps.stderr(dirResult.message);
        return 1;
      }
      return runAttestCommand(command, env, dirResult.artifactsDir, deps, null);
    }
    const pageEnv = requireEnv(env);
    if (!pageEnv.ok) {
      deps.stderr(pageEnv.message);
      return 1;
    }
    // The page is acquired LAZILY so a failed connect is recorded as a FAILED
    // attestation (ok:false in attest.json) rather than a bare non-zero exit
    // with no file — the runner distinguishes "the channel disagreed" from
    // "the step never ran" purely by that file's presence.
    return runAttestCommand(command, env, pageEnv.artifactsDir, deps, () =>
      ensurePage(pageEnv.port, pageEnv.artifactsDir, pageEnv.attachOnly, deps),
    );
  }

  const envResult = requireEnv(env);
  if (!envResult.ok) {
    deps.stderr(envResult.message);
    return 1;
  }

  try {
    const page = await ensurePage(
      envResult.port,
      envResult.artifactsDir,
      envResult.attachOnly,
      deps,
    );
    return await executeCommand(command, page, envResult.artifactsDir, deps);
  } catch (err) {
    deps.stderr(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/**
 * connect-first-then-launch: tries CDP reconnection before ever launching a
 * browser. In `attachOnly` mode the launch fallback is DISABLED — a failed
 * connect is a hard error (the app under test must already be listening on the
 * driver port), because launching a blank chromium there would screenshot the
 * wrong surface. Attach mode also prefers the first NON-devtools page: an
 * Electron target's CDP endpoint commonly exposes `devtools://` inspector
 * pages alongside the real app window.
 */
async function ensurePage(
  port: number,
  artifactsDir: string,
  attachOnly: boolean,
  deps: DriverDeps,
): Promise<Page> {
  const cdpUrl = `http://127.0.0.1:${port}`;
  let browser: Browser;
  try {
    browser = await deps.connectOverCDP(cdpUrl);
  } catch {
    if (attachOnly) {
      throw new Error(
        `CDP endpoint not reachable on port ${port} — in attach mode the app under test must already be listening (launch it with --remote-debugging-port="$VERIFY_DRIVER_PORT" and wait for it to boot)`,
      );
    }
    browser = await launchAndConnect(port, artifactsDir, deps);
  }

  const contexts = browser.contexts();
  const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
  const pages = context.pages();
  const usablePages = attachOnly ? pages.filter((p) => !isDevtoolsPage(p)) : pages;
  const page = usablePages.length > 0 ? usablePages[0] : await context.newPage();
  return page;
}

/**
 * True for a `devtools://` inspector page. Guards on `url` being a callable
 * (real Playwright `Page.url()`) so the test seam's fake page — which has no
 * `url()` — is simply never treated as a devtools page.
 */
function isDevtoolsPage(page: Page): boolean {
  if (typeof page.url !== 'function') return false;
  try {
    return page.url().startsWith('devtools://');
  } catch {
    return false;
  }
}

async function launchAndConnect(port: number, artifactsDir: string, deps: DriverDeps): Promise<Browser> {
  const executablePath = await deps.resolveChromiumExecutable();
  if (!executablePath) {
    throw new Error(
      'chromium executable not found — run `npx playwright install chromium` in the app environment',
    );
  }
  await deps.ensureDir(join(artifactsDir, DRIVER_STATE_DIR));
  const { pid } = await deps.spawnDetachedChromium({
    executablePath,
    port,
    userDataDir: join(artifactsDir, DRIVER_STATE_DIR, 'profile'),
  });
  await deps.writePidFile(pidFilePath(artifactsDir), pid);
  await deps.waitForCdpReady(port, LAUNCH_TIMEOUT_MS);
  return deps.connectOverCDP(`http://127.0.0.1:${port}`);
}

async function executeCommand(
  command: Exclude<DriverCommand, { kind: 'stop' } | { kind: 'attest' } | { kind: 'native-screenshot' }>,
  page: Page,
  artifactsDir: string,
  deps: DriverDeps,
): Promise<number> {
  switch (command.kind) {
    case 'goto': {
      const response = await page.goto(command.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
      if (response && !response.ok()) {
        deps.stderr(`goto failed: ${command.url} returned HTTP ${response.status()}`);
        return 1;
      }
      deps.stdout(`ok: navigated to ${command.url}`);
      return 0;
    }
    case 'click': {
      await page.locator(command.selector).click({ timeout: ACTION_TIMEOUT_MS });
      deps.stdout(`ok: clicked ${command.selector}`);
      return 0;
    }
    case 'type': {
      await page.locator(command.selector).fill(command.text, { timeout: ACTION_TIMEOUT_MS });
      deps.stdout(`ok: typed into ${command.selector}`);
      return 0;
    }
    case 'screenshot': {
      if (command.viewport) {
        await page.setViewportSize(command.viewport);
      }
      await deps.ensureDir(artifactsDir);
      await page.screenshot({ path: join(artifactsDir, command.name) });
      deps.stdout(`ok: screenshot ${command.name}`);
      return 0;
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`unhandled driver command: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Attestation (§7.1) + the native-screen observe surface (§4 fn.²)
// ---------------------------------------------------------------------------

/** The verdict one attestation channel produced. Never thrown past {@link runAttestCommand}. */
interface AttestOutcome {
  ok: boolean;
  detail: string;
}

/** Resolve the peekaboo binary: the runner-exported override, else the bare PATH name. */
function resolvePeekabooBin(env: NodeJS.ProcessEnv): string {
  const raw = env.VERIFY_PEEKABOO_BIN;
  return raw && raw.trim().length > 0 ? raw.trim() : DEFAULT_PEEKABOO_BIN;
}

/** Bound a value echoed into an attest detail so a huge evaluate() result cannot bloat the record. */
function truncateDetail(value: string, max = 200): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Run ONE attest command end-to-end: evaluate the channel, ALWAYS write
 * `.driver/attest.json`, then exit 0/1. A probe that THROWS (connection
 * refused, missing peekaboo binary, an unreachable CDP endpoint) is recorded
 * as `ok:false` with the error in `detail` rather than escaping — the runner
 * must be able to tell "the channel came up and disagreed" (file, ok:false)
 * from "the agent never ran the attest step" (no file at all), and a throw
 * that skipped the write would collapse the two.
 *
 * The attest-file write itself is FAIL-SOFT: a write failure is reported on
 * stderr and forces a non-zero exit (a successful attestation the runner
 * cannot see is worthless, so it must not read as success), but it never
 * throws out of the CLI.
 */
async function runAttestCommand(
  command: AttestCommand,
  env: NodeJS.ProcessEnv,
  artifactsDir: string,
  deps: DriverDeps,
  getPage: (() => Promise<Page>) | null,
): Promise<number> {
  const kind = ATTEST_KIND_BY_CHANNEL[command.channel];
  let outcome: AttestOutcome;
  try {
    outcome = await evaluateAttestation(command, env, deps, getPage);
  } catch (err) {
    outcome = {
      ok: false,
      detail: `${kind}: probe failed — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const record: DriverAttestRecord = {
    ok: outcome.ok,
    kind,
    detail: outcome.detail,
    at: new Date().toISOString(),
  };
  let written = true;
  try {
    await deps.ensureDir(join(artifactsDir, DRIVER_STATE_DIR));
    await deps.writeAttestFile(attestFilePath(artifactsDir), record);
  } catch (err) {
    written = false;
    deps.stderr(
      `failed to write ${attestFilePath(artifactsDir)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!outcome.ok) {
    deps.stderr(outcome.detail);
    return 1;
  }
  if (!written) return 1;
  deps.stdout(`ok: attested ${kind} — ${outcome.detail}`);
  return 0;
}

/**
 * Evaluate one attestation channel. Each returns an explicit ok/detail rather
 * than throwing for a NEGATIVE result — a throw is reserved for "the probe
 * could not run", which {@link runAttestCommand} folds into the same
 * `ok:false` record (§7.1's rule is that an unproven identity never passes,
 * whatever the reason).
 */
async function evaluateAttestation(
  command: AttestCommand,
  env: NodeJS.ProcessEnv,
  deps: DriverDeps,
  getPage: (() => Promise<Page>) | null,
): Promise<AttestOutcome> {
  switch (command.channel) {
    case 'http': {
      const nonce = env.VERIFY_ATTEST_NONCE;
      if (!nonce || nonce.trim().length === 0) {
        return { ok: false, detail: 'http-endpoint: VERIFY_ATTEST_NONCE is not set (nothing to prove identity with)' };
      }
      const portRaw = env.VERIFY_PORT;
      const port = portRaw ? Number.parseInt(portRaw, 10) : NaN;
      if (!Number.isFinite(port) || port <= 0) {
        return { ok: false, detail: `http-endpoint: VERIFY_PORT is not a valid port: ${portRaw ?? '(unset)'}` };
      }
      const path = command.urlPath.startsWith('/') ? command.urlPath : `/${command.urlPath}`;
      const url = `http://127.0.0.1:${port}${path}`;
      const res = await deps.httpGet(url, ATTEST_HTTP_TIMEOUT_MS);
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, detail: `http-endpoint ${url} returned HTTP ${res.status}` };
      }
      if (!res.body.includes(nonce)) {
        return {
          ok: false,
          detail: `http-endpoint ${url} answered HTTP ${res.status} but its body does not carry this request's nonce — the surface on that port is NOT this deliverable`,
        };
      }
      return { ok: true, detail: `http-endpoint ${url} returned this request's nonce` };
    }
    case 'dom': {
      const nonce = env.VERIFY_ATTEST_NONCE;
      if (!nonce || nonce.trim().length === 0) {
        return { ok: false, detail: 'dom-marker: VERIFY_ATTEST_NONCE is not set (nothing to prove identity with)' };
      }
      if (!getPage) {
        return { ok: false, detail: 'dom-marker: no page available (the driver could not be given a CDP surface)' };
      }
      const page = await getPage();
      const locator = page.locator(command.selector);
      // Text AND the data-verify-nonce attribute: a deliverable that cannot
      // render the nonce as visible copy can still stamp it on an attribute.
      const text = await locator.textContent({ timeout: ACTION_TIMEOUT_MS });
      const attr = await locator.getAttribute('data-verify-nonce', { timeout: ACTION_TIMEOUT_MS });
      const haystack = `${text ?? ''}\n${attr ?? ''}`;
      if (!haystack.includes(nonce)) {
        return {
          ok: false,
          detail: `dom-marker "${command.selector}" was found but neither its text nor its data-verify-nonce attribute carries this request's nonce`,
        };
      }
      return { ok: true, detail: `dom-marker "${command.selector}" carries this request's nonce` };
    }
    case 'cdp': {
      if (!getPage) {
        return { ok: false, detail: 'cdp-token: no page available (the driver could not be given a CDP surface)' };
      }
      const page = await getPage();
      // Evaluated over the EXISTING page, which is what makes this the only
      // channel that works in attach mode: the app under test is already
      // running and there is no navigation to hang an identity check off.
      const value = await page.evaluate(command.expression);
      const actual = String(value);
      if (actual !== command.expected) {
        return {
          ok: false,
          detail: `cdp-token: ${command.expression} evaluated to "${truncateDetail(actual)}", expected "${truncateDetail(command.expected)}"`,
        };
      }
      return { ok: true, detail: `cdp-token: ${command.expression} matched "${truncateDetail(command.expected)}"` };
    }
    case 'window': {
      const bin = resolvePeekabooBin(env);
      const stdout = await deps.runPeekaboo(bin, peekabooListWindowsArgs(), PEEKABOO_TIMEOUT_MS);
      const titles = extractWindowTitles(stdout);
      const matcher = compileTitleMatcher(command.titlePattern);
      const matched = titles.find((t) => matcher(t));
      if (matched === undefined) {
        return {
          ok: false,
          detail: `window-identity (weakest channel): no window title matching /${command.titlePattern}/ among ${titles.length} listed window(s)`,
        };
      }
      return {
        ok: true,
        detail: `window-identity (weakest channel): matched window title "${truncateDetail(matched)}"`,
      };
    }
  }
}

/**
 * Compile a title pattern into a predicate. A valid regex source is used as a
 * regex; an INVALID one degrades to a plain substring test rather than
 * throwing — a malformed pattern must not turn into "probe failed" noise when
 * the honest answer ("does any window title contain this?") is still
 * computable.
 */
function compileTitleMatcher(pattern: string): (title: string) => boolean {
  try {
    const re = new RegExp(pattern);
    return (title) => re.test(title);
  } catch {
    return (title) => title.includes(pattern);
  }
}

/**
 * Pull candidate window titles out of a peekaboo listing. DELIBERATELY
 * schema-tolerant: peekaboo's JSON shape varies by version (the same reason
 * `peekabooBackend.parsePermissionsJson` reads its grants loosely), and the
 * listing subcommand itself is un-smoked (see {@link peekabooListWindowsArgs}).
 * So this walks any JSON structure collecting string values under the keys a
 * window title plausibly lives on, and falls back to treating the raw stdout
 * as one title per line when the output is not JSON at all. Over-collecting is
 * safe: a title that does not match the pattern simply never matches.
 */
export function extractWindowTitles(stdout: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stdout);
    const titles: string[] = [];
    collectTitles(parsed, titles);
    if (titles.length > 0) return titles;
  } catch {
    // not JSON — fall through to the line-oriented reading below.
  }
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Recursive half of {@link extractWindowTitles} (JSON has no cycles, so plain recursion is safe). */
function collectTitles(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTitles(item, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  for (const key of ['title', 'window_title', 'windowTitle', 'name', 'app_name', 'appName']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) out.push(candidate);
  }
  for (const nested of Object.values(record)) {
    if (typeof nested === 'object' && nested !== null) collectTitles(nested, out);
  }
}

/**
 * `native-screenshot <name>` — a Peekaboo capture into VERIFY_ARTIFACTS_DIR,
 * the ONLY observe path for the `native-screen` modality (an arbitrary OS
 * window exposes no CDP endpoint, so the chromium `screenshot` command cannot
 * see it). Allowed regardless of attach mode: it never touches the browser.
 * A peekaboo failure (missing binary, declined TCC grant, non-zero exit)
 * exits non-zero with the error on stderr — the agent must report
 * `not_testable` rather than fabricate a capture.
 */
async function nativeScreenshotCommand(
  command: Extract<DriverCommand, { kind: 'native-screenshot' }>,
  env: NodeJS.ProcessEnv,
  artifactsDir: string,
  deps: DriverDeps,
): Promise<number> {
  try {
    await deps.ensureDir(artifactsDir);
    await deps.runPeekaboo(
      resolvePeekabooBin(env),
      peekabooCaptureArgs(join(artifactsDir, command.name), command.appTarget),
      PEEKABOO_TIMEOUT_MS,
    );
    deps.stdout(`ok: native screenshot ${command.name}`);
    return 0;
  } catch (err) {
    deps.stderr(`native-screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * `stop` is best-effort cleanup and ALWAYS exits 0 (§5.4 step 6 — the
 * harness's port probe + lease quarantine is the real backstop, this is just
 * hygiene). Attempts a graceful CDP close when the endpoint is reachable, then
 * ALWAYS SIGKILLs the recorded pid: playwright's `close()` on a connectOverCDP
 * browser only DISCONNECTS the client, so a "successful" CDP close can leave
 * the spawned chromium alive and the port bound (observed live: leaked process
 * + port quarantine). SIGKILL is uncatchable, so once issued the pid file is
 * safe to remove. Missing env / no pid file / an already-gone process are all
 * silently fine.
 */
async function stopCommand(env: NodeJS.ProcessEnv, deps: DriverDeps): Promise<number> {
  const artifactsDir = env.VERIFY_ARTIFACTS_DIR;
  const portRaw = env.VERIFY_DRIVER_PORT;
  const port = portRaw ? Number.parseInt(portRaw, 10) : NaN;

  // Graceful CDP close first — never trusted as the kill (see the doc above).
  if (Number.isFinite(port) && port > 0) {
    try {
      const browser = await deps.connectOverCDP(`http://127.0.0.1:${port}`);
      await deps.closeBrowser(browser);
    } catch {
      // unreachable — the pid kill below is the real teardown.
    }
  }

  if (artifactsDir) {
    try {
      const pid = await deps.readPidFile(pidFilePath(artifactsDir));
      if (pid !== null && deps.isProcessAlive(pid)) {
        deps.killPid(pid, 'SIGKILL');
      }
    } catch {
      // best-effort — stop never fails the process.
    }
    await deps.removePidFile(pidFilePath(artifactsDir)).catch(() => {});
  }

  deps.stdout('ok: stopped');
  return 0;
}

// ---------------------------------------------------------------------------
// Real deps (the only part of this module that touches a real browser / fs / child process)
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `playwright` is loaded LAZILY here (never at module scope) — same
 * contract as `playwrightBackend.ts` / `playwrightInstaller.ts`: a packaged
 * build that pruned the devDependency soft-fails at call time instead of
 * MODULE_NOT_FOUND-crashing this CLI's boot.
 */
async function defaultConnectOverCDP(endpointUrl: string): Promise<Browser> {
  const { chromium } = await import('playwright');
  return chromium.connectOverCDP(endpointUrl);
}

async function defaultResolveChromiumExecutable(): Promise<string | null> {
  try {
    const { chromium } = await import('playwright');
    const p = chromium.executablePath();
    if (typeof p !== 'string' || p.length === 0) return null;
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * The SAME chromium resolution the driver's launch fallback uses, exported so
 * the agent-path PREFLIGHT (docs/proposals/verification-setup-flow.md §3.5,
 * `../preflight.ts`) can answer "is a launchable chromium present on this host?"
 * BEFORE a budget increment + snapshot provisioning + a full SDK deploy — today
 * a missing chromium only surfaces here, at driver-launch time, deep inside the
 * deployed agent's session (the §1 "launch_failed" bucket).
 *
 * Resolution must go through THIS function rather than a re-implementation, so
 * the preflight verdict and the driver's own behavior can never disagree: a
 * preflight that says "present" while the driver then fails to resolve one would
 * classify a genuine env failure as `'ambiguous'`, and the reverse would skip a
 * lane on a host that could actually have run the check.
 *
 * `null` means AFFIRMATIVELY absent (playwright resolved no path, or the
 * resolved path does not exist); a resolution error is swallowed to `null` by
 * the delegate, which the preflight's chromium check treats as absent — the one
 * place its fail-open rule is bounded by the delegate's own catch.
 */
export function probeChromiumExecutable(): Promise<string | null> {
  return defaultResolveChromiumExecutable();
}

async function defaultSpawnDetachedChromium(args: {
  executablePath: string;
  port: number;
  userDataDir: string;
}): Promise<{ pid: number }> {
  const child = spawn(
    args.executablePath,
    [
      `--remote-debugging-port=${args.port}`,
      '--remote-debugging-address=127.0.0.1',
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${args.userDataDir}`,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  if (!child.pid) {
    throw new Error('failed to spawn chromium: no pid assigned');
  }
  return { pid: child.pid };
}

async function defaultWaitForCdpReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/json/version`;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  const suffix = lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : '';
  throw new Error(`CDP endpoint on port ${port} did not become ready within ${timeoutMs}ms${suffix}`);
}

async function defaultReadPidFile(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function defaultWritePidFile(path: string, pid: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, String(pid), 'utf8');
}

async function defaultRemovePidFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultKillPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // already gone — stop is best-effort.
  }
}

/**
 * Plain `fetch` with a hard deadline — no browser, no playwright. A refused
 * connection / timeout REJECTS, which {@link runAttestCommand} records as a
 * failed attestation (the honest reading: the identity channel never came up).
 */
async function defaultHttpGet(url: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.text();
  return { status: res.status, body };
}

/**
 * Spawn the peekaboo CLI and resolve its stdout on a clean exit. Mirrors
 * `DefaultPeekabooClient.run`'s contract (non-zero exit / spawn error /
 * timeout all reject, with the child SIGKILLed so a wedged binary never
 * lingers) but lives here so the standalone driver CLI keeps its
 * node-builtins-only posture — it must not import an Electron-side service.
 */
function defaultRunPeekaboo(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: Error) => finish(() => reject(err)));
    child.on('close', (code: number | null) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${bin} exited ${code ?? 'null'}${stderr ? `: ${stderr.trim()}` : ''}`));
      });
    });
  });
}

async function defaultWriteAttestFile(path: string, record: DriverAttestRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record), 'utf8');
}

/** Builds the real DriverDeps used by driverCli.ts. Never used by tests. */
export function createDefaultDriverDeps(): DriverDeps {
  return {
    connectOverCDP: defaultConnectOverCDP,
    resolveChromiumExecutable: defaultResolveChromiumExecutable,
    spawnDetachedChromium: defaultSpawnDetachedChromium,
    waitForCdpReady: defaultWaitForCdpReady,
    closeBrowser: async (browser) => {
      // `browser.close()` on a connectOverCDP browser only disconnects the
      // client — the CDP protocol `Browser.close` command is what actually
      // terminates the browser process. Send it first (chromium-only API, which
      // is the only browser this driver ever spawns), then disconnect; either
      // half failing falls through to stop's unconditional pid SIGKILL.
      try {
        const session = await browser.newBrowserCDPSession();
        await session.send('Browser.close');
      } catch {
        // endpoint already gone or non-chromium — the disconnect below still runs.
      }
      await browser.close().catch(() => {});
    },
    readPidFile: defaultReadPidFile,
    writePidFile: defaultWritePidFile,
    removePidFile: defaultRemovePidFile,
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    isProcessAlive: defaultIsProcessAlive,
    killPid: defaultKillPid,
    httpGet: defaultHttpGet,
    runPeekaboo: defaultRunPeekaboo,
    writeAttestFile: defaultWriteAttestFile,
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}
