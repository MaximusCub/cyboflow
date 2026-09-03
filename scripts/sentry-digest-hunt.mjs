#!/usr/bin/env node
/**
 * sentry-digest-hunt — recover the PLAINTEXT behind an `errorDigest` Sentry tag.
 *
 * WHY THIS EXISTS
 * ---------------
 * `captureSeamError` deliberately never ships raw error text: the message is a
 * bounded vocabulary (`sdk terminal result (other)`) and the `extra` bag is
 * deleted outright by `scrubSentryEvent`. That is the right privacy posture and
 * it makes the `other` / `unknown` buckets nearly untriageable — you can see a
 * seam failing 50 times and have no idea which failure it is.
 *
 * `errorDigest` is the escape hatch. It is FNV-1a-32 over `skeletonize(text)`
 * (main/src/orchestrator/programmatic/systemicError.ts), so it leaks nothing on
 * its own — but a hash over a SMALL, ENUMERABLE domain is reversible by
 * brute force. The error strings we care about come from a handful of known
 * binaries, so digest every candidate line and look for a collision.
 *
 * This paid off on 2026-08-29: digest `d1a52bbe` turned out to be
 *   "Failed to authenticate: OAuth session expired and could not be refreshed"
 * which identified a 52-event cascade as ONE user's expired login, and showed
 * the classifier was missing it by a single word ("session", not "token").
 * Log archaeology had already failed at the same question.
 *
 * DO THIS FIRST on any unexplained `other`/`unknown` group. It is minutes, and
 * the alternative is guesswork.
 *
 * USAGE
 * -----
 *   node scripts/sentry-digest-hunt.mjs <digest> [<digest>...]
 *   node scripts/sentry-digest-hunt.mjs --self-test
 *
 * Corpus is assembled automatically from whatever is present: the vendored and
 * installed `claude` binaries (`strings`), the Agent SDK's JS bundles, and this
 * repo's own string literals. Add more with --corpus <file> (one candidate per
 * line).
 *
 * A MISS IS INFORMATIVE. The recipe reproduces known digests, so if a target
 * does not hit, the string is not a bare literal in any of those sources — it is
 * templated (interpolated at runtime) or comes from somewhere else entirely.
 * Stop re-running the same corpus at it. Digests `01cebb29` and `80e9aec4` are
 * both in that category as of 2026-09-01.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * MIRRORS `skeletonize` in main/src/orchestrator/programmatic/systemicError.ts.
 *
 * Kept as a copy because that module is TypeScript and this script must run
 * with bare `node` against an unbuilt tree. The copy is NOT trusted to stay
 * correct on its own — `sentryDigestHunt.test.ts` imports both this file and
 * the real module and asserts they agree over a sample corpus, so drift fails
 * the unit suite rather than silently producing digests that match nothing.
 */
export function skeletonize(text) {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, '<url>')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/(?:\/[^\s'"`,;:()\[\]{}]+){2,}/g, '<path>')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '<str>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 400);
}

