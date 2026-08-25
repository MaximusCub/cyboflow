/**
 * Mechanical ratchet: no production file under main/src/orchestrator may import
 * `electron` or reach into main/src/services at RUNTIME.
 *
 * The orchestrator is meant to lift out of Electron and run as a plain Node
 * service for the team tier (docs/ARCHITECTURE.md → "Team-tier v2"). Nothing
 * type-checks that claim today, so it decays quietly: a single
 * `import { app } from 'electron'` for one boolean is enough to make the whole
 * subtree unextractable, and it reads as harmless in review. The seam is an
 * interface (DatabaseLike-style) or a value the boot wiring in main/src/index.ts
 * injects — see the `claudeExecutablePath` argument threaded into the SDK-query
 * factories for the worked example.
 *
 * Two layers guard this. main/eslint.config.js carries a
 * `@typescript-eslint/no-restricted-imports` override over the same tree, which
 * gives the fast in-editor signal. This test is the backstop that catches what
 * an import rule structurally cannot see — a dynamic `require('electron')` or
 * `await import('../services/x')` — and it is where the frozen exemption list
 * lives with a reason per entry.
 *
 * Type-only imports are deliberately NOT violations: tsc erases them, so they
 * bind the extracted service to nothing at runtime. They are still real coupling
 * for a reader, which is why the eslint rule sets `allowTypeImports` rather than
 * pretending they do not exist.
 *
 * Scope note: the scan is SPECIFIER-anchored. It reads the import/export/require
 * specifier strings out of the source text and classifies them; it does not
 * resolve modules, so it cannot see a forbidden module reached transitively
 * through an allowed one. That gap is accepted — the direct edge is the one a
 * reviewer can act on, and the transitive case only exists because a direct edge
 * was added somewhere this scan does cover.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Walk up from the working directory to whichever ancestor holds the
 * orchestrator tree, so the scan works whether vitest is rooted at the repo or
 * at main/. `import.meta` is unavailable under this package's CommonJS target.
 */
