#!/usr/bin/env node

/**
 * snapshot-download-stats.mjs — freeze one UTC day of download analytics into a
 * durable JSON snapshot, so the numbers survive Cloudflare's retention window.
 *
 * Why this exists: r2-download-stats.mjs reads live edge analytics, and those
 * expire. The per-path detail (httpRequestsAdaptiveGroups) is gone after roughly
 * THREE DAYS; the daily rollup after ~30. So "how many downloads have I had"
 * is permanently unanswerable for anything older than a month — not because the
 * measurement is missing, but because nobody wrote it down. This script is the
 * writing-it-down half: run it daily and every day is preserved forever.
 *
 * It shells out to r2-download-stats.mjs rather than re-querying GraphQL itself,
 * so there is exactly ONE implementation of the download-counting rules (the
 * ≥1 MB real-download floor, feed-prefix filtering, sampling correction). If that
 * script's definition of a download changes, snapshots follow automatically.
 *
 * PRIVACY — the reason this is not just `--by-ip > file.json`:
 * Per-downloader counts are the whole point (they answer "how many PEOPLE", which
 * request counts cannot), but raw IPs must never land in durable storage. So each
 * IP is replaced by a salted hash and the raw value is dropped before writing.
 *
 *   monthlySalt  = sha256(DOWNLOAD_STATS_SALT + ':' + YYYY-MM)
 *   downloaderId = sha256(monthlySalt + ':' + ip)  (first 16 hex chars)
 *
 * The salt is REQUIRED and unsalted hashing is never a fallback: IPv4 is only
 * ~4.3 billion addresses, so an unsalted hash is a few seconds of brute force away
 * from the original IP and would not be anonymous at all.
 *
 * Rotating the salt monthly bounds how long two visits stay linkable. Within a
 * calendar month the same machine yields a stable id, so unique-downloader counts
 * are real; across months the id changes and the link is gone. Monthly matches the
 * release cadence, and residential IPs rotate faster than that anyway — a longer
 * window would add identifiability without adding accuracy.
 *
 * Required env:
 *   CLOUDFLARE_API_TOKEN     Zone › Analytics:Read (CLOUDFLARE_ANALYTICS_API also works)
 *   DOWNLOAD_STATS_SALT      long random string, kept secret and STABLE — changing it
 *                            renumbers every downloader id and breaks continuity
 * Required to upload (omit only with --out-dir / --dry-run):
 *   R2_ACCOUNT_ID
 *   R2_ANALYTICS_ACCESS_KEY_ID / R2_ANALYTICS_SECRET_ACCESS_KEY
 *                            credentials for a PRIVATE bucket — deliberately NOT the
 *                            release keys, because cyboflow-updates is served publicly
 *                            over updates.cyboflow.com and anything written there
 *                            would be world-readable.
 * Optional:
 *   R2_ANALYTICS_BUCKET      destination bucket        (default: cyboflow-analytics)
 *   CLOUDFLARE_ZONE_ID       passed through to the stats script
 *
 * Flags:
 *   --date=YYYY-MM-DD   single UTC day to snapshot     (default: yesterday)
 *   --since=YYYY-MM-DD  start of a backfill range (inclusive, with --until)
 *   --until=YYYY-MM-DD  end of a backfill range   (inclusive)
 *   --out-dir=PATH      write files locally instead of uploading to R2
 *   --dry-run           print the snapshot to stdout, write nothing
 *   --force             re-snapshot a day even if its object already exists
 *
 * Default is YESTERDAY because today is still accumulating — snapshotting a partial
 * UTC day would freeze an undercount that later runs cannot correct.
 *
 * Re-running a day is safe: the object key is derived from the date, so a repeat run
 * overwrites with fresher data rather than duplicating (that is also how --force
 * repairs a day captured while the adaptive logs were still filling).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATS_SCRIPT = join(HERE, 'r2-download-stats.mjs');
const SCHEMA_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Which UTC days to snapshot. --since/--until backfills a range (useful right after
// setup, to rescue whatever is still inside the ~3-day adaptive window).
function targetDays() {
  if (args.since || args.until) {
    if (!args.since || !args.until) fail('--since and --until must be given together.');
    if (!DATE_RE.test(args.since) || !DATE_RE.test(args.until)) fail('--since/--until must be YYYY-MM-DD.');
    const days = [];
    let cursor = new Date(`${args.since}T00:00:00Z`);
    const end = new Date(`${args.until}T00:00:00Z`);
    if (Number.isNaN(cursor.getTime()) || Number.isNaN(end.getTime())) fail('Could not parse --since/--until.');
    if (cursor > end) fail('--since must not be after --until.');
    while (cursor <= end) {
      days.push(cursor.toISOString().slice(0, 10));
      cursor = new Date(cursor.getTime() + DAY_MS);
    }
    return days;
  }
  if (args.date) {
    if (!DATE_RE.test(args.date)) fail('--date must be YYYY-MM-DD.');
    return [args.date];
  }
  return [new Date(Date.now() - DAY_MS).toISOString().slice(0, 10)];
}

// Run the stats script for one day in one mode and parse its --json output. Its
// modes are mutually exclusive, so a full day costs three subprocesses.
function runStats(day, extraFlags) {
  const argv = [STATS_SCRIPT, `--since=${day}`, `--until=${day}`, '--json', ...extraFlags];
  let stdout;
  try {
    stdout = execFileSync(process.execPath, argv, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    });
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim();
    fail(`r2-download-stats.mjs failed for ${day} (${extraFlags.join(' ') || 'paths'}):\n${detail}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    fail(`Could not parse JSON from r2-download-stats.mjs for ${day}:\n${stdout.slice(0, 400)}`);
  }
}

const saltSecret = process.env.DOWNLOAD_STATS_SALT;
if (!saltSecret) {
  fail(
    'DOWNLOAD_STATS_SALT is not set. It is required — hashing IPs without a secret\n' +
      '  salt is reversible by brute force and would store PII in plain sight.\n' +
      '  Generate one once and keep it stable:  openssl rand -hex 32',
  );
}

// Salt is derived per calendar month from one long-lived secret, so rotation needs
// no storage and no cron — the month in the input rotates it.
function monthlySalt(day) {
  const period = day.slice(0, 7);
  return { period, salt: createHash('sha256').update(`${saltSecret}:${period}`).digest('hex') };
}

function hashIp(ip, salt) {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 16);
}

function buildSnapshot(day) {
  const paths = runStats(day, []);
  const byIp = runStats(day, ['--by-ip']);
  const volume = runStats(day, ['--daily']);
  const { period, salt } = monthlySalt(day);

  // Replace ip with a salted id and drop the raw value. `feeds`/`country` stay:
  // low-cardinality and not identifying on their own, but useful for splitting
  // dev-box traffic from real users later.
  const downloaders = (byIp.rows || []).map((r) => ({
    id: hashIp(r.ip, salt),
    country: r.country,
    dmg: r.dmg,
    zip: r.zip,
    polls: r.polls,
    bytes: r.bytes,
    downloads: r.downloads,
    feeds: r.feeds,
    // A real user installs and the app then polls latest-mac.yml. Downloading the
    // installer and never polling is the crawler signature — most of the datacenter
    // traffic on this host looks like this. Kept as a flag, not a filter, so the
    // heuristic can be revisited against history instead of discarding rows now.
    botLikely: r.downloads > 0 && r.polls === 0,
  }));

  const pathRows = paths.rows || [];
  const sumKind = (kind, field) =>
    pathRows.filter((r) => r.kind === kind).reduce((s, r) => s + (r[field] || 0), 0);

  const humans = downloaders.filter((d) => !d.botLikely);

  return {
    schemaVersion: SCHEMA_VERSION,
    day,
    generatedAt: new Date().toISOString(),
    host: paths.host,
    zoneTag: paths.zoneTag,
    // Retention is short enough that a snapshot can legitimately capture nothing.
    // Recording coverage distinguishes "no downloads that day" from "we ran too late".
    coverage: paths.coverage,
    sampled: Boolean(paths.sampled),
    saltPeriod: period,
    totals: {
      dmgDownloads: sumKind('dmg', 'real'),
      zipDownloads: sumKind('zip', 'real'),
      ymlPolls: sumKind('yml', 'requests'),
      dmgBytes: sumKind('dmg', 'bytes'),
      zipBytes: sumKind('zip', 'bytes'),
      uniqueDownloaders: downloaders.length,
      uniqueHumanDownloaders: humans.length,
      humanDownloads: humans.reduce((s, d) => s + d.downloads, 0),
    },
    paths: pathRows,
    volume: volume.rows || [],
    downloaders,
  };
}

// Year/month prefixes keep the bucket listable as it grows past a few hundred days.
const objectKey = (day) => `snapshots/${day.slice(0, 4)}/${day.slice(5, 7)}/${day}.json`;

// One lazily-built client shared across the run, so a backfill of N days does not
// construct N clients (and so --dry-run / --out-dir never need R2 credentials).
let r2 = null;
async function getR2() {
  if (r2) return r2;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ANALYTICS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_ANALYTICS_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    fail(
      'R2_ACCOUNT_ID, R2_ANALYTICS_ACCESS_KEY_ID and R2_ANALYTICS_SECRET_ACCESS_KEY are\n' +
        '  required to upload. Use --out-dir=PATH or --dry-run to run without them.\n' +
        '  These must be a PRIVATE bucket\'s keys — not the release keys, whose bucket is\n' +
        '  served publicly over updates.cyboflow.com.',
    );
  }
  const { S3Client, PutObjectCommand, HeadObjectCommand } = await import('@aws-sdk/client-s3');
  r2 = {
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    }),
    bucket: process.env.R2_ANALYTICS_BUCKET || 'cyboflow-analytics',
    PutObjectCommand,
    HeadObjectCommand,
  };
  return r2;
}

// Checked BEFORE building a snapshot, not after: the scheduled job re-walks a
// trailing multi-day window every night so a failed run self-heals, and building
// first would re-query Cloudflare three times per already-stored day.
async function alreadySnapshotted(day) {
  const { client, bucket, HeadObjectCommand } = await getR2();
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey(day) }));
    return true;
  } catch {
    return false; // Not found — the normal path for a fresh day.
  }
}

async function upload(day, snapshot) {
  const { client, bucket, PutObjectCommand } = await getR2();
  const Key = objectKey(day);
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key,
      Body: JSON.stringify(snapshot),
      ContentType: 'application/json',
    }),
  );
  console.log(`  ${day}  → r2://${bucket}/${Key}`);
}

async function main() {
  const days = targetDays();
  console.log(`\nSnapshotting ${days.length} day(s): ${days[0]}${days.length > 1 ? ` → ${days[days.length - 1]}` : ''}`);

  const uploading = !args['dry-run'] && !args['out-dir'];

  for (const day of days) {
    if (uploading && !args.force) {
      // eslint-disable-next-line no-await-in-loop -- sequential keeps us off Cloudflare's rate limits
      if (await alreadySnapshotted(day)) {
        console.log(`  ${day}  already snapshotted (skip; --force to overwrite)`);
        continue;
      }
    }

    const snapshot = buildSnapshot(day);
    const t = snapshot.totals;

    if (args['dry-run']) {
      console.log(JSON.stringify(snapshot, null, 2));
      continue;
    }
    if (args['out-dir']) {
      const path = resolve(String(args['out-dir']), objectKey(day));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(snapshot));
      console.log(`  ${day}  → ${path}`);
    } else {
      // eslint-disable-next-line no-await-in-loop -- same reason
      await upload(day, snapshot);
    }
    console.log(
      `           ${t.dmgDownloads} dmg · ${t.zipDownloads} zip · ${t.ymlPolls} polls · ` +
        `${t.uniqueHumanDownloaders}/${t.uniqueDownloaders} downloaders look human`,
    );
  }
  console.log('');
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