/** MIRRORS `digestErrorSkeleton` in systemicError.ts — see skeletonize above. */
export function digestErrorSkeleton(error) {
  const skeleton = skeletonize(error ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < skeleton.length; i++) {
    hash ^= skeleton.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * How a raw string may have been wrapped before it reached the digest. A CLI
 * line is rarely thrown verbatim — it arrives prefixed by the SDK's own
 * templates or by `Error: `. Each wrapper multiplies the corpus, so keep this
 * list to shapes actually observed in the wild.
 */
const WRAPPERS = [
  (s) => s,
  (s) => `Error: ${s}`,
  (s) => `${s}.`,
  (s) => `Error: ${s}.`,
  (s) => s.replace(/\.$/, ''),
  (s) => `API Error: ${s}`,
  (s) => `Command failed: ${s}`,
  // The SDK's subprocess-failure template. Digits skeletonize to '#', so the
  // exit code and stderr prefix are covered by any single instantiation.
  (s) => `Claude Code process exited with code 1. stderr: ${s}`,
  (s) => `Claude Code process exited with code 1. stderr: Error: ${s}`,
];

/** Candidate `claude` binaries, newest install layouts first. Missing paths are skipped. */
function binaryCandidates() {
  const home = process.env.HOME ?? '';
  const globs = [
    path.join(REPO_ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'),
    path.join(REPO_ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude'),
    '/Applications/Cyboflow.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
  ];
  const versionsDir = path.join(home, '.local/share/claude/versions');
  if (fs.existsSync(versionsDir)) {
    for (const entry of fs.readdirSync(versionsDir)) {
      globs.push(path.join(versionsDir, entry));
    }
  }
  return globs.filter((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/** Every quoted string literal in a JS/TS file, unquoted. */
function stringLiterals(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const m of text.matchAll(/["'`]([^"'`\n]{8,200})["'`]/g)) out.push(m[1]);
  return out;
}

function walk(dir, filter, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, filter, acc);
    else if (filter(e.name)) acc.push(full);
  }
  return acc;
}

function buildCorpus(extraFiles) {
  const candidates = new Set();
  let sources = 0;

  for (const bin of binaryCandidates()) {
    try {
      const out = execFileSync('strings', ['-n', '4', bin], {
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'utf8',
      });
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (t.length >= 6) candidates.add(t);
      }
      sources++;
      process.stderr.write(`  corpus: strings ${bin}\n`);
    } catch {
      process.stderr.write(`  corpus: SKIPPED (strings failed) ${bin}\n`);
    }
  }

  const sdkDir = path.join(REPO_ROOT, 'node_modules/@anthropic-ai/claude-agent-sdk');
  for (const f of walk(sdkDir, (n) => n.endsWith('.mjs') || n.endsWith('.js'))) {
    for (const s of stringLiterals(f)) candidates.add(s);
    sources++;
  }

  for (const f of walk(path.join(REPO_ROOT, 'main/src'), (n) => n.endsWith('.ts'))) {
    for (const s of stringLiterals(f)) candidates.add(s);
  }
  sources++;

  for (const f of extraFiles) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.length >= 6) candidates.add(t);
    }
    sources++;
    process.stderr.write(`  corpus: ${f}\n`);
  }

  return { candidates, sources };
}

/** The known-good pair that proves the recipe still reproduces real digests. */
const SELF_TEST = {
  text: 'Failed to authenticate: OAuth session expired and could not be refreshed',
  digest: 'd1a52bbe',
};

function main(argv) {
  if (argv.includes('--self-test')) {
    const got = digestErrorSkeleton(SELF_TEST.text);
    const ok = got === SELF_TEST.digest;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${SELF_TEST.digest} expected, ${got} computed`);
    return ok ? 0 : 1;
  }

  const extraFiles = [];
  const targets = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus') extraFiles.push(argv[++i]);
    else targets.push(argv[i].toLowerCase());
  }

  if (targets.length === 0) {
    console.error('usage: node scripts/sentry-digest-hunt.mjs <digest>... [--corpus <file>]');
    console.error('       node scripts/sentry-digest-hunt.mjs --self-test');
    return 2;
  }

  // Fail loudly if the mirrored implementation has drifted; every result below
  // would otherwise be silently wrong.
  if (digestErrorSkeleton(SELF_TEST.text) !== SELF_TEST.digest) {
    console.error(
      'ABORT: self-test failed — the digest implementation here no longer matches the one\n' +
        'that produced real tags. Re-sync skeletonize/digestErrorSkeleton from\n' +
        'main/src/orchestrator/programmatic/systemicError.ts before trusting any hit.',
    );
    return 1;
  }

  process.stderr.write('Building corpus...\n');
  const { candidates, sources } = buildCorpus(extraFiles);
  process.stderr.write(
    `Corpus: ${candidates.size} unique candidates from ${sources} sources, ` +
      `x${WRAPPERS.length} wrappers = ${candidates.size * WRAPPERS.length} digests\n\n`,
  );

  const wanted = new Set(targets);
  const hits = new Map();
  for (const candidate of candidates) {
    for (const wrap of WRAPPERS) {
      const variant = wrap(candidate);
      const d = digestErrorSkeleton(variant);
      if (wanted.has(d) && !hits.has(d)) hits.set(d, variant);
    }
  }

  for (const target of targets) {
    if (hits.has(target)) console.log(`${target}  <=  ${JSON.stringify(hits.get(target))}`);
    else console.log(`${target}  --  NOT FOUND (templated, or not from these sources)`);
  }
  return hits.size === targets.length ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
