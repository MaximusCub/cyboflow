-- cyboflow-download-counter — D1 schema.
--
-- Append-only, one row per download START (see src/index.ts for why a redirect
-- makes that a meaningful unit). No aggregation at write time: at ~50 downloads a
-- day this is ~18k rows a year against a 5 GB free-tier limit, so keeping raw rows
-- costs nothing and leaves every future question answerable. Aggregates are cheap
-- to compute on read; a discarded dimension is gone forever.

CREATE TABLE IF NOT EXISTS downloads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT    NOT NULL,           -- ISO8601 UTC instant
  day           TEXT    NOT NULL,           -- YYYY-MM-DD UTC, denormalised for grouping
  path          TEXT    NOT NULL,           -- /stable/Cyboflow-latest-macOS-arm64.dmg
  variant       TEXT    NOT NULL,           -- stable | dev
  arch          TEXT    NOT NULL,           -- arm64 | x64 | unknown

  -- sha256(sha256(SALT:YYYY-MM):ip)[0:16]. The raw IP is never stored. Stable
  -- within a salt_period, unlinkable across periods — so unique-downloader counts
  -- are only meaningful WITHIN a period. Always group by (salt_period, downloader_id).
  downloader_id TEXT    NOT NULL,
  salt_period   TEXT    NOT NULL,           -- YYYY-MM

  country       TEXT,
  asn           INTEGER,
  as_org        TEXT,
  ua            TEXT,
  -- Heuristic flag from a small known-cloud ASN list, stored rather than applied so
  -- the definition can be revised against history instead of losing rows now.
  datacenter    INTEGER NOT NULL DEFAULT 0,
  referer       TEXT
);

CREATE INDEX IF NOT EXISTS idx_downloads_day ON downloads (day);
CREATE INDEX IF NOT EXISTS idx_downloads_downloader ON downloads (salt_period, downloader_id);
CREATE INDEX IF NOT EXISTS idx_downloads_variant_day ON downloads (variant, day);