function locateOrchestratorRoot(): string {
  let dir = process.cwd();
  for (;;) {
    for (const candidate of [path.join(dir, 'src'), path.join(dir, 'main', 'src')]) {
      if (fs.existsSync(path.join(candidate, 'orchestrator', 'Orchestrator.ts'))) {
        return path.join(candidate, 'orchestrator');
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not locate main/src/orchestrator from ${process.cwd()}`);
    dir = parent;
  }
}

const ORCH_ROOT = locateOrchestratorRoot();

/**
 * Files that still hold a runtime edge to electron or to main/src/services, each
 * with the reason it was not inverted. This list may shrink; growing it needs a
 * reviewer to agree the edge genuinely cannot be broken.
 *
 * Only the first two entries actually pull `electron` into the subtree. The rest
 * are electron-free service modules — a layering violation rather than an
 * extraction blocker — and the durable fix for them is relocating the shared
 * module (streamParser, modelContext, encodeCwd, agentProviderGuard) under
 * shared/, which ripples through their many services-side callers and is out of
 * scope for the module that merely consumes them.
 *
 * Keep in sync with the exemption block in main/eslint.config.js.
 */
const FROZEN_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'trpc/ipcAdapter.ts',
    'The Electron host adapter itself — its entire job is binding the orchestrator tRPC router to BrowserWindow IPC. A standalone service substitutes a different transport adapter rather than extracting this one.',
  ],
  [
    'mcpServer/scriptPath.ts',
    'Needs app.isPackaged, and unlike the SDK-query factories it is consumed BY services (claudeCodeManager, interactiveClaudeManager, mcpOrphanTripwire) at no-arg call sites, so the dependency runs the other way and injection would thread through five chains.',
  ],
  [
    'runEventBridge.ts',
    'Runtime use of the streamParser barrel (EventRouter, RawEventsSink, TypedEventNarrowing, deriveEventType). Electron-free; the fix is relocating streamParser under shared/.',
  ],
  [
    'runRawEventsListing.ts',
    'Runtime use of streamParser (TypedEventNarrowing, deriveEventType). Same relocation as runEventBridge.',
  ],
  [
    'runUnifiedMessagesListing.ts',
    'Runtime use of streamParser (MessageProjection, TypedEventNarrowing, agentStreamEventToClaudeStreamEvent). Same relocation as runEventBridge.',
  ],
  [
    'agentThreadUnifiedMessagesListing.ts',
    'Runtime use of streamParser, mirroring runUnifiedMessagesListing on the agent-thread path. Same relocation as runEventBridge.',
  ],
  [
    'verify/codexVerificationAgentQuery.ts',
    'Runtime use of the Codex app-server schema helper and the Codex usage observer — the Codex provider surface lives entirely under services/panels/codex.',
  ],
  [
    'dynamicWorkflows/dynamicWorkflowTracker.ts',
    'Runtime use of RawEventsSink and the transcript encodeCwd helper. Electron-free; same streamParser relocation.',
  ],
  [
    'eval/evalJury.ts',
    'Runtime use of resolveModelAlias from the Claude model catalog. Electron-free; the alias table belongs under shared/.',
  ],
  [
    'eval/pairwiseJudge.ts',
    'Runtime use of resolveModelAlias — same model-catalog relocation as evalJury.',
  ],
  [
    'eval/codexPairwiseJudge.ts',
    'Runtime use of AgentProviderDisabledError, the shared provider-guard error type. Electron-free.',
  ],
  [
    'agentThread/agentThreadEventsSink.ts',
    'Runtime use of derivePersistedEventType from streamParser. Same relocation as runEventBridge.',
  ],
]);

/**
 * The three ways a specifier can appear, scanned as INDEPENDENT passes rather
 * than one alternation. A single alternating regex makes the branches mutually
 * exclusive, and the statement branch's lazy clause then swallows whole lines:
 * `export const p = () => require('electron').app` would be eaten as the clause
 * of the next `... from '...'` statement and its require never seen. Separate
 * passes cannot mask each other.
 *
 * The statement clause is bounded by `[^;]*?` for the same reason — an import
 * clause never contains a semicolon, so it cannot reach across a statement.
 */
const MODULE_REFS = [
  // import ... from 'x'  /  export ... from 'x'   (clause captured for the type check)
  /(?:^|\n)[ \t]*(?:import|export)(?<clause>[^;]*?)\bfrom\s*['"](?<spec>[^'"]+)['"]/g,
  // import 'x'  (bare side-effect import)
  /(?:^|\n)[ \t]*import\s*['"](?<spec>[^'"]+)['"]/g,
  // require('x') and dynamic import('x') — invisible to any eslint import rule
  /\b(?:require|import)\s*\(\s*['"](?<spec>[^'"]+)['"]\s*\)/g,
] as const;

/** `electron`, or any specifier whose path descends into a `services/` directory. */
function isForbiddenSpecifier(spec: string): boolean {
  if (spec === 'electron' || spec.startsWith('electron/')) return true;
  return /(?:^|\/)services\//.test(spec);
}

/**
 * True when the statement is erased by tsc: the `import type` / `export type`
 * form, or a brace clause in which every binding carries an inline `type`.
 */
function isTypeOnly(clause: string | undefined): boolean {
  if (clause === undefined) return false;
  if (/^\s*type\s/.test(clause)) return true;
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return false;
  const bindings = braces[1].split(',').map(s => s.trim()).filter(s => s.length > 0);
  return bindings.length > 0 && bindings.every(b => /^type\s/.test(b));
}

function isProductionFile(relPath: string): boolean {
  if (!relPath.endsWith('.ts')) return false;
  if (relPath.endsWith('.test.ts') || relPath.endsWith('.itest.ts')) return false;
  const segments = relPath.split(path.sep);
  return !segments.includes('__tests__') && !segments.includes('__test_fixtures__');
}

function listProductionFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...listProductionFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && isProductionFile(rel)) {
      out.push(rel);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  spec: string;
}

function findViolations(relPath: string, source?: string): Violation[] {
  const text = source ?? fs.readFileSync(path.join(ORCH_ROOT, relPath), 'utf8');
  const byLine = new Map<string, Violation>();
  for (const re of MODULE_REFS) {
    for (const match of text.matchAll(re)) {
      const { spec, clause } = match.groups ?? {};
      if (spec === undefined || !isForbiddenSpecifier(spec)) continue;
      if (isTypeOnly(clause)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      // A specifier can be seen by more than one pass; report it once.
      byLine.set(`${line}:${spec}`, { file: relPath, line, spec });
    }
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

describe('standalone-typecheck invariant on main/src/orchestrator', () => {
  const files = listProductionFiles(ORCH_ROOT);

  it('finds production files to scan (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('Orchestrator.ts');
    expect(files).toContain(path.join('verify', 'verificationAgentQuery.ts'));
  });

  it('no non-exempt orchestrator file imports electron or a concrete service', () => {
    const offenders = files
      .filter(f => !FROZEN_EXEMPTIONS.has(f.split(path.sep).join('/')))
      .flatMap(f => findViolations(f));

    expect(
      offenders.map(v => `${v.file}:${v.line}  ${v.spec}`),
      'Depend on an interface, or take the value from the boot wiring in main/src/index.ts (see docs/ARCHITECTURE.md → "Team-tier v2")',
    ).toEqual([]);
  });

  it('every exemption is still a real, still-offending file (no stale exemptions)', () => {
    for (const [relPath, reason] of FROZEN_EXEMPTIONS) {
      const native = relPath.split('/').join(path.sep);
      expect(fs.existsSync(path.join(ORCH_ROOT, native)), `${relPath} no longer exists`).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
      expect(
        findViolations(native).length,
        `${relPath} no longer imports electron or a service — drop it from FROZEN_EXEMPTIONS (and from main/eslint.config.js)`,
      ).toBeGreaterThan(0);
    }
  });

  it('the six inverted SDK-query factories stay free of the services import', () => {
    // The dependency inversion these files got is the worked example the module
    // doc points at; pin it so a future edit cannot quietly re-add the import.
    const inverted = [
      'verify/verificationAgentQuery.ts',
      'verify/runbookDraftAgentQuery.ts',
      'programmatic/monitorQuery.ts',
      'feedback/revisionQuery.ts',
      'eval/pairwiseJudgeQuery.ts',
      'eval/evalJudgeQuery.ts',
    ];
    for (const relPath of inverted) {
      expect(FROZEN_EXEMPTIONS.has(relPath), `${relPath} must not be exempt`).toBe(false);
      expect(findViolations(relPath.split('/').join(path.sep)), relPath).toEqual([]);
    }
  });

  it('the scanner actually detects the forms it claims to (self-check)', () => {
    const positives: [string, string][] = [
      ["import { app } from 'electron';", 'electron'],
      ["import { EventRouter } from '../services/streamParser';", '../services/streamParser'],
      ["export { x } from '../../services/panels/claude/modelContext';", '../../services/panels/claude/modelContext'],
      ["const { app } = require('electron');", 'electron'],
      ["const m = await import('../services/streamParser');", '../services/streamParser'],
      ["import 'electron';", 'electron'],
      // Mixed clause: one runtime binding is enough to keep the edge.
      ["import { type Foo, bar } from '../services/x';", '../services/x'],
      // Multi-line clause — the real tree writes streamParser imports this way.
      ["import {\n  MessageProjection,\n} from '../services/streamParser';", '../services/streamParser'],
    ];
    for (const [sample, spec] of positives) {
      const found = findViolations('sample.ts', sample);
      expect(found.map(v => v.spec), sample).toEqual([spec]);
    }

    // Regression: a lazily-bounded statement clause used to swallow the line
    // below it, hiding a require() behind the NEXT import's specifier. The
    // require must still be reported even when an innocuous import follows.
    const swallowed = [
      "export const probe = () => require('electron').app.isPackaged;",
      "import type { X } from '../../../shared/types/x';",
    ].join('\n');
    expect(findViolations('sample.ts', swallowed).map(v => v.spec)).toEqual(['electron']);

    const negatives = [
      // Erased by tsc — coupling for a reader, not for the extracted service.
      "import type { WorktreeManager } from '../services/worktreeManager';",
      "import { type EventRouter } from '../services/streamParser/eventRouter';",
      "export type { SpawnEventsSink } from '../services/panels/claude/claudeCodeManager';",
      // Not electron, not a service.
      "import * as path from 'node:path';",
      "import { makeDeadline } from './deadline';",
      // `services` as a bare word, not a path segment we forbid.
      "import { registerServices } from './registerServices';",
      "const label = 'electron';",
    ];
    for (const sample of negatives) {
      expect(findViolations('sample.ts', sample), sample).toEqual([]);
    }
  });
});
