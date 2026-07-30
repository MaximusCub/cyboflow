# cyboflow-download-counter

Counts installer downloads at `dl.cyboflow.com`, then 302s to the R2 release host.

**Tier 1** of download instrumentation. Tier 0 (`scripts/snapshot-download-stats.mjs`)
freezes Cloudflare's expiring edge analytics into R2; this replaces the noisy part of
that signal with a first-party counter. See `docs/UPDATES.md` → "Measuring downloads".

## Why it redirects instead of serving

The Worker is touched exactly once, when a download **starts**. Byte-range requests
and resumes go to the redirect target and never reach it, so one row is one download
rather than one row per `206`. Range inflation is precisely what makes the raw edge
counts untrustworthy — 5 "downloads" totalling 331 MB against a 300 MB file — and a
redirect removes it structurally instead of trying to dedupe it back out afterwards.

It also keeps failures cheap. A broken 302 is obvious and harmless; a Worker
streaming 305 MB that mishandles `Range` hands someone a truncated DMG that fails
signature verification, which reads as "the app is broken".

Because the bytes still come from `updates.cyboflow.com`, Tier 0 keeps observing the
actual transfer — two independent measurements that catch each other drifting.

## One-time setup

```bash
cd workers/download-counter
pnpm install                      # local to this dir; NOT part of the pnpm workspace

wrangler d1 create cyboflow-downloads
# copy the printed database_id into wrangler.toml (replaces REPLACE_ME)

pnpm run schema                   # apply schema.sql to the remote D1

# MUST be byte-identical to the Tier 0 secret, or downloader ids from the two
# systems stop joining. It is in .envrc.local as DOWNLOAD_STATS_SALT.
wrangler secret put DOWNLOAD_STATS_SALT

pnpm run deploy                   # provisions dl.cyboflow.com DNS + cert, then deploys
```

Verify before touching the website — this must 302, not 200:

```bash
curl -sI https://dl.cyboflow.com/stable/Cyboflow-latest-macOS-arm64.dmg | head -5
curl -sI https://dl.cyboflow.com/../etc/passwd | head -1     # expect 404
```

## Then repoint the website

Four links in `~/Developer/cyboflow-web` (`download/index.html`, `dev/index.html`):
swap the `updates.cyboflow.com` host for `dl.cyboflow.com`, leaving the paths alone.
Anything still pointing at `updates.` keeps working — it just goes uncounted here.

## Reading the data

```bash
# downloads per day, real vs datacenter
wrangler d1 execute cyboflow-downloads --remote --command \
  "SELECT day, variant,
          SUM(datacenter = 0) AS human,
          SUM(datacenter = 1) AS bots
     FROM downloads GROUP BY day, variant ORDER BY day DESC LIMIT 30"

# unique downloaders this month — MUST group by salt_period, ids are not
# comparable across months by design
wrangler d1 execute cyboflow-downloads --remote --command \
  "SELECT salt_period, COUNT(DISTINCT downloader_id) AS unique_downloaders
     FROM downloads WHERE datacenter = 0 GROUP BY salt_period ORDER BY salt_period DESC"

# the operator-machine signature: one downloader taking multiple arches in a day
wrangler d1 execute cyboflow-downloads --remote --command \
  "SELECT day, downloader_id, COUNT(DISTINCT arch) AS arches, COUNT(*) AS pulls
     FROM downloads GROUP BY day, downloader_id HAVING arches > 1"
```

## Gotchas

| Concern | Detail |
|---|---|
| **Redirect must not be cached** | The 302 is sent `no-store`. An edge-cached redirect would serve later downloads without invoking the Worker at all, and they would silently go uncounted. |
| **Salt must match Tier 0** | Same secret, same `sha256(sha256(SALT:YYYY-MM):ip)[0:16]` derivation. Change either side and ids stop joining across the two systems. |
| **Never point this at `updates.cyboflow.com`** | That host serves the updater's manifest and differential payloads. Compute in front of it means a bug strands existing installs on an old version — and the fix ships through the thing you broke. |
| **Allowlist is the open-redirect guard** | Only `/(stable\|dev)/<basename>.dmg` redirects; everything else 404s. Loosening `ARTIFACT_RE` to accept user-shaped paths would turn this into an open redirect. |
| **`datacenter` is a flag, not a filter** | Rows are always stored. The ASN list is a starter heuristic and will miss things — revise it against history rather than dropping rows at write time. |
| **Counts starts, not completions** | A click cancelled at 5 MB counts. Neither shape can measure completion reliably; cross-check against Tier 0 egress when it matters. |
