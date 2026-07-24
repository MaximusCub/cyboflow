import { IpcMain, app, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { pathToFileURL } from 'url';
import type { AppServices } from './types';
import { getCyboflowSubdirectory } from '../utils/cyboflowDirectory';
import {
  ARTIFACT_PROTOTYPE_CSP,
  ARTIFACT_POLICIES,
  PROTOTYPE_HTML_RELPATH,
  MAX_PROTOTYPE_HTML_BYTES,
  isHtmlLoadableAtype,
  type LoadArtifactHtmlAtype,
  type LoadArtifactHtmlRequest,
  type LoadArtifactHtmlResult,
  type OpenArtifactHtmlExternalRequest,
  type OpenArtifactHtmlExternalResult,
} from '../../../shared/types/artifacts';
import { safeRunId, resolveArtifactCommitDir, loadCommittedHtml } from '../orchestrator/artifactSnapshot';

/**
 * IPC handler for the static-mockup `ui-prototype`/`generic` HTML loader
 * (Approach C — an on-disk self-contained HTML+CSS document, no dev server, no
 * JS). Reads the canonical `prototype/index.html` for the SELECTED artifact only
 * and returns it as a string with a restrictive CSP `<meta>` prepended as the
 * document's first token (see injectPrototypeCsp); the renderer embeds it via a
 * bare `sandbox=""` `srcDoc` iframe (`LiveCanvasEmbed`).
 *
 *   artifacts:load-html  { runId, atype: 'ui-prototype'|'generic', committed? }
 *                          -> IPCResponse<{ html: string | null }>
 *
 * DUAL SOURCE (IDEA-039):
 *   1. the run's live artifacts subtree
 *      (`CYBOFLOW_DIR/artifacts/runs/<safeRunId>/prototype/index.html`), derived
 *      from the TRUSTED runId via getCyboflowSubdirectory — the env var
 *      CYBOFLOW_RUN_ARTIFACTS_DIR is NEVER read in the main process;
 *   2. else the committed project snapshot store
 *      (`<projectRoot>/.cyboflow/artifacts/<safeRunId>/<atype>/files/prototype/
 *      index.html`) — a committed artifact's run subtree is reaped on close-out,
 *      so its bytes live only in the durable commit store.
 *
 * HARDENING (both sources): path-resolve containment inside the root, an `lstat`
 * reject of a symlinked final component, a `realpath` re-verify inside the root
 * (guards an intermediate symlinked dir), a regular-file check, and a size
 * ceiling. FAIL-SOFT: a missing / invalid / oversized file is NOT fatal — the
 * handler returns `{ html: null }` (the renderer shows an explicit empty state),
 * never an error.
 */

/**
 * Inject the restrictive artifact CSP as the document's FIRST token so it governs
 * every subsequent element and subresource fetch. With a bare `sandbox=""` iframe
 * (no `allow-scripts`, no `allow-same-origin`) this injected `<meta>` is the SOLE
 * network-egress control — scripts are already disabled by the sandbox, but
 * `sandbox=""` does NOT block subresource GETs (`<img>`, CSS `url()`, `@font-face`),
 * so the policy must hold against adversarial markup.
 *
 * We deliberately do NOT locate `<head>` by regex, and we do NOT preserve ANY
 * untrusted prefix ahead of the meta — both are bypassable by a parser
 * differential:
 *   - `.replace(/<head\b[^>]*>/i)` matches the FIRST occurrence, so a leading
 *     `<!-- <head> -->` comment captures the splice and leaves the doc unprotected;
 *   - keeping a "leading `<!doctype>`" ahead of the meta via a `/^\s*<!doctype/`
 *     probe is unsafe because JS `\s` matches characters HTML does NOT treat as
 *     pre-doctype whitespace (U+FEFF BOM, U+00A0 NBSP, U+000B vertical tab). An
 *     attacker prefixes one of those, the probe still "sees" the doctype and
 *     splices AFTER it, but the HTML parser treats the char as text — opening
 *     `<body>` early and pushing the CSP `<meta>` OUT of `<head>`, where a
 *     `http-equiv` CSP is ignored → external subresource fetches escape.
 *
 * Instead we ALWAYS prepend the meta at absolute position 0. Nothing can precede
 * it, so no prefix trick applies; the parser hoists a leading `<meta>` into a
 * (synthesized) `<head>` as its first child and the CSP governs the whole
 * document. This document is only ever rendered via an iframe `srcDoc` (see
 * LiveCanvasEmbed) — a srcdoc document defaults to no-quirks parse mode even
 * without a leading `<!doctype>`, so prepending ahead of any original doctype
 * does NOT regress rendering fidelity.
 *
 * The policy string is atype-driven (the artifact registry's per-atype `csp`):
 * static ui-prototype/generic get the scripts-off `ARTIFACT_PROTOTYPE_CSP`
 * (the default, so existing callers/tests need no change), interactive-prototype
 * gets the scripts-on, egress-off `ARTIFACT_INTERACTIVE_CSP`. The load-html
 * handler selects the policy from the registry by atype and passes it here.
 */
export function injectPrototypeCsp(html: string, csp: string = ARTIFACT_PROTOTYPE_CSP): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return `${meta}${html}`;
}

