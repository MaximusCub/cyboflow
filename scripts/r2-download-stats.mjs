#!/usr/bin/env node

/**
 * r2-download-stats.mjs — back into download counts for the release artifacts
 * served from R2 over the custom domain (updates.cyboflow.com).
 *
 * Why this instead of R2 storage metrics: the DMGs serve over a Cloudflare custom
 * domain, so every request is logged at the edge WITH its URL path. That lets us
 * count downloads per-artifact (and split new-install .dmg from auto-update .zip),
 * which the bucket-level R2 "Class B operations" counter can't do — and which
 * undercounts anyway whenever Cloudflare serves a file from edge cache (a cache
 * hit never reaches R2). This is the retroactive, telemetry-independent download
 * proxy; treat the numbers as download ATTEMPTS, not unique installs.
 *
 * TWO datasets, because of a Free-plan limit (learned empirically against this
 * zone):
 *   - Per-path detail comes from `httpRequestsAdaptiveGroups`, which REJECTS any
 *     query window wider than 1 day on this plan. So the default mode chunks the
 *     range into one-UTC-day queries and aggregates per path. Its log retention is
 *     short (a handful of days) — days past it simply contribute nothing, and the
 *     run reports how many days actually had data.
 *   - `--daily` uses `httpRequests1dGroups` (non-sampled daily rollup, ~30-day
 *     retention) for long-range VOLUME. No per-file breakdown — only per-day
 *     totals plus a content-type split (zip = auto-update; the large "unknown"
 *     bytes are the .dmg installers, which Cloudflare has no friendly name for).
 *
 * Required env (a release/analytics shell — NOT baked into any build):
 *   CLOUDFLARE_API_TOKEN   token with Zone › Analytics:Read (+ Zone › Zone:Read if
 *                          you rely on zone-name lookup rather than CLOUDFLARE_ZONE_ID)
 *                          CLOUDFLARE_ANALYTICS_API is accepted as an alias — that is
 *                          the name the token is stored under in .envrc.local, and
 *                          reading both means a direnv shell just works.
 * Optional:
 *   CLOUDFLARE_ZONE_ID     zone id for cyboflow.com (skips the name → id lookup)
 *   CLOUDFLARE_ZONE_NAME   zone to look up when no id is given (default: cyboflow.com)
 *
 * Flags (also accepted as env in UPPER_SNAKE, e.g. DAYS=7):
 *   --days=N               look back N days from now           (default: 7)
 *   --since=YYYY-MM-DD     explicit start (overrides --days)
 *   --until=YYYY-MM-DD     explicit end                        (default: now)
 *   --host=<host>          edge host to count                  (default: updates.cyboflow.com)
 *   --variant=stable|dev   restrict to one feed's path prefix  (default: both)
 *   --all-paths            don't filter to release feeds — show every path, incl.
 *                          the vuln-scanner 404 noise that constantly probes the host
 *   --daily                long-range daily VOLUME via httpRequests1dGroups
 *                          (no per-file split; use for ranges past adaptive retention)
 *   --by-ip                group downloads by client IP — spots your own test
 *                          machines (repeat hitters) vs the long tail of real users.
 *                          ⚠ output contains IP addresses (PII) — do NOT commit or paste it.
 *   --json                 emit raw aggregated rows as JSON instead of a table
 *
 * All times are UTC — Cloudflare logs in UTC, and the per-day chunks are UTC days,
 * so a "day" here is 00:00–23:59 UTC, not local.
 */

const GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const REST_BASE = 'https://api.cloudflare.com/client/v4';
const DAY_MS = 24 * 60 * 60 * 1000;

// The per-variant prefixes publish-update.mjs writes under (beta = the legacy dev
// feed name). A path outside these is scanner noise probing the host, not a release.
const FEED_PREFIXES = ['/stable/', '/dev/', '/beta/'];
// A real download moves a file; a 200/206 averaging under this many bytes is a
// HEAD/range probe or a cached error body, not an install. Real artifacts are
// tens-to-hundreds of MB, so a 1 MB floor cleanly separates them from the ~760 B probes.
const REAL_DOWNLOAD_MIN_BYTES = 1024 * 1024;

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// --flag / --flag=value parsing, falling back to UPPER_SNAKE env for each name.
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const opt = (name, envName, fallback) => {
  if (args[name] !== undefined) return args[name];
  if (envName && process.env[envName]) return process.env[envName];
  return fallback;
};

