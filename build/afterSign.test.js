/**
 * Smoke test for build/afterSign.js (post-sign JAR tripwire).
 * Run as: node build/afterSign.test.js
 * Exits 0 on success, 1 on any failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const afterSign = require('./afterSign').default;

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error('FAIL:', message);
    failed++;
  } else {
    console.log('PASS:', message);
    passed++;
  }
}

/** Run afterSign while capturing console.warn output. */
async function runCapturingWarnings(ctx) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let threw = false;
  try {
    await afterSign(ctx);
  } catch (_err) {
    threw = true;
  } finally {
    console.warn = originalWarn;
  }
  return { threw, warnings };
}

function macContext(appOutDir, productName) {
  return {
    appOutDir,
    packager: {
      platform: { name: 'mac' },
      appInfo: { productName }
    }
  };
}

// ---------------------------------------------------------------------------
// Case A: non-mac context resolves without throwing or warning
// ---------------------------------------------------------------------------
async function caseA() {
  const { threw, warnings } = await runCapturingWarnings({
    appOutDir: '/tmp',
    packager: {
      platform: { name: 'linux' },
      appInfo: { productName: 'X' }
    }
  });
  assert(!threw, 'Case A: non-mac returns without throwing');
  assert(warnings.length === 0, 'Case A: non-mac emits no warnings');
}

// ---------------------------------------------------------------------------
// Case B: mac tree WITH JARs — warns, does NOT delete (post-sign bundle is sealed)
// ---------------------------------------------------------------------------
async function caseB() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    const unpackedBase = path.join(
      tmpDir,
      `${productName}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'some-dep'
    );
    const subDir = path.join(unpackedBase, 'sub');
    fs.mkdirSync(subDir, { recursive: true });

    const jar1 = path.join(unpackedBase, 'foo.jar');
    const jar2 = path.join(subDir, 'bar.jar');
    fs.writeFileSync(jar1, 'fake-jar-content');
    fs.writeFileSync(jar2, 'fake-jar-content');

    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    const warnText = warnings.join('\n');

    assert(!threw, 'Case B: mac context does not throw');
    assert(fs.existsSync(jar1), 'Case B: top-level jar NOT deleted (foo.jar)');
    assert(fs.existsSync(jar2), 'Case B: nested jar NOT deleted (sub/bar.jar)');
    assert(warnText.includes('foo.jar'), 'Case B: warning names foo.jar');
    assert(warnText.includes('bar.jar'), 'Case B: warning names nested bar.jar');
    assert(warnText.includes('2 JAR file(s)'), 'Case B: warning reports the count');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case C: mac tree with no JARs — resolves quietly
// ---------------------------------------------------------------------------
async function caseC() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    const unpackedBase = path.join(
      tmpDir,
      `${productName}.app`,
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'some-dep'
    );
    fs.mkdirSync(unpackedBase, { recursive: true });
    fs.writeFileSync(path.join(unpackedBase, 'index.js'), 'module.exports = {};');

    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    assert(!threw, 'Case C: mac context without JARs does not throw');
    assert(warnings.length === 0, 'Case C: no warnings when no JARs present');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Case D: mac context with no app.asar.unpacked directory at all — no throw
// ---------------------------------------------------------------------------
async function caseD() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aftersign-test-'));
  try {
    const productName = 'TestApp';
    fs.mkdirSync(path.join(tmpDir, `${productName}.app`, 'Contents', 'Resources'), {
      recursive: true
    });
    const { threw, warnings } = await runCapturingWarnings(macContext(tmpDir, productName));
    assert(!threw, 'Case D: missing app.asar.unpacked does not throw');
    assert(warnings.length === 0, 'Case D: missing app.asar.unpacked emits no warnings');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  console.log('--- afterSign smoke test ---');
  await caseA();
  await caseB();
  await caseC();
  await caseD();

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
