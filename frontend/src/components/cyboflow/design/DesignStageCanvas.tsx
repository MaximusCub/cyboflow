/**
 * DesignStageCanvas — the v0.5/v1 fullscreen design surface's prototype
 * render. Dispatches on the artifact's atype (design-mode.md "Canvas v1 —
 * interactive-prototype atype"):
 *
 *   - `interactive-prototype` (v1): the process-isolated, JS-enabled OOPIF
 *     canvas — `InteractivePrototypeEmbed` talks to the surface-owned
 *     loopback server via `window.electronAPI.designPrototypeServer`.
 *   - everything else (`ui-prototype` today): the pre-v1 static pipeline —
 *     resolves the artifact's on-disk HTML and embeds it via the
 *     bare-sandbox `LiveCanvasEmbed`. Split into its own child
 *     (`StaticPrototypeCanvas`) so this component can dispatch on atype
 *     up front without a conditionally-called hook.
 */
import type { ReactElement, Ref } from 'react';
import { useArtifactHtml } from '../../../hooks/useArtifactHtml';
import { LiveCanvasEmbed } from '../LiveCanvasEmbed';
import { InteractivePrototypeEmbed, type InteractivePrototypeCaptureHandle } from './InteractivePrototypeEmbed';
import type { Artifact } from '../../../../../shared/types/artifacts';

const FAINT = 'var(--color-text-tertiary)';

interface DesignStageCanvasProps {
  artifact: Artifact;
  /**
   * Comment mode's imperative capture handle for the interactive frame
   * (design-mode.md "Comment mode", invariant 1). Only meaningful — and only
   * forwarded — for an `interactive-prototype` artifact; the static pipeline
   * has no live frame to capture from.
   */
  captureRef?: Ref<InteractivePrototypeCaptureHandle>;
}

export function DesignStageCanvas({ artifact, captureRef }: DesignStageCanvasProps): ReactElement {
  if (artifact.atype === 'interactive-prototype') {
    return (
      // Same flex-column contract as the static wrapper below (InteractivePrototypeEmbed
      // sizes itself `flex: 1`, same iframe-collapse hazard as LiveCanvasEmbed).
      <div data-testid="design-stage-canvas" className="h-full w-full flex flex-col min-h-0">
        <InteractivePrototypeEmbed ref={captureRef} runId={artifact.runId} contentKey={artifact.revision ?? 0} />
      </div>
    );
  }
  return <StaticPrototypeCanvas artifact={artifact} />;
}

/** The pre-v1 static pipeline — unchanged behavior, just its own component. */
function StaticPrototypeCanvas({ artifact }: DesignStageCanvasProps): ReactElement {
  const { html, loading } = useArtifactHtml(artifact.runId, 'ui-prototype', true, artifact.revision ?? 0);

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <span data-testid="design-stage-canvas-loading" className="text-xs text-text-muted">
          Loading prototype…
        </span>
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <span data-testid="design-stage-canvas-unreadable" className="text-xs" style={{ color: FAINT }}>
          Prototype not readable — ask the designer to re-report it
        </span>
      </div>
    );
  }

  return (
    // MUST be a flex column: LiveCanvasEmbed sizes itself `flex: 1` and its
    // iframe collapses to the ~150px default height when the parent isn't a
    // flex container (live-smoke finding: prototype rendered as a thin strip).
    <div data-testid="design-stage-canvas" className="h-full w-full flex flex-col min-h-0">
      <LiveCanvasEmbed html={html} />
    </div>
  );
}
