/**
 * hostProbeAdapters — the two NON-TRIVIAL adapters behind the §6 health
 * panel's host probes (docs/proposals/verification-setup-flow.md §6).
 *
 * `index.ts` wires the probe implementations the verification preflight
 * already uses, and most of them pass straight through. These two do not: each
 * has a rule that is easy to get subtly wrong and impossible to cover where it
 * used to live, since `index.ts` boots Electron and cannot be imported by a
 * unit test. Extracting them keeps `index.ts` to wiring and puts the rules
 * under test.
 *
 *   - {@link makeDriverCliProbe} — the fail-open rule from `preflight.ts`:
 *     only AFFIRMATIVE absence is a miss.
 *   - {@link makeChromiumProvisioner} — retry semantics over a memoizing
 *     installer.
 *   - {@link makeAccessibilityRequester} — a one-shot OS prompt with a Settings
 *     fallback, because the prompt fires once per binary and then goes quiet.
 *
 * No Electron import: `index.ts` supplies the concrete `access` / installer
 * factory / `systemPreferences` calls, so all of them are exercisable with
 * plain fakes.
 */
import type { LoggerLike } from '../../orchestrator/types';

/**
 * Deep links to the two System Settings panes. `x-apple.systempreferences:` is
 * the documented URL scheme and survives the Ventura-era rename of the app.
 */
export const SCREEN_RECORDING_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
export const ACCESSIBILITY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

/** The subset of a provisioning installer these adapters drive. */
export interface ChromiumInstallerLike {
  ensureChromium(): Promise<boolean>;
}

/**
 * A driver-CLI existence probe that preserves `preflight.ts`'s fail-open rule
 * across the adapter boundary.
 *
 * THE RULE: a probe that cannot answer is INCONCLUSIVE, never evidence. Only
 * an affirmative "the file is not there" (ENOENT) may report `exists: false`.
 * EACCES/EPERM from an unsearchable parent, EIO, or anything else says nothing
 * about whether the CLI is present, and must REJECT so the router maps it to
 * `'inconclusive'`.
 *
 * Catching every error and reporting `exists: false` is the specific bug this
 * exists to prevent: it converts "could not check" into a confident "missing"
 * BEFORE the router's rejection branch can see it, sending users to reinstall
 * a CLI that is present and merely unreadable.
 */
export function makeDriverCliProbe(
  path: string,
  access: (path: string) => Promise<void>,
): () => Promise<{ path: string; exists: boolean }> {
  return async () => {
    try {
      await access(path);
      return { path, exists: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        return { path, exists: false };
      }
      throw err;
    }
  };
}

/**
 * A chromium provisioning action with the retry semantics the panel's fix-it
 * button needs.
 *
 * Two rules, both about the installer being MEMOIZED on a settled promise:
 *
 *  - A concluded attempt must not be reused. `PlaywrightInstaller` caches its
 *    first promise, so a second click on a cached `false` would resolve
 *    instantly without spawning an install and the button would look broken.
 *    A FRESH installer is taken after any non-success — resolved-false AND
 *    rejected alike. The rejection half matters most: the documented contract
 *    is that provisioning resolves false rather than throwing, so a throw is
 *    exactly the unanticipated case that would otherwise wedge every later
 *    retry against one poisoned promise.
 *  - Concurrent callers share ONE attempt. An impatient double-click must not
 *    race two `playwright install` spawns at the same cache directory.
 *
 * The returned function propagates a rejection rather than flattening it to
 * `false`: the caller re-probes either way, and a swallowed throw here would
 * hide a genuinely broken installer behind an ordinary-looking "still missing".
 */
export function makeChromiumProvisioner(
  createInstaller: () => ChromiumInstallerLike,
  logger?: LoggerLike,
): () => Promise<boolean> {
  let installer = createInstaller();
  let inFlight: Promise<boolean> | null = null;

  return () => {
    if (inFlight) return inFlight;
    const attempt = installer
      .ensureChromium()
      .then((ok) => {
        if (!ok) installer = createInstaller();
        return ok;
      })
      .catch((err: unknown) => {
        installer = createInstaller();
        logger?.warn('[hostProbeAdapters] chromium provisioning threw; installer reset for retry', {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = attempt;
    return attempt;
  };
}

/**
 * The panel's "grant accessibility" action: ask the OS to prompt, and open the
 * Settings pane when it will not.
 *
 * WHY THE FALLBACK IS NOT OPTIONAL: macOS shows the Accessibility consent
 * dialog at most ONCE per binary. Every later call to
 * `isTrustedAccessibilityClient(true)` returns false without displaying
 * anything, so a button wired to the prompt alone works exactly one time in the
 * app's lifetime and then silently does nothing — which reads as a broken
 * button, not as a permission the user has to go and grant.
 *
 * The pane is opened only when the app is NOT already trusted. Sending someone
 * to System Settings to enable a switch that is already on is its own kind of
 * wrong answer.
 *
 * A failed `openExternal` is swallowed: the caller re-probes regardless, and
 * this action is advisory — nothing downstream depends on the pane having
 * opened.
 */
export function makeAccessibilityRequester(deps: {
  /** `systemPreferences.isTrustedAccessibilityClient` — `true` PROMPTS (once, ever). */
  isTrustedAccessibilityClient: (prompt: boolean) => boolean;
  openSettings: (url: string) => Promise<void>;
  logger?: LoggerLike;
}): () => Promise<void> {
  return async () => {
    let trusted = false;
    try {
      trusted = deps.isTrustedAccessibilityClient(true);
    } catch (err) {
      deps.logger?.warn('[hostProbeAdapters] accessibility trust check threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (trusted) return;
    await openSettingsPane(deps, ACCESSIBILITY_SETTINGS_URL);
  };
}

/**
 * The panel's "open screen-recording settings" action.
 *
 * There is no macOS API to REQUEST this grant — not `systemPreferences`, not at
 * any privilege level — so unlike accessibility there is no prompt to try
 * first. Showing the user the switch is the entire available remedy.
 */
export function makeScreenRecordingSettingsOpener(deps: {
  openSettings: (url: string) => Promise<void>;
  logger?: LoggerLike;
}): () => Promise<void> {
  return async () => {
    await openSettingsPane(deps, SCREEN_RECORDING_SETTINGS_URL);
  };
}

async function openSettingsPane(
  deps: { openSettings: (url: string) => Promise<void>; logger?: LoggerLike },
  url: string,
): Promise<void> {
  try {
    await deps.openSettings(url);
  } catch (err) {
    deps.logger?.warn('[hostProbeAdapters] could not open the System Settings pane', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
