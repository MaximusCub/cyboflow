/**
 * DesignStageCanvas — the v0.5 stage's prototype render (the v1 swap seam).
 * Covers the three states (loading / unreadable / rendered) and the layout
 * regression from the live smoke: LiveCanvasEmbed sizes itself `flex: 1`, so
 * the canvas wrapper MUST be a flex column or the embedded iframe collapses
 * to the ~150px default height (prototype rendered as a thin strip).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Artifact } from '../../../../../../shared/types/artifacts';

let mockHtml: string | null = null;
let mockLoading = false;
const mockUseArtifactHtml = vi.fn(() => ({ html: mockHtml, loading: mockLoading }));

vi.mock('../../../../hooks/useArtifactHtml', () => ({
  useArtifactHtml: (...args: unknown[]) => mockUseArtifactHtml(...(args as [])),
}));

vi.mock('../../LiveCanvasEmbed', () => ({
  LiveCanvasEmbed: ({ html }: { html: string }) => (
    <div data-testid="live-canvas-embed-stub" data-html-length={html.length} />
  ),
}));

import { DesignStageCanvas } from '../DesignStageCanvas';

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    atype: 'ui-prototype',
    label: 'Prototype',
    stepOrigin: null,
    mode: 'canvas',
    committed: false,
    sessionOnly: true,
    isNew: false,
    payloadJson: JSON.stringify({ fileName: 'prototype/index.html' }),
    sourceRef: 'IDEA-1',
    createdAt: '2026-07-23T00:00:00Z',
    committedAt: null,
    revision: 5,
    ...overrides,
  } as Artifact;
}

describe('DesignStageCanvas', () => {
  beforeEach(() => {
    mockHtml = null;
    mockLoading = false;
    mockUseArtifactHtml.mockClear();
  });

  it('resolves the artifact html by runId with the ui-prototype atype', () => {
    render(<DesignStageCanvas artifact={makeArtifact({ runId: 'run-9' })} />);
    expect(mockUseArtifactHtml).toHaveBeenCalledWith('run-9', 'ui-prototype', true);
  });

  it('shows the loading state while the html resolves', () => {
    mockLoading = true;
    render(<DesignStageCanvas artifact={makeArtifact()} />);
    expect(screen.getByTestId('design-stage-canvas-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('live-canvas-embed-stub')).not.toBeInTheDocument();
  });

  it('shows the unreadable state when the html resolves to null', () => {
    mockHtml = null;
    render(<DesignStageCanvas artifact={makeArtifact()} />);
    expect(screen.getByTestId('design-stage-canvas-unreadable')).toBeInTheDocument();
  });

  it('renders the embed inside a flex-column wrapper (iframe-collapse regression)', () => {
    mockHtml = '<html><body>proto</body></html>';
    render(<DesignStageCanvas artifact={makeArtifact()} />);
    const wrapper = screen.getByTestId('design-stage-canvas');
    // LiveCanvasEmbed's root is `flex: 1` and needs a flex-column parent; a
    // plain block wrapper collapses the iframe to its default height.
    expect(wrapper.className).toContain('flex');
    expect(wrapper.className).toContain('flex-col');
    expect(wrapper.className).toContain('h-full');
    expect(screen.getByTestId('live-canvas-embed-stub')).toBeInTheDocument();
  });
});
