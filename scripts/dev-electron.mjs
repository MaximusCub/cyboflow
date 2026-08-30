#!/usr/bin/env node
/**
 * dev-electron — cross-platform Electron launcher for the dev scripts.
 *
 * Replaces the former inline chain `wait-on http://localhost:${VITE} &&
 * env -u NODE_OPTIONS electron . <flags>`, whose `${VAR:-default}` expansion
 * and `env -u` are POSIX-only — on Windows `pnpm dev` could not start the
 * Electron half at all (cmd cannot run that syntax).
 *
 * What it does (same net effect on every platform):
 *   1. Waits for the Vite dev server (default port 4521, CYBOFLOW_VITE_PORT
 *      override) — replaces `wait-on`.
 *   2. Strips NODE_OPTIONS from the child env (replaces `env -u`), because
 *      the Electron binary rejects some host-only NODE_OPTIONS flags.
 *   3. Spawns the real Electron binary (resolved from the electron package)
 *      on the repo root, forwarding every flag this script was not told to
 *      own, and pipes stdio through.
 *
 * Flags owned by this script (never forwarded verbatim):
 *   --cdp      append `--remote-debugging-port=<CYBOFLOW_CDP_PORT || 9223>`
 *   --inspect  append `--inspect=<CYBOFLOW_INSPECT_PORT || 9229>`
 *   --perf     set CYBOFLOW_PERF_TRACE=1 in the child env
 * Everything else is forwarded to Electron as-is (e.g. extra Chromium flags).
 * Exits with the child's exit code; while the child is alive a SIGINT/SIGTERM
 * is forwarded to it, and if the child dies FROM a signal this wrapper
 * re-raises the same signal onto itself (after dropping its own handlers), so
 * the wrapper and `concurrently` terminate with the shell-conventional code
 * instead of hanging around a dead child.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const wants = (flag) => argv.includes(flag);
const forwarded = argv.filter((a) => !['--cdp', '--inspect', '--perf'].includes(a));
const cdpPort = process.env.CYBOFLOW_CDP_PORT || '9223';
const inspectPort = process.env.CYBOFLOW_INSPECT_PORT || '9229';
const vitePort = process.env.CYBOFLOW_VITE_PORT || '4521';

if (wants('--cdp')) forwarded.push(`--remote-debugging-port=${cdpPort}`);
if (wants('--inspect')) forwarded.push(`--inspect=${inspectPort}`);

// The electron npm package resolves to the binary path string when required
// from plain Node (outside Electron itself).
const require = createRequire(import.meta.url);
const electronBinary = require('electron');
if (typeof electronBinary !== 'string' || !electronBinary) {
  console.error('[dev-electron] could not resolve the electron binary — run pnpm install first');
  process.exit(1);
}

/**
 * Poll the Vite server; any HTTP response means it is up.
 *
 * The response STATUS is deliberately not checked (anything 2xx-5xx counts):
 * Vite answers 200 on `/`, and a 5xx can only come from a non-Vite squatter
 * that grabbed the port — dev-only noise that would just block the launch,
 * not worth failing over. Connection errors, the real signal that Vite is
 * not up yet, are what the retry loop waits out.
 */
async function waitOnVite() {
  const deadline = Date.now() + 120_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${vitePort}/`);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.error(`[dev-electron] Vite dev server on :${vitePort} did not come up within 120s (${lastError})`);
  process.exit(1);
}

await waitOnVite();

const childEnv = { ...process.env };
if (wants('--perf')) childEnv.CYBOFLOW_PERF_TRACE = '1';
// `env -u NODE_OPTIONS` equivalent: the Electron binary rejects some
// host-Node-only NODE_OPTIONS entries even in dev.
delete childEnv.NODE_OPTIONS;

const child = spawn(electronBinary, ['.', ...forwarded], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: childEnv,
});

/** True once the child has exited (by code or by signal). */
function childIsDead() {
  return child.exitCode !== null || child.signalCode !== null;
}

child.on('exit', (code, signal) => {
  if (!signal) {
    process.exit(code ?? 0);
  }
  // The child died FROM a signal (e.g. Ctrl+C delivering SIGINT to the whole
  // foreground process group). Re-raise the SAME signal onto this process so
  // it dies the shell-conventional way (128+n) — but drop our own SIGINT/
  // SIGTERM handlers first: they exist to forward signals to the child, and
  // with the child dead that forwarding is a no-op. Leaving them installed
  // would SWALLOW the re-raised signal (a handled signal kills nothing), and
  // this wrapper — and `concurrently`, which waits on it — would hang forever
  // after Ctrl+C. The signal is forwarded as received, never defaulted: the
  // handlers below pass the actual signal, not child.kill()'s SIGTERM.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.kill(process.pid, signal);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (childIsDead()) return; // exit handler owns the process now
    child.kill(sig);
  });
}
