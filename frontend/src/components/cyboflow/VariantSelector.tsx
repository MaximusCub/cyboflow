/**
 * VariantSelector — per-launch workflow A/B variant choice (migration 048),
 * following the {@link ModelSelector} / {@link SubstrateSelector} template:
 * controlled (value/onChange), fed by `trpc.cyboflow.variants.list` via
 * {@link useWorkflowVariants}.
 *
 * Renders NOTHING when the workflow has zero variants — launches then behave
 * exactly as today (no `variantId`/`baseline` sent, the picker occupies no
 * layout space). Once at least one variant exists, offers (in order):
 *   - "Rotation (auto)" — ONLY when >=2 ACTIVE variants have weight>0; this is
 *     also the DEFAULT selection in that case (seeded once via a one-shot
 *     effect on first load, mirroring SubstrateSelector's self-correction).
 *   - "Baseline (no variant)" — always offered once any variant exists.
 *   - Each ACTIVE variant by label; each DRAFT variant suffixed " (draft)".
 *   - PAUSED / RETIRED variants are never offered (still pinnable via restart /
 *     experiment arms, per the resolver, just not from this picker).
 *
 * Shared by WorkflowPicker's Configure section and SessionStartWizard's
 * Advanced options so the option logic + default never drifts between the two
 * launch surfaces.
 *
 * Variants are TUNING-LEVEL scoped (migration 126): the options are the variants
 * of the level this launch will run at, since only those can rotate into it or
 * be pinned for it. Changing the level therefore re-seeds the selection — a pin
 * carried across levels would name a variant the launch would refuse.
 */
import { useEffect, useRef } from 'react';
import { useWorkflowVariants } from '../../stores/variantsStore';
import type { TuningLevel } from '../../../../shared/tuning/workflowTuning';
import {
  buildVariantSelectorOptions,
  defaultVariantSelection,
  selectionForSentinel,
  sentinelForSelection,
  type VariantSelection,
} from './variantSelectorLogic';

interface VariantSelectorProps {
  workflowId: string;
  /**
   * The tuning level this launch will run at (migration 126) — the pool whose
   * variants are offered. `null` for a flow outside the level system.
   */
  tuningLevel: TuningLevel | null;
  value: VariantSelection;
  onChange: (selection: VariantSelection) => void;
  /** DOM id for the <select> (label association). */
  id?: string;
  /** Heading text above the select. */
  label?: string;
}

export function VariantSelector({
  workflowId,
  tuningLevel,
  value,
  onChange,
  id = 'variant-select',
  label = 'Variant',
}: VariantSelectorProps): React.JSX.Element | null {
  const { variants, loaded } = useWorkflowVariants(workflowId, tuningLevel);
  const options = buildVariantSelectorOptions(variants);

  // One-shot default seeding: the FIRST time this workflow's variant list
  // resolves, hand the parent the architect-specified default ("Rotation
  // (auto)" when eligible, else "Baseline") so an un-touched picker launches
  // with the right behavior. Guarded per workflow AND LEVEL so switching either
  // the picker's target workflow or its tuning level re-seeds once for the new
  // pool, while the user's own choice within a pool is never overwritten. The
  // level belongs in the key, not just the filter: a variant pinned under
  // Standard is not a member of Thorough's pool, so carrying the pin across
  // would send the launcher an id it refuses.
  const seededForPool = useRef<string | null>(null);
  const poolKey = `${workflowId}::${tuningLevel ?? ''}`;
  useEffect(() => {
    if (!loaded) return;
    if (seededForPool.current === poolKey) return;
    seededForPool.current = poolKey;
    if (options.length > 0) {
      onChange(defaultVariantSelection(variants));
      return;
    }
    // An EMPTY pool offers nothing, so this renders nothing and stays silent —
    // a variant-less workflow launches exactly as it always has. The one
    // exception is a pin inherited from the pool we just left: it names a
    // variant this launch would refuse, so it is dropped to 'rotation' (the
    // no-op selection that sends no variant fields at all).
    if (value.mode === 'variant') onChange({ mode: 'rotation' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, poolKey]);

  if (!loaded || options.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-secondary">
        {label}
      </label>
      <select
        id={id}
        value={sentinelForSelection(value)}
        onChange={(e) => onChange(selectionForSentinel(e.target.value))}
        className="w-full rounded-input border border-border-primary bg-bg-primary px-2 py-1 text-sm text-text-primary"
        aria-label="Select workflow variant"
      >
        {options.map((opt) => (
          <option key={opt.sentinel} value={opt.sentinel}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
