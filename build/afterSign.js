/**
 * Post-sign tripwire hook for electron-builder.
 *
 * Responsibility: scan the unpacked asar tree for `*.jar` files and warn
 * loudly if any are found. JARs can carry unsigned native code that fails
 * notarization or trips Gatekeeper, and none of the currently shipped
 * dependencies contain any — so a JAR appearing here means a dependency
 * changed and the packaging config needs a decision.
 *
 * This hook deliberately does NOT delete anything: it runs after codesign,
 * and removing a file from an already-signed .app invalidates the bundle's
 * resource seal. The fix for a real JAR belongs BEFORE signing — exclude it
 * via `build.files` / package exclusion, or sign its native contents.
 *
 * (Historical: the Crystal-era version of this hook stripped JARs from
 * `@anthropic-ai/claude-code/vendor/`; that package is no longer shipped —
 * the SDK path uses `@anthropic-ai/claude-agent-sdk` — so the strip logic
 * had been a silent no-op and was retired.)
 *
 * Notarization is delegated to electron-builder's built-in hook (controlled
 * by build.mac.notarize in package.json). This script does NOT invoke the
 * notarization toolchain directly.
 */

const path = require('path');
const fs = require('fs');

function collectJarsRecursively(dir, found) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJarsRecursively(fullPath, found);
    } else if (entry.name.endsWith('.jar')) {
      found.push(fullPath);
    }
  }
}

exports.default = async function(context) {
  const { appOutDir, packager } = context;

  if (packager.platform.name !== 'mac') {
    return;
  }

  // Check if we have signing certificates (useful for debugging dev builds)
  const hasSigningCredentials = process.env.CSC_LINK || process.env.CSC_KEY_PASSWORD;
  if (!hasSigningCredentials) {
    console.log('AfterSign: No signing credentials found');
  }

  console.log('AfterSign: notarization is handled by electron-builder built-in hook; this script only scans for JAR files');

  const appPath = path.join(appOutDir, `${packager.appInfo.productName}.app`);
  const unpackedRoot = path.join(appPath, 'Contents/Resources/app.asar.unpacked');
  console.log('AfterSign: scanning', unpackedRoot);

  if (!fs.existsSync(unpackedRoot)) {
    console.log('AfterSign: no app.asar.unpacked directory found — nothing to scan');
    return;
  }

  const jars = [];
  collectJarsRecursively(unpackedRoot, jars);

  if (jars.length === 0) {
    console.log('AfterSign: no JAR files found under app.asar.unpacked (expected)');
    return;
  }

  console.warn('AfterSign: ============================================================');
  console.warn(`AfterSign: WARNING — ${jars.length} JAR file(s) found in the signed app bundle:`);
  for (const jar of jars) {
    console.warn('AfterSign:   ' + jar);
  }
  console.warn('AfterSign: JARs can contain unsigned native code that fails notarization');
  console.warn('AfterSign: or trips Gatekeeper. Do NOT delete them here (the app is already');
  console.warn('AfterSign: signed — removing sealed resources invalidates the signature).');
  console.warn('AfterSign: Exclude them from packaging via build.files BEFORE signing, or');
  console.warn('AfterSign: sign their native contents. See docs/signing/APPLE_DEVELOPER_SETUP.md.');
  console.warn('AfterSign: ============================================================');
};
