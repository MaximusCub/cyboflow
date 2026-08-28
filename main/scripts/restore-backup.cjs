#!/usr/bin/env node
/**
 * restore-backup — rebuild a complete sessions.db from a daily backup plus the
 * raw_events archive.
 *
 * WHY THIS EXISTS. A daily backup deliberately carries an EMPTY raw_events
 * table; the history lives once in <backups>/raw-events/<lineage>/ instead of
 * seven times in the retained dailies. That makes "copy the backup over
 * sessions.db" an incomplete recovery — the app would open perfectly and show
 * no chat history — so this is the supported way back.
 *
 * It never writes to the backup you point it at: the restore happens on a copy.
 *
 *   node main/scripts/restore-backup.cjs <backup.db> [--deltas <dir>] [--out <path>]
 *
 * --deltas defaults to a `raw-events` directory beside the backup, which is
 * where the app writes it. --out defaults to <backup>.restored.db.
 *
 * Requires `pnpm build:main` to have run, and better-sqlite3 on the HOST ABI
 * (`node scripts/ensure-sqlite-abi.mjs host` from the repo root if it complains
 * about NODE_MODULE_VERSION).
 */
const fs = require('node:fs');
const path = require('node:path');

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error('usage: node main/scripts/restore-backup.cjs <backup.db> [--deltas <dir>] [--out <path>]');
  process.exit(message ? 1 : 0);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) usage();

let backupArg = null;
let deltasArg = null;
let outArg = null;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--deltas') deltasArg = argv[++i] ?? usage('--deltas needs a directory');
  else if (arg === '--out') outArg = argv[++i] ?? usage('--out needs a path');
  else if (arg.startsWith('-')) usage(`unknown option ${arg}`);
  else if (backupArg === null) backupArg = arg;
  else usage('more than one backup given');
}
if (backupArg === null) usage('no backup given');

const backupPath = path.resolve(backupArg);
if (!fs.existsSync(backupPath)) usage(`no such backup: ${backupPath}`);

const deltaDir = path.resolve(deltasArg ?? path.join(path.dirname(backupPath), 'raw-events'));
const outPath = path.resolve(outArg ?? `${backupPath.replace(/\.db$/, '')}.restored.db`);

if (fs.existsSync(outPath)) usage(`refusing to overwrite an existing file: ${outPath}`);

let restoreRawEvents;
try {
  ({ restoreRawEvents } = require(path.join(__dirname, '..', 'dist', 'main', 'src', 'services', 'databaseBackupRestore')));
} catch (err) {
  console.error('error: could not load the compiled restore module. Run `pnpm build:main` first.');
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
}

console.log(`backup   ${backupPath}`);
console.log(`archive  ${deltaDir}`);
console.log(`output   ${outPath}`);

// Work on a copy so a failed or partial restore can never damage the backup.
fs.copyFileSync(backupPath, outPath);

try {
  const result = restoreRawEvents(outPath, deltaDir);
  if (result.skipped) {
    console.log(`\nnothing to replay: ${result.skipped}`);
  } else {
    console.log(`\nlineage    ${result.lineage}`);
    console.log(`watermark  ${result.watermark}`);
    console.log(`shards     ${result.appliedFiles.length ? result.appliedFiles.join(', ') : 'none'}`);
    console.log(`restored   ${result.restoredRows} raw_events rows`);
  }
  console.log(`\nDone. Move ${outPath} into place as sessions.db with the app CLOSED.`);
} catch (err) {
  // Leave nothing half-built: a file that looks like a recovered database but
  // is missing history is more dangerous than no file at all.
  try {
    fs.unlinkSync(outPath);
  } catch {
    /* best-effort */
  }
  console.error(`\nrestore failed: ${err && err.message ? err.message : err}`);
  console.error('The backup was not modified and no output was written.');
  process.exit(1);
}
