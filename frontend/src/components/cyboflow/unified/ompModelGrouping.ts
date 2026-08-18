import type { OmpModelOption } from '../../../../../shared/types/agentModels';

/**
 * Groups an OMP model catalog by its `ompProvider` field (e.g. 'anthropic',
 * 'openai'), preserving first-seen provider order and each provider's own
 * within-group order — both pickers (ModelSelector's native `<optgroup>`,
 * ModelPill's dropdown section headers) render one group per OMP vendor.
 */
export function groupOmpOptionsByProvider(
  options: readonly OmpModelOption[],
): ReadonlyArray<readonly [string, OmpModelOption[]]> {
  const groups = new Map<string, OmpModelOption[]>();
  for (const option of options) {
    const list = groups.get(option.ompProvider);
    if (list) list.push(option);
    else groups.set(option.ompProvider, [option]);
  }
  return Array.from(groups.entries());
}
