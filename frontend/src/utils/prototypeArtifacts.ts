/**
 * prototypeArtifacts — shared pure helpers for the design-prototype artifact
 * family (`ui-prototype` / `interactive-prototype`), extracted from
 * DesignModeSurface so the center-pane tab machinery can reuse the same
 * bytes/selection semantics (design-mode.md "Canvas v1 — interactive-prototype
 * atype").
 */
import type { Artifact } from '../../../shared/types/artifacts';

/** The v0.5 static atype and the v1 process-isolated atype are both "the
 * session's prototype" for picking purposes — a session's canvas may be
 * either depending on when it was created / which tier it runs. */
export function isPrototypeAtype(atype: Artifact['atype']): boolean {
  return atype === 'ui-prototype' || atype === 'interactive-prototype';
}

/**
 * True when the prototype artifact actually has rendered bytes behind it — a
 * canonical `{ fileName }` payload pointer. The backend creates a BYTES-LESS
 * stub row at design-session creation (the re-entry door: its artifact tab +
 * CTA must exist before the agent's first report), and consumers must treat
 * that stub as "no prototype yet" (intro/working), not as an unreadable
 * prototype.
 */
export function prototypeHasBytes(artifact: Artifact | null): boolean {
  if (artifact === null || artifact.payloadJson === null) return false;
  try {
    const parsed: unknown = JSON.parse(artifact.payloadJson);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { fileName?: unknown }).fileName === 'string'
    );
  } catch {
    return false;
  }
}

/**
 * Pick the session's current prototype artifact. A design session iterates
 * ONE prototype in place, but across re-launches a session can span multiple
 * runs — and a tier promotion leaves a superseded static row beside the
 * interactive one — so several candidates can coexist.
 *
 * THE prototype-family selection rule, mirrored verbatim in the backend's
 * draft binding (mcpQueryHandler, where the rationale lives) and draftStatus
 * (design router) — change all three together so the surface and the Approve
 * CAS never disagree about WHICH artifact is "the session's prototype":
 *   1. payload-bearing beats the bytes-less re-entry stub;
 *   2. the interactive tier beats the static one (a mid-session tier
 *      switch leaves both payload-bearing; the lo-fi row may hold a
 *      higher revision from its earlier life);
 *   3. revision, then createdAt, as residual deterministic tie-breaks.
 */
export function pickPrototype(artifacts: Artifact[]): Artifact | null {
  let best: Artifact | null = null;
  for (const a of artifacts) {
    if (!isPrototypeAtype(a.atype)) continue;
    if (best === null) {
      best = a;
      continue;
    }
    const aBytes = prototypeHasBytes(a);
    const bestBytes = prototypeHasBytes(best);
    if (aBytes !== bestBytes) {
      if (aBytes) best = a;
      continue;
    }
    const aInteractive = a.atype === 'interactive-prototype';
    const bestInteractive = best.atype === 'interactive-prototype';
    if (aInteractive !== bestInteractive) {
      if (aInteractive) best = a;
      continue;
    }
    if ((a.revision ?? 0) > (best.revision ?? 0)) {
      best = a;
    } else if ((a.revision ?? 0) === (best.revision ?? 0) && a.createdAt > best.createdAt) {
      best = a;
    }
  }
  return best;
}

/**
 * Drop `ui-prototype` rows that a payload-bearing `interactive-prototype` in
 * the same list supersedes — used by the center-pane tab sync so a design
 * session that runs (or was promoted to) the interactive tier doesn't present
 * a second, dead prototype tab beside the live one.
 *
 * Covers both shapes the interactive tier leaves behind:
 *   - the BYTES-LESS re-entry stub minted at session creation (the agent's
 *     first report went to the interactive atype instead of enriching it);
 *   - a superseded payload-bearing static row after a mid-session tier
 *     promotion (pickPrototype would never select it, so its tab is inert
 *     clutter).
 *
 * With no bytes-backed interactive row present, the list passes through
 * unchanged — the static tier (and the pre-first-report stub, which IS the
 * re-entry door) keep their tabs.
 */
export function hideSupersededPrototypes(artifacts: Artifact[]): Artifact[] {
  const hasLiveInteractive = artifacts.some(
    (a) => a.atype === 'interactive-prototype' && prototypeHasBytes(a),
  );
  if (!hasLiveInteractive) return artifacts;
  return artifacts.filter((a) => a.atype !== 'ui-prototype');
}
