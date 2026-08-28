/**
 * Unit tests for VariantSelector's mount/render behavior: hidden at zero
 * variants, rotation-default seeding, and the option list it hands off to
 * variantSelectorLogic (covered independently in variantSelectorLogic.test.ts).
 *
 * `useWorkflowVariants` is mocked so these tests never touch trpc — they only
 * verify VariantSelector's OWN wiring (hide/seed/render), mirroring
 * SubstrateSelector.test.tsx's mocked-hook approach.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WorkflowVariantRow } from '../../../stores/variantsStore';

const { mockUseWorkflowVariants } = vi.hoisted(() => ({
  mockUseWorkflowVariants: vi.fn(),
}));

vi.mock('../../../stores/variantsStore', () => ({
  useWorkflowVariants: mockUseWorkflowVariants,
}));

import { VariantSelector } from '../VariantSelector';

function makeVariant(overrides: Partial<WorkflowVariantRow> = {}): WorkflowVariantRow {
  return {
    id: 'wfv_1',
    workflow_id: 'wf-1',
    label: 'Variant A',
    spec_json: '{}',
    agent_overrides_json: null,
    model: null,
    execution_model: null,
    agent_provider: null,
    agent_runtime: null,
    tuning_level: null,
    weight: 1,
    status: 'active',
    archived_at: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  mockUseWorkflowVariants.mockReset();
});

describe('VariantSelector — zero variants', () => {
  it('renders nothing (hidden entirely) and never seeds a default', () => {
    mockUseWorkflowVariants.mockReturnValue({ variants: [], loaded: true, loading: false, error: null });
    const onChange = vi.fn();
    const { container } = render(
      <VariantSelector tuningLevel={null} workflowId="wf-1" value={{ mode: 'rotation' }} onChange={onChange} />,
    );
    expect(container.firstChild).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders nothing while still loading', () => {
    mockUseWorkflowVariants.mockReturnValue({ variants: [], loaded: false, loading: true, error: null });
    const { container } = render(
      <VariantSelector tuningLevel={null} workflowId="wf-1" value={{ mode: 'rotation' }} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('VariantSelector — >=2 active variants (rotation-eligible)', () => {
  beforeEach(() => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'a', label: 'Variant A' }), makeVariant({ id: 'b', label: 'Variant B' })],
      loaded: true,
      loading: false,
      error: null,
    });
  });

  it('renders the select with Rotation, Baseline, and both variants', () => {
    render(<VariantSelector tuningLevel={null} workflowId="wf-1" value={{ mode: 'rotation' }} onChange={vi.fn()} />);
    const select = screen.getByRole('combobox', { name: /select workflow variant/i });
    expect(select).toBeInTheDocument();
    expect(screen.getByText('Rotation (auto)')).toBeInTheDocument();
    expect(screen.getByText('Baseline (no variant)')).toBeInTheDocument();
    expect(screen.getByText('Variant A')).toBeInTheDocument();
    expect(screen.getByText('Variant B')).toBeInTheDocument();
  });

  it('seeds the default selection to rotation on first load', () => {
    const onChange = vi.fn();
    render(<VariantSelector tuningLevel={null} workflowId="wf-1" value={{ mode: 'baseline' }} onChange={onChange} />);
    expect(onChange).toHaveBeenCalledWith({ mode: 'rotation' });
  });
});

describe('VariantSelector — 1 variant (not rotation-eligible)', () => {
  it('offers Baseline + the variant but NOT Rotation, and seeds Baseline as default', () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'a', label: 'Variant A', status: 'draft' })],
      loaded: true,
      loading: false,
      error: null,
    });
    const onChange = vi.fn();
    render(<VariantSelector tuningLevel={null} workflowId="wf-1" value={{ mode: 'rotation' }} onChange={onChange} />);

    expect(screen.queryByText('Rotation (auto)')).not.toBeInTheDocument();
    expect(screen.getByText('Baseline (no variant)')).toBeInTheDocument();
    // Draft variant is suffixed.
    expect(screen.getByText('Variant A (draft)')).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith({ mode: 'baseline' });
  });
});

describe('VariantSelector — tuning-level pool (migration 126)', () => {
  it('asks the store for THIS level\'s variants', () => {
    mockUseWorkflowVariants.mockReturnValue({ variants: [], loaded: true, loading: false, error: null });
    render(
      <VariantSelector
        workflowId="wf-1"
        tuningLevel="thorough"
        value={{ mode: 'rotation' }}
        onChange={vi.fn()}
      />,
    );
    expect(mockUseWorkflowVariants).toHaveBeenCalledWith('wf-1', 'thorough');
  });

  it('re-seeds the selection when the LEVEL changes, not just the workflow', () => {
    // A pin belongs to one level's pool; carrying it into another level would
    // hand the launcher an id it refuses, so the pool key includes the level.
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_std', tuning_level: 'standard' })],
      loaded: true,
      loading: false,
      error: null,
    });
    const onChange = vi.fn();
    const { rerender } = render(
      <VariantSelector
        workflowId="wf-1"
        tuningLevel="standard"
        value={{ mode: 'variant', variantId: 'wfv_std' }}
        onChange={onChange}
      />,
    );
    onChange.mockClear();

    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_thorough', tuning_level: 'thorough' })],
      loaded: true,
      loading: false,
      error: null,
    });
    rerender(
      <VariantSelector
        workflowId="wf-1"
        tuningLevel="thorough"
        value={{ mode: 'variant', variantId: 'wfv_std' }}
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith({ mode: 'rotation' });
  });

  it('drops a stale cross-level pin even when the new level has NO variants', () => {
    mockUseWorkflowVariants.mockReturnValue({
      variants: [makeVariant({ id: 'wfv_std', tuning_level: 'standard' })],
      loaded: true,
      loading: false,
      error: null,
    });
    const onChange = vi.fn();
    const { rerender } = render(
      <VariantSelector
        workflowId="wf-1"
        tuningLevel="standard"
        value={{ mode: 'variant', variantId: 'wfv_std' }}
        onChange={onChange}
      />,
    );
    onChange.mockClear();

    mockUseWorkflowVariants.mockReturnValue({ variants: [], loaded: true, loading: false, error: null });
    rerender(
      <VariantSelector
        workflowId="wf-1"
        tuningLevel="efficient"
        value={{ mode: 'variant', variantId: 'wfv_std' }}
        onChange={onChange}
      />,
    );
    expect(onChange).toHaveBeenCalledWith({ mode: 'rotation' });
  });
});