const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_ANALYTICS_API;
if (!token) fail('CLOUDFLARE_API_TOKEN (or CLOUDFLARE_ANALYTICS_API) is not set (needs Zone › Analytics:Read).');

const host = opt('host', 'CLOUDFLARE_ANALYTICS_HOST', 'updates.cyboflow.com');
const variant = opt('variant', null, null);
if (variant && variant !== 'stable' && variant !== 'dev') {
  fail(`--variant must be "stable" or "dev" (got "${variant}").`);
}
const asJson = Boolean(args.json);
const dailyMode = Boolean(args.daily);
const byIpMode = Boolean(args['by-ip']);
const allPaths = Boolean(args['all-paths']);

// Resolve the time window (UTC). --since/--until win; otherwise look back --days.
const days = Number(opt('days', 'DAYS', 7));
if (!Number.isFinite(days) || days <= 0) fail(`--days must be a positive number (got "${days}").`);
const now = new Date();
const untilDate = args.until ? new Date(`${args.until}T23:59:59Z`) : now;
const sinceDate = args.since
  ? new Date(`${args.since}T00:00:00Z`)
  : new Date(now.getTime() - days * DAY_MS);
if (Number.isNaN(sinceDate.getTime()) || Number.isNaN(untilDate.getTime())) {
  fail('Could not parse --since/--until (expected YYYY-MM-DD).');
}
if (sinceDate >= untilDate) fail('The start of the range is not before its end.');

async function cf(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });
  const body = await res.json().catch(() => null);
  if (!body) fail(`Cloudflare API returned no/invalid JSON (HTTP ${res.status}).`);
  // REST surfaces failures as success:false; GraphQL as a non-empty errors[] with
  // data:null. Check BOTH — missing the GraphQL form is what made this script
  // silently report "no requests" while the API was actually erroring on the
  // ">1d time range" quota.
  const gqlErrors = Array.isArray(body.errors) ? body.errors : [];
  if (!res.ok || body.success === false || gqlErrors.length > 0) {
    const msg = gqlErrors.length
      ? gqlErrors.map((e) => e.message).join('; ')
      : Array.isArray(body.errors) && body.errors.length
        ? body.errors.map((e) => e.message).join('; ')
        : `HTTP ${res.status}`;
    fail(`Cloudflare API error: ${msg}`);
  }
  return body;
}

// Zone id: explicit env wins; otherwise look it up by name (needs Zone:Read).
async function resolveZoneTag() {
  const explicit = process.env.CLOUDFLARE_ZONE_ID;
  if (explicit) return explicit;
  const name = process.env.CLOUDFLARE_ZONE_NAME || 'cyboflow.com';
  const body = await cf(`${REST_BASE}/zones?name=${encodeURIComponent(name)}`, { method: 'GET' });
  const zone = body.result && body.result[0];
  if (!zone) fail(`No zone "${name}" visible to this token. Set CLOUDFLARE_ZONE_ID or grant Zone:Read.`);
  return zone.id;
}

function classify(path) {
  if (path.endsWith('.dmg')) return 'dmg'; // first-install download (website)
  if (path.endsWith('.zip')) return 'zip'; // auto-updater payload
  if (path.endsWith('.yml')) return 'yml'; // updater manifest poll (not a download)
  if (path.endsWith('.blockmap')) return 'blockmap'; // delta map
  return 'other';
}

function fmtBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

