#!/usr/bin/env node

/**
 * Configure build settings based on environment.
 *
 * Reads the canonical electron-builder config from package.json's `build` field
 * (the committed source of truth — NEVER mutated) and writes an environment-adjusted
 * copy to build/electron-builder.generated.json. The mac build scripts pass that file
 * to electron-builder via `--config`, which uses it INSTEAD of package.json's `build`
 * (electron-builder reads a `--config` file exclusively; it does not merge package.json
 * `build` on top — see app-builder-lib getConfig). This keeps the tracked package.json
 * clean across signed, unsigned, and dev builds.
 *
 * Adjustments:
 *   - Signing/notarization posture is toggled based on the presence of Apple credentials.
 *   - When BUILD_VARIANT=dev, the dev appId / productName / artifactName / publish URL
 *     overrides are baked in (these used to be inline `--config.*` flags on build:mac:dev).
 *
 * Windows (BUILD_PLATFORM=win, normally passed as `node scripts/configure-build.js
 * --platform win --arch x64` by the build:win scripts):
 *   - Requires build.win instead of build.mac; the mac signing posture is skipped.
 *   - npmRebuild is turned OFF: the Windows build lands native modules on the
 *     Electron ABI via prebuild-install (see docs/WINDOWS-BUILD.md) and
 *     electron-builder must package those .node files as-is, not rebuild them
 *     (a rebuild needs MSVC, which a Windows dev host may not have). Set
 *     CYBOFLOW_WIN_NPM_REBUILD=1 to restore electron-builder's rebuild step.
 *   - Because npmRebuild is off, nothing at packaging time would otherwise fix
 *     a better-sqlite3 artifact that is on the WRONG ABI — but two everyday
 *     flows put it there (the host-ABI auto-flip before test:unit /
 *     test:integration, and a plain `pnpm install`, which re-runs
 *     better-sqlite3's install script). Packaging as-is would ship an
 *     installer that hard-crashes on first DB open (NODE_MODULE_VERSION
 *     mismatch), so the Electron ABI is PROBED here and a wrong-ABI artifact
 *     fails the build before electron-builder runs.
 *   - The lean-packaging plan keeps win32 agent binaries and excludes the
 *     darwin/linux ones, mirroring the mac plan.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PACKAGE_JSON_PATH = path.join(__dirname, '..', 'package.json');
const GENERATED_CONFIG_PATH = path.join(__dirname, '..', 'build', 'electron-builder.generated.json');

const CLAUDE_NATIVE_SUFFIXES = [
  'darwin-arm64', 'darwin-x64',
  'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl',
  'win32-x64', 'win32-arm64',
];
const CODEX_NATIVE_SUFFIXES = [
  'darwin-arm64', 'darwin-x64',
  'linux-x64', 'linux-arm64',
  'win32-x64', 'win32-arm64',
];

function getLeanPackagingPlan(targetArch) {
  if (targetArch !== 'arm64' && targetArch !== 'x64') {
    return null;
  }

  const targetSuffix = `darwin-${targetArch}`;
  const codexTargetTriple = targetArch === 'arm64'
    ? 'aarch64-apple-darwin'
    : 'x86_64-apple-darwin';

  return {
    requiredBinaries: [
      {
        label: 'Claude Code',
        packageName: `@anthropic-ai/claude-agent-sdk-${targetSuffix}`,
        relativePath: path.join(
          'node_modules', '@anthropic-ai', `claude-agent-sdk-${targetSuffix}`, 'claude'
        ),
      },
      {
        label: 'Codex',
        packageName: `@openai/codex-${targetSuffix}`,
        relativePath: path.join(
          'node_modules', '@openai', `codex-${targetSuffix}`,
          'vendor', codexTargetTriple, 'bin', 'codex'
        ),
      },
    ],
    exclusions: [
      ...CLAUDE_NATIVE_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/@anthropic-ai/claude-agent-sdk-${suffix}/**`),
      ...CODEX_NATIVE_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/@openai/codex-${suffix}/**`),
    ],
  };
}

/**
 * The Windows counterpart to getLeanPackagingPlan: a Windows installer needs
 * only the matching win32 agent packages, and the darwin/linux ones are dead
 * weight (and would ride into the asar unchecked). Binary layouts verified on
 * disk: claude-agent-sdk-win32-<arch>/claude.exe and
 * codex-win32-<arch>/vendor/<triple>/bin/codex.exe.
 */
