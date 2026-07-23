/**
 * DesignStageCanvas — the v0.5 fullscreen design surface's prototype render.
 *
 * v1 SEAM: this is the single swap point where v1's isolated interactive frame
 * (design-mode.md "Canvas v1 — interactive-prototype atype") replaces the
 * static render — keep the boundary at this component. Today it resolves the
 * artifact's on-disk `ui-prototype` HTML (the same static pipeline the
 * existing canvas tab uses) and embeds it via the bare-sandbox `LiveCanvasEmbed`;
 * v1 swaps the inner render for the process-isolated interactive frame behind
 * this same `{ artifact }` prop contract.
 */
import type { ReactElement } from 'react';
import { useArtifactHtml } from '../../../hooks/useArtifactHtml';
import { LiveCanvasEmbed } from '../LiveCanvasEmbed';
import type { Artifact } from '../../../../../shared/types/artifacts';

const FAINT = 'var(--color-text-tertiary)';

interface DesignStageCanvasProps {
  artifact: Artifact;
}

export function DesignStageCanvas({ artifact }: DesignStageCanvasProps): ReactElement {
  const { html, loading } = useArtifactHtml(artifact.runId, 'ui-prototype', true);

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
    <div data-testid="design-stage-canvas" className="h-full w-full">
      <LiveCanvasEmbed html={html} />
    </div>
  );
}