// Split [sinceDate, untilDate] into <1-day UTC windows so each adaptive query
// stays under the plan's "no range wider than 1d" cap. Each window is clamped to
// the requested bounds and ends one second before the next UTC midnight (86399s).
function dayWindows() {
  const windows = [];
  let cursor = new Date(Date.UTC(sinceDate.getUTCFullYear(), sinceDate.getUTCMonth(), sinceDate.getUTCDate()));
  while (cursor < untilDate) {
    const nextMidnight = new Date(cursor.getTime() + DAY_MS);
    const start = cursor < sinceDate ? sinceDate : cursor;
    const end = nextMidnight > untilDate ? untilDate : new Date(nextMidnight.getTime() - 1000);
    if (start < end) windows.push([start.toISOString(), end.toISOString()]);
    cursor = nextMidnight;
  }
  return windows;
}

const PATHS_QUERY = `
query Paths($zoneTag: String!, $since: Time!, $until: Time!, $host: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        limit: 500
        filter: { datetime_geq: $since, datetime_leq: $until, clientRequestHTTPHost: $host }
        orderBy: [count_DESC]
      ) {
        count
        avg { sampleInterval }
        sum { edgeResponseBytes }
        dimensions { clientRequestPath edgeResponseStatus }
      }
    }
  }
}`;

const BY_IP_QUERY = `
query ByIp($zoneTag: String!, $since: Time!, $until: Time!, $host: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        limit: 5000
        filter: { datetime_geq: $since, datetime_leq: $until, clientRequestHTTPHost: $host }
        orderBy: [count_DESC]
      ) {
        count
        sum { edgeResponseBytes }
        dimensions { clientIP clientCountryName clientRequestPath edgeResponseStatus }
      }
    }
  }
}`;

const DAILY_QUERY = `
query Daily($zoneTag: String!, $since: String!, $until: String!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(limit: 90, filter: { date_geq: $since, date_leq: $until }, orderBy: [date_ASC]) {
        dimensions { date }
        sum {
          requests
          bytes
          contentTypeMap { edgeResponseContentTypeName requests bytes }
          responseStatusMap { edgeResponseStatus requests }
        }
      }
    }
  }
}`;

