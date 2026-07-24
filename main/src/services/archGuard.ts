/**
 * Boot guard for architecture mismatch — an x64 bundle running under ARM64
 * translation (Rosetta on macOS, WOW on Windows) on Apple Silicon / ARM hardware.
 *
 * WHY this exists: the app boots and mostly works when you install the wrong
 * DMG, so the mismatch is invisible. What it actually breaks is the bundled
 * Claude Agent SDK sidecar — the bundle ships exactly ONE arch-specific
 * `@anthropic-ai/claude-agent-sdk-darwin-{arch}/claude` binary, and the x64 one
 * runs emulated. Cold-starting an emulated sidecar routinely exceeds the 30s
 * first-event watchdog in claudeCodeManager (SDK_FIRST_EVENT_TIMEOUT_MS), so
 * the user sees "claude subprocess may have failed to start" with no hint that
 * the real cause is the build they installed. Observed in the wild: three such
 * timeouts inside five minutes on an x64 0.1.31 Dev DMG on an M1 Pro.
 *
 * This guard does NOT block boot — the app is usable under translation, just
 * slow and prone to SDK timeouts. It makes the misconfiguration loud instead of
 * silent so the fix (install the native build) is obvious.
 */

export interface ArchGuardDeps {
  /**
   * Whether the process is running under an ARM64 translator. From Electron's
   * `app.runningUnderARM64Translation` (darwin/win32 only; false elsewhere).
   */
  runningUnderARM64Translation: boolean;
  /** `process.arch` — the architecture this bundle was BUILT for. */
  processArch: string;
  /** `process.platform` — translation only exists on darwin/win32. */
  platform: NodeJS.Platform;
}

export interface ArchMismatch {
  /** The architecture this bundle was built for (e.g. 'x64'). */
  bundleArch: string;
  /** The host CPU's real architecture. Always 'arm64' under ARM64 translation. */
  nativeArch: string;
}

/**
 * Detect an emulated-bundle mismatch. Returns null when the bundle matches the
 * host (the overwhelmingly common case) so callers can treat non-null as "warn".
 *
 * Note we cannot compare `process.arch` to `os.arch()` — both report the arch
 * the *Node binary* was compiled for, so under Rosetta both say 'x64' and the
 * mismatch is undetectable. The translator flag is the only reliable signal,
 * and by definition it means an ARM64 host, hence the constant `nativeArch`.
 */
export function detectArchMismatch(deps: ArchGuardDeps): ArchMismatch | null {
  if (deps.platform !== 'darwin' && deps.platform !== 'win32') return null;
  if (!deps.runningUnderARM64Translation) return null;
  return { bundleArch: deps.processArch, nativeArch: 'arm64' };
}

/** One-line form for the main-process log. */
export function formatArchMismatchLog(m: ArchMismatch): string {
  return `[Main] Architecture mismatch: running the ${m.bundleArch} build under ARM64 translation on ${m.nativeArch} hardware — the bundled Claude CLI is emulated and may time out on start`;
}

/**
 * Dialog copy. Platform-aware because the same mismatch is "Intel build on an
 * Apple Silicon Mac" (Rosetta) or "x64 build on an ARM PC" (WOW). Names the
 * concrete symptom so a screenshot of this dialog is self-diagnosing.
 */
export function formatArchMismatchDialog(
  m: ArchMismatch,
  platform: NodeJS.Platform,
): { message: string; detail: string } {
  const machine = platform === 'darwin' ? 'Apple Silicon Mac' : 'ARM PC';
  return {
    message: `This is the ${m.bundleArch} build running on an ${machine}`,
    detail:
      `You installed the ${m.bundleArch} build, but this machine has an ${m.nativeArch} ` +
      `processor, so the whole app is running under emulation.\n\n` +
      `Cyboflow will work, but the Claude CLI it bundles is emulated too and often takes ` +
      `longer than 30 seconds to start — which surfaces as sessions failing with ` +
      `"claude subprocess may have failed to start".\n\n` +
      `Installing the ${m.nativeArch} build fixes this.`,
  };
}
