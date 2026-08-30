#!/usr/bin/env node
/**
 * copy-assets — copy the runtime SQL assets into the compiled bundle.
 *
 * Replaces the former shell pipeline (`mkdirp … && cp src/database/*.sql …`)
 * whose `cp` and `*.sql` globbing only worked on POSIX shells — on Windows
 * `pnpm build:main` died right here. fs.cpSync + readdirSync are portable and
 * behave identically on every host.
 *
 * Copies:
 *   src/database/*.sql            -> dist/main/src/database/
 *   src/database/migrations/*.sql -> dist/main/src/database/migrations/
 *
 * Runs in the `main` build chain after `tsc`. The workflow markdown copy is a
 * separate step (copy-workflow-assets.js) and stays in package.json's
 * copy:assets chain. CommonJS to match the other build helpers in this
 * directory.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const COPIES = [
  {
    srcDir: path.join(ROOT, 'src', 'database'),
    destDir: path.join(ROOT, 'dist', 'main', 'src', 'database'),
  },
  {
    srcDir: path.join(ROOT, 'src', 'database', 'migrations'),
    destDir: path.join(ROOT, 'dist', 'main', 'src', 'database', 'migrations'),
  },
];

let copied = 0;
for (const { srcDir, destDir } of COPIES) {
  let entries;
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.warn(`[copy-assets] missing source dir ${srcDir} — skipping`);
      continue;
    }
    throw err;
  }
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(srcDir, entry.name), path.join(destDir, entry.name));
    copied += 1;
  }
}
console.log(`[copy-assets] copied ${copied} SQL file(s) to dist`);