// ---- Mode A (default): per-path detail, chunked one UTC day at a time ----
async function runPaths(zoneTag) {
  const windows = dayWindows();
  const byPath = new Map();
  let sampled = false;
  let daysWithData = 0;

  for (const [since, until] of windows) {
    // eslint-disable-next-line no-await-in-loop -- sequential keeps us under the 1d cap and avoids rate spikes
    const body = await cf(GRAPHQL_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ query: PATHS_QUERY, variables: { zoneTag, since, until, host } }),
    });
    const zones = body.data && body.data.viewer && body.data.viewer.zones;
    const groups = (zones && zones[0] && zones[0].httpRequestsAdaptiveGroups) || [];
    if (groups.length) daysWithData += 1;
    for (const g of groups) {
      const path = g.dimensions.clientRequestPath;
      if (variant && !path.startsWith(`/${variant}/`)) continue;
      const interval = g.avg && g.avg.sampleInterval ? g.avg.sampleInterval : 1;
      if (interval > 1) sampled = true;
      const est = Math.round(g.count * interval);
      const bytes = (g.sum && g.sum.edgeResponseBytes ? g.sum.edgeResponseBytes : 0) * interval;
      const status = g.dimensions.edgeResponseStatus;
      const row = byPath.get(path) || { path, kind: classify(path), requests: 0, full: 0, partial: 0, bytes: 0 };
      row.requests += est;
      if (status === 200) row.full += est; // a full file delivered in one response
      else if (status === 206) row.partial += est; // a ranged/resumed chunk
      row.bytes += bytes;
      byPath.set(path, row);
    }
  }

  // Restrict to the release feeds (drops the constant vuln-scanner 404 noise) and
  // mark each row's "real" downloads — a 200/206 only counts if the row's average
  // response was actually file-sized, so the ~760 B HEAD/range probes don't inflate.
  let rows = [...byPath.values()];
  if (!allPaths) {
    // Feed prefix AND a real artifact kind — drops /dev/.env, /dev/env.js and other
    // scanner probes that happen to sit under a feed path but aren't release files.
    rows = rows.filter((r) => FEED_PREFIXES.some((p) => r.path.startsWith(p)) && r.kind !== 'other');
  }
  for (const r of rows) {
    const meanBytes = r.bytes / Math.max(1, r.full + r.partial);
    r.real = meanBytes >= REAL_DOWNLOAD_MIN_BYTES ? r.full + r.partial : 0;
  }
  rows.sort((a, b) => b.bytes - a.bytes || b.requests - a.requests);
  const coverage = `${daysWithData}/${windows.length} day(s) had adaptive log data`;

  if (asJson) {
    console.log(JSON.stringify({ zoneTag, host, mode: 'paths', sampled, coverage, rows }, null, 2));
    return;
  }

  const window = `${sinceDate.toISOString().slice(0, 10)} → ${untilDate.toISOString().slice(0, 10)} UTC`;
  console.log(`\nPer-file downloads — ${host}${variant ? ` (${variant} feed)` : ''}   ${window}`);
  console.log(`zone ${zoneTag}   (${coverage})${allPaths ? '   [--all-paths: incl. scanner noise]' : ''}\n`);

  if (rows.length === 0) {
    console.log('  (no release-feed rows — past the short adaptive-log retention; try --daily)\n');
    return;
  }

  // Table hides zero-download probe rows + blockmaps by default (the rollup below
  // still counts the full feed-filtered set); --all-paths shows everything.
  const tableRows = allPaths
    ? rows
    : rows.filter((r) => (r.kind === 'dmg' || r.kind === 'zip' ? r.real > 0 : r.kind === 'yml'));

  // Binaries show real downloads; .yml are update-check polls (informative: ~live installs).
  const w = Math.min(56, Math.max(20, ...tableRows.map((r) => r.path.length), 20));
  console.log(`  ${'artifact'.padEnd(w)}  ${'kind'.padEnd(6)} ${'downloads'.padStart(10)} ${'egress'.padStart(10)}`);
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);
  for (const r of tableRows) {
    const measure = r.kind === 'yml' ? `${r.requests} polls` : r.kind === 'dmg' || r.kind === 'zip' ? String(r.real) : String(r.requests);
    console.log(`  ${r.path.padEnd(w)}  ${r.kind.padEnd(6)} ${measure.padStart(10)} ${fmtBytes(r.bytes).padStart(10)}`);
  }

  // Roll up by kind: real .dmg ≈ new installs, real .zip ≈ auto-updates.
  const totals = {};
  for (const r of rows) {
    const t = (totals[r.kind] = totals[r.kind] || { real: 0, requests: 0, bytes: 0 });
    t.real += r.real || 0;
    t.requests += r.requests;
    t.bytes += r.bytes;
  }
  console.log('\n  by kind:');
  for (const kind of ['dmg', 'zip', 'yml', 'blockmap', 'other']) {
    const t = totals[kind];
    if (!t) continue;
    if (kind === 'dmg') console.log(`    dmg      ${String(t.real).padStart(5)} downloads  (${fmtBytes(t.bytes)})   ← new-install proxy`);
    else if (kind === 'zip') console.log(`    zip      ${String(t.real).padStart(5)} downloads  (${fmtBytes(t.bytes)})   ← auto-update payload`);
    else if (kind === 'yml') console.log(`    yml      ${String(t.requests).padStart(5)} polls      (running apps checking for updates)`);
    else console.log(`    ${kind.padEnd(8)} ${String(t.requests).padStart(5)} requests   (${fmtBytes(t.bytes)})`);
  }

  console.log('\n  caveats — download attempts, not unique installs:');
  console.log('    • a real download = a 200/206 whose row averages ≥1 MB (probes excluded)');
  console.log('    • a resumed download can be several 206 range requests for one human');
  console.log('    • -latest- aliases double-count alongside any versioned file');
  console.log('    • no dedup to people, no retention/D7 — that gap is what Aptabase fills');
  if (sampled) console.log('    • ⚠ edge sampling was active; counts are scaled estimates');
  console.log('');
}