function getWinPackagingPlan(targetArch) {
  if (targetArch !== 'x64' && targetArch !== 'arm64') {
    return null;
  }

  const targetSuffix = `win32-${targetArch}`;
  const codexTargetTriple = targetArch === 'x64'
    ? 'x86_64-pc-windows-msvc'
    : 'aarch64-pc-windows-msvc';

  return {
    requiredBinaries: [
      {
        label: 'Claude Code',
        packageName: `@anthropic-ai/claude-agent-sdk-${targetSuffix}`,
        relativePath: path.join(
          'node_modules', '@anthropic-ai', `claude-agent-sdk-${targetSuffix}`, 'claude.exe'
        ),
      },
      {
        label: 'Codex',
        packageName: `@openai/codex-${targetSuffix}`,
        relativePath: path.join(
          'node_modules', '@openai', `codex-${targetSuffix}`,
          'vendor', codexTargetTriple, 'bin', 'codex.exe'
        ),
      },
    ],
    exclusions: [
      ...CLAUDE_NATIVE_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/@anthropic-ai/claude-agent-sdk-${suffix}/**`),
      ...CODEX_NATIVE_SUFFIXES
        .filter((suffix) => suffix !== targetSuffix)
        .map((suffix) => `!node_modules/@openai/codex-${suffix}/**`),
    ],
  };
}

/**
 * Warn — loudly, but do not fail — when the bundled screen-capture binary is
 * absent from node_modules.
 *
 * It is an OPTIONAL dependency (`os: ["darwin"]`, so a required one would break
 * `pnpm install` on the Linux CI runners), which means "absent" is a legitimate
 * state on any non-macOS box and this check has to be a no-op there.
 *
 * A warning rather than the hard fail the per-arch agent binaries get: shipping
 * without it degrades to resolving `peekaboo` off the user's PATH, which is
 * exactly the pre-bundling behaviour — a lost convenience, not a broken
 * runtime. Silent, though, it would be the regression where most users simply
 * never satisfy the prerequisite.
 */
function warnIfPeekabooMissing() {
  if (process.platform !== 'darwin') return;
  const binary = path.join(
    __dirname, '..', 'node_modules', '@steipete', 'peekaboo-mcp', 'peekaboo'
  );
  if (fs.existsSync(binary)) return;
  console.warn(
    'Warning: the bundled peekaboo capture binary is missing ' +
      '(@steipete/peekaboo-mcp). This build will ship without it and ' +
      'native-screen verification will fall back to whatever is on the ' +
      "user's PATH. Run \"pnpm install\" to restore it."
  );
}

/**
 * Read-only probe: does the installed better-sqlite3 artifact actually LOAD
 * under the Electron ABI?
 *
 * Delegates to scripts/ensure-sqlite-abi.mjs --check electron, which spawns a
 * real child Electron and runs `new Database(':memory:')` — ground truth about
 * whether the packaged .node would load, not a marker-file guess. That script
 * is ESM and this file is CommonJS, so it is invoked as a child process rather
 * than imported. `--check` is the read-only mode: it swaps nothing, so probing
 * here never mutates the tree it is about to package.
 *
 * Module-level (not inline) so tests can inject a stub via
 * __setAbiProbeForTesting instead of needing a real native artifact on disk.
 */
function probeWinElectronAbi() {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'ensure-sqlite-abi.mjs'), '--check', 'electron'],
    { encoding: 'utf8' }
  );
  return {
    ok: result.status === 0,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

/** Test seam: replace the ABI probe (see probeWinElectronAbi). */
let abiProbe = probeWinElectronAbi;
function __setAbiProbeForTesting(fn) {
  abiProbe = fn;
}

function configureBuild() {
  console.log('Configuring build for current environment...');

  // Check if signing is explicitly disabled
  const signingDisabled = process.env.CSC_DISABLE === 'true';

  // Check if we have Apple signing credentials
  const hasAppleCertificate = !!(process.env.CSC_LINK || process.env.APPLE_CERTIFICATE);
  const hasAppleId = !!process.env.APPLE_ID;
  const hasTeamId = !!process.env.APPLE_TEAM_ID;
  const hasAppPassword = !!(process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_APP_PASSWORD);

  const canSign = !signingDisabled && hasAppleCertificate;
  const canNotarize = canSign && hasAppleId && hasTeamId && hasAppPassword;
  const isDev = process.env.BUILD_VARIANT === 'dev';
  const isWin = process.env.BUILD_PLATFORM === 'win';

  console.log('Environment check:');
  console.log(`  - Target Platform: ${isWin ? 'win' : 'mac'}`);
  console.log(`  - Signing Disabled: ${signingDisabled ? '✓' : '✗'}`);
  console.log(`  - Apple Certificate: ${hasAppleCertificate ? '✓' : '✗'}`);
  console.log(`  - Apple ID: ${hasAppleId ? '✓' : '✗'}`);
  console.log(`  - Team ID: ${hasTeamId ? '✓' : '✗'}`);
  console.log(`  - App Password: ${hasAppPassword ? '✓' : '✗'}`);
  console.log(`  - Can Sign: ${canSign ? '✓' : '✗'}`);
  console.log(`  - Can Notarize: ${canNotarize ? '✓' : '✗'}`);
  console.log(`  - Build Variant: ${isDev ? 'dev' : 'stable'}`);

  // Read the canonical config from package.json (source of truth — not mutated)
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

  if (!packageJson.build || (!isWin && !packageJson.build.mac)) {
    console.error('Error: No macOS build configuration found in package.json');
    process.exit(1);
  }
  if (isWin && !packageJson.build.win) {
    console.error('Error: No Windows build configuration found in package.json');
    process.exit(1);
  }

  // Deep-clone so the source package.json is never touched
  const config = JSON.parse(JSON.stringify(packageJson.build));

  // Configure macOS signing posture based on capabilities. A win build has no
  // Apple posture to adjust — the signing credentials above are darwin-only
  // and the win config carries no hardenedRuntime/entitlements to mutate.
  if (!isWin) {
    config.mac.notarize = canNotarize;

    if (!canSign) {
      console.log('Configuring for unsigned build...');
      config.mac.hardenedRuntime = false;
      // Keep gatekeeperAssess false so unsigned apps can run locally
      config.mac.gatekeeperAssess = false;
      delete config.mac.entitlements;
      delete config.mac.entitlementsInherit;
    } else {
      console.log('Configuring for signed build...');
      config.mac.hardenedRuntime = true;
      config.mac.gatekeeperAssess = false;
      config.mac.entitlements = 'build/entitlements.mac.plist';
      config.mac.entitlementsInherit = 'build/entitlements.mac.plist';
    }
  }

  // Dev-variant overrides (previously inline --config.* flags on build:mac:dev).
  // Template tokens like ${version} are electron-builder placeholders and must stay literal.
  if (isDev) {
    console.log('Applying dev-variant overrides...');
    config.appId = 'com.cyboflow.app.dev';
    config.productName = 'Cyboflow Dev';
    config.mac.artifactName = 'Cyboflow-Dev-${version}-macOS-${arch}.${ext}';
    if (isWin && config.win) {
      config.win.artifactName = 'Cyboflow-Dev-${version}-Windows-${arch}.${ext}';
    }
    config.publish = { ...(config.publish || {}), url: 'https://updates.cyboflow.com/dev' };
  }

  // Windows ships hand-placed prebuilt native modules (better-sqlite3 and
  // node-pty on the Electron ABI via prebuild-install — docs/WINDOWS-BUILD.md).
  // electron-builder must package those .node files as-is; a rebuild here
  // would (a) need MSVC, which a Windows dev host may not have, and (b)
  // clobber the verified prebuilds. CYBOFLOW_WIN_NPM_REBUILD=1 restores the
  // rebuild step for hosts that do have a toolchain.
  if (isWin) {
    const winNpmRebuild = process.env.CYBOFLOW_WIN_NPM_REBUILD === '1';
    config.npmRebuild = winNpmRebuild;
    console.log(`Windows packaging: npmRebuild=${config.npmRebuild}` +
      (winNpmRebuild ? '' : ' (prebuilt .node files are packaged as-is; set CYBOFLOW_WIN_NPM_REBUILD=1 to rebuild)'));

    // ABI guard. With npmRebuild off the .node files ship EXACTLY as they sit
    // in node_modules — and two everyday flows leave better-sqlite3 on the
    // wrong (host Node) ABI there: the auto-flip before test:unit /
    // test:integration, and a plain `pnpm install`. Packaging that as-is
    // produces an installer that hard-crashes on first DB open
    // (NODE_MODULE_VERSION mismatch), which is far away from its cause — fail
    // here instead, while the fix is one command. Skipped when npmRebuild was
    // re-enabled: electron-builder then rebuilds better-sqlite3 for Electron
    // itself, so the prebuilt artifact's ABI is irrelevant.
    if (!winNpmRebuild) {
      const probe = abiProbe();
      if (!probe.ok) {
        console.error(
          'Error: the installed better-sqlite3 artifact does not load under the ' +
            'ELECTRON ABI, but this build packages it as-is (npmRebuild=false). Shipping ' +
            'it would hard-crash the app on first database open ' +
            '(NODE_MODULE_VERSION mismatch).'
        );
        console.error('Run "node scripts/ensure-sqlite-abi.mjs electron" first, then retry the build.');
        if (probe.output) console.error(`Probe output:\n${probe.output}`);
        process.exit(1);
      }
      console.log('Windows packaging: better-sqlite3 verified on the Electron ABI.');
    }
  }

  // Lean per-arch packaging. Both agent distributions ship their native CLIs
  // as optional per-platform/arch packages. electron-builder bundles
  // node_modules wholesale, and a cross-arch dev box (or a forced install that
  // materializes every optionalDependency) can have all of them present. A
  // macOS DMG needs only the matching darwin package for each agent — and a
  // Windows installer only the matching win32 package. Exclude every foreign
  // native package and fail fast if either target binary is absent, which
  // would otherwise silently break that runtime after release.
  // BUILD_ARCH unset / 'universal' leaves files untouched.
  const targetArch = process.env.BUILD_ARCH;
  const leanPackagingPlan = isWin
    ? getWinPackagingPlan(targetArch)
    : getLeanPackagingPlan(targetArch);
  if (leanPackagingPlan) {
    const leanPlatform = isWin ? 'Windows' : 'macOS';
    for (const required of leanPackagingPlan.requiredBinaries) {
      const targetBinary = path.join(__dirname, '..', required.relativePath);
      if (fs.existsSync(targetBinary)) continue;
      console.error(
        `Error: the ${targetArch} ${required.label} binary is missing ` +
          `(${required.packageName}). A ${targetArch} ${leanPlatform} build would ` +
          `ship without it and break that agent runtime. ` +
          (isWin
            ? `Run "pnpm install" on the Windows host (its os/cpu constraints ` +
              `materialize the win32 optional packages).`
            : `Run "pnpm run install:darwin-cross" before a cross-arch build.`)
      );
      process.exit(1);
    }
    config.files = [
      ...(config.files || []),
      ...leanPackagingPlan.exclusions,
    ];
    console.log(
      `Lean packaging: keeping only ${isWin ? 'win32' : 'darwin'}-${targetArch} ` +
        `agent binaries; excluding ${leanPackagingPlan.exclusions.length} foreign native packages.`
    );
  }

  warnIfPeekabooMissing();

  // Write the environment-adjusted config; package.json stays pristine
  fs.mkdirSync(path.dirname(GENERATED_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(GENERATED_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

  const relPath = path.relative(path.join(__dirname, '..'), GENERATED_CONFIG_PATH);
  console.log(`Build configuration written to ${relPath}`);
  if (!isWin) {
    console.log(`Notarization: ${config.mac.notarize ? 'enabled' : 'disabled'}`);
    console.log(`Hardened Runtime: ${config.mac.hardenedRuntime ? 'enabled' : 'disabled'}`);
  }

  return config;
}

if (require.main === module) {
  // CLI arg form (--platform/--arch/--variant) exists so package.json scripts
  // never need POSIX `VAR=value cmd` env syntax, which breaks on Windows' cmd
  // shell. It simply feeds the same env vars the mac scripts set inline.
  const argv = process.argv.slice(2);
  const takeValue = (flag) => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    if (!value || value.startsWith('--')) {
      console.error(`Error: ${flag} needs a value`);
      process.exit(2);
    }
    return value;
  };
  const platform = takeValue('--platform');
  const arch = takeValue('--arch');
  const variant = takeValue('--variant');
  if (platform !== undefined) process.env.BUILD_PLATFORM = platform;
  if (arch !== undefined) process.env.BUILD_ARCH = arch;
  if (variant !== undefined) process.env.BUILD_VARIANT = variant;
  configureBuild();
}

module.exports = {
  configureBuild,
  getLeanPackagingPlan,
  getWinPackagingPlan,
  GENERATED_CONFIG_PATH,
  __setAbiProbeForTesting,
};
