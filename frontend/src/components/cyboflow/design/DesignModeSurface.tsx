/**
 * DesignModeSurface — the v0.5 fullscreen design takeover (design-mode.md
 * "Fullscreen design surface (v0.5)").
 *
 * A renderer-level takeover: App swaps the normal shell for this component
 * whenever `useDesignModeStore.activeDesignSessionId` is non-null (a CONDITIONAL
 * SWAP, not a stacked overlay — so only ONE chat view and ONE canvas subscribe
 * per session, satisfying the spec's single-mount / single-subscribe invariant).
 * The root renders in NORMAL FLOW below the TitleBar (flex-1 in App's column) —
 * deliberately NOT `fixed inset-0`, which would cover the title bar and put the
 * macOS traffic lights on top of the Exit button (live-smoke finding).
 *
 * Layout:
 *   - Top bar: Exit (top-left) · "DESIGN MODE" wordmark + session name · Approve
 *     control (top-right, gated identically to the canvas header).
 *   - Body: left rail = the session's existing Claude chat panel at rail width;
 *     center = the <DesignStage> (clarify → working → prototype precedence).
 *
 * Artifacts are resolved ONCE here (session-scoped) and the derived
 * ui-prototype artifact is threaded to BOTH the top-bar Approve control and the
 * stage — the canvas is the single place v1 later swaps in the isolated frame.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ReactElement } from 'react';
import { useDesignModeStore } from '../../../stores/designModeStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { usePanelStore } from '../../../stores/panelStore';
import { useSessionArtifactsList } from '../../../hooks/useArtifactsList';
import { useEnsureClaudePanel } from '../../../hooks/useEnsureClaudePanel';
import { ClaudePanel } from '../../panels/claude/ClaudePanel';
import { DesignApproveControl } from '../DesignApproveControl';
import { DesignStage } from './DesignStage';
import type { Artifact } from '../../../../../shared/types/artifacts';

/**
 * Pick the session's current ui-prototype artifact. A design session iterates
 * ONE prototype in place, but across re-launches a session can span multiple
 * runs — so if several exist, prefer the most recently created (newest run),
 * tie-breaking on the higher enrich-in-place revision.
 */
/**
 * True when the prototype artifact actually has rendered bytes behind it — a
 * canonical `{ fileName }` payload pointer. The backend creates a BYTES-LESS
 * stub row at design-session creation (the re-entry door: its artifact tab +
 * CTA must exist before the agent's first report), and the stage must treat
 * that stub as "no prototype yet" (intro/working), not as an unreadable
 * prototype.
 */
function prototypeHasBytes(artifact: Artifact | null): boolean {
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

function pickPrototype(artifacts: Artifact[]): Artifact | null {
  let best: Artifact | null = null;
  for (const a of artifacts) {
    if (a.atype !== 'ui-prototype') continue;
    if (best === null) {
      best = a;
      continue;
    }
    if (a.createdAt > best.createdAt) {
      best = a;
    } else if (a.createdAt === best.createdAt && (a.revision ?? 0) > (best.revision ?? 0)) {
      best = a;
    }
  }
  return best;
}

export function DesignModeSurface(): ReactElement | null {
  const activeDesignSessionId = useDesignModeStore((s) => s.activeDesignSessionId);
  const exitDesignMode = useDesignModeStore((s) => s.exitDesignMode);

  const session = useSessionStore((s) =>
    s.sessions.find((x) => x.id === activeDesignSessionId),
  );
  const projectId = session?.projectId ?? null;
  const sessionPanels = usePanelStore((s) =>
    activeDesignSessionId ? s.panels[activeDesignSessionId] : undefined,
  );
  const claudePanel = (sessionPanels ?? []).find((p) => p.type === 'claude') ?? null;

  // Resolve artifacts once at the surface level (session-scoped: a design
  // session's prototype can come from any of its runs).
  const { artifacts } = useSessionArtifactsList(activeDesignSessionId, projectId);
  const prototypeArtifact = useMemo(() => pickPrototype(artifacts), [artifacts]);

  // Find-or-create the session's Claude panel — a FALLBACK only: the wizard
  // path store-adds its created panel before onSuccess, so this normally finds
  // it instantly. Guarded ONCE per session (ref) because the effect can re-fire
  // before the store reflects an in-flight create (StrictMode double-invoke,
  // dep-identity churn) — un-guarded, that minted DUPLICATE Claude panels on
  // the very first live smoke.
  const ensureClaudePanel = useEnsureClaudePanel(session ?? null, {
    logTag: 'DesignModeSurface',
  });
  const ensureAttemptedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!session || claudePanel) return;
    if (ensureAttemptedForRef.current === session.id) return;
    ensureAttemptedForRef.current = session.id;
    void ensureClaudePanel();
  }, [session, claudePanel, ensureClaudePanel]);

  // App gates mounting on activeDesignSessionId; this is belt-and-suspenders.
  if (activeDesignSessionId === null) return null;

  // The Approve control renders only when the prototype passes the same
  // server-stamped gate the canvas header uses (sourceRef + sessionId).
  const approveGateOpen =
    prototypeArtifact !== null &&
    prototypeArtifact.sourceRef !== null &&
    prototypeArtifact.sessionId !== null;

  return (
    <div
      data-testid="design-mode-surface"
      className="flex flex-1 min-h-0 flex-col overflow-hidden bg-bg-primary"
    >
      {/* Top bar */}
      <div className="h-10 shrink-0 border-b border-border-primary flex items-center gap-3 px-3">
        <button
          type="button"
          data-testid="design-mode-exit"
          onClick={() => exitDesignMode()}
          className="text-xs font-medium text-text-secondary hover:text-text-primary whitespace-nowrap"
        >
          ← Exit design mode
        </button>
        <span className="text-[10px] font-bold tracking-wide text-text-tertiary whitespace-nowrap">
          DESIGN MODE
        </span>
        {session && (
          <span className="text-xs text-text-secondary truncate">{session.name}</span>
        )}
        <div className="ml-auto flex items-center">
          {session && approveGateOpen && (
            <DesignApproveControl
              sessionId={session.id}
              artifactRevision={prototypeArtifact?.revision}
            />
          )}
        </div>
      </div>

      {/* Body — inline session && claudePanel truthiness so TS narrows both to
          non-null for the rail/stage; the placeholder covers the not-yet-ready gap. */}
      {session && claudePanel ? (
        <div className="flex flex-1 overflow-hidden">
          {/* Left rail: the session's existing Claude chat panel at rail width.
              ClaudePanel derives the active session from the GLOBAL
              sessionStore.activeSessionId, which IS this session by construction
              of both entry doors (wizard start / artifact CTA both activate the
              session before entering the surface). */}
          <div className="w-[400px] shrink-0 border-r border-border-primary flex flex-col overflow-hidden">
            <ClaudePanel panel={claudePanel} isActive />
          </div>
          {/* Center stage: clarify → working → prototype precedence. The stage
              only receives a BYTES-BACKED prototype — the creation-time stub
              (no fileName payload) must read as "no prototype yet", not as an
              unreadable one. */}
          <DesignStage
            sessionId={session.id}
            chatRunId={session.chatRunId ?? null}
            panelId={claudePanel?.id ?? null}
            sessionStatus={session.status ?? null}
            prototypeArtifact={prototypeHasBytes(prototypeArtifact) ? prototypeArtifact : null}
          />
        </div>
      ) : (
        <div
          data-testid="design-mode-preparing"
          className="flex flex-1 items-center justify-center"
        >
          <span className="text-sm text-text-tertiary">Preparing design session…</span>
        </div>
      )}
    </div>
  );
}