// ---- Mode B (--daily): long-range volume via the non-sampled daily rollup ----
async function runDaily(zoneTag) {
  const since = sinceDate.toISOString().slice(0, 10);
  const until = untilDate.toISOString().slice(0, 10);
  const body = await cf(GRAPHQL_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify({ query: DAILY_QUERY, variables: { zoneTag, since, until } }),
  });
  const zones = body.data && body.data.viewer && body.data.viewer.zones;
  const days1 = (zones && zones[0] && zones[0].httpRequests1dGroups) || [];

  // Per day, pull out the bytes that map to installers vs updates. Cloudflare maps
  // application/x-apple-diskimage (.dmg) to the catch-all "unknown" type, so the
  // large-byte "unknown" bucket IS the installer traffic; "zip" is the updater payload.
  const rows = days1.map((d) => {
    const ct = (d.sum.contentTypeMap || []).reduce((acc, c) => {
      acc[c.edgeResponseContentTypeName] = { requests: c.requests, bytes: c.bytes };
      return acc;
    }, {});
    const status = (d.sum.responseStatusMap || []).reduce((acc, s) => {
      acc[s.edgeResponseStatus] = s.requests;
      return acc;
    }, {});
    return {
      date: d.dimensions.date,
      requests: d.sum.requests,
      bytes: d.sum.bytes,
      installerBytes: ct.unknown ? ct.unknown.bytes : 0,
      zipBytes: ct.zip ? ct.zip.bytes : 0,
      ok: status[200] || 0,
      notFound: status[404] || 0,
    };
  });

  if (asJson) {
    console.log(JSON.stringify({ zoneTag, host, mode: 'daily', rows }, null, 2));
    return;
  }

  console.log(`\nDaily volume — zone ${zoneTag}   ${since} → ${until} UTC\n`);
  if (rows.length === 0) {
    console.log('  (no daily rows in range)\n');
    return;
  }
  console.log(`  ${'date'.padEnd(11)} ${'req'.padStart(6)} ${'egress'.padStart(10)} ${'installer'.padStart(10)} ${'update-zip'.padStart(10)} ${'200'.padStart(5)} ${'404'.padStart(5)}`);
  console.log(`  ${'-'.repeat(11)} ${'-'.repeat(6)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(10)} ${'-'.repeat(5)} ${'-'.repeat(5)}`);
  let totReq = 0;
  let totInstaller = 0;
  let totZip = 0;
  for (const r of rows) {
    totReq += r.requests;
    totInstaller += r.installerBytes;
    totZip += r.zipBytes;
    console.log(
      `  ${r.date.padEnd(11)} ${String(r.requests).padStart(6)} ${fmtBytes(r.bytes).padStart(10)} ${fmtBytes(r.installerBytes).padStart(10)} ${fmtBytes(r.zipBytes).padStart(10)} ${String(r.ok).padStart(5)} ${String(r.notFound).padStart(5)}`,
    );
  }
  console.log(`\n  totals: ${totReq} requests · ${fmtBytes(totInstaller)} installer (.dmg) · ${fmtBytes(totZip)} update (.zip) egress`);
  console.log('  note: 1dGroups has no per-file/host split — "installer" is the apple-diskimage');
  console.log('        ("unknown") content type zone-wide; run the default per-path mode for file detail.\n');
}