/** IPCResponse-compatible result shape (mirrors frontend/src/utils/api.ts). */
interface LoadHtmlResponse {
  success: boolean;
  data?: LoadArtifactHtmlResult;
  error?: string;
}

/**
 * Hardened read of the canonical `prototype/index.html` from the run's LIVE
 * artifacts subtree. Returns the raw document string, or null (fail-soft) when
 * absent / invalid / oversized / escaping the root.
 *
 * TOCTOU-hardened: the containing dir is realpath-checked for containment, then
 * the FINAL component is opened with `O_NOFOLLOW` (a symlinked index.html is
 * rejected atomically at open, ELOOP), and the `fstat` size check + the bytes
 * returned come off that SAME descriptor — no lstat→realpath→read window.
 */
async function loadRunSubtreeHtml(runId: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const runRoot = path.resolve(getCyboflowSubdirectory('artifacts', 'runs', safeRunId(runId)));
    const target = path.resolve(runRoot, PROTOTYPE_HTML_RELPATH);
    if (target !== runRoot && !target.startsWith(runRoot + path.sep)) return null;
    const realRoot = await fs.realpath(runRoot);
    const realDir = await fs.realpath(path.dirname(target));
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) return null;
    fh = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = await fh.stat();
    if (!st.isFile()) return null;
    if (st.size > MAX_PROTOTYPE_HTML_BYTES) return null;
    return await fh.readFile('utf-8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Hardened read of the canonical `prototype/index.html` from the COMMITTED
 * project snapshot store for `(runId, atype)`. Resolves the run's project via
 * workflow_runs + the configured commit dir, then delegates the guarded read to
 * artifactSnapshot.loadCommittedHtml. Returns null (fail-soft) when the run /
 * project / store / file is absent or invalid.
 */
async function loadCommittedStoreHtml(
  services: AppServices,
  runId: string,
  atype: string,
): Promise<string | null> {
  try {
    const db = services.databaseService.getDb();
    const run = db
      .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
      .get(runId) as { projectId: number } | undefined;
    if (!run) return null;
    const project = services.databaseService.getProject(run.projectId);
    if (!project?.path) return null;
    const storeDir = resolveArtifactCommitDir(project.path, services.configManager.getArtifactCommitDir());
    return await loadCommittedHtml(storeDir, runId, atype);
  } catch {
    return null;
  }
}

/** Narrow an untrusted `atype` to an HTML-loadable canvas atype, else null.
 *  Consults the artifact registry (`htmlLoadable`) — the single authority on
 *  which atypes the loader may source bytes for (ui-prototype / generic /
 *  interactive-prototype). */
function coerceAtype(atype: unknown): LoadArtifactHtmlAtype | null {
  return typeof atype === 'string' && isHtmlLoadableAtype(atype) ? atype : null;
}

/** The CSP to inject when serving a given HTML-loadable atype's document —
 *  from the registry, falling back to the static prototype CSP. */
function cspForAtype(atype: LoadArtifactHtmlAtype): string {
  return ARTIFACT_POLICIES[atype].csp ?? ARTIFACT_PROTOTYPE_CSP;
}

/**
 * Load the CANONICAL prototype HTML bytes for `(runId, atype)` — the RAW document
 * (NO CSP injection, unlike the IPC handler), sourced from the live run subtree
 * first, then the committed snapshot store. Reuses the SAME hardened loaders the
 * `artifacts:load-html` handler uses (no duplicated path resolution). Exported for
 * the design Approve snapshot step (designHandoffService), which stores the raw
 * bytes and lets the render path inject the CSP. Fail-soft: null when absent /
 * invalid / oversized.
 */
export async function loadCanonicalPrototypeHtml(
  services: AppServices,
  runId: string,
  atype: string,
): Promise<string | null> {
  const subtree = await loadRunSubtreeHtml(runId);
  if (subtree !== null) return subtree;
  return loadCommittedStoreHtml(services, runId, atype);
}

export function registerArtifactHtmlHandlers(ipcMain: IpcMain, services: AppServices): void {
  ipcMain.handle(
    'artifacts:load-html',
    async (_event, req: LoadArtifactHtmlRequest): Promise<LoadHtmlResponse> => {
      try {
        const runId = typeof req?.runId === 'string' ? req.runId : '';
        // REJECT an unrecognized atype (fail-soft null) rather than defaulting it
        // to ui-prototype — defaulting would read a DIFFERENT artifact's file for a
        // request like { atype: 'screenshots' }.
        const atype = coerceAtype(req?.atype);
        if (runId.length === 0 || atype === null) {
          return { success: true, data: { html: null } };
        }

        // Try the live run subtree FIRST regardless of the committed hint: reap can
        // preserve a committed artifact's live bytes when its snapshot isn't yet
        // durable, so a committed artifact's HTML may still live only in the subtree.
        let raw = await loadRunSubtreeHtml(runId);
        // Then the committed project snapshot store.
        if (raw === null) {
          raw = await loadCommittedStoreHtml(services, runId, atype);
        }

        const html = raw === null ? null : injectPrototypeCsp(raw, cspForAtype(atype));
        return { success: true, data: { html } };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Failed to load artifact HTML.' };
      }
    },
  );

  // Open the canonical prototype HTML in the user's default browser. The RAW
  // document (no CSP meta) is written to a temp copy and opened via
  // shell.openExternal — the user is deliberately opening their own local file
  // outside the sandboxed in-app iframe, so the in-app egress policy does not
  // apply. Sourced through the SAME hardened dual-source loader as load-html,
  // so no new path-resolution surface is introduced.
  ipcMain.handle(
    'artifacts:open-in-browser',
    async (
      _event,
      req: OpenArtifactHtmlExternalRequest,
    ): Promise<{ success: boolean; data?: OpenArtifactHtmlExternalResult; error?: string }> => {
      try {
        const runId = typeof req?.runId === 'string' ? req.runId : '';
        const atype = coerceAtype(req?.atype);
        if (runId.length === 0 || atype === null) {
          return { success: false, error: 'Invalid open-in-browser request.' };
        }

        const raw = await loadCanonicalPrototypeHtml(services, runId, atype);
        if (raw === null) {
          return { success: false, error: 'Prototype HTML is not readable.' };
        }

        const dir = path.join(app.getPath('temp'), 'cyboflow-prototypes');
        await fs.mkdir(dir, { recursive: true });
        // safeRunId keeps the temp filename traversal-free.
        const target = path.join(dir, `${safeRunId(runId)}-${atype}.html`);
        await fs.writeFile(target, raw, 'utf-8');
        await shell.openExternal(pathToFileURL(target).toString());
        return { success: true, data: { opened: true } };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'Failed to open prototype in browser.',
        };
      }
    },
  );
}