// ---- Mode C (--by-ip): group downloads by client IP to separate dev/test
// machines (repeat hitters across feeds + arches) from real one-off users ----
async function runByIp(zoneTag) {
  const windows = dayWindows();
  const byIp = new Map();

  for (const [since, until] of windows) {
    // eslint-disable-next-line no-await-in-loop -- sequential keeps us under the 1d cap
    const body = await cf(GRAPHQL_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ query: BY_IP_QUERY, variables: { zoneTag, since, until, host } }),
    });
    const zones = body.data && body.data.viewer && body.data.viewer.zones;
    const groups = (zones && zones[0] && zones[0].httpRequestsAdaptiveGroups) || [];
    for (const g of groups) {
      const path = g.dimensions.clientRequestPath;
      if (!allPaths && !(FEED_PREFIXES.some((p) => path.startsWith(p)) && classify(path) !== 'other')) continue;
      if (variant && !path.startsWith(`/${variant}/`)) continue;
      const ip = g.dimensions.clientIP;
      const kind = classify(path);
      const e = byIp.get(ip) || { ip, country: g.dimensions.clientCountryName || '??', dmg: 0, zip: 0, polls: 0, bytes: 0, feeds: new Set() };
      if (kind === 'yml') {
        e.polls += g.count;
      } else if (kind === 'dmg' || kind === 'zip') {
        const bytes = g.sum && g.sum.edgeResponseBytes ? g.sum.edgeResponseBytes : 0;
        const real = bytes / Math.max(1, g.count) >= REAL_DOWNLOAD_MIN_BYTES ? g.count : 0;
        e[kind] += real;
        e.bytes += bytes;
        if (real) e.feeds.add(path.startsWith('/stable/') ? 'stable' : path.startsWith('/dev/') ? 'dev' : 'beta');
      }
      byIp.set(ip, e);
    }
  }

  // Rank by total real downloads; a dev box stands out as a high-count IP that
  // pulled from multiple feeds (stable AND dev) — real users grab one file, once.
  const rows = [...byIp.values()]
    .map((e) => ({ ...e, downloads: e.dmg + e.zip, feeds: [...e.feeds].sort().join('+') }))
    .filter((e) => e.downloads > 0)
    .sort((a, b) => b.downloads - a.downloads || b.polls - a.polls);

  if (asJson) {
    console.log(JSON.stringify({ zoneTag, host, mode: 'by-ip', rows }, null, 2));
    return;
  }

  const window = `${sinceDate.toISOString().slice(0, 10)} → ${untilDate.toISOString().slice(0, 10)} UTC`;
  console.log(`\nDownloads by client IP — ${host}   ${window}`);
  console.log(`zone ${zoneTag}\n  ⚠ contains IP addresses (PII) — do not commit or paste this output\n`);
  if (rows.length === 0) {
    console.log('  (no per-IP download rows — past adaptive retention, or no downloads in range)\n');
    return;
  }

  const w = Math.min(42, Math.max(15, ...rows.map((r) => r.ip.length)));
  console.log(`  ${'client IP'.padEnd(w)}  ${'cc'.padEnd(3)} ${'dmg'.padStart(4)} ${'zip'.padStart(4)} ${'polls'.padStart(6)} ${'feeds'.padStart(12)}`);
  console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(3)} ${'-'.repeat(4)} ${'-'.repeat(4)} ${'-'.repeat(6)} ${'-'.repeat(12)}`);
  for (const r of rows) {
    console.log(`  ${r.ip.padEnd(w)}  ${r.country.padEnd(3)} ${String(r.dmg).padStart(4)} ${String(r.zip).padStart(4)} ${String(r.polls).padStart(6)} ${r.feeds.padStart(12)}`);
  }

  const totalDl = rows.reduce((s, r) => s + r.downloads, 0);
  const multiFeed = rows.filter((r) => r.feeds.includes('+'));
  console.log(`\n  ${rows.length} distinct IPs · ${totalDl} downloads`);
  console.log('  likely-you heuristics: an IP that pulled from MULTIPLE feeds (stable+dev), or with a high poll count,');
  console.log('  is a dev/test box — subtract it to estimate real-user downloads:');
  if (multiFeed.length) {
    for (const r of multiFeed) console.log(`    • ${r.ip} (${r.feeds}, ${r.downloads} dls, ${r.polls} polls) ⇐ multi-feed = almost certainly a dev machine`);
    const realUser = totalDl - multiFeed.reduce((s, r) => s + r.downloads, 0);
    console.log(`  → excluding the ${multiFeed.length} multi-feed IP(s): ~${realUser} downloads from single-feed IPs`);
  } else {
    console.log('    (no multi-feed IPs in range — nothing obviously a dev box by that test)');
  }
  console.log('');
}

async function main() {
  const zoneTag = await resolveZoneTag();
  if (byIpMode) return runByIp(zoneTag);
  if (dailyMode) return runDaily(zoneTag);
  return runPaths(zoneTag);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
